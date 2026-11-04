"use strict";
// addy.io (formerly AnonAddy, self-hostable). API: https://app.addy.io/docs/
//   POST /api/v1/aliases { domain, description } -> 201 { data: { email, id } }   header `Authorization: Bearer <token>`
//   GET  /api/v1/account-details -> { data: { username, default_alias_domain } }
(() => {
  const P = globalThis.AliasProviders;
  const base = (cfg) => P.normalizeBaseUrl(cfg.baseUrl || "https://app.addy.io");
  const auth = (cfg) => ({ authorization: `Bearer ${cfg.apiKey}`, "x-requested-with": "XMLHttpRequest" });
  P.register({
    id: "addy",
    short: "ADDY.IO",
    name: "addy.io",
    codes: false,
    baseUrl: "https://app.addy.io",
    help: "addy.io → Settings → API → Create new API key. The domain is one of your alias domains (anonaddy.me, your username subdomain or a custom one).",
    fields: [
      { key: "baseUrl", label: "Server URL", type: "url", default: "https://app.addy.io" },
      { key: "apiKey", label: "API access token", type: "password", required: true },
      { key: "domain", label: "Alias domain", type: "text", default: "anonaddy.me", required: true },
    ],
    configured: (cfg) => !!(cfg.apiKey && cfg.domain),
    async createAlias(cfg, { note }) {
      const data = await P.http(`${base(cfg)}/api/v1/aliases`, {
        method: "POST",
        headers: auth(cfg),
        body: { domain: cfg.domain, description: note },
      });
      return { email: data?.data?.email, id: data?.data?.id };
    },
    async testConnection(cfg) {
      const me = await P.http(`${base(cfg)}/api/v1/account-details`, { headers: auth(cfg) });
      return `Signed in as ${me?.data?.username || "?"}.`;
    },
  });
})();
