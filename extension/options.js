"use strict";
const $ = (id) => document.getElementById(id);
function status(message, error = false) {
  $("status").textContent = message;
  $("status").dataset.tone = error ? "error" : "normal";
}

// ---------- Provider picker ----------
const providerId = () => $("provider").value;
const provider = () => AliasProviders.get(providerId());

for (const p of AliasProviders.list()) $("provider").add(new Option(p.name, p.id));

// Builds the selected provider's fields (Throwaway Mail keeps its own static block).
function renderFields(values) {
  const p = provider();
  $("provider-help").textContent = p.help || "";
  $("tm-fields").hidden = p.id !== "throwaway";
  $("codes-on").hidden = !p.codes;
  $("codes-off").hidden = !!p.codes;
  $("clear").hidden = !p.fields.some((f) => f.type === "password") && p.id !== "throwaway";
  $("test").textContent = p.id === "none" ? "Preview an address" : "Test connection";
  const box = $("generic-fields");
  box.replaceChildren();
  for (const f of p.fields) {
    const wrap = document.createElement("div");
    wrap.dataset.key = f.key;
    if (f.when) wrap.dataset.when = JSON.stringify(f.when);
    const label = document.createElement("label");
    label.htmlFor = `f-${f.key}`;
    label.textContent = f.label;
    if (f.hint) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = ` (${f.hint})`;
      label.append(hint);
    }
    let input;
    if (f.type === "select") {
      input = document.createElement("select");
      for (const [value, text] of f.options) input.add(new Option(text, value));
      input.addEventListener("change", syncConditions);
    } else {
      input = document.createElement("input");
      input.type = f.type;
      input.autocomplete = "off";
      input.spellcheck = false;
      if (f.placeholder) input.placeholder = f.placeholder;
    }
    input.id = `f-${f.key}`;
    input.value = values[f.key] ?? f.default ?? "";
    wrap.append(label, input);
    box.append(wrap);
  }
  syncConditions();
}

// Fields shown only for some values of another field (e.g. the catch-all domain for the catch-all style).
function syncConditions() {
  for (const wrap of $("generic-fields").querySelectorAll("[data-when]")) {
    const when = JSON.parse(wrap.dataset.when);
    wrap.hidden = !Object.entries(when).every(([k, v]) => $(`f-${k}`)?.value === v);
  }
}

function genericValues() {
  return Object.fromEntries(provider().fields.map((f) => [f.key, String($(`f-${f.key}`).value).trim()]));
}

$("provider").addEventListener("change", async () => {
  renderFields(await AliasProviders.settings(providerId()));
  if (providerId() === "throwaway") await loadThrowaway();
  status("");
});

// ---------- Throwaway Mail ----------
async function loadDomains(cfg, selected) {
  const data = await Throwaway.request("/v1/domains", { cfg });
  $("domain").replaceChildren(new Option("Server default", ""));
  for (const d of data.domains || []) $("domain").add(new Option(d.name, d.name));
  $("domain").value = selected || "";
  return data.domains?.length || 0;
}

async function loadThrowaway() {
  const cfg = await Throwaway.config();
  $("server").value = cfg.server || "";
  $("api-key").value = cfg.apiKey;
  $("expires-days").value = String(cfg.expiresDays || 0);
  $("max-messages").value = cfg.maxMessages ? String(cfg.maxMessages) : "";
  if (cfg.server && cfg.apiKey) await loadDomains(cfg, cfg.domain).catch(() => status("Server unreachable or invalid key.", true));
}

// ---------- Form → settings, with access to the provider's API origin only (needs a user gesture) ----------
async function formConfig() {
  const p = provider();
  let cfg;
  if (p.id === "throwaway") {
    const server = Throwaway.normalizeServer($("server").value);
    const apiKey = $("api-key").value.trim();
    if (!apiKey) throw new Error("Paste an API key.");
    cfg = { server, apiKey, domain: $("domain").value };
  } else {
    cfg = genericValues();
    if (cfg.baseUrl) cfg.baseUrl = AliasProviders.normalizeBaseUrl(cfg.baseUrl);
    const missing = p.fields.find((f) => f.required && !cfg[f.key]);
    if (missing) throw new Error(`Fill in “${missing.label}”.`);
  }
  const origin = AliasProviders.originPattern(p, cfg);
  if (origin && !(await browser.permissions.request({ origins: [origin] })))
    throw new Error(`Access to ${new URL(origin.slice(0, -2)).host} was denied.`);
  return cfg;
}

function failure(e) {
  return e?.status === 401 || e?.status === 403 ? AliasProviders.errorMessage(provider(), e) : `Failed: ${e?.message || e}`;
}

$("test").addEventListener("click", async () => {
  try {
    const cfg = await formConfig();
    status("Connecting…");
    const message = await provider().testConnection(cfg);
    if (providerId() === "throwaway") await loadDomains(cfg, cfg.domain);
    status(message);
  } catch (e) {
    status(failure(e), true);
  }
});

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const p = provider();
    const cfg = await formConfig();
    if (p.id === "throwaway") {
      await Throwaway.request("/v1/auth/me", { cfg });
      await browser.storage.local.set({
        tmServer: cfg.server,
        tmApiKey: cfg.apiKey,
        tmDomain: cfg.domain,
        tmExpiresDays: Number($("expires-days").value) || 0,
        tmMaxMessages: Number($("max-messages").value) || 0,
      });
    } else await AliasProviders.saveSettings(p.id, cfg);
    if (!p.configured(p.id === "throwaway" ? cfg : await AliasProviders.settings(p.id)))
      throw new Error("Some settings are missing: nothing would be generated.");
    await browser.storage.local.set({ aliasProvider: p.id, ...toggles() });
    status(`Saved. Next fills will use ${p.id === "none" ? "your own addresses" : p.name}.`);
  } catch (e) {
    status(e?.status === 401 ? `${AliasProviders.errorMessage(provider(), e)} Nothing was saved.` : failure(e), true);
  }
});

$("clear").addEventListener("click", async () => {
  const p = provider();
  if (p.id === "throwaway") await browser.storage.local.remove(["tmApiKey"]);
  else {
    const cfg = await AliasProviders.settings(p.id);
    for (const f of p.fields) if (f.type === "password") delete cfg[f.key];
    await AliasProviders.saveSettings(p.id, cfg);
  }
  renderFields(await AliasProviders.settings(p.id));
  $("api-key").value = "";
  status("Key deleted. Back to @example.com addresses until another provider is set up.");
});

// ---------- Automation ----------
const TOGGLES = { "auto-prompt": "autoPrompt", "auto-code": "autoCode", "always-new": "alwaysNew" };
const toggles = () => ({
  ...Object.fromEntries(Object.entries(TOGGLES).map(([id, key]) => [key, $(id).checked])),
  bitwardenMode: $("bitwarden-mode").checked,
  autoFillCode: $("auto-fill-code").checked,
  identityTtlHours: Number($("identity-ttl").value),
});
// Off by default / 24 h by default, unlike the other automations.
for (const id of ["bitwarden-mode", "identity-ttl", "auto-fill-code"])
  $(id).addEventListener("change", async () => {
    await browser.storage.local.set(toggles());
    await browser.runtime.sendMessage({ type: "purge" }).catch(() => {});
    status("Automation settings saved.");
  });
for (const id of Object.keys(TOGGLES))
  $(id).addEventListener("change", async () => {
    await browser.storage.local.set(toggles());
    if ($("auto-prompt").checked || $("auto-code").checked) await browser.permissions.request(ALL_SITES).catch(() => {});
    status("Automation settings saved.");
  });

(async () => {
  const flags = await browser.storage.local.get(Object.values(TOGGLES));
  for (const [id, key] of Object.entries(TOGGLES)) $(id).checked = flags[key] !== false;
  const extra = await browser.storage.local.get(["bitwardenMode", "identityTtlHours", "autoFillCode"]);
  $("auto-fill-code").checked = extra.autoFillCode === true;
  $("bitwarden-mode").checked = extra.bitwardenMode === true;
  $("identity-ttl").value = String(extra.identityTtlHours ?? 24);
  $("provider").value = await AliasProviders.selectedId();
  renderFields(await AliasProviders.settings(providerId()));
  const active = await AliasProviders.active();
  if (providerId() === "throwaway") await loadThrowaway();
  if (active && !$("status").textContent) status(`${active.provider.name} is active.`);
  else if (!active) status("No provider set up yet: identities use @example.com addresses.");
})();

// Firefox (MV3) does not grant "all sites" at install time: ask for it (needs a click).
const ALL_SITES = { origins: ["http://*/*", "https://*/*"] };
async function checkSitePermission() {
  const banner = document.getElementById("perm-banner");
  banner.hidden = await browser.permissions.contains(ALL_SITES);
  document.getElementById("perm-grant").onclick = async () => {
    if (await browser.permissions.request(ALL_SITES)) banner.hidden = true;
  };
}
void checkSitePermission();
