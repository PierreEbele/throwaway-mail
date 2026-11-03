"use strict";
const $ = (id) => document.getElementById(id);
const fieldLabels = FableGenerator.fields;
const fieldKeys = Object.keys(fieldLabels);
let profile = null;
let revision = 0;
let countryTouched = false;
let settingsTouched = false;
let busy = false;
let selectedFields = new Set(fieldKeys);
let lockedFields = new Set();
let testCard = null;
let cardSettingsTouched = false;
function cardStatus(message, error = false) {
  $("card-status").textContent = message;
  $("card-status").dataset.tone = error ? "error" : "normal";
}
function showPanel(name) {
  for (const key of ["profile", "card"]) {
    $(key + "-panel").hidden = key !== name;
    $("tab-" + key).setAttribute("aria-pressed", String(key === name));
  }
  $("profile-actions").hidden = name !== "profile";
  document.querySelector("main").scrollTop = 0;
}
$("tab-profile").addEventListener("click", () => showPanel("profile"));
$("tab-card").addEventListener("click", () => showPanel("card"));
for (const [key, name] of Object.entries(FableGenerator.banks)) $("card-bank").add(new Option(name + " (simulated)", key));
function syncCardSettings() {
  const bankMode = $("card-mode").value === "bank-bin";
  $("card-network").querySelector('[value="visa"]').textContent = bankMode ? "Visa" : "CB / Visa";
  $("card-network").querySelector('[value="mastercard"]').textContent = bankMode ? "Mastercard" : "CB / Mastercard";
  for (const option of $("card-network").options)
    option.disabled =
      bankMode &&
      option.value !== "random" &&
      !FableGenerator.bankBins.some(
        (entry) => ($("card-bank").value === "random" || entry.bankCode === $("card-bank").value) && entry.networkCode === option.value,
      );
  if ($("card-network").selectedOptions[0]?.disabled) $("card-network").value = "random";
}
for (const id of ["card-mode", "card-bank", "card-network"])
  $(id).addEventListener("change", async () => {
    cardSettingsTouched = true;
    syncCardSettings();
    cardStatus("Applies to the next test card.");
    try {
      await browser.storage.local.set({
        cardMode: $("card-mode").value,
        cardBankMode: $("card-bank").value,
        cardNetworkMode: $("card-network").value,
      });
    } catch {
      cardStatus("Applied, but saving it locally failed.", true);
    }
  });
function renderCard() {
  const bankMode = testCard.mode === "bank-bin";
  $("card-mode-heading").textContent = bankMode ? "FRANCE · SYNTHETIC NUMBER" : "FRANCE · STRIPE SANDBOX";
  $("card-explanation").textContent = bankMode
    ? "BIN attributed to the bank by BinCheck.org; the other digits are generated with a Luhn check digit. No card is issued and no account is created. Mock-up number, not certified by the bank and not provided by Stripe for its sandbox."
    : "Official Stripe test numbers, fixed per network. The bank is a simulated label: these cards are not issued by the banks shown and cannot make any real payment.";
  $("card-bin-info").hidden = !bankMode;
  $("card-bin-info").replaceChildren();
  if (bankMode) {
    const source = document.createElement("a");
    source.href = testCard.binSource;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.textContent = "BinCheck source";
    $("card-bin-info").append(`BIN ${testCard.bin} · ${testCard.binIssuer}. Checked on ${testCard.binChecked || "2026-10-20"}. `, source);
  }
  $("card-bank-name").textContent = testCard.bank + " · simulated";
  $("card-network-name").textContent = testCard.network + " · France";
  $("card-number").textContent = testCard.number.match(/.{4}/g).join(" ");
  $("card-holder").textContent = testCard.holder;
  $("card-expiry").textContent = testCard.expiry;
  $("card-cvc").textContent = testCard.cvc;
  syncControls();
}
$("generate-card").addEventListener("click", async () => {
  if (busy) return;
  const generated = FableGenerator.generateCard($("card-bank").value, $("card-network").value, profile?.fullName, $("card-mode").value);
  if (!generated) {
    cardStatus("No known BIN for this bank/network combination. Pick another network.", true);
    return;
  }
  testCard = generated;
  renderCard();
  cardStatus(
    testCard.mode === "bank-bin"
      ? "Synthetic number ready, with the listed bank BIN. For form mock-ups only."
      : "Test card ready. The official number is fixed per network.",
  );
  try {
    await browser.storage.local.set({ testCard });
  } catch {
    cardStatus("Card ready, but saving it locally failed.", true);
  }
});
for (const id of ["copy-card", "copy-card-number"])
  $(id).addEventListener("click", async () => {
    if (!testCard) return;
    const text =
      id === "copy-card-number"
        ? testCard.number
        : [
            testCard.mode === "bank-bin" ? "SYNTHETIC CARD — MOCK-UP, NOT A STRIPE SANDBOX CARD" : "TEST CARD — STRIPE SANDBOX",
            `Simulated bank: ${testCard.bank} (not actually issued)`,
            ...(testCard.mode === "bank-bin"
              ? [`Listed BIN: ${testCard.bin}`, `Issuer per BinCheck: ${testCard.binIssuer}`, `Source: ${testCard.binSource}`]
              : []),
            `Network: ${testCard.network}`,
            "Country: France",
            `Number: ${testCard.number}`,
            `Fake holder: ${testCard.holder}`,
            `Expiry: ${testCard.expiry}`,
            `Test CVC: ${testCard.cvc}`,
          ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      cardStatus(id === "copy-card-number" ? "Test number copied." : "Test card copied.");
    } catch {
      cardStatus("Copy unavailable. You can copy the displayed values by hand.", true);
    }
  });
function status(message, error = false) {
  $("status").textContent = message;
  $("status").dataset.tone = error ? "error" : "normal";
}
function syncControls() {
  for (const id of ["generate-card", "card-mode", "card-bank", "card-network", "card-overwrite", "undo-card"]) $(id).disabled = busy;
  for (const id of ["fill-card", "copy-card", "copy-card-number"]) $(id).disabled = busy || !testCard;
  $("fill").disabled = busy || selectedFields.size === 0;
  $("generate").disabled = busy;
  $("copy").disabled = busy || !profile;
  $("reveal-password").disabled = busy || !profile;
  $("undo").disabled = busy;
  $("overwrite").disabled = busy;
  const countryLocked = !!profile && FableGenerator.isCountryLocked([...lockedFields]);
  $("country-mode").disabled = busy || countryLocked;
  $("country-hint").hidden = !countryLocked;
  $("country-hint").textContent = countryLocked ? `Country kept: ${profile.country} (location details locked).` : "";
  $("options-count").textContent = `${selectedFields.size}/${fieldKeys.length} fields · ${lockedFields.size} locked`;
  for (const key of fieldKeys) {
    const include = $("include-" + key),
      lock = $("lock-" + key);
    include.checked = selectedFields.has(key);
    include.disabled = busy;
    lock.disabled = busy || !profile;
    lock.setAttribute("aria-pressed", String(lockedFields.has(key)));
    lock.setAttribute("aria-label", `${lockedFields.has(key) ? "Unlock" : "Lock"}: ${fieldLabels[key]}`);
    lock.textContent = lockedFields.has(key) ? "Locked" : "Free";
    lock.title = lockedFields.has(key) ? "Value kept when generating" : "Keep this value when generating";
  }
}
async function saveSettings() {
  try {
    await browser.storage.local.set({ selectedFields: [...selectedFields], lockedFields: [...lockedFields], settingsVersion: 3 });
  } catch {
    status("Settings applied, but saving them locally failed.", true);
  }
}
for (const [key, label] of Object.entries(fieldLabels)) {
  const row = document.createElement("div");
  row.className = "option-row";
  const name = document.createElement("label");
  name.htmlFor = "include-" + key;
  name.textContent = label;
  const include = document.createElement("input");
  include.type = "checkbox";
  include.id = "include-" + key;
  include.setAttribute("aria-label", "Fill: " + label);
  include.addEventListener("change", () => {
    settingsTouched = true;
    if (include.checked) selectedFields.add(key);
    else selectedFields.delete(key);
    syncControls();
    status(selectedFields.size ? `${selectedFields.size} field(s) selected for filling.` : "Tick at least one field to fill.");
    void saveSettings();
  });
  const lock = document.createElement("button");
  lock.type = "button";
  lock.id = "lock-" + key;
  lock.className = "lock-button";
  lock.addEventListener("click", () => {
    if (!profile) return;
    settingsTouched = true;
    if (lockedFields.has(key)) lockedFields.delete(key);
    else lockedFields.add(key);
    syncControls();
    status(`${lockedFields.has(key) ? "Locked" : "Unlocked"}: “${label}”.`);
    void saveSettings();
  });
  row.append(name, include, lock);
  $("field-options").append(row);
}
function render() {
  for (const [id, key] of Object.entries({
    "full-name": "fullName",
    "first-name": "firstName",
    "last-name": "lastName",
    address: "address",
    city: "city",
    "postal-code": "postalCode",
    country: "country",
    email: "email",
    phone: "phone",
  }))
    $(id).textContent = profile[key];
  $("avatar").textContent = profile.firstName[0] + profile.lastName[0];
  $("edition").textContent = `Identity #${revision} · ${profile.country}`;
  $("password").value = profile.password;
  $("birth-date").textContent = profile.birthDate.split("-").reverse().join("/");
  $("password").type = "password";
  $("reveal-password").textContent = "Show";
  $("reveal-password").setAttribute("aria-pressed", "false");
  syncControls();
}
$("reveal-password").addEventListener("click", () => {
  const show = $("password").type === "password";
  $("password").type = show ? "text" : "password";
  $("reveal-password").textContent = show ? "Hide" : "Show";
  $("reveal-password").setAttribute("aria-pressed", String(show));
});
$("country-mode").addEventListener("change", async () => {
  countryTouched = true;
  const countryMode = $("country-mode").value;
  status("Country set for the next profile. Click New identity.");
  try {
    await browser.storage.local.set({ countryMode });
  } catch {
    status("Applied, but saving it locally failed.", true);
  }
});
$("generate").addEventListener("click", async () => {
  if (profile && lockedFields.size === fieldKeys.length) {
    status("Every field is locked. Set at least one value to Free to regenerate it.");
    return;
  }
  // The disposable address follows the e-mail: kept only if the e-mail is locked.
  const keptAlias = lockedFields.has("email") ? profile?.throwaway : undefined;
  profile = FableGenerator.generate($("country-mode").value, profile, [...lockedFields]);
  revision++;
  if (keptAlias) profile.throwaway = keptAlias;
  tmCode = null;
  void tmRender();
  render();
  status(lockedFields.size ? "Profile regenerated. Locked values were kept." : "New profile ready. The page was not changed.");
  try {
    await browser.storage.local.set({ profile, revision });
  } catch {
    status("Profile ready, but saving it locally failed.", true);
  }
});
$("copy").addEventListener("click", async () => {
  if (!profile) return;
  const text = Object.entries(fieldLabels)
    .map(([key, label]) => `${label}: ${key === "birthDate" ? profile[key].split("-").reverse().join("/") : profile[key]}`)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    status("Profile copied to the clipboard.");
  } catch {
    status("Copy unavailable. You can select the displayed values and copy them by hand.", true);
  }
});
async function activeTabId() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("NO_TAB");
  return tab.id;
}
$("fill").addEventListener("click", async () => {
  if (!selectedFields.size || busy) return;
  busy = true;
  syncControls();
  status("Looking for form fields…");
  try {
    if (!(await ensureIdentity())) return;
    const { bitwardenMode } = await browser.storage.local.get("bitwardenMode");
    if (!bitwardenMode && !(await ensureAlias())) return;
    const tabId = await activeTabId();
    await browser.scripting.executeScript({ target: { tabId }, files: ["filler.js"] });
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: (data, options) => globalThis.FableFill.fill(data, options),
      args: [
        profile,
        {
          overwrite: $("overwrite").checked,
          fields: [...selectedFields].filter((k) => !bitwardenMode || (k !== "email" && k !== "password")),
        },
      ],
    });
    const report = results[0]?.result;
    if (!report) throw new Error("NO_RESULT");
    // Bitwarden mode: the page waits for the e-mail filled by Bitwarden, then the code.
    if (bitwardenMode) await browser.tabs.sendMessage(tabId, { type: "watch-email" }).catch(() => {});
    if (report.filled && profile.throwaway) void handOffCode(tabId);
    const passwordNote =
      (report.passwordIssue === "preserved"
        ? " Passwords kept together to avoid a mismatched confirmation."
        : report.passwordIssue === "constraints"
          ? " Password does not meet the site’s rules: neither field was changed."
          : report.passwordIssue === "registration"
            ? " Password skipped: not recognised as a sign-up."
            : "") +
      (report.birthIssue === "preserved"
        ? " Existing birth date kept as a whole."
        : report.birthIssue === "constraints"
          ? " Birth date does not meet the site’s rules: its fields were kept."
          : "");
    if (report.filled) {
      status(
        `${report.filled} field${report.filled > 1 ? "s" : ""} filled.${report.preserved ? ` ${report.preserved} already filled, kept.` : ""}${report.rejected ? ` ${report.rejected} value(s) rejected.` : ""}${passwordNote} Nothing was submitted.`,
      );
    } else if (report.passwordIssue || report.birthIssue)
      status(
        passwordNote.trim(),
        report.passwordIssue === "constraints" || report.birthIssue === "constraints" || report.passwordIssue === "registration",
      );
    else if (report.preserved) status("The detected fields are already filled. Tick Overwrite existing to change them.");
    else if (report.unchanged) status("The selected fields already hold the profile values.");
    else if (report.rejected) status("Fields found, but their rules rejected the values. No field changed.", true);
    else if (report.blockedAuthentication)
      status("This looks like a sign-in or account verification form. Throwaway Mail skips those forms and their passwords.", true);
    else if (report.selectionMismatch)
      status("Some fields were recognised but are unticked in Fields to fill. Tick the ones to fill.", true);
    else status("No field matches your selection. Some embedded forms and custom components cannot be reached.", true);
  } catch {
    status(
      "Cannot access this page. Open a regular web page and try again. Firefox protects its internal pages, its add-on store and some PDFs.",
      true,
    );
  } finally {
    busy = false;
    syncControls();
  }
});
$("fill-card").addEventListener("click", async () => {
  if (!testCard || busy) return;
  busy = true;
  syncControls();
  cardStatus("Looking for card fields…");
  try {
    const tabId = await activeTabId();
    await browser.scripting.executeScript({ target: { tabId }, files: ["filler.js"] });
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: (card, options) => globalThis.FableFill.fillCard(card, options),
      args: [testCard, { overwrite: $("card-overwrite").checked }],
    });
    const report = results[0]?.result;
    if (!report) throw new Error("NO_RESULT");
    if (report.invalidCard) cardStatus("Invalid or expired test card. Generate a new one.", true);
    else if (report.readOnlyGroup) cardStatus("A card field is read-only and holds another value. No field changed.", true);
    else if (report.preservedGroup) cardStatus("Existing values kept as a whole. Tick Overwrite existing to insert the test card.");
    else if (report.incompatible) cardStatus("A field’s rules reject this test card. No field changed.", true);
    else if (report.filled)
      cardStatus(
        `${report.filled} card field(s) filled.${report.missing?.length ? ` Not found: ${report.missing.join(", ")}.` : ""}${report.rejected ? ` ${report.rejected} value(s) rejected by the site.` : ""} Nothing was clicked or submitted.`,
      );
    else if (report.unchanged) cardStatus("The detected fields already hold this test card.");
    else cardStatus("No card form recognised. Iframes from another domain and some custom fields cannot be reached.", true);
  } catch {
    cardStatus("Cannot access this page. Open your test form and try again.", true);
  } finally {
    busy = false;
    syncControls();
  }
});
async function undoFill(cardMode = false) {
  if (busy) return;
  const notify = cardMode ? cardStatus : status;
  busy = true;
  syncControls();
  notify("Undoing the last fill…");
  try {
    const tabId = await activeTabId();
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.FableFill?.undo?.() || { available: false, restored: 0, skipped: 0, failed: 0 },
    });
    const report = results[0]?.result;
    if (!report?.available) notify("Nothing to undo on this page.");
    else
      notify(
        `${report.restored} field(s) restored.${report.skipped ? ` ${report.skipped} field(s) edited since or unreachable, kept.` : ""}${report.failed ? ` ${report.failed} restore(s) rejected by the site.` : ""}`,
        !!report.failed,
      );
  } catch {
    notify("Cannot undo on this page. The fill must belong to the active tab.", true);
  } finally {
    busy = false;
    syncControls();
  }
}
$("undo").addEventListener("click", () => undoFill(false));
$("undo-card").addEventListener("click", () => undoFill(true));
// ---------------------------------------------------------------------------
// Throwaway Mail: a real disposable address per site + retrieval of the received code.
// ---------------------------------------------------------------------------
let tmCode = null;
let tmWaiting = false;
function tmStatus(message, error = false) {
  $("tm-status").textContent = message;
  $("tm-status").dataset.tone = error ? "error" : "normal";
}
async function tmRender() {
  const on = await Throwaway.enabled().catch(() => false);
  $("tm-badge").replaceChildren(document.createElement("i"), on ? " THROWAWAY" : " LOCAL");
  $("tm-badge").classList.toggle("on", on);
  $("tm-badge").title = on ? "Real e-mail addresses via Throwaway Mail" : "@example.com addresses, nothing leaves the browser";
  const alias = profile?.throwaway;
  $("tm-email-note").hidden = !on;
  $("tm-email-note").textContent = alias ? "DISPOSABLE" : "DISPOSABLE ON FILL";
  $("tm-panel").hidden = !(on && alias);
  if (alias) $("tm-address").textContent = alias.email;
  $("tm-code").textContent = tmCode?.code || "—";
  $("tm-copy").disabled = $("tm-paste").disabled = !tmCode?.code;
  $("tm-wait").disabled = tmWaiting || !alias;
  $("tm-wait").textContent = tmWaiting ? "Waiting…" : tmCode ? "Next code" : "Wait for code";
  $("tm-link").hidden = !(tmCode && !tmCode.code && tmCode.links?.length);
  $("tm-link").replaceChildren();
  if (tmCode && !tmCode.code && tmCode.links?.length) {
    const a = document.createElement("a");
    a.href = tmCode.links[0].url || tmCode.links[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Open the confirmation link";
    $("tm-link").append(a);
  }
}
async function activeTabUrl() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.url || "";
}
// Before filling: create (or reuse) the disposable address for the open site.
// Returns false if the fill must be aborted.
async function ensureAlias() {
  if (!selectedFields.has("email") || !(await Throwaway.enabled())) return true;
  const url = await activeTabUrl();
  if (!/^https?:/.test(url)) {
    status("Open a website’s form and try again.", true);
    return false;
  }
  const host = new URL(url).hostname;
  if (profile.throwaway?.host === host) return true;
  status(`Creating a disposable address for ${host}…`);
  try {
    const alias = await Throwaway.createAddress(url, profile.fullName);
    profile = { ...profile, email: alias.email, throwaway: alias };
    tmCode = null;
    render();
    void tmRender();
    await browser.storage.local.set({ profile });
    return true;
  } catch (e) {
    status(
      e.status === 401
        ? "Invalid Throwaway Mail API key. Check the settings."
        : `Could not create a disposable address: ${e.message}. Nothing was filled.`,
      true,
    );
    return false;
  }
}
// New identity for every new site ("alwaysNew" setting, on by default).
async function ensureIdentity() {
  const { alwaysNew } = await browser.storage.local.get("alwaysNew");
  const url = await activeTabUrl();
  const host = /^https?:/.test(url) ? new URL(url).hostname : "";
  const sameSite = profile?.throwaway?.host === host;
  if (profile && (alwaysNew === false || sameSite)) return true;
  if (profile && lockedFields.size === fieldKeys.length) return true;
  const keptAlias = lockedFields.has("email") ? profile?.throwaway : undefined;
  profile = FableGenerator.generate($("country-mode").value, profile, [...lockedFields]);
  revision++;
  if (keptAlias) profile.throwaway = keptAlias;
  tmCode = null;
  render();
  void tmRender();
  await browser.storage.local.set({ profile, revision });
  return true;
}
// After a fill: the content script waits for the code and pastes it by itself,
// even if the popup closes or the site moves to another page.
async function handOffCode(tabId) {
  const { autoCode } = await browser.storage.local.get("autoCode");
  if (autoCode === false || !profile?.throwaway) return;
  await browser.runtime.sendMessage({ type: "pending-set", host: profile.throwaway.host, alias: profile.throwaway }).catch(() => {});
  await browser.tabs.sendMessage(tabId, { type: "watch-code" }).catch(() => {});
  tmStatus("The code will be pasted into the page as soon as it arrives.");
}
async function tmPoll(wait) {
  const alias = profile?.throwaway;
  if (!alias) return;
  const since = tmCode?.message_id || alias.createdAt;
  tmWaiting = wait > 0;
  void tmRender();
  if (wait) tmStatus("Waiting for an e-mail (up to 2 min). Keep this window open.");
  try {
    let found = null;
    for (let i = 0; i < (wait ? 2 : 1) && !found; i++) found = await Throwaway.waitForCode(alias.id, since, wait);
    if (found) {
      tmCode = found;
      if (found.code && wait) setTimeout(() => $("tm-paste").click(), 0);
      tmStatus(
        found.code
          ? `From ${found.from || "?"}${found.subject ? ` · “${found.subject}”` : ""}.`
          : "E-mail received without a code: confirmation link available.",
      );
    } else if (wait) tmStatus("Nothing yet. Try again after asking the site to send the code.");
  } catch (e) {
    tmStatus(`Throwaway Mail unreachable: ${e.message}`, true);
  } finally {
    tmWaiting = false;
    void tmRender();
  }
}
$("tm-wait").addEventListener("click", () => tmPoll(55));
$("tm-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(tmCode.code);
    tmStatus("Code copied.");
  } catch {
    tmStatus("Copy unavailable.", true);
  }
});
$("tm-paste").addEventListener("click", async () => {
  try {
    const tabId = await activeTabId();
    const [res] = await browser.scripting.executeScript({ target: { tabId }, func: fillCodeInPage, args: [tmCode.code] });
    tmStatus(
      res?.result ? `Code pasted (${res.result} field${res.result > 1 ? "s" : ""}). Nothing submitted.` : "No code field found: use Copy.",
      !res?.result,
    );
  } catch {
    tmStatus("Cannot access this page. Use Copy.", true);
  }
});
// Runs in the page: one-time-code field, focused field or one-digit boxes.
function fillCodeInPage(code) {
  const set = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const visible = (el) =>
    !el.disabled &&
    !el.readOnly &&
    el.offsetParent !== null &&
    !["hidden", "password", "email", "checkbox", "radio", "submit", "button"].includes(el.type);
  const inputs = [...document.querySelectorAll("input")].filter(visible);
  const boxes = inputs.filter((el) => el.maxLength === 1);
  if (boxes.length >= code.length && code.length > 1) {
    const start = Math.max(0, boxes.indexOf(document.activeElement));
    code.split("").forEach((ch, i) => boxes[start + i] && set(boxes[start + i], ch));
    return code.length;
  }
  const hint = /code|otp|token|verif|pin|2fa|mfa|one.?time/i;
  const target =
    inputs.find((el) => el.autocomplete === "one-time-code") ||
    (inputs.includes(document.activeElement) ? document.activeElement : null) ||
    inputs.find((el) => hint.test(`${el.name} ${el.id} ${el.placeholder} ${el.getAttribute("aria-label") || ""}`));
  if (!target) return 0;
  set(target, code);
  target.focus();
  return 1;
}
$("tm-settings").addEventListener("click", (event) => {
  event.preventDefault();
  void browser.runtime.openOptionsPage();
  window.close();
});

syncControls();
(async () => {
  try {
    await browser.runtime.sendMessage({ type: "purge" }).catch(() => {});
    const saved = await browser.storage.local.get([
      "profile",
      "revision",
      "countryMode",
      "selectedFields",
      "lockedFields",
      "settingsVersion",
      "testCard",
      "cardMode",
      "cardBankMode",
      "cardNetworkMode",
    ]);
    if (!cardSettingsTouched) {
      if (saved.cardBankMode === "random" || Object.hasOwn(FableGenerator.banks, saved.cardBankMode))
        $("card-bank").value = saved.cardBankMode;
      if (saved.cardNetworkMode === "random" || Object.hasOwn(FableGenerator.cardNetworks, saved.cardNetworkMode))
        $("card-network").value = saved.cardNetworkMode;
      if (["stripe", "bank-bin"].includes(saved.cardMode)) $("card-mode").value = saved.cardMode;
      syncCardSettings();
    }
    if (!testCard && FableGenerator.isTestCard(saved.testCard)) {
      testCard = saved.testCard;
      renderCard();
      cardStatus("Last test card restored.");
    }
    if (!countryTouched && ["random", "FR", "GB", "US"].includes(saved.countryMode)) $("country-mode").value = saved.countryMode;
    if (!settingsTouched) {
      if (Array.isArray(saved.selectedFields)) selectedFields = new Set(saved.selectedFields.filter((key) => fieldKeys.includes(key)));
      if (
        (!saved.settingsVersion || saved.settingsVersion < 2) &&
        fieldKeys.filter((key) => key !== "password" && key !== "birthDate").every((key) => selectedFields.has(key))
      )
        selectedFields.add("password");
      if (
        (!saved.settingsVersion || saved.settingsVersion < 3) &&
        fieldKeys.filter((key) => key !== "birthDate").every((key) => selectedFields.has(key))
      )
        selectedFields.add("birthDate");
      if (Array.isArray(saved.lockedFields)) lockedFields = new Set(saved.lockedFields.filter((key) => fieldKeys.includes(key)));
    }
    if (
      !profile &&
      saved.profile &&
      Array.isArray(saved.profile.countryAliases) &&
      [
        "firstName",
        "lastName",
        "fullName",
        "email",
        "phone",
        "address",
        "city",
        "postalCode",
        "country",
        "countryEnglish",
        "countryCode",
        "phoneNational",
        "phoneCountryCode",
      ].every((key) => typeof saved.profile[key] === "string")
    ) {
      profile = saved.profile;
      let upgradedProfile = false;
      if (!FableGenerator.validBirthDate(profile.birthDate)) {
        profile = { ...profile, birthDate: FableGenerator.generateBirthDate() };
        upgradedProfile = true;
      }
      if (typeof profile.password !== "string" || !profile.password) {
        profile = { ...profile, password: FableGenerator.generatePassword() };
        upgradedProfile = true;
      }
      revision = saved.revision || 1;
      render();
      status("Last profile restored. Ready to fill a form.");
      if (upgradedProfile) await browser.storage.local.set({ profile });
    }
    if (saved.settingsVersion !== 3) await saveSettings();
    syncControls();
    await tmRender();
    if (profile?.throwaway && (await Throwaway.enabled())) void tmPoll(0);
  } catch {
    status("Local storage unavailable. You can still generate a profile.", true);
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
