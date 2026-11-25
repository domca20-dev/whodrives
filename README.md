# WhoDrives

Kdo dnes řídí? Férové střídání aut v partě podle ujetých kilometrů. Kdo nemá auto, dorovná to QR platbou.

Čistě statická webová appka (HTML + JS), žádný build ani závislosti.

## Soubory
| Soubor | Co dělá |
|---|---|
| `index.html`, `styles.css` | vzhled |
| `app.js` | logika, ukládání, synchronizace |
| `qr.js` | generátor QR kódu (běží lokálně, účet ani částka neopouští telefon) |
| `config.js` | adresa a veřejný klíč Supabase (prázdné = jen lokální režim) |
| `sw.js`, `manifest.webmanifest`, ikony | instalace na plochu a offline režim |
| `supabase/schema.sql` | databáze pro sdílení skupin |
| `archive/` | předchozí verze (nenahrává se) |

## Nasazení zdarma
1. **Supabase** (free tier, nic se na něm nedá zaplatit): vytvoř projekt (region Frankfurt), v SQL Editoru spusť `supabase/schema.sql`.
2. V Project Settings → API zkopíruj *Project URL* a *publishable/anon key* do `config.js`.
3. **GitHub Pages**: nahraj složku do repozitáře, zapni Pages z větve `main`. Appka poběží na `https://<uživatel>.github.io/<repo>/`.
4. Při každém dalším nasazení zvyš `VERSION` v `sw.js`, ať se telefonům stáhne nová verze.

## Bezpečnost
- Skupina = tajný odkaz (192 bitů náhody). Kdo odkaz má, vidí a upravuje skupinu, takže ho posílej jen partě.
- Klíč se drží v části URL za `#`, takže se neposílá na server a neukládá do logů. Po otevření ho appka z adresního řádku smaže.
- Databáze ukládá jen hash klíče. Tabulky nejsou přes API dostupné, appka smí volat jen 3 funkce s limity velikosti.
- Data od ostatních se před zobrazením validují a escapují. Content-Security-Policy zakazuje cizí skripty.
- Free projekt Supabase se po 7 dnech bez provozu uspí. Data zůstanou, jen je potřeba ho v dashboardu probudit.
