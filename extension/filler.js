(function (root) {
  "use strict";
  // The popup reinjects this file on each fill; keep the last transaction alive.
  if (root.ThrowawayFill?.version === "1.9") return;
  let lastFill = null;
  const fieldKeys = ["firstName", "lastName", "address", "city", "postalCode", "country", "email", "phone", "birthDate", "password"];
  function allowed(key, selected) {
    if (key === "fullName" || key === "username") return selected.has("firstName") && selected.has("lastName");
    if (key === "phoneNational" || key === "phoneCountryCode") return selected.has("phone");
    if (["birthDay", "birthMonth", "birthYear"].includes(key)) return selected.has("birthDate");
    return selected.has(key);
  }
  function dispose(transaction) {
    for (const entry of transaction?.entries || []) {
      entry.el.removeEventListener("input", entry.onEdit);
      entry.el.removeEventListener("change", entry.onEdit);
    }
  }
  function rememberChanges(changes) {
    if (!changes.length) return;
    dispose(lastFill);
    for (const entry of changes) {
      entry.dirty = entry.el.value !== entry.after;
      entry.onEdit = () => {
        entry.dirty = true;
      };
      entry.el.addEventListener("input", entry.onEdit);
      entry.el.addEventListener("change", entry.onEdit);
    }
    lastFill = { entries: changes, url: root.location.href };
  }
  const normalize = (value) =>
    String(value || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const rules = [
    ["firstName", /\b(first\s*name|given\s*name|forename|prenom|vorname|nombre|nome di battesimo|voornaam|fname)\b/],
    ["lastName", /\b(last\s*name|sur\s*name|family\s*name|nom de famille|nachname|familienname|apellido\w*|cognome|achternaam|lname)\b/],
    ["email", /\b(e\s*mail|emailaddress|courriel|correo(?: electronico)?|posta elettronica)\b/],
    ["postalCode", /\b(post\s*(?:al\s*)?code|zip\s*(?:code)?|zipcode|code postal|codigo postal|postleitzahl|plz|postcode|cap)\b/],
    ["country", /\b(country(?:\s*(?:code|name))?|pays|pais|land|paese)\b/],
    ["city", /\b(city|town|ville|localite|ciudad|citta|stadt|ort|woonplaats)\b/],
    ["phone", /\b(phone(?:\s*number)?|telephone|tel|mobile|portable|telefon(?:nummer)?|telefono|cellulare|telefoon)\b/],
    ["address2", /\b(address\s*(?:line\s*)?2|adresse\s*2|complement|apartment|suite|building|batiment)\b/],
    ["address", /\b(address(?:\s*(?:line\s*)?1)?|adresse(?:\s*1)?|street(?:\s*address)?|rue|direccion|indirizzo|strasse|straat)\b/],
    [
      "fullName",
      /\b(full\s*name|your\s*name|display\s*name|nom d affichage|anzeigename|contact\s*name|customer\s*name|nom complet|votre nom|nombre completo|nome completo|vollstandiger name)\b/,
    ],
  ];
  const autocomplete = {
    "given-name": "firstName",
    "family-name": "lastName",
    name: "fullName",
    email: "email",
    "street-address": "address",
    "address-line1": "address",
    "address-line2": "address2",
    "address-level2": "city",
    "postal-code": "postalCode",
    country: "country",
    "country-name": "country",
    tel: "phone",
    "tel-national": "phoneNational",
    "tel-country-code": "phoneCountryCode",
  };
  function signals(el) {
    const scope = el.getRootNode();
    const labelled = (el.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => scope.getElementById?.(id)?.textContent || "");
    const labels = Array.from(el.labels || [], (label) => label.textContent);
    const parent = el.parentElement;
    const nearby =
      !labels.length && parent && parent.querySelectorAll("input,select,textarea").length === 1 && parent.textContent.length < 100
        ? parent.textContent
        : "";
    return [
      ...labels,
      ...labelled,
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.name,
      el.id,
      el.title,
      el.getAttribute("data-label"),
      nearby,
    ]
      .map(normalize)
      .filter(Boolean);
  }
  function classify(el) {
    const type = (el.type || "").toLowerCase();
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return null;
    if (el.tagName === "INPUT" && !["text", "email", "tel", "number", "password", "date", ""].includes(type)) return null;
    const birth = classifyBirth(el);
    if (birth) return birth;
    if (type === "date") return null;
    if (classifyCard(el)) return null;
    const auto = (el.getAttribute("autocomplete") || "")
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((token) => token !== "webauthn")
      .pop();
    // Discord & co.: e-mail field marked autocomplete="username" (login identifier = e-mail).
    if (auto === "username" && el.tagName === "INPUT" && (type === "email" || signals(el).some((text) => /^e ?mail$|\bemail\b/.test(text))))
      return "email";
    if (
      auto &&
      /^(username|current-password|one-time-code|cc-.+|bday.*|sex|organization.*|address-level[134]|address-line3|tel-(area-code|local.*|extension))$/.test(
        auto,
      )
    )
      return null;
    const texts = signals(el);
    const passwordHint = texts.some((text) => /\b(password|mot de passe|motdepasse|passwort|contrasena|senha|pwd)\b/.test(text));
    if (el.tagName === "INPUT" && (type === "password" || auto === "new-password" || passwordHint)) {
      if (texts.some((text) => /\b(current|existing|old|actuel|actuelle|ancien|ancienne)\b/.test(text))) return null;
      return "password"; // Only a recognized registration group may use this candidate.
    }
    // "Nouvelle adresse mail Yahoo", "choose your Gmail address": a mailbox is being created on the site,
    // the field expects a username (not a postal address nor our disposable address).
    const mailWords = /\b(e ?mail|mail|courriel|gmail|outlook|yahoo)\b/;
    if (
      el.tagName === "INPUT" &&
      type !== "email" &&
      texts.some((text) => mailWords.test(text) && /\b(new|nouvelle|nouveau|choose|choisissez|choisir|create|creer|neue)\b/.test(text))
    )
      return "username";
    // Username: filled only in a recognised sign-up form (see fill()).
    if (
      el.tagName === "INPUT" &&
      auto !== "username" &&
      texts.some((text) => /^(user ?name|nom d utilisateur|pseudo|pseudonyme|benutzername|nombre de usuario)\b/.test(text))
    )
      return "username";
    if (
      texts.some((text) =>
        /\b(search|recherche|captcha|honeypot|website|url|password|mot de passe|username|login|subject|objet|message|company|entreprise|organisation|organization|fax|birth|naissance|iban|card number|account number)\b/.test(
          text,
        ),
      )
    )
      return null;
    if (autocomplete[auto]) return autocomplete[auto];
    // Explicit semantic input types take precedence over loose textual hints.
    if (type === "email") return "email";
    if (type === "tel") return "phone";
    // "Adresse mail" / "adresse e-mail": never a postal address.
    if (texts.some((text) => /\badresse (e )?mail\b|\bmail address\b/.test(text))) return "email";
    for (const [key, pattern] of rules) if (texts.some((text) => pattern.test(text))) return key;
    if (texts.some((text) => /^(nom|name|nome|naam)$/.test(text))) return "fullName";
    return null;
  }
  function visible(el, requireEditable = true) {
    if (
      (requireEditable && (el.disabled || el.readOnly)) ||
      el.closest('[hidden],[inert],[aria-hidden="true"]') ||
      el.getClientRects().length === 0
    )
      return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "none" && style.opacity !== "0";
  }
  function scan(doc) {
    const controls = [],
      visited = new Set();
    function visit(scope) {
      if (visited.has(scope)) return;
      visited.add(scope);
      for (const el of scope.querySelectorAll("*")) {
        if (el.matches("input,select,textarea")) controls.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
        if (el.tagName === "IFRAME" && visible(el)) {
          try {
            if (el.contentDocument) visit(el.contentDocument);
          } catch {
            /* Cross-origin frames remain untouched. */
          }
        }
      }
    }
    visit(doc);
    return controls;
  }
  function selectValue(el, key, data) {
    const candidates = key === "country" ? data.countryAliases : [data[key]];
    const expected = candidates.map(normalize);
    for (const option of el.options) {
      if (option.disabled || option.parentElement?.disabled || !option.value) continue;
      if (expected.includes(normalize(option.value)) || expected.includes(normalize(option.textContent))) return option.value;
    }
    return null;
  }
  function proposedValue(el, key, data) {
    if (key.startsWith("birth")) return birthValue(el, key, data.birthDate);
    if (key === "username")
      return (
        data.username ||
        normalize(data.firstName + data.lastName)
          .replace(/ /g, "")
          .slice(0, 20) +
          String(data.password || "")
            .replace(/\D/g, "")
            .slice(0, 3)
            .padEnd(3, "7")
      );
    if (el.tagName === "SELECT") return selectValue(el, key, data);
    if (key === "country")
      return /code|iso/.test(normalize(el.name + " " + el.id)) || (el.maxLength > 0 && el.maxLength <= 3)
        ? data.countryCode
        : data.countryEnglish;
    let value = data[key];
    if (["phone", "phoneNational"].includes(key)) {
      const variants = [value, key === "phone" ? data.phone.replace(/\D/g, "") : value, data.phoneNational];
      // Ask native HTML validation without changing the actual page control.
      const probe = el.cloneNode(false);
      return (
        variants.find((candidate) => {
          probe.value = candidate;
          return probe.checkValidity() && (el.maxLength < 0 || candidate.length <= el.maxLength);
        }) ?? null
      );
    }
    return value;
  }
  function write(el, value) {
    const view = el.ownerDocument.defaultView;
    const prototype =
      el.tagName === "SELECT"
        ? view.HTMLSelectElement.prototype
        : el.tagName === "TEXTAREA"
          ? view.HTMLTextAreaElement.prototype
          : view.HTMLInputElement.prototype;
    // Sequence close to real typing (focus → input → change → blur): password
    // managers (Bitwarden…) only save fields they have seen being "typed".
    el.dispatchEvent(new view.FocusEvent("focus", { composed: true }));
    el.dispatchEvent(new view.FocusEvent("focusin", { bubbles: true, composed: true }));
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, value);
    el.dispatchEvent(new view.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new view.Event("change", { bubbles: true, composed: true }));
    el.dispatchEvent(new view.FocusEvent("blur", { composed: true }));
    el.dispatchEvent(new view.FocusEvent("focusout", { bubbles: true, composed: true }));
  }
  const cardAutocomplete = {
    "cc-number": "cardNumber",
    "cc-name": "cardHolder",
    "cc-exp": "cardExpiry",
    "cc-exp-month": "cardMonth",
    "cc-exp-year": "cardYear",
    "cc-csc": "cardCvc",
  };
  const birthAutocomplete = { bday: "birthDate", "bday-day": "birthDay", "bday-month": "birthMonth", "bday-year": "birthYear" };
  const monthNames = [
    "january janvier",
    "february fevrier",
    "march mars",
    "april avril",
    "may mai",
    "june juin",
    "july juillet",
    "august aout",
    "september septembre",
    "october octobre",
    "november novembre",
    "december decembre",
  ];
  function classifyBirth(el) {
    if (!["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) return null;
    if (el.tagName === "INPUT" && !["text", "date", "number", "tel", ""].includes(el.type)) return null;
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase().trim().split(/\s+/).pop();
    if (birthAutocomplete[auto]) return birthAutocomplete[auto];
    if (auto && auto !== "off" && auto !== "on") return null;
    const texts = signals(el);
    const birthHint = /\b(birth\s*date|birth\s*day|birth|dob|date de naissance|naissance|anniversaire|geburtsdatum|nacimiento|nascita)\b/;
    if (texts.some((text) => /\b(place|lieu|city|ville|pays|country|age)\b/.test(text))) return null;
    const context = normalize(
      el.closest("fieldset")?.querySelector("legend")?.textContent || el.closest('[role="group"]')?.getAttribute("aria-label"),
    );
    if (!texts.some((text) => birthHint.test(text)) && !birthHint.test(context)) return null;
    const parts = texts.filter(
      (text) =>
        !(/\b(day|jour|dd|jj)\b/.test(text) && /\b(month|mois|mm)\b/.test(text)) &&
        !(/\b(year|annee|yyyy|aaaa)\b/.test(text) && /\b(month|mois|mm)\b/.test(text)),
    );
    if (parts.some((text) => /\b(day|jour|dd|jj)\b/.test(text) && (text !== "birth day" || el.type === "number" || el.maxLength === 2)))
      return "birthDay";
    if (parts.some((text) => /\b(month|mois|mm)\b/.test(text))) return "birthMonth";
    if (parts.some((text) => /\b(year|annee|yyyy|aaaa)\b/.test(text))) return "birthYear";
    return texts.some((text) => birthHint.test(text)) ? "birthDate" : null;
  }
  function birthValue(el, key, iso) {
    if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const date = new Date(iso + "T00:00:00Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
    const [year, month, day] = iso.split("-");
    const part = { birthDay: day, birthMonth: month, birthYear: year }[key];
    if (el.tagName === "SELECT") {
      for (const option of el.options) {
        if (!option.value || option.disabled || option.parentElement?.disabled) continue;
        const values = [option.value, option.textContent.trim()];
        if (
          part &&
          values.some(
            (value) =>
              Number(value) === Number(part) ||
              (key === "birthMonth" && monthNames[Number(month) - 1].split(" ").includes(normalize(value))),
          )
        )
          return option.value;
        if (key === "birthDate" && values.includes(iso)) return option.value;
      }
      return null;
    }
    if (part) return [part, String(Number(part))].find((value) => acceptsValue(el, value)) ?? null;
    if (el.getAttribute("type")?.toLowerCase() === "date") return acceptsValue(el, iso) ? iso : null;
    const hint = (el.placeholder || "") + " " + (el.getAttribute("data-format") || "");
    let variants;
    if (/yyyy[\s/.-]*mm|aaaa[\s/.-]*mm/i.test(hint)) variants = [iso, `${year}/${month}/${day}`, `${year}${month}${day}`];
    else if (/mm[\s/.-]*(dd|jj)/i.test(hint)) variants = [`${month}/${day}/${year}`, `${month}-${day}-${year}`, `${month}${day}${year}`];
    else variants = [`${day}/${month}/${year}`, `${day}-${month}-${year}`, `${day}.${month}.${year}`, `${day}${month}${year}`, iso];
    const format = hint.match(/(yyyy|aaaa|dd|jj|mm)([/.\-]?)(yyyy|aaaa|dd|jj|mm)\2(yyyy|aaaa|dd|jj|mm)/i);
    if (format) {
      const values = { yyyy: year, aaaa: year, mm: month, dd: day, jj: day };
      variants.unshift([format[1], format[3], format[4]].map((token) => values[token.toLowerCase()]).join(format[2]));
    }
    return variants.find((value) => acceptsValue(el, value)) ?? null;
  }
  function classifyCard(el) {
    if (!["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) return null;
    if (el.tagName === "INPUT" && !["text", "tel", "number", "password", "month", ""].includes(el.type)) return null;
    if (classifyBirth(el)) return null;
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase().trim().split(/\s+/).pop();
    if (cardAutocomplete[auto]) return cardAutocomplete[auto];
    if (auto && /^(cc-.+|.*password|one-time-code|bday.*|username)$/.test(auto)) return null;
    const texts = signals(el);
    if (
      texts.some((text) =>
        /\b(search|recherche|captcha|honeypot|iban|account|compte|birth|birthday|naissance|password|mot de passe|motdepasse|pin|otp)\b/.test(
          text,
        ),
      )
    )
      return null;
    if (texts.some((text) => /\b(cvc|cvv|cvv2|csc|cryptogramme|security code|code de securite|code securite)\b/.test(text)))
      return "cardCvc";
    if (el.type === "password") return null;
    if (
      texts.some((text) =>
        /\b(card\s*number|cc\s*(number|num)|numero (de (la )?)?carte|numero carte|num carte|card no|pan|kartennummer)\b/.test(text),
      )
    )
      return "cardNumber";
    if (
      texts.some((text) =>
        /\b(card\s*holder(\s*name)?|name on (the )?card|nom (sur|de) (la )?carte|titulaire|porteur|karteninhaber)\b/.test(text),
      )
    )
      return "cardHolder";
    if (
      texts.some(
        (text) => /\b(exp\s*(iry|iration)?\s*month|expiration month|mois (d )?expiration)\b/.test(text) || /^(month|mois|mm)$/.test(text),
      )
    )
      return "cardMonth";
    if (
      texts.some(
        (text) =>
          /\b(exp\s*(iry|iration)?\s*year|expiration year|annee (d )?expiration)\b/.test(text) ||
          /^(year|annee|yy|yyyy|aa|aaaa)$/.test(text),
      )
    )
      return "cardYear";
    if (
      el.getAttribute("type")?.toLowerCase() === "month" ||
      texts.some(
        (text) =>
          /\b(expiry|expiration|expire|exp date|valid thru|valid until|date de validite|date validite|validite)\b/.test(text) ||
          /^(exp|mm yy|mm yyyy|mm aa|mm aaaa)$/.test(text),
      )
    )
      return "cardExpiry";
    return null;
  }
  function validTestCard(card) {
    if (!card || card.testOnly !== true || card.bankSimulated !== true || card.countryCode !== "FR") return false;
    if (card.mode === "bank-bin") {
      const bins = {
        bnp: { visa: "406714" },
        agricole: { visa: "453304" },
        sg: { visa: "448539" },
        mutuel: { visa: "497762", mastercard: "513633" },
        postale: { visa: "415059" },
        populaire: { visa: "448415" },
        epargne: { visa: "455666" },
      };
      if (
        card.sandbox !== "None" ||
        card.bin !== bins[card.bankCode]?.[card.networkCode] ||
        !/^\d{16}$/.test(card.number) ||
        !card.number.startsWith(card.bin)
      )
        return false;
      const checksum = [...card.number].reverse().reduce((sum, digit, index) => {
        let n = Number(digit);
        if (index % 2) {
          n *= 2;
          if (n > 9) n -= 9;
        }
        return sum + n;
      }, 0);
      if (checksum % 10) return false;
    } else if (
      (card.mode && card.mode !== "stripe") ||
      card.sandbox !== "Stripe" ||
      !["4000002500001001", "5555552500001001"].includes(card.number)
    )
      return false;
    if (typeof card.holder !== "string" || !card.holder.trim()) return false;
    if (
      typeof card.expiryYear !== "string" ||
      !/^\d{4}$/.test(card.expiryYear) ||
      !/^(0[1-9]|1[0-2])$/.test(card.expiryMonth) ||
      !/^\d{3}$/.test(card.cvc)
    )
      return false;
    const now = new Date();
    return Number(card.expiryYear) * 12 + Number(card.expiryMonth) >= now.getUTCFullYear() * 12 + now.getUTCMonth() + 1;
  }
  function acceptsValue(el, value) {
    if (
      typeof value !== "string" ||
      !value ||
      (el.maxLength > -1 && value.length > el.maxLength) ||
      (el.minLength > 0 && value.length < el.minLength)
    )
      return false;
    const probe = el.cloneNode(true);
    probe.value = value;
    return probe.value === value && probe.checkValidity();
  }
  function cardValue(el, key, card) {
    const month = card.expiryMonth,
      year = card.expiryYear,
      shortYear = year.slice(-2);
    if (el.tagName === "SELECT") {
      const months = [
        "january janvier",
        "february fevrier",
        "march mars",
        "april avril",
        "may mai",
        "june juin",
        "july juillet",
        "august aout",
        "september septembre",
        "october octobre",
        "november novembre",
        "december decembre",
      ];
      for (const option of el.options) {
        if (!option.value || option.disabled || option.parentElement?.disabled) continue;
        const values = [option.value, option.textContent.trim()];
        if (
          key === "cardMonth" &&
          values.some((value) => Number(value) === Number(month) || months[Number(month) - 1].split(" ").includes(normalize(value)))
        )
          return option.value;
        if (key === "cardYear" && values.some((value) => value === year || value === shortYear)) return option.value;
      }
      return null;
    }
    let variants = [];
    if (key === "cardNumber") variants = [card.number, card.number.match(/.{4}/g).join(" ")];
    if (key === "cardCvc") variants = [card.cvc];
    if (key === "cardHolder") variants = [card.holder];
    if (key === "cardMonth") variants = [month, String(Number(month))];
    if (key === "cardYear")
      variants = /yyyy|aaaa/i.test(el.placeholder || "") || el.maxLength !== 2 ? [year, shortYear] : [shortYear, year];
    if (key === "cardExpiry") {
      if (el.getAttribute("type")?.toLowerCase() === "month") variants = [`${year}-${month}`];
      else {
        variants = [`${month}/${shortYear}`, `${month}/${year}`, `${month} / ${shortYear}`, `${month}${shortYear}`];
        if (/yyyy|aaaa/i.test(el.placeholder || "")) variants.unshift(`${month}/${year}`);
      }
    }
    return variants.find((value) => acceptsValue(el, value)) ?? null;
  }
  function cardPlaceholder(el) {
    return (
      el.tagName === "SELECT" &&
      (el.selectedOptions[0]?.disabled ||
        /^(choose|select|selectionner|choisir|please select|month|year|mois|annee|mm|yy|yyyy|aa|aaaa)(\s|$)/.test(
          normalize(el.selectedOptions[0]?.textContent),
        ))
    );
  }
  function sameCardValue(key, actual, desired, card) {
    if (actual === desired) return true;
    if (!actual.trim()) return false;
    if (key === "cardNumber") return actual.replace(/\D/g, "") === card.number;
    if (key === "cardHolder") return normalize(actual) === normalize(card.holder);
    if (key === "cardMonth") return Number(actual) === Number(card.expiryMonth);
    if (key === "cardYear") return actual === card.expiryYear || actual === card.expiryYear.slice(-2);
    if (key === "cardExpiry") {
      const parts = actual.match(/^\s*(\d{2})\s*[/-]\s*(\d{2}|\d{4})\s*$/);
      return !!parts && parts[1] === card.expiryMonth && [card.expiryYear, card.expiryYear.slice(-2)].includes(parts[2]);
    }
    return false;
  }
  function fillCard(card, options = {}) {
    const report = { filled: 0, preserved: 0, rejected: 0, unchanged: 0, detected: 0, missing: [] };
    // Validate the selected test format again in the page-side engine.
    if (!validTestCard(card)) return { ...report, invalidCard: true };
    const groups = new Map();
    for (const el of scan(root.document)) {
      if (!visible(el, false)) continue;
      const key = classifyCard(el);
      if (!key) continue;
      const owner = el.form || el.closest('[role="form"]') || el.getRootNode();
      if (!groups.has(owner)) groups.set(owner, []);
      groups.get(owner).push({ el, key });
    }
    const ranked = [...groups.values()]
      .map((fields) => {
        const keys = new Set(fields.map((field) => field.key));
        return { fields, keys, score: keys.size * 10 + (fields.some(({ el }) => el === el.ownerDocument.activeElement) ? 5 : 0) };
      })
      .filter(
        (group) =>
          group.keys.has("cardNumber") ||
          (group.keys.has("cardCvc") && (group.keys.has("cardExpiry") || (group.keys.has("cardMonth") && group.keys.has("cardYear")))),
      )
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return report;
    const { fields, keys } = ranked[0];
    report.detected = fields.length;
    if (!keys.has("cardNumber")) report.missing.push("number");
    if (!(keys.has("cardExpiry") || (keys.has("cardMonth") && keys.has("cardYear")))) report.missing.push("expiry");
    if (!keys.has("cardCvc")) report.missing.push("CVC");
    if (!keys.has("cardHolder")) report.missing.push("holder");
    const plans = fields.map((field) => ({ ...field, value: cardValue(field.el, field.key, card) }));
    if (plans.some((plan) => plan.value === null))
      return { ...report, rejected: plans.filter((plan) => plan.value === null).length, incompatible: true };
    if (plans.some(({ el, key, value }) => !visible(el) && !sameCardValue(key, el.value, value, card)))
      return { ...report, preservedGroup: true, readOnlyGroup: true };
    if (
      !options.overwrite &&
      plans.some(({ el, key, value }) => {
        if (!el.value.trim() || cardPlaceholder(el)) return false;
        return !sameCardValue(key, el.value, value, card);
      })
    )
      return { ...report, preserved: plans.filter(({ el }) => el.value.trim() && !cardPlaceholder(el)).length, preservedGroup: true };
    const changes = [];
    for (const { el, key, value } of plans) {
      if (sameCardValue(key, el.value, value, card)) {
        report.unchanged++;
        continue;
      }
      if (!visible(el)) {
        report.preserved++;
        continue;
      }
      const before = el.value;
      try {
        write(el, value);
        if (el.isConnected && sameCardValue(key, el.value, value, card)) {
          report.filled++;
          changes.push({ el, key, before, after: el.value, dirty: false });
        } else report.rejected++;
      } catch {
        report.rejected++;
      }
    }
    rememberChanges(changes);
    return report;
  }
  function authenticationForm(group, keys, context) {
    // A password field does not make an entire registration form a login form.
    // Look only at inputs belonging to this group, not at nested/unrelated forms.
    const belongs = (el) => (el.form || el.closest('[role="form"]') || el.getRootNode()) === group;
    const inputs = Array.from(group.querySelectorAll?.("input") || []).filter((el) => belongs(el) && visible(el, false));
    const tokens = (el) => (el.getAttribute("autocomplete") || "").toLowerCase().trim().split(/\s+/);
    const passwords = inputs.filter((el) => el.type === "password");
    const currentPassword = inputs.some(
      (el) =>
        tokens(el).includes("current-password") ||
        (el.type === "password" && signals(el).some((text) => /\b(current|existing|old|actuel|actuelle|ancien|ancienne)\b/.test(text))),
    );
    const newPassword = inputs.some((el) => tokens(el).includes("new-password"));
    const oneTimeCode = inputs.some((el) => tokens(el).includes("one-time-code"));
    const buttons = Array.from(group.querySelectorAll?.('button[type="submit"],button:not([type]),input[type="submit"]') || [])
      .filter((el) => belongs(el) && visible(el))
      .map((el) => el.textContent || el.value)
      .join(" ");
    const wording = context + " " + normalize(buttons);
    const signup = /\b(register|registration|signup|sign up|inscription|inscrire|create account|creer un compte)\b/.test(wording);
    const identity = keys.has("fullName") || (keys.has("firstName") && keys.has("lastName"));
    const registration = newPassword || identity || signup;
    const blocked =
      currentPassword || oneTimeCode || (!registration && (passwords.length > 0 || /\b(login|connexion|sign in|signin)\b/.test(context)));
    const reset = /\b(reset|reinitialiser|reinitialisation|recover|recuperer|change password|changer le mot de passe)\b/.test(wording);
    const allowPassword = !blocked && !reset && (signup || identity || (newPassword && keys.has("email")));
    return { blocked, allowPassword, passwordPeers: inputs.filter((el) => classify(el) === "password") };
  }
  function fill(data, options = {}) {
    const report = { filled: 0, preserved: 0, rejected: 0, detected: 0, unchanged: 0, excluded: 0 };
    const selectedFields = new Set((Array.isArray(options.fields) ? options.fields : fieldKeys).filter((key) => fieldKeys.includes(key)));
    if (!selectedFields.size) return { ...report, emptySelection: true };
    const changes = [];
    const groups = new Map();
    for (const el of scan(root.document)) {
      if (!visible(el)) continue;
      const key = classify(el);
      if (!key || key === "address2") continue;
      const group = el.form || el.closest('[role="form"]') || el.getRootNode();
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push({ el, key });
    }
    const candidates = Array.from(groups, ([group, fields]) => {
      // Resolve "Prénom" + "Nom" before applying the user's field selection.
      if (fields.some((field) => field.key === "firstName") && !fields.some((field) => field.key === "lastName")) {
        for (const field of fields) {
          if (field.key === "fullName" && signals(field.el).some((text) => /^(nom|name|nome|naam)$/.test(text))) field.key = "lastName";
        }
      }
      const keys = new Set(fields.map((field) => field.key));
      const context = normalize(
        [group.id, group.getAttribute?.("name"), group.getAttribute?.("aria-label"), group.getAttribute?.("role")].join(" "),
      );
      const auth = authenticationForm(group, keys, context);
      const blockedAuthentication = auth.blocked;
      const score =
        blockedAuthentication || /\b(search)\b/.test(context)
          ? -1
          : keys.size * 10 + (/contact/.test(context) ? 6 : 0) + (fields.some(({ el }) => el === el.ownerDocument.activeElement) ? 8 : 0);
      return { fields, score, blockedAuthentication, allowPassword: auth.allowPassword, passwordPeers: auth.passwordPeers };
    });
    const ranked = candidates
      .filter((group) => group.score > 0 && group.fields.some((field) => allowed(field.key, selectedFields)))
      .sort((a, b) => b.score - a.score);
    if (!ranked.length)
      return {
        ...report,
        blockedAuthentication: candidates.some(
          (group) => group.blockedAuthentication && group.fields.some((field) => allowed(field.key, selectedFields)),
        ),
        selectionMismatch: candidates.some((group) => group.score > 0),
      };
    const selected = ranked[0].fields;
    const birthOwner = selected[0].el.form || selected[0].el.closest('[role="form"]') || selected[0].el.getRootNode();
    const birthFields = scan(root.document)
      .filter((el) => visible(el, false) && (el.form || el.closest('[role="form"]') || el.getRootNode()) === birthOwner)
      .map((el) => ({ el, key: classifyBirth(el) }))
      .filter((field) => field.key);
    const birthPlans = birthFields.map((field) => ({ ...field, value: proposedValue(field.el, field.key, data) }));
    let birthIssue = null;
    if (selectedFields.has("birthDate") && birthPlans.length) {
      if (birthPlans.some(({ el, value }) => !visible(el) && el.value !== value)) birthIssue = "preserved";
      else if (birthPlans.some((plan) => plan.value === null)) birthIssue = "constraints";
      else if (
        !options.overwrite &&
        birthPlans.some(
          ({ el, value }) =>
            el.value.trim() &&
            el.value !== value &&
            !(
              el.tagName === "SELECT" &&
              (el.selectedOptions[0]?.disabled ||
                /^(choose|select|selectionner|choisir|please select|day|month|year|jour|mois|annee|jj|mm|aaaa)(\s|$)/.test(
                  normalize(el.selectedOptions[0]?.textContent),
                ))
            ),
        )
      )
        birthIssue = "preserved";
    }
    if (birthIssue) report.birthIssue = birthIssue;
    const passwordFields = selected.filter((field) => field.key === "password");
    let passwordIssue = null;
    if (selectedFields.has("password") && passwordFields.length) {
      if (!ranked[0].allowPassword) passwordIssue = "registration";
      else if (
        ranked[0].passwordPeers.some((el) => el.value !== data.password && (el.disabled || el.readOnly || (!options.overwrite && el.value)))
      )
        passwordIssue = "preserved";
      else if (
        passwordFields.some(({ el }) => {
          const value = data.password;
          if (
            typeof value !== "string" ||
            !value ||
            (el.maxLength > -1 && value.length > el.maxLength) ||
            (el.minLength > 0 && value.length < el.minLength)
          )
            return true;
          const probe = el.cloneNode(true);
          probe.value = value;
          return !probe.checkValidity();
        })
      )
        passwordIssue = "constraints";
    }
    if (passwordIssue) report.passwordIssue = passwordIssue;
    for (const { el, key } of selected) {
      if (!allowed(key, selectedFields)) {
        report.excluded++;
        continue;
      }
      report.detected++;
      if (key.startsWith("birth") && birthIssue) {
        if (birthIssue === "preserved") report.preserved++;
        else report.rejected++;
        continue;
      }
      if (key === "username" && !ranked[0].allowPassword) {
        report.excluded++;
        continue;
      }
      if (key === "password" && passwordIssue) {
        if (passwordIssue === "preserved") report.preserved++;
        else if (passwordIssue === "constraints") report.rejected++;
        else report.excluded++;
        continue;
      }
      const existing = String(el.value || "").trim();
      const placeholderSelect =
        el.tagName === "SELECT" &&
        (el.selectedOptions[0]?.disabled ||
          /^(choose|select|selectionner|choisir|please select|day|month|year|jour|mois|annee|jj|mm|aaaa)(\s|$)/.test(
            normalize(el.selectedOptions[0]?.textContent),
          ));
      if (existing && !placeholderSelect && !options.overwrite) {
        report.preserved++;
        continue;
      }
      const value = proposedValue(el, key, data);
      if (typeof value !== "string" || !value || (el.maxLength > -1 && value.length > el.maxLength)) {
        report.rejected++;
        continue;
      }
      const probe = el.cloneNode(true);
      probe.value = value;
      if (!probe.checkValidity()) {
        report.rejected++;
        continue;
      }
      const before = el.value;
      if (before === value) {
        report.unchanged++;
        continue;
      }
      try {
        write(el, value);
        if (el.isConnected && el.value === value) {
          report.filled++;
          changes.push({ el, key, before, after: value, dirty: false });
        } else report.rejected++;
      } catch {
        report.rejected++;
      }
    }
    rememberChanges(changes);
    return report;
  }
  function undo() {
    const report = { restored: 0, skipped: 0, failed: 0, available: false };
    const transaction = lastFill;
    if (!transaction) return report;
    lastFill = null;
    dispose(transaction);
    // Old page values stay in the content-script memory, never in extension storage.
    if (transaction.url !== root.location.href) return report;
    report.available = true;
    const current = new Set(scan(root.document));
    for (const entry of [...transaction.entries].reverse()) {
      const { el, key, before, after, dirty } = entry;
      const cardEntry = key.startsWith("card");
      const currentKind = cardEntry ? classifyCard(el) : classify(el);
      if (
        dirty ||
        !current.has(el) ||
        !visible(el) ||
        !currentKind ||
        (cardEntry || key.startsWith("birth") ? currentKind !== key : (currentKind === "password") !== (key === "password")) ||
        el.value !== after
      ) {
        report.skipped++;
        continue;
      }
      try {
        write(el, before);
        if (el.isConnected && el.value === before) report.restored++;
        else report.failed++;
      } catch {
        report.failed++;
      }
    }
    return report;
  }
  root.ThrowawayFill = { version: "1.6", fill, fillCard, undo, classify };
})(globalThis);
