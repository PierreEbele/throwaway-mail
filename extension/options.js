"use strict";
const $ = (id) => document.getElementById(id);
function status(message, error = false) {
  $("status").textContent = message;
  $("status").dataset.tone = error ? "error" : "normal";
}

async function loadDomains(cfg, selected) {
  const data = await Throwaway.request("/v1/domains", { cfg });
  $("domain").replaceChildren(new Option("Server default", ""));
  for (const d of data.domains || []) $("domain").add(new Option(d.name, d.name));
  $("domain").value = selected || "";
  return data.domains?.length || 0;
}

// Reads the form and requests access to the server (requires a user gesture).
async function formConfig() {
  const server = Throwaway.normalizeServer($("server").value);
  const apiKey = $("api-key").value.trim();
  if (!apiKey) throw new Error("Paste an API key.");
  const granted = await browser.permissions.request({ origins: [server + "/*", "http://*/*", "https://*/*"] });
  if (!granted) throw new Error("Access to the server was denied.");
  return { server, apiKey, domain: $("domain").value };
}

const TOGGLES = { "auto-prompt": "autoPrompt", "auto-code": "autoCode", "always-new": "alwaysNew" };
const toggles = () => ({
  ...Object.fromEntries(Object.entries(TOGGLES).map(([id, key]) => [key, $(id).checked])),
  bitwardenMode: $("bitwarden-mode").checked,
  identityTtlHours: Number($("identity-ttl").value),
});
// Off by default / 24 h by default, unlike the other automations.
for (const id of ["bitwarden-mode", "identity-ttl"])
  $(id).addEventListener("change", async () => {
    await browser.storage.local.set(toggles());
    await browser.runtime.sendMessage({ type: "purge" }).catch(() => {});
    status("Automation settings saved.");
  });
for (const id of Object.keys(TOGGLES))
  $(id).addEventListener("change", async () => {
    await browser.storage.local.set(toggles());
    if ($("auto-prompt").checked || $("auto-code").checked)
      await browser.permissions.request({ origins: ["http://*/*", "https://*/*"] }).catch(() => {});
    status("Automation settings saved.");
  });

$("test").addEventListener("click", async () => {
  try {
    const cfg = await formConfig();
    status("Connecting…");
    const me = await Throwaway.request("/v1/auth/me", { cfg });
    const n = await loadDomains(cfg, cfg.domain);
    status(`Signed in as ${me.user?.name || me.user?.email || "?"} · ${n} domain(s) available.`);
  } catch (e) {
    status(e.status === 401 ? "Invalid or revoked API key." : `Failed: ${e.message}`, true);
  }
});

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const cfg = await formConfig();
    await Throwaway.request("/v1/auth/me", { cfg });
    await browser.storage.local.set({
      tmServer: cfg.server,
      tmApiKey: cfg.apiKey,
      tmDomain: cfg.domain,
      tmExpiresDays: Number($("expires-days").value) || 0,
      tmMaxMessages: Number($("max-messages").value) || 0,
      ...toggles(),
    });
    status("Saved. Next fills will use Throwaway Mail.");
  } catch (e) {
    status(e.status === 401 ? "Invalid or revoked API key: nothing was saved." : `Failed: ${e.message}`, true);
  }
});

$("clear").addEventListener("click", async () => {
  await browser.storage.local.remove(["tmApiKey"]);
  $("api-key").value = "";
  status("Key deleted. Back to @example.com addresses.");
});

(async () => {
  const flags = await browser.storage.local.get(Object.values(TOGGLES));
  for (const [id, key] of Object.entries(TOGGLES)) $(id).checked = flags[key] !== false;
  const extra = await browser.storage.local.get(["bitwardenMode", "identityTtlHours"]);
  $("bitwarden-mode").checked = extra.bitwardenMode === true;
  $("identity-ttl").value = String(extra.identityTtlHours ?? 24);
  const cfg = await Throwaway.config();
  $("server").value = cfg.server || "";
  $("api-key").value = cfg.apiKey;
  $("expires-days").value = String(cfg.expiresDays || 0);
  $("max-messages").value = cfg.maxMessages ? String(cfg.maxMessages) : "";
  if (cfg.server && cfg.apiKey) {
    try {
      await loadDomains(cfg, cfg.domain);
      status("Throwaway Mail is active.");
    } catch {
      status("Server unreachable or invalid key.", true);
    }
  }
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
