"use strict";
// Alias providers: where the e-mail address of a fake identity comes from.
// Each adapter (extension/providers/*.js) registers itself here with:
//   id, name, codes (true when it can read received mail, i.e. fetch verification codes),
//   fields (per-provider settings shown on the options page), baseUrl (default API origin, if any),
//   configured(cfg), createAlias(cfg, { site, url, note, name }) -> { email, id? }, testConnection(cfg) -> message,
//   and optionally waitForCode(cfg, alias, since, wait).
// Settings live in browser.storage.local: `aliasProvider` (selected id) and `providerSettings` ({ [id]: {...} });
// Throwaway Mail keeps its historical tm* keys (see throwaway.js).
globalThis.AliasProviders = (() => {
  const registry = new Map();

  function register(provider) {
    registry.set(provider.id, provider);
  }

  const list = () => [...registry.values()];
  const get = (id) => registry.get(id) || null;

  // Plain HTTPS origin (localhost may use http, for self-hosted tests).
  function normalizeBaseUrl(raw) {
    const url = new URL(String(raw || "").trim());
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("The server must use HTTPS.");
    return url.origin + url.pathname.replace(/\/+$/, "");
  }

  // "shop.example.co.uk" -> "example": the readable part of a host name, for local parts.
  const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "ne", "or", "gouv"]);
  function siteLabel(host) {
    const parts = String(host || "")
      .toLowerCase()
      .replace(/^www\d*\./, "")
      .split(".")
      .filter(Boolean);
    let label = parts[0] || "site";
    if (parts.length >= 3 && SECOND_LEVEL.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2)
      label = parts[parts.length - 3];
    else if (parts.length >= 2) label = parts[parts.length - 2];
    return label.replace(/[^a-z0-9-]/g, "").slice(0, 30) || "site";
  }

  function randomToken(length = 6) {
    const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  }

  // JSON request with the provider's own error message on failure (err.status = HTTP status).
  async function http(url, { method = "GET", headers = {}, body } = {}) {
    const res = await fetch(url, {
      method,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "omit",
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const detail = data?.error?.message || data?.error || data?.message || data?.detail;
      const err = new Error(typeof detail === "string" && detail ? detail : `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function selectedId() {
    const s = await browser.storage.local.get(["aliasProvider", "tmServer", "tmApiKey"]);
    if (s.aliasProvider && registry.has(s.aliasProvider)) return s.aliasProvider;
    // Installs from before providers existed: a configured Throwaway Mail stays in use.
    return s.tmServer && s.tmApiKey && registry.has("throwaway") ? "throwaway" : "none";
  }

  async function settings(id) {
    const provider = get(id);
    if (!provider) return {};
    if (provider.loadSettings) return provider.loadSettings();
    const { providerSettings = {} } = await browser.storage.local.get("providerSettings");
    const defaults = Object.fromEntries((provider.fields || []).filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));
    return { ...defaults, ...(providerSettings[id] || {}) };
  }

  async function saveSettings(id, values) {
    const { providerSettings = {} } = await browser.storage.local.get("providerSettings");
    await browser.storage.local.set({ providerSettings: { ...providerSettings, [id]: values } });
  }

  // API origin the browser must allow for this provider ("https://host/*"), or null when it needs no network.
  function originPattern(provider, cfg) {
    const base = provider.apiBase ? provider.apiBase(cfg) : cfg.baseUrl || provider.baseUrl;
    return base ? new URL(normalizeBaseUrl(base)).origin + "/*" : null;
  }

  // The selected provider when it is set up, otherwise null (identities then keep @example.com addresses).
  async function active() {
    const id = await selectedId();
    const provider = get(id);
    if (!provider) return null;
    const cfg = await settings(id);
    return provider.configured(cfg) ? { provider, cfg } : null;
  }

  // Creates an address for this page with the active provider: { email, host, createdAt, provider, id?, ... }.
  // `name` (the fake identity's) is only used by Throwaway Mail, as the address label.
  async function createAlias(pageUrl, name) {
    const a = await active();
    if (!a) throw new Error("NOT_CONFIGURED");
    const url = new URL(pageUrl);
    const created = await a.provider.createAlias(a.cfg, {
      site: url.hostname,
      url: url.origin,
      note: `Throwaway Mail extension · ${url.hostname}`,
      name,
    });
    if (!created?.email) throw new Error(`${a.provider.name} returned no address.`);
    return { createdAt: Date.now(), ...created, host: url.hostname, provider: a.provider.id };
  }

  // Human message for a failed call.
  function errorMessage(provider, e) {
    if (e?.status === 401 || e?.status === 403) return `Invalid ${provider?.name || "provider"} API key.`;
    if (e?.message === "NOT_CONFIGURED") return "No alias provider is set up (see the extension settings).";
    return e?.message || String(e);
  }

  return {
    register,
    list,
    get,
    normalizeBaseUrl,
    siteLabel,
    randomToken,
    http,
    selectedId,
    settings,
    saveSettings,
    originPattern,
    active,
    createAlias,
    errorMessage,
  };
})();
