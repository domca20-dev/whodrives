// Apply the saved / system theme before first paint (no flash).
(function () {
  try {
    var saved = localStorage.getItem('whodrives.theme');
    var dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {}
})();
