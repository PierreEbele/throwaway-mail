"use strict";
// Background script: fills a page with a fresh identity + a disposable address,
// and relays network requests for content scripts (which cannot reach the server because of CORS).
// Addresses "waiting for a code" are kept per site in storage.local (tmPending)
// to survive page changes between sign-up and code entry.

const PENDING_MS = 15 * 60_000;
const DEFAULT_TTL_HOURS = 24;

// Fake identities expire: after the delay (settings, 24 h by default, 0 = never),
// the current identity (name, password…) is deleted from storage. The disposable address stays on the server.
async function purgeExpired() {
  const {
    profile,
    identityTtlHours = DEFAULT_TTL_HOURS,
    tmPending = {},
  } = await browser.storage.local.get(["profile", "identityTtlHours", "tmPending"]);
  const now = Date.now();
  if (profile && !profile.createdAt) await browser.storage.local.set({ profile: { ...profile, createdAt: now } });
  else if (profile && identityTtlHours > 0 && now - profile.createdAt > identityTtlHours * 3600_000)
    await browser.storage.local.remove(["profile"]);
  const live = Object.fromEntries(Object.entries(tmPending).filter(([, p]) => p.until > now));
  if (Object.keys(live).length !== Object.keys(tmPending).length) await browser.storage.local.set({ tmPending: live });
}
browser.alarms.create("purge", { periodInMinutes: 30 });
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === "purge") void purgeExpired();
});
browser.runtime.onStartup.addListener(() => void purgeExpired());

async function settings() {
  await purgeExpired();
  const s = await browser.storage.local.get([
    "autoPrompt",
    "autoCode",
    "alwaysNew",
    "bitwardenMode",
    "selectedFields",
    "lockedFields",
    "countryMode",
    "profile",
  ]);
  return {
    bitwardenMode: s.bitwardenMode === true,
    autoPrompt: s.autoPrompt !== false,
    autoCode: s.autoCode !== false,
    alwaysNew: s.alwaysNew !== false,
    selectedFields: Array.isArray(s.selectedFields) ? s.selectedFields : Object.keys(FableGenerator.fields),
    lockedFields: Array.isArray(s.lockedFields) ? s.lockedFields : [],
    countryMode: s.countryMode || "random",
    profile: s.profile || null,
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

// Fresh identity (except locked fields) + disposable address for this site, then fill the tab.
async function fillNewIdentity(tabId, pageUrl) {
  const s = await settings();
  const host = new URL(pageUrl).hostname;
  // Bitwarden mode: e-mail and password are left to Bitwarden (which saves them).
  const fields = s.bitwardenMode ? s.selectedFields.filter((k) => k !== "email" && k !== "password") : s.selectedFields;
  const keepPrevious = s.profile && (!s.alwaysNew || s.profile.throwaway?.host === host || (s.bitwardenMode && s.profile.site === host));
  let profile = keepPrevious ? s.profile : FableGenerator.generate(s.countryMode, s.profile, s.lockedFields);
  if (!keepPrevious && s.lockedFields.includes("email") && s.profile?.throwaway) profile.throwaway = s.profile.throwaway;
  profile = { ...profile, site: host };
  if (!s.bitwardenMode && s.selectedFields.includes("email") && (await Throwaway.enabled()) && profile.throwaway?.host !== host) {
    const alias = await Throwaway.createAddress(pageUrl, profile.fullName);
    profile = { ...profile, email: alias.email, throwaway: alias };
  }
  const { revision = 0 } = await browser.storage.local.get("revision");
  await browser.storage.local.set({ profile, revision: keepPrevious ? revision : revision + 1 });
  await browser.scripting.executeScript({ target: { tabId }, files: ["filler.js"] });
  const [res] = await browser.scripting.executeScript({
    target: { tabId },
    func: (data, options) => globalThis.FableFill.fill(data, options),
    args: [profile, { overwrite: true, fields }],
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
        return {
          autoPrompt: s.autoPrompt && !dismissedHosts.includes(host),
          autoCode: s.autoCode,
          pending: host && s.autoCode ? await getPending(host) : null,
        };
      })();
    case "fill-new":
      return fillNewIdentity(tabId, url).catch((e) => ({ error: e.status === 401 ? "Invalid Throwaway Mail API key." : e.message }));
    case "poll-code":
      // Short long polling (20 s): each message keeps the background script awake.
      return (async () => {
        const p = host && (await getPending(host));
        if (!p) return { done: true };
        try {
          const found = await Throwaway.waitForCode(p.id, p.since, 20);
          if (found?.code) {
            await clearPending(host);
            return { code: found.code, from: found.from };
          }
          if (found?.links?.length) {
            await clearPending(host);
            return { link: found.links[0].url };
          }
          return { waiting: true };
        } catch (e) {
          return { error: e.message };
        }
      })();
    case "adopt-email":
      // Bitwarden mode: is the address typed/filled in the page one of our disposable addresses?
      return (async () => {
        const email = String(msg.email || "")
          .trim()
          .toLowerCase();
        if (!host || !/^[^@\s]+@[^@\s]+$/.test(email) || !(await Throwaway.enabled())) return { ok: false };
        try {
          const data = await Throwaway.request(`/v1/addresses?q=${encodeURIComponent(email)}`);
          const a = (data.addresses || []).find((x) => x.email.toLowerCase() === email);
          if (!a) return { ok: false };
          if ((await settings()).autoCode) await setPending(host, { id: a.id, email: a.email, createdAt: a.created_at });
          return { ok: true, email: a.email };
        } catch {
          return { ok: false };
        }
      })();
    case "site-code":
      // Code field detected with no wait in progress: latest code (< 15 min) of this site's address.
      return (async () => {
        if (!host || !(await Throwaway.enabled()) || !(await settings()).autoCode) return { done: true };
        try {
          const a = await addressForHost(host, url, false);
          if (!a) return { done: true };
          const q = new URLSearchParams({
            wait: String(Math.min(Math.max(Number(msg.wait) || 0, 0), 20)),
            require: "code",
            since: String(Date.now() - PENDING_MS),
          });
          const found = await Throwaway.request(`/v1/addresses/${encodeURIComponent(a.id)}/code?${q}`);
          return found?.code ? { code: found.code, from: found.from } : { waiting: true };
        } catch (e) {
          return { error: e.message };
        }
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
        if (host && !dismissedHosts.includes(host))
          await browser.storage.local.set({ dismissedHosts: [...dismissedHosts, host].slice(-500) });
      })();
  }
  return undefined;
});

// This site's disposable address: the current identity's, the one waiting for a code, otherwise the
// server's (site_name = host); if `create`, a new one is created as a last resort.
async function addressForHost(host, pageUrl, create) {
  const { profile } = await browser.storage.local.get("profile");
  if (profile?.throwaway?.host === host) return profile.throwaway;
  const p = await getPending(host);
  if (p) return { id: p.id, email: p.email, host, createdAt: p.since };
  const a = await Throwaway.siteAddress(host);
  if (a) return { id: a.id, email: a.email, host, createdAt: a.created_at, unread: a.unread_count || 0, leak: a.leak || null };
  return create ? Throwaway.createAddress(pageUrl, profile?.fullName) : null;
}

// ---------- Context menu for editable fields ----------
browser.menus.create(
  { id: "tm-insert", title: "Generate a Throwaway address here", contexts: ["editable"] },
  () => void browser.runtime.lastError,
);
browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "tm-insert" || !tab?.id || !/^https?:/.test(tab.url || "")) return;
  const host = new URL(tab.url).hostname;
  let email;
  try {
    if (!(await Throwaway.enabled())) throw new Error("Throwaway Mail is not configured (see the extension settings).");
    const a = await addressForHost(host, tab.url, true);
    email = a.email;
    if ((await settings()).autoCode) await setPending(host, a);
  } catch (e) {
    email = null;
    await browser.scripting
      .executeScript({
        target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
        func: (m) => alert(m),
        args: [e.status === 401 ? "Invalid Throwaway Mail API key." : e.message],
      })
      .catch(() => {});
    return;
  }
  await browser.scripting
    .executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
      args: [email],
      func: (value) => {
        const el = document.activeElement;
        if (!el) return;
        if (el.isContentEditable) {
          document.execCommand("insertText", false, value);
          return;
        }
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
    })
    .catch(() => {});
  void updateBadge(tab.id);
});

// ---------- Badge: unread count (or "!" on leak) of the active site's address ----------
async function updateBadge(tabId) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  let text = "",
    color = "#18181b";
  try {
    if (tab && /^https?:/.test(tab.url || "") && (await Throwaway.enabled())) {
      const a = await Throwaway.siteAddress(new URL(tab.url).hostname);
      if (a?.leak) {
        text = "!";
        color = "#dc2626";
      } else if (a?.unread_count) text = a.unread_count > 99 ? "99+" : String(a.unread_count);
    }
  } catch {
    /* server unreachable: empty badge */
  }
  await browser.action.setBadgeText({ tabId, text }).catch(() => {});
  if (text) await browser.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}
async function updateActiveBadge() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (tab?.id) await updateBadge(tab.id);
}
browser.tabs.onActivated.addListener(({ tabId }) => void updateBadge(tabId));
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (tab.active && (change.status === "complete" || change.url)) void updateBadge(tabId);
});
browser.alarms.create("badge", { periodInMinutes: 2 });
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === "badge") void updateActiveBadge();
});

// On install / update: without site access, open the settings to ask for it.
browser.runtime.onInstalled.addListener(async () => {
  if (!(await browser.permissions.contains({ origins: ["http://*/*", "https://*/*"] }))) browser.runtime.openOptionsPage();
});
