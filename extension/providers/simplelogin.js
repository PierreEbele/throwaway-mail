"use strict";
// SimpleLogin (https://simplelogin.io, self-hostable). API: https://github.com/simple-login/app/blob/master/docs/api.md
//   POST /api/alias/random/new?hostname=<site>  { note }  -> 201 { alias | email, id }   header `Authentication: <key>`
//   GET  /api/user_info -> { name, email }
(() => {
  const P = globalThis.AliasProviders;
  const base = (cfg) => P.normalizeBaseUrl(cfg.baseUrl || "https://app.simplelogin.io");
  const auth = (cfg) => ({ authentication: cfg.apiKey });
  P.register({
    id: "simplelogin",
    short: "SIMPLELOGIN",
    name: "SimpleLogin",
    codes: false,
    baseUrl: "https://app.simplelogin.io",
    help: "SimpleLogin → API Keys → Create API key. Change the server only if you host SimpleLogin yourself.",
    fields: [
      { key: "baseUrl", label: "Server URL", type: "url", default: "https://app.simplelogin.io" },
      { key: "apiKey", label: "API key", type: "password", required: true },
    ],
    configured: (cfg) => !!cfg.apiKey,
    async createAlias(cfg, { site, note }) {
      const data = await P.http(`${base(cfg)}/api/alias/random/new?hostname=${encodeURIComponent(site)}`, {
        method: "POST",
        headers: auth(cfg),
        body: { note },
      });
      return { email: data?.alias || data?.email, id: data?.id };
    },
    async testConnection(cfg) {
      const me = await P.http(`${base(cfg)}/api/user_info`, { headers: auth(cfg) });
      return `Signed in as ${me?.name || me?.email || "?"}${me?.is_premium ? " (premium)" : ""}.`;
    },
  });
})();
