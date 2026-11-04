"use strict";
// "No service": addresses built locally, nothing is sent anywhere.
//   catch-all: <pattern>@your-domain, e.g. netflix.k3x9q2@example.net (the domain must accept any local part)
//   plus:      you+<site>@gmail.com (sub-addressing, supported by Gmail, Outlook, Proton, Fastmail…)
(() => {
  const P = globalThis.AliasProviders;
  const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
  const ADDRESS = /^([^@\s+]+)@([^@\s]+\.[^@\s]+)$/;

  function localPart(pattern, site) {
    const out = String(pattern || "{site}.{random}")
      .replaceAll("{site}", P.siteLabel(site))
      .replaceAll("{random}", P.randomToken(6))
      .toLowerCase()
      .replace(/[^a-z0-9._+-]/g, "")
      .replace(/^[.]+|[.]+$/g, "")
      .replace(/\.{2,}/g, ".");
    return out.slice(0, 64) || P.randomToken(10);
  }

  P.register({
    id: "none",
    short: "OWN DOMAIN",
    name: "No service",
    codes: false,
    help: "Addresses are made up in the browser: a catch-all domain you own, or plus-addressing on your own mailbox. Nothing is sent anywhere.",
    fields: [
      {
        key: "mode",
        label: "Address style",
        type: "select",
        default: "catchall",
        options: [
          ["catchall", "Catch-all domain (site.random@your-domain)"],
          ["plus", "Plus-addressing (you+site@your-mailbox)"],
        ],
      },
      { key: "domain", label: "Catch-all domain", type: "text", placeholder: "example.net", when: { mode: "catchall" } },
      {
        key: "pattern",
        label: "Local part pattern",
        type: "text",
        default: "{site}.{random}",
        hint: "{site} = site name, {random} = 6 random characters",
        when: { mode: "catchall" },
      },
      { key: "address", label: "Your address", type: "email", placeholder: "you@gmail.com", when: { mode: "plus" } },
    ],
    configured(cfg) {
      return cfg.mode === "plus" ? ADDRESS.test(String(cfg.address || "").trim()) : DOMAIN.test(String(cfg.domain || "").trim());
    },
    async createAlias(cfg, { site }) {
      if (cfg.mode === "plus") {
        const m = ADDRESS.exec(String(cfg.address || "").trim());
        if (!m) throw new Error("Enter your own address for plus-addressing.");
        return { email: `${m[1]}+${P.siteLabel(site)}@${m[2]}`.toLowerCase() };
      }
      const domain = String(cfg.domain || "")
        .trim()
        .toLowerCase();
      if (!DOMAIN.test(domain)) throw new Error("Enter a valid catch-all domain.");
      return { email: `${localPart(cfg.pattern, site)}@${domain}` };
    },
    async testConnection(cfg) {
      if (!this.configured(cfg)) throw new Error(cfg.mode === "plus" ? "Enter your own address." : "Enter a valid domain.");
      const { email } = await this.createAlias(cfg, { site: "www.example.com" });
      return `No network needed. Example for example.com: ${email}`;
    },
  });
})();
