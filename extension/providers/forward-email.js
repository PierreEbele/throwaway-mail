"use strict";
// Forward Email (https://forwardemail.net, open source). API: https://forwardemail.net/en/email-api
//   POST /v1/domains/<domain>/aliases { labels, description } -> { name, domain: { name } }   (no name = random alias)
//   GET  /v1/account -> { email }
//   Basic auth: the API token as user name, empty password.
(() => {
  const P = globalThis.AliasProviders;
  const base = (cfg) => P.normalizeBaseUrl(cfg.baseUrl || "https://api.forwardemail.net");
  const auth = (cfg) => ({ authorization: `Basic ${btoa(`${cfg.apiKey}:`)}` });
  P.register({
    id: "forward-email",
    short: "FORWARD EMAIL",
    name: "Forward Email",
    codes: false,
    baseUrl: "https://api.forwardemail.net",
    help: "Forward Email → My Account → Security → Developer access (API token). The domain must be set up in your account.",
    fields: [
      { key: "baseUrl", label: "API URL", type: "url", default: "https://api.forwardemail.net" },
      { key: "apiKey", label: "API token", type: "password", required: true },
      { key: "domain", label: "Domain", type: "text", placeholder: "example.net", required: true },
    ],
    configured: (cfg) => !!(cfg.apiKey && cfg.domain),
    async createAlias(cfg, { site, note }) {
      const domain = String(cfg.domain).trim().toLowerCase();
      const data = await P.http(`${base(cfg)}/v1/domains/${encodeURIComponent(domain)}/aliases`, {
        method: "POST",
        headers: auth(cfg),
        body: { labels: site, description: note },
      });
      return { email: data?.name ? `${data.name}@${data.domain?.name || domain}` : null, id: data?.id };
    },
    async testConnection(cfg) {
      const me = await P.http(`${base(cfg)}/v1/account`, { headers: auth(cfg) });
      return `Signed in as ${me?.email || "?"}.`;
    },
  });
})();
