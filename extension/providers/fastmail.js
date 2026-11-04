"use strict";
// Fastmail Masked Email, over JMAP (https://www.fastmail.com/dev/). Token: Settings → Privacy & Security → API tokens,
// with the "Masked Email" scope.
//   GET  /jmap/session -> { primaryAccounts: { "https://www.fastmail.com/dev/maskedemail": accountId }, apiUrl }
//   POST /jmap/api/ MaskedEmail/set create { state, forDomain, description } -> created[id].email
(() => {
  const P = globalThis.AliasProviders;
  const BASE = "https://api.fastmail.com";
  const CAPABILITY = "https://www.fastmail.com/dev/maskedemail";
  const auth = (cfg) => ({ authorization: `Bearer ${cfg.apiKey}` });

  async function session(cfg) {
    const s = await P.http(`${BASE}/jmap/session`, { headers: auth(cfg) });
    const accountId = s?.primaryAccounts?.[CAPABILITY];
    if (!accountId) throw new Error("This token has no Masked Email access.");
    return { accountId, username: s.username };
  }

  P.register({
    id: "fastmail",
    short: "FASTMAIL",
    name: "Fastmail Masked Email",
    codes: false,
    baseUrl: BASE,
    help: "Fastmail → Settings → Privacy & Security → API tokens → New token, with the Masked Email scope.",
    fields: [{ key: "apiKey", label: "API token", type: "password", required: true }],
    configured: (cfg) => !!cfg.apiKey,
    async createAlias(cfg, { url, note }) {
      const { accountId } = await session(cfg);
      const data = await P.http(`${BASE}/jmap/api/`, {
        method: "POST",
        headers: auth(cfg),
        body: {
          using: ["urn:ietf:params:jmap:core", CAPABILITY],
          methodCalls: [["MaskedEmail/set", { accountId, create: { new: { state: "enabled", forDomain: url, description: note } } }, "0"]],
        },
      });
      const [name, result] = data?.methodResponses?.[0] || [];
      if (name === "error") throw new Error(result?.description || result?.type || "JMAP error");
      const created = result?.created?.new;
      if (!created) throw new Error(result?.notCreated?.new?.description || "Fastmail did not create the masked address.");
      return { email: created.email, id: created.id };
    },
    async testConnection(cfg) {
      const { username } = await session(cfg);
      return `Signed in as ${username || "?"}, Masked Email available.`;
    },
  });
})();
