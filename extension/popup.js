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
for (const [key, name] of Object.entries(FableGenerator.banks)) $("card-bank").add(new Option(name + " (simulation)", key));
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
    cardStatus("Choix appliqué à la prochaine carte de test.");
    try {
      await browser.storage.local.set({
        cardMode: $("card-mode").value,
        cardBankMode: $("card-bank").value,
        cardNetworkMode: $("card-network").value,
      });
    } catch {
      cardStatus("Choix appliqué ; sa sauvegarde locale a échoué.", true);
    }
  });
function renderCard() {
  const bankMode = testCard.mode === "bank-bin";
  $("card-mode-heading").textContent = bankMode ? "FRANCE · NUMÉRO SYNTHÉTIQUE" : "FRANCE · SANDBOX STRIPE";
  $("card-explanation").textContent = bankMode
    ? "BIN attribué à la banque par BinCheck.org ; les autres chiffres sont générés avec une clé Luhn. Aucune carte n’est émise ni aucun compte créé. Numéro de maquette, non certifié par la banque et non fourni par Stripe pour son sandbox."
    : "Numéros officiels de test Stripe, fixes selon le réseau. Le choix de banque est un libellé simulé : ces cartes ne sont pas émises par les banques indiquées et ne permettent aucun paiement réel.";
  $("card-bin-info").hidden = !bankMode;
  $("card-bin-info").replaceChildren();
  if (bankMode) {
    const source = document.createElement("a");
    source.href = testCard.binSource;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.textContent = "Source BinCheck";
    $("card-bin-info").append(`BIN ${testCard.bin} · ${testCard.binIssuer}. Relevé le ${testCard.binChecked || "2026-10-20"}. `, source);
  }
  $("card-bank-name").textContent = testCard.bank + " · simulée";
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
    cardStatus("Aucun BIN référencé pour cette combinaison banque/réseau. Choisissez un autre réseau.", true);
    return;
  }
  testCard = generated;
  renderCard();
  cardStatus(
    testCard.mode === "bank-bin"
      ? "Numéro synthétique prêt, avec le BIN bancaire référencé. Réservé aux maquettes de formulaires."
      : "Carte de test prête. Le numéro officiel reste fixe selon le réseau.",
  );
  try {
    await browser.storage.local.set({ testCard });
  } catch {
    cardStatus("Carte prête ; sa sauvegarde locale a échoué.", true);
  }
});
for (const id of ["copy-card", "copy-card-number"])
  $(id).addEventListener("click", async () => {
    if (!testCard) return;
    const text =
      id === "copy-card-number"
        ? testCard.number
        : [
            testCard.mode === "bank-bin" ? "CARTE SYNTHÉTIQUE — MAQUETTE, HORS SANDBOX STRIPE" : "CARTE DE TEST — SANDBOX STRIPE",
            `Banque simulée : ${testCard.bank} (aucune émission réelle)`,
            ...(testCard.mode === "bank-bin"
              ? [`BIN référencé : ${testCard.bin}`, `Émetteur selon BinCheck : ${testCard.binIssuer}`, `Source : ${testCard.binSource}`]
              : []),
            `Réseau : ${testCard.network}`,
            "Pays : France",
            `Numéro : ${testCard.number}`,
            `Titulaire fictif : ${testCard.holder}`,
            `Expiration : ${testCard.expiry}`,
            `CVC de test : ${testCard.cvc}`,
          ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      cardStatus(id === "copy-card-number" ? "Numéro de test copié." : "Carte de test copiée.");
    } catch {
      cardStatus("Copie indisponible. Vous pouvez copier les valeurs affichées manuellement.", true);
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
  $("country-hint").textContent = countryLocked ? `Pays conservé : ${profile.country} (coordonnées verrouillées).` : "";
  $("options-count").textContent =
    `${selectedFields.size}/${fieldKeys.length} champs · ${lockedFields.size} verrou${lockedFields.size > 1 ? "s" : ""}`;
  for (const key of fieldKeys) {
    const include = $("include-" + key),
      lock = $("lock-" + key);
    include.checked = selectedFields.has(key);
    include.disabled = busy;
    lock.disabled = busy || !profile;
    lock.setAttribute("aria-pressed", String(lockedFields.has(key)));
    lock.setAttribute("aria-label", `${lockedFields.has(key) ? "Déverrouiller" : "Verrouiller"} : ${fieldLabels[key]}`);
    lock.textContent = lockedFields.has(key) ? "Fixé" : "Libre";
    lock.title = lockedFields.has(key) ? "Valeur conservée lors de Générer" : "Verrouiller cette valeur lors de Générer";
  }
}
async function saveSettings() {
  try {
    await browser.storage.local.set({ selectedFields: [...selectedFields], lockedFields: [...lockedFields], settingsVersion: 3 });
  } catch {
    status("Réglages appliqués ; leur sauvegarde locale a échoué.", true);
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
  include.setAttribute("aria-label", "Remplir : " + label);
  include.addEventListener("change", () => {
    settingsTouched = true;
    if (include.checked) selectedFields.add(key);
    else selectedFields.delete(key);
    syncControls();
    status(
      selectedFields.size
        ? `${selectedFields.size} information(s) sélectionnée(s) pour le remplissage.`
        : "Cochez au moins une information à remplir.",
    );
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
    status(`${lockedFields.has(key) ? "Verrou activé" : "Verrou retiré"} pour « ${label} ».`);
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
  $("edition").textContent = `Identité n° ${revision} · ${profile.country}`;
  $("password").value = profile.password;
  $("birth-date").textContent = profile.birthDate.split("-").reverse().join("/");
  $("password").type = "password";
  $("reveal-password").textContent = "Afficher";
  $("reveal-password").setAttribute("aria-pressed", "false");
  syncControls();
}
$("reveal-password").addEventListener("click", () => {
  const show = $("password").type === "password";
  $("password").type = show ? "text" : "password";
  $("reveal-password").textContent = show ? "Masquer" : "Afficher";
  $("reveal-password").setAttribute("aria-pressed", String(show));
});
$("country-mode").addEventListener("change", async () => {
  countryTouched = true;
  const countryMode = $("country-mode").value;
  status("Pays choisi pour le prochain profil. Cliquez sur Générer.");
  try {
    await browser.storage.local.set({ countryMode });
  } catch {
    status("Choix appliqué ; sa sauvegarde locale a échoué.", true);
  }
});
$("generate").addEventListener("click", async () => {
  if (profile && lockedFields.size === fieldKeys.length) {
    status("Toutes les informations sont verrouillées. Passez au moins une valeur sur Libre pour la régénérer.");
    return;
  }
  // L'adresse jetable suit l'e-mail : conservée seulement si l'e-mail est verrouillé.
  const keptAlias = lockedFields.has("email") ? profile?.throwaway : undefined;
  profile = FableGenerator.generate($("country-mode").value, profile, [...lockedFields]);
  revision++;
  if (keptAlias) profile.throwaway = keptAlias;
  tmCode = null;
  void tmRender();
  render();
  status(
    lockedFields.size ? "Profil régénéré. Les valeurs verrouillées sont conservées." : "Nouveau profil prêt. La page n’a pas été modifiée.",
  );
  try {
    await browser.storage.local.set({ profile, revision });
  } catch {
    status("Profil prêt ; sa sauvegarde locale a échoué.", true);
  }
});
$("copy").addEventListener("click", async () => {
  if (!profile) return;
  const text = Object.entries(fieldLabels)
    .map(([key, label]) => `${label} : ${key === "birthDate" ? profile[key].split("-").reverse().join("/") : profile[key]}`)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    status("Profil copié dans le presse-papiers.");
  } catch {
    status("Copie indisponible. Vous pouvez sélectionner les valeurs affichées et les copier manuellement.", true);
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
  status("Recherche des champs du formulaire…");
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
    // Mode Bitwarden : la page attend l'e-mail rempli par Bitwarden, puis le code.
    if (bitwardenMode) await browser.tabs.sendMessage(tabId, { type: "watch-email" }).catch(() => {});
    if (report.filled && profile.throwaway) void handOffCode(tabId);
    const passwordNote =
      (report.passwordIssue === "preserved"
        ? " Mots de passe conservés ensemble pour éviter une confirmation différente."
        : report.passwordIssue === "constraints"
          ? " Mot de passe incompatible avec les contraintes du site : aucun des deux champs modifié."
          : report.passwordIssue === "registration"
            ? " Mot de passe ignoré : inscription non identifiée."
            : "") +
      (report.birthIssue === "preserved"
        ? " Date de naissance existante conservée ensemble."
        : report.birthIssue === "constraints"
          ? " Date de naissance incompatible avec les contraintes du site : ses champs sont conservés."
          : "");
    if (report.filled) {
      status(
        `${report.filled} champ${report.filled > 1 ? "s" : ""} rempli${report.filled > 1 ? "s" : ""}.${report.preserved ? ` ${report.preserved} déjà renseigné(s), conservé(s).` : ""}${report.rejected ? ` ${report.rejected} valeur(s) incompatible(s).` : ""}${passwordNote} Aucun envoi déclenché par Fable.`,
      );
    } else if (report.passwordIssue || report.birthIssue)
      status(
        passwordNote.trim(),
        report.passwordIssue === "constraints" || report.birthIssue === "constraints" || report.passwordIssue === "registration",
      );
    else if (report.preserved) status("Les champs détectés sont déjà renseignés. Cochez l’option de remplacement pour les modifier.");
    else if (report.unchanged) status("Les champs sélectionnés contiennent déjà les valeurs du profil.");
    else if (report.rejected) status("Champs détectés, mais valeurs refusées par leurs contraintes. Aucun champ modifié.", true);
    else if (report.blockedAuthentication)
      status(
        "Ce formulaire semble être une connexion ou une vérification de compte. Fable ignore ces formulaires et les mots de passe.",
        true,
      );
    else if (report.selectionMismatch)
      status("Des champs sont reconnus, mais ils sont décochés dans Personnaliser. Cochez les informations à remplir.", true);
    else
      status(
        "Aucun champ compatible avec votre sélection. Certains formulaires intégrés et composants personnalisés sont inaccessibles.",
        true,
      );
  } catch {
    status(
      "Impossible d’accéder à cette page. Ouvrez une page web ordinaire puis réessayez. Firefox protège ses pages internes, sa boutique et certains PDF.",
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
  cardStatus("Recherche des champs de carte…");
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
    if (report.invalidCard) cardStatus("Carte de test invalide ou expirée. Générez une nouvelle carte.", true);
    else if (report.readOnlyGroup) cardStatus("Un champ de carte est protégé et contient une autre valeur. Aucun champ modifié.", true);
    else if (report.preservedGroup) cardStatus("Valeurs existantes conservées ensemble. Cochez Remplacer pour insérer la carte de test.");
    else if (report.incompatible) cardStatus("Les contraintes d’un champ refusent cette carte de test. Aucun champ modifié.", true);
    else if (report.filled)
      cardStatus(
        `${report.filled} champ(s) de carte rempli(s).${report.missing?.length ? ` Non détecté(s) : ${report.missing.join(", ")}.` : ""}${report.rejected ? ` ${report.rejected} valeur(s) refusée(s) par le site.` : ""} Aucun clic ni envoi déclenché par Fable.`,
      );
    else if (report.unchanged) cardStatus("Les champs détectés contiennent déjà cette carte de test.");
    else
      cardStatus(
        "Aucun formulaire de carte reconnu. Les iframes d’un autre domaine et certains champs personnalisés sont inaccessibles.",
        true,
      );
  } catch {
    cardStatus("Impossible d’accéder à cette page. Ouvrez votre formulaire de test puis réessayez.", true);
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
  notify("Annulation du dernier remplissage…");
  try {
    const tabId = await activeTabId();
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.FableFill?.undo?.() || { available: false, restored: 0, skipped: 0, failed: 0 },
    });
    const report = results[0]?.result;
    if (!report?.available) notify("Aucun remplissage à annuler sur cette page.");
    else
      notify(
        `${report.restored} champ(s) restauré(s).${report.skipped ? ` ${report.skipped} champ(s) retouché(s) ou inaccessible(s), conservé(s).` : ""}${report.failed ? ` ${report.failed} restauration(s) refusée(s) par le site.` : ""}`,
        !!report.failed,
      );
  } catch {
    notify("Annulation impossible sur cette page. Le remplissage doit appartenir à l’onglet actif.", true);
  } finally {
    busy = false;
    syncControls();
  }
}
$("undo").addEventListener("click", () => undoFill(false));
$("undo-card").addEventListener("click", () => undoFill(true));
// ---------------------------------------------------------------------------
// Throwaway Mail : vraie adresse jetable par site + récupération du code reçu.
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
  $("tm-badge").title = on ? "Adresses e-mail réelles via Throwaway Mail" : "Adresses @example.com, rien ne quitte le navigateur";
  const alias = profile?.throwaway;
  $("tm-email-note").hidden = !on;
  $("tm-email-note").textContent = alias ? "JETABLE" : "JETABLE AU REMPLISSAGE";
  $("tm-panel").hidden = !(on && alias);
  if (alias) $("tm-address").textContent = alias.email;
  $("tm-code").textContent = tmCode?.code || "—";
  $("tm-copy").disabled = $("tm-paste").disabled = !tmCode?.code;
  $("tm-wait").disabled = tmWaiting || !alias;
  $("tm-wait").textContent = tmWaiting ? "En attente…" : tmCode ? "Code suivant" : "Attendre le code";
  $("tm-link").hidden = !(tmCode && !tmCode.code && tmCode.links?.length);
  $("tm-link").replaceChildren();
  if (tmCode && !tmCode.code && tmCode.links?.length) {
    const a = document.createElement("a");
    a.href = tmCode.links[0].url || tmCode.links[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Ouvrir le lien de confirmation";
    $("tm-link").append(a);
  }
}
async function activeTabUrl() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.url || "";
}
// Avant de remplir : crée (ou réutilise) l'adresse jetable du site ouvert.
// Retourne false si le remplissage doit être interrompu.
async function ensureAlias() {
  if (!selectedFields.has("email") || !(await Throwaway.enabled())) return true;
  const url = await activeTabUrl();
  if (!/^https?:/.test(url)) {
    status("Ouvrez le formulaire d’un site web puis réessayez.", true);
    return false;
  }
  const host = new URL(url).hostname;
  if (profile.throwaway?.host === host) return true;
  status(`Création de l’adresse jetable pour ${host}…`);
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
        ? "Clé API Throwaway Mail invalide. Vérifiez les réglages."
        : `Adresse jetable impossible : ${e.message}. Rien n’a été rempli.`,
      true,
    );
    return false;
  }
}
// Nouvelle identité pour chaque nouveau site (réglage « alwaysNew », activé par défaut).
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
// Après un remplissage : le script de page attend le code et le colle tout seul,
// même si la popup se ferme ou si le site change de page.
async function handOffCode(tabId) {
  const { autoCode } = await browser.storage.local.get("autoCode");
  if (autoCode === false || !profile?.throwaway) return;
  await browser.runtime.sendMessage({ type: "pending-set", host: profile.throwaway.host, alias: profile.throwaway }).catch(() => {});
  await browser.tabs.sendMessage(tabId, { type: "watch-code" }).catch(() => {});
  tmStatus("Le code sera collé automatiquement dans la page dès son arrivée.");
}
async function tmPoll(wait) {
  const alias = profile?.throwaway;
  if (!alias) return;
  const since = tmCode?.message_id || alias.createdAt;
  tmWaiting = wait > 0;
  void tmRender();
  if (wait) tmStatus("En attente d’un e-mail (jusqu’à 2 min). Gardez cette fenêtre ouverte.");
  try {
    let found = null;
    for (let i = 0; i < (wait ? 2 : 1) && !found; i++) found = await Throwaway.waitForCode(alias.id, since, wait);
    if (found) {
      tmCode = found;
      if (found.code && wait) setTimeout(() => $("tm-paste").click(), 0);
      tmStatus(
        found.code
          ? `Reçu de ${found.from || "?"}${found.subject ? ` · « ${found.subject} »` : ""}.`
          : "E-mail reçu sans code : lien de confirmation disponible.",
      );
    } else if (wait) tmStatus("Rien reçu pour l’instant. Réessayez après avoir demandé le code au site.");
  } catch (e) {
    tmStatus(`Throwaway Mail injoignable : ${e.message}`, true);
  } finally {
    tmWaiting = false;
    void tmRender();
  }
}
$("tm-wait").addEventListener("click", () => tmPoll(55));
$("tm-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(tmCode.code);
    tmStatus("Code copié.");
  } catch {
    tmStatus("Copie indisponible.", true);
  }
});
$("tm-paste").addEventListener("click", async () => {
  try {
    const tabId = await activeTabId();
    const [res] = await browser.scripting.executeScript({ target: { tabId }, func: fillCodeInPage, args: [tmCode.code] });
    tmStatus(
      res?.result
        ? `Code collé (${res.result} champ${res.result > 1 ? "s" : ""}). Aucun envoi déclenché.`
        : "Aucun champ de code trouvé : utilisez Copier.",
      !res?.result,
    );
  } catch {
    tmStatus("Impossible d’accéder à cette page. Utilisez Copier.", true);
  }
});
// Exécutée dans la page : champ one-time-code, champ focalisé ou cases d'un chiffre.
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
      cardStatus("Dernière carte de test retrouvée.");
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
      status("Dernier profil retrouvé. Prêt à remplir un formulaire.");
      if (upgradedProfile) await browser.storage.local.set({ profile });
    }
    if (saved.settingsVersion !== 3) await saveSettings();
    syncControls();
    await tmRender();
    if (profile?.throwaway && (await Throwaway.enabled())) void tmPoll(0);
  } catch {
    status("Stockage local indisponible. Vous pouvez toujours générer un profil.", true);
  }
})();

// Firefox (MV3) n'accorde pas « tous les sites » à l'installation : on le demande (clic requis).
const ALL_SITES = { origins: ["http://*/*", "https://*/*"] };
async function checkSitePermission() {
  const banner = document.getElementById("perm-banner");
  banner.hidden = await browser.permissions.contains(ALL_SITES);
  document.getElementById("perm-grant").onclick = async () => {
    if (await browser.permissions.request(ALL_SITES)) banner.hidden = true;
  };
}
void checkSitePermission();
