"use strict";
const $ = id => document.getElementById(id);
function status(message, error = false) {
  $("status").textContent = message;
  $("status").dataset.tone = error ? "error" : "normal";
}

async function loadDomains(cfg, selected) {
  const data = await Throwaway.request("/v1/domains", { cfg });
  $("domain").replaceChildren(new Option("Par défaut du serveur", ""));
  for (const d of data.domains || []) $("domain").add(new Option(d.name, d.name));
  $("domain").value = selected || "";
  return data.domains?.length || 0;
}

// Lit le formulaire et demande la permission d'accès au serveur (geste utilisateur requis).
async function formConfig() {
  const server = Throwaway.normalizeServer($("server").value);
  const apiKey = $("api-key").value.trim();
  if (!apiKey) throw new Error("Collez une clé API.");
  const granted = await browser.permissions.request({ origins: [server + "/*", "<all_urls>"] });
  if (!granted) throw new Error("Permission d’accès au serveur refusée.");
  return { server, apiKey, domain: $("domain").value };
}

const TOGGLES = { "auto-prompt": "autoPrompt", "auto-code": "autoCode", "always-new": "alwaysNew" };
const toggles = () => ({ ...Object.fromEntries(Object.entries(TOGGLES).map(([id, key]) => [key, $(id).checked])), bitwardenMode: $("bitwarden-mode").checked, identityTtlHours: Number($("identity-ttl").value) });
// Désactivés par défaut / 24 h par défaut, contrairement aux autres automatismes.
for (const id of ["bitwarden-mode", "identity-ttl"]) $(id).addEventListener("change", async () => {
  await browser.storage.local.set(toggles());
  await browser.runtime.sendMessage({ type: "purge" }).catch(() => {});
  status("Automatismes enregistrés.");
});
for (const id of Object.keys(TOGGLES)) $(id).addEventListener("change", async () => {
  await browser.storage.local.set(toggles());
  if ($("auto-prompt").checked || $("auto-code").checked) await browser.permissions.request({ origins: ["<all_urls>"] }).catch(() => {});
  status("Automatismes enregistrés.");
});

$("test").addEventListener("click", async () => {
  try {
    const cfg = await formConfig();
    status("Connexion…");
    const me = await Throwaway.request("/v1/auth/me", { cfg });
    const n = await loadDomains(cfg, cfg.domain);
    status(`Connecté en tant que ${me.user?.name || me.user?.email || "?"} · ${n} domaine(s) disponible(s).`);
  } catch (e) { status(e.status === 401 ? "Clé API invalide ou révoquée." : `Échec : ${e.message}`, true); }
});

$("form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const cfg = await formConfig();
    await Throwaway.request("/v1/auth/me", { cfg });
    await browser.storage.local.set({ tmServer: cfg.server, tmApiKey: cfg.apiKey, tmDomain: cfg.domain, ...toggles() });
    status("Enregistré. Les prochains remplissages utiliseront Throwaway Mail.");
  } catch (e) { status(e.status === 401 ? "Clé API invalide ou révoquée : rien n’a été enregistré." : `Échec : ${e.message}`, true); }
});

$("clear").addEventListener("click", async () => {
  await browser.storage.local.remove(["tmApiKey"]);
  $("api-key").value = "";
  status("Clé effacée. Fable revient aux adresses @example.com.");
});

(async () => {
  const flags = await browser.storage.local.get(Object.values(TOGGLES));
  for (const [id, key] of Object.entries(TOGGLES)) $(id).checked = flags[key] !== false;
  const extra = await browser.storage.local.get(["bitwardenMode", "identityTtlHours"]);
  $("bitwarden-mode").checked = extra.bitwardenMode === true;
  $("identity-ttl").value = String(extra.identityTtlHours ?? 24);
  const cfg = await Throwaway.config();
  $("server").value = cfg.server || "https://mail.example.com";
  $("api-key").value = cfg.apiKey;
  if (cfg.server && cfg.apiKey) {
    try { await loadDomains(cfg, cfg.domain); status("Throwaway Mail est actif."); }
    catch { status("Serveur injoignable ou clé invalide.", true); }
  }
})();

// Firefox (MV3) n'accorde pas « tous les sites » à l'installation : on le demande (clic requis).
const ALL_SITES = { origins: ["<all_urls>"] };
async function checkSitePermission() {
  const banner = document.getElementById("perm-banner");
  banner.hidden = await browser.permissions.contains(ALL_SITES);
  document.getElementById("perm-grant").onclick = async () => {
    if (await browser.permissions.request(ALL_SITES)) banner.hidden = true;
  };
}
void checkSitePermission();
