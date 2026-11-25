-- WhoDrives – databáze pro sdílení skupin (Supabase, free tier)
-- Spusť celé v Supabase → SQL Editor → New query → Run. Skript jde pustit opakovaně.
--
-- Bezpečnostní model:
--  * Tabulky nejsou přes API přístupné vůbec (RLS zapnuté, žádné policies, odebraná práva).
--  * Appka volá jen 3 funkce níže. Každá potřebuje tajný klíč skupiny (192 bitů náhody z odkazu).
--  * V databázi je uložený jen SHA-256 hash klíče, ne klíč samotný.
--  * Limity velikosti a počtu chrání free tier před zahlcením.

create table if not exists public.wd_groups (
  id          uuid primary key default gen_random_uuid(),
  secret_hash text not null unique,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

create sequence if not exists public.wd_rev_seq;

create table if not exists public.wd_docs (
  group_id   uuid not null references public.wd_groups(id) on delete cascade,
  k          text not null,
  d          jsonb,
  del        boolean not null default false,
  rev        bigint not null,
  updated_at timestamptz not null default now(),
  primary key (group_id, k)
);
create index if not exists wd_docs_rev on public.wd_docs (group_id, rev);

alter table public.wd_groups enable row level security;
alter table public.wd_docs   enable row level security;
revoke all on public.wd_groups, public.wd_docs from anon, authenticated;
revoke all on sequence public.wd_rev_seq from anon, authenticated;

-- ---------------------------------------------------------------------
create or replace function public.wd_group_id(p_secret text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare gid uuid;
begin
  if p_secret is null or p_secret !~ '^[A-Za-z0-9_-]{32}$' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select id into gid from wd_groups where secret_hash = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');
  if gid is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return gid;
end $$;
revoke all on function public.wd_group_id(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
create or replace function public.wd_create_group(p_secret text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_secret is null or p_secret !~ '^[A-Za-z0-9_-]{32}$' then
    raise exception 'bad_secret' using errcode = '22023';
  end if;
  -- ochrana proti spamu: max 300 nových skupin za hodinu celkem
  if (select count(*) from wd_groups where created_at > now() - interval '1 hour') >= 300 then
    raise exception 'rate_limited' using errcode = '53400';
  end if;
  insert into wd_groups (secret_hash) values (encode(sha256(convert_to(p_secret, 'UTF8')), 'hex'))
  on conflict (secret_hash) do nothing;
  return true;
end $$;

-- ---------------------------------------------------------------------
create or replace function public.wd_push(p_secret text, p_docs jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  gid uuid := wd_group_id(p_secret);
  item jsonb;
  v_key text;
  total int;
begin
  if jsonb_typeof(p_docs) <> 'array' or jsonb_array_length(p_docs) > 100 then
    raise exception 'bad_payload' using errcode = '22023';
  end if;
  -- zápisy do jedné skupiny jdou postupně, aby čísla revizí odpovídala pořadí commitů
  perform pg_advisory_xact_lock(hashtextextended(gid::text, 0));

  for item in select * from jsonb_array_elements(p_docs) loop
    v_key := item->>'k';
    if v_key is null or length(v_key) > 64
       or v_key !~ '^(settings|(m|pr|r|p|c):[a-z0-9]{1,24}|off:[0-9]{4}-[0-9]{2}-[0-9]{2}:[a-z0-9]{1,24})$' then
      raise exception 'bad_key' using errcode = '22023';
    end if;
    if pg_column_size(item->'d') > 4096 then
      raise exception 'doc_too_large' using errcode = '22023';
    end if;
    insert into wd_docs (group_id, k, d, del, rev, updated_at)
    values (gid, v_key,
            case when coalesce((item->>'del')::boolean, false) then null else item->'d' end,
            coalesce((item->>'del')::boolean, false),
            nextval('wd_rev_seq'), now())
    on conflict (group_id, k) do update
      set d = excluded.d, del = excluded.del, rev = excluded.rev, updated_at = excluded.updated_at;
  end loop;

  select count(*) into total from wd_docs where group_id = gid;
  if total > 20000 then
    raise exception 'group_full' using errcode = '53400';
  end if;
  update wd_groups set last_seen = now() where id = gid;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
create or replace function public.wd_pull(p_secret text, p_since bigint default 0)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  gid uuid := wd_group_id(p_secret);
  v_rows jsonb;
  cnt int;
  max_rev bigint;
begin
  -- počká na rozpracovaný zápis do stejné skupiny, ať nic nepřeskočíme
  perform pg_advisory_xact_lock_shared(hashtextextended(gid::text, 0));

  select coalesce(jsonb_agg(jsonb_build_object('k', k, 'd', d, 'del', del, 'rev', rev) order by rev), '[]'::jsonb),
         count(*), max(rev)
    into v_rows, cnt, max_rev
    from (select k, d, del, rev from wd_docs
           where group_id = gid and rev > coalesce(p_since, 0)
           order by rev limit 1000) t;

  return jsonb_build_object('docs', v_rows, 'rev', coalesce(max_rev, p_since, 0), 'more', cnt = 1000);
end $$;

-- jen tyhle tři funkce smí appka volat
revoke all on function public.wd_create_group(text)  from public;
revoke all on function public.wd_push(text, jsonb)   from public;
revoke all on function public.wd_pull(text, bigint)  from public;
grant execute on function public.wd_create_group(text) to anon, authenticated;
grant execute on function public.wd_push(text, jsonb)  to anon, authenticated;
grant execute on function public.wd_pull(text, bigint) to anon, authenticated;
