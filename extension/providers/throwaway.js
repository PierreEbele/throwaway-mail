"use strict";
// Throwaway Mail (self-hosted): the only provider that reads received mail, hence verification codes.
// The API client is extension/throwaway.js; settings keep their tm* keys.
(() => {
  globalThis.AliasProviders.register({
    id: "throwaway",
    short: "THROWAWAY",
    name: "Throwaway Mail",
    codes: true,
    help: "Your own Throwaway Mail server: real disposable addresses, and the verification code they receive is pasted into the page.",
    fields: [],
    loadSettings: () => Throwaway.config(),
    apiBase: (cfg) => cfg.server,
    configured: (cfg) => !!(cfg.server && cfg.apiKey),
    async createAlias(_cfg, { url, name }) {
      return Throwaway.createAddress(url, name);
    },
    async testConnection(cfg) {
      const me = await Throwaway.request("/v1/auth/me", { cfg });
      const data = await Throwaway.request("/v1/domains", { cfg });
      return `Signed in as ${me.user?.name || me.user?.email || "?"} · ${data.domains?.length || 0} domain(s) available.`;
    },
    waitForCode: (_cfg, alias, since, wait) => Throwaway.waitForCode(alias.id, since, wait),
  });
})();
