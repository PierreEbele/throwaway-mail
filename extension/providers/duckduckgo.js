"use strict";
// DuckDuckGo Email Protection — EXPERIMENTAL: the API is not public. It is the one DuckDuckGo's own extension uses,
// also used by Bitwarden's generator (bitwarden/clients, libs/tools/generator/core/src/integration/duck-duck-go.ts):
//   POST https://quack.duckduckgo.com/api/email/addresses -> { address }  =>  <address>@duck.com   header `Authorization: Bearer <token>`
// It may change or break without notice. There is no read-only endpoint to test the token.
(() => {
  const P = globalThis.AliasProviders;
  const BASE = "https://quack.duckduckgo.com";
  P.register({
    id: "duckduckgo",
    short: "DUCK",
    name: "DuckDuckGo (experimental)",
    experimental: true,
    codes: false,
    baseUrl: BASE,
    help: "Unofficial API. The token is the one DuckDuckGo's extension stores after you sign in to Email Protection (see the extension docs). It may stop working at any time.",
    fields: [{ key: "apiKey", label: "Token", type: "password", required: true }],
    configured: (cfg) => !!cfg.apiKey,
    async createAlias(cfg) {
      const data = await P.http(`${BASE}/api/email/addresses`, { method: "POST", headers: { authorization: `Bearer ${cfg.apiKey}` } });
      return { email: data?.address ? `${data.address}@duck.com` : null };
    },
    async testConnection(cfg) {
      if (!cfg.apiKey) throw new Error("Paste a token.");
      return "Token saved. DuckDuckGo has no test endpoint: it is checked when the first address is created.";
    },
  });
})();
