"use strict";
// Client de l'API Throwaway Mail (clé API Bearer). Partagé par la popup et la page d'options.
// La clé reste dans browser.storage.local de ce profil Firefox et n'est envoyée qu'au serveur configuré.
const Throwaway = (() => {
  const KEYS = ["tmServer", "tmApiKey", "tmDomain"];

  function normalizeServer(raw) {
    const url = new URL(String(raw || "").trim());
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Le serveur doit être en HTTPS.");
    return url.origin;
  }

  async function config() {
    const saved = await browser.storage.local.get(KEYS);
    return { server: saved.tmServer || "", apiKey: saved.tmApiKey || "", domain: saved.tmDomain || "" };
  }

  async function enabled() {
    const c = await config();
    return !!(c.server && c.apiKey);
  }

  async function request(path, { method = "GET", body, cfg } = {}) {
    const c = cfg || await config();
    if (!c.server || !c.apiKey) throw new Error("NOT_CONFIGURED");
    const res = await fetch(c.server + path, {
      method,
      headers: { authorization: "Bearer " + c.apiKey, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "omit"
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Une adresse par site : site_name = nom d'hôte de l'onglet, libellé = identité fictive.
  async function createAddress(pageUrl, label) {
    const c = await config();
    const url = new URL(pageUrl);
    const data = await request("/v1/addresses", {
      method: "POST",
      cfg: c,
      body: { site_name: url.hostname, site_url: url.origin, label: label ? `Fable · ${label}` : "Fable", ...(c.domain ? { domain: c.domain } : {}) }
    });
    return { id: data.id, email: data.email, host: url.hostname, createdAt: data.address?.created_at ?? Date.now() };
  }

  // Adresse déjà créée pour ce site (site_name = nom d'hôte exact ; `site` côté serveur est un LIKE).
  async function siteAddress(host) {
    const data = await request(`/v1/addresses?site=${encodeURIComponent(host)}&status=active&limit=50`);
    return (data?.addresses || []).find(a => String(a.site_name || "").toLowerCase() === host.toLowerCase()) || null;
  }

  // Attend (long polling, 55 s max par appel) un code arrivé après `since`.
  function waitForCode(addressId, since, wait = 55) {
    const q = new URLSearchParams({ wait: String(wait), require: "any" });
    if (since) q.set("since", String(since));
    return request(`/v1/addresses/${encodeURIComponent(addressId)}/code?${q}`);
  }

  return { KEYS, normalizeServer, config, enabled, request, createAddress, siteAddress, waitForCode };
})();
