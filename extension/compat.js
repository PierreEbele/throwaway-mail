// Firefox/Chrome compatibility: the code uses Firefox's promise-based `browser.*` namespace.
// On Chrome (MV3, promise-based `chrome.*`), expose a `browser` view of `chrome` that fills the gaps.
// No-op on Firefox. Chrome's API objects are not writable, hence the proxies.
(() => {
  // Firefox has `browser.menus`; recent Chrome also defines `browser`, but as plain `chrome`.
  if (globalThis.browser?.menus || typeof globalThis.chrome === "undefined") return;
  const api = globalThis.chrome;
  // Chrome listeners cannot answer by returning a Promise: bridge it to sendResponse.
  const wrapped = new WeakMap();
  const bridge = (fn) => {
    if (!wrapped.has(fn))
      wrapped.set(fn, (msg, sender, sendResponse) => {
        const r = fn(msg, sender);
        if (!r || typeof r.then !== "function") return false;
        r.then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
        return true;
      });
    return wrapped.get(fn);
  };
  const onMessage = api.runtime?.onMessage && {
    addListener: (fn) => api.runtime.onMessage.addListener(bridge(fn)),
    removeListener: (fn) => api.runtime.onMessage.removeListener(bridge(fn)),
    hasListener: (fn) => api.runtime.onMessage.hasListener(bridge(fn)),
  };
  const runtime = api.runtime && new Proxy(api.runtime, { get: (t, k) => (k === "onMessage" && onMessage ? onMessage : t[k]) });
  const shim = new Proxy(api, {
    get: (t, k) => {
      if (k === "runtime") return runtime;
      // Chrome names the context-menu API `contextMenus` (Firefox: `menus`).
      if (k === "menus") return t.menus || t.contextMenus;
      return t[k];
    },
  });
  Object.defineProperty(globalThis, "browser", { value: shim, configurable: true, writable: true });
})();
