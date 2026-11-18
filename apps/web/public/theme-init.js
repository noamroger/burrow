// Runs before the app bundle to avoid a flash of the wrong theme.
// Mirrors the logic in src/lib/theme.ts.
(function () {
  try {
    var pref = localStorage.getItem('burrow.theme');
    var dark =
      pref === 'dark' ||
      ((pref === null || pref === 'system') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch {
    /* storage unavailable: keep the default (light) */
  }
})();
