const HISTORY_HOOK = `
(() => {
  if (window.__cs_history_hooked__) return;
  window.__cs_history_hooked__ = true;
  const emit = (reason) => {
    try {
      if (typeof window.__cs_reportNav === 'function') {
        window.__cs_reportNav({ href: location.href, reason });
      }
    } catch {}
  };
  const wrap = (fn, name) => function (...args) {
    const ret = fn.apply(this, args);
    emit(name);
    return ret;
  };
  history.pushState = wrap(history.pushState, 'pushState');
  history.replaceState = wrap(history.replaceState, 'replaceState');
  window.addEventListener('popstate', () => emit('popstate'));
  window.addEventListener('hashchange', () => emit('hashchange'));
})();
`;

/**
 * @param {import('playwright').Page} page
 * @param {(detail: { href: string, reason: string }) => void} onNav
 */
export async function installHistoryObserver(page, onNav) {
  await page.exposeFunction('__cs_reportNav', onNav);
  await page.addInitScript(HISTORY_HOOK);
  // Also inject into current document if already loaded
  await page.evaluate(HISTORY_HOOK).catch(() => {});
}

export { HISTORY_HOOK };
