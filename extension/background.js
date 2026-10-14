"use strict";
// Script de fond : remplit une page avec une identité neuve + une adresse jetable,
// et sert de relais réseau aux scripts de page (qui n'ont pas accès au serveur à cause du CORS).
// Les adresses « en attente de code » sont gardées par site dans storage.local (tmPending)
// pour survivre aux changements de page entre l'inscription et la saisie du code.

const PENDING_MS = 15 * 60_000;
const DEFAULT_TTL_HOURS = 24;

// Les identités Fable se périment : passé le délai (réglages, 24 h par défaut, 0 = jamais),
// l'identité courante (nom, mot de passe…) est effacée du stockage. L'adresse jetable reste sur le serveur.
async function purgeExpired() {
  const { profile, identityTtlHours = DEFAULT_TTL_HOURS, tmPending = {} } = await browser.storage.local.get(["profile", "identityTtlHours", "tmPending"]);
  const now = Date.now();
  if (profile && !profile.createdAt) await browser.storage.local.set({ profile: { ...profile, createdAt: now } });
  else if (profile && identityTtlHours > 0 && now - profile.createdAt > identityTtlHours * 3600_000) await browser.storage.local.remove(["profile"]);
  const live = Object.fromEntries(Object.entries(tmPending).filter(([, p]) => p.until > now));
  if (Object.keys(live).length !== Object.keys(tmPending).length) await browser.storage.local.set({ tmPending: live });
}
browser.alarms.create("purge", { periodInMinutes: 30 });
browser.alarms.onAlarm.addListener(a => { if (a.name === "purge") void purgeExpired(); });
browser.runtime.onStartup.addListener(() => void purgeExpired());

async function settings() {
  await purgeExpired();
  const s = await browser.storage.local.get(["autoPrompt", "autoCode", "alwaysNew", "bitwardenMode", "selectedFields", "lockedFields", "countryMode", "profile"]);
  return {
    bitwardenMode: s.bitwardenMode === true,
    autoPrompt: s.autoPrompt !== false,
    autoCode: s.autoCode !== false,
    alwaysNew: s.alwaysNew !== false,
    selectedFields: Array.isArray(s.selectedFields) ? s.selectedFields : Object.keys(FableGenerator.fields),
    lockedFields: Array.isArray(s.lockedFields) ? s.lockedFields : [],
    countryMode: s.countryMode || "random",
    profile: s.profile || null
  };
}

async function setPending(host, alias) {
  const { tmPending = {} } = await browser.storage.local.get("tmPending");
  const now = Date.now();
  for (const [h, p] of Object.entries(tmPending)) if (p.until < now) delete tmPending[h];
  tmPending[host] = { id: alias.id, email: alias.email, since: alias.createdAt, until: now + PENDING_MS };
  await browser.storage.local.set({ tmPending });
}

async function getPending(host) {
  const { tmPending = {} } = await browser.storage.local.get("tmPending");
  const p = tmPending[host];
  return p && p.until > Date.now() ? p : null;
}

async function clearPending(host) {
  const { tmPending = {} } = await browser.storage.local.get("tmPending");
  delete tmPending[host];
  await browser.storage.local.set({ tmPending });
}

// Identité neuve (sauf champs verrouillés) + adresse jetable pour ce site, puis remplissage de l'onglet.
async function fillNewIdentity(tabId, pageUrl) {
  const s = await settings();
  const host = new URL(pageUrl).hostname;
  // Mode Bitwarden : l'e-mail et le mot de passe sont laissés à Bitwarden (qui les enregistre).
  const fields = s.bitwardenMode ? s.selectedFields.filter(k => k !== "email" && k !== "password") : s.selectedFields;
  const keepPrevious = s.profile && (!s.alwaysNew || s.profile.throwaway?.host === host || (s.bitwardenMode && s.profile.site === host));
  let profile = keepPrevious ? s.profile : FableGenerator.generate(s.countryMode, s.profile, s.lockedFields);
  if (!keepPrevious && s.lockedFields.includes("email") && s.profile?.throwaway) profile.throwaway = s.profile.throwaway;
  profile = { ...profile, site: host };
  if (!s.bitwardenMode && s.selectedFields.includes("email") && await Throwaway.enabled() && profile.throwaway?.host !== host) {
    const alias = await Throwaway.createAddress(pageUrl, profile.fullName);
    profile = { ...profile, email: alias.email, throwaway: alias };
  }
  const { revision = 0 } = await browser.storage.local.get("revision");
  await browser.storage.local.set({ profile, revision: keepPrevious ? revision : revision + 1 });
  await browser.scripting.executeScript({ target: { tabId }, files: ["filler.js"] });
  const [res] = await browser.scripting.executeScript({
    target: { tabId },
    func: (data, options) => globalThis.FableFill.fill(data, options),
    args: [profile, { overwrite: true, fields }]
  });
  if (s.bitwardenMode) return { report: res?.result || null, name: profile.fullName, bitwarden: true };
  if (profile.throwaway?.host === host && s.autoCode) await setPending(host, profile.throwaway);
  return { report: res?.result || null, email: profile.email, name: profile.fullName };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  const url = sender.tab?.url || "";
  const host = /^https?:/.test(url) ? new URL(url).hostname : "";
  switch (msg?.type) {
    case "state":
      return (async () => {
        const s = await settings();
        const { dismissedHosts = [] } = await browser.storage.local.get("dismissedHosts");
        return { autoPrompt: s.autoPrompt && !dismissedHosts.includes(host), autoCode: s.autoCode, pending: host && s.autoCode ? await getPending(host) : null };
      })();
    case "fill-new":
      return fillNewIdentity(tabId, url).catch(e => ({ error: e.status === 401 ? "Clé API Throwaway Mail invalide." : e.message }));
    case "poll-code":
      // Long polling court (20 s) : chaque message garde le script de fond éveillé.
      return (async () => {
        const p = host && await getPending(host);
        if (!p) return { done: true };
        try {
          const found = await Throwaway.waitForCode(p.id, p.since, 20);
          if (found?.code) { await clearPending(host); return { code: found.code, from: found.from }; }
          if (found?.links?.length) { await clearPending(host); return { link: found.links[0].url }; }
          return { waiting: true };
        } catch (e) { return { error: e.message }; }
      })();
    case "adopt-email":
      // Mode Bitwarden : l'adresse tapée/remplie dans la page est-elle une de nos adresses jetables ?
      return (async () => {
        const email = String(msg.email || "").trim().toLowerCase();
        if (!host || !/^[^@\s]+@[^@\s]+$/.test(email) || !await Throwaway.enabled()) return { ok: false };
        try {
          const data = await Throwaway.request(`/v1/addresses?q=${encodeURIComponent(email)}`);
          const a = (data.addresses || []).find(x => x.email.toLowerCase() === email);
          if (!a) return { ok: false };
          if ((await settings()).autoCode) await setPending(host, { id: a.id, email: a.email, createdAt: a.created_at });
          return { ok: true, email: a.email };
        } catch { return { ok: false }; }
      })();
    case "purge":
      return purgeExpired();
    case "pending-set":
      return msg.host && msg.alias ? setPending(msg.host, msg.alias) : undefined;
    case "pending-clear":
      return host ? clearPending(host) : undefined;
    case "dismiss-host":
      return (async () => {
        const { dismissedHosts = [] } = await browser.storage.local.get("dismissedHosts");
        if (host && !dismissedHosts.includes(host)) await browser.storage.local.set({ dismissedHosts: [...dismissedHosts, host].slice(-500) });
      })();
  }
  return undefined;
});

// À l'installation / mise à jour : sans accès aux sites, ouvrir les réglages pour le demander.
browser.runtime.onInstalled.addListener(async () => {
  if (!await browser.permissions.contains({ origins: ["<all_urls>"] })) browser.runtime.openOptionsPage();
});
