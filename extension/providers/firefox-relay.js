"use strict";
// Firefox Relay (https://relay.firefox.com). API: https://relay.firefox.com/api/v1/docs/
//   POST /api/v1/relayaddresses/ { enabled, generated_for, description } -> 201 { full_address, id }   header `Authorization: Token <key>`
//   GET  /api/v1/profiles/ -> [ { ... } ]
(() => {
  const P = globalThis.AliasProviders;
  const BASE = "https://relay.firefox.com";
  const auth = (cfg) => ({ authorization: `Token ${cfg.apiKey}` });
  P.register({
    id: "firefox-relay",
    short: "RELAY",
    name: "Firefox Relay",
    codes: false,
    baseUrl: BASE,
    help: "relay.firefox.com → Settings → API key.",
    fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],
    configured: (cfg) => !!cfg.apiKey,
    async createAlias(cfg, { url, note }) {
      const data = await P.http(`${BASE}/api/v1/relayaddresses/`, {
        method: "POST",
        headers: auth(cfg),
        body: { enabled: true, generated_for: url.slice(0, 255), description: note.slice(0, 64) },
      });
      return { email: data?.full_address, id: data?.id };
    },
    async testConnection(cfg) {
      const profiles = await P.http(`${BASE}/api/v1/profiles/`, { headers: auth(cfg) });
      const p = Array.isArray(profiles) ? profiles[0] : null;
      if (!p) throw new Error("No Relay profile for this key.");
      return `Connected${p.has_premium ? " (premium)" : ""}.`;
    },
  });
})();
