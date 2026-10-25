// Applies the saved colour theme before first paint (no flash). Kept tiny and blocking on purpose.
(function () {
  try {
    var t = localStorage.getItem('rdv-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* storage unavailable: follow the system theme */
  }
})();
