/*
 * Dark mode follows the operating system; the design draws no switch. The theme selects dark
 * with a `dark` class on <html>, so this runs in the head, before the body paints, and keeps
 * following the setting while the page is open. It is served with the page's CSP nonce
 * (ADR 0085). Without script the page stays light, which is still fully usable.
 */
export const COLOR_SCHEME_SCRIPT = `(function () {
  var query = window.matchMedia('(prefers-color-scheme: dark)');
  function apply() {
    document.documentElement.classList.toggle('dark', query.matches);
  }
  apply();
  query.addEventListener('change', apply);
})()`;
