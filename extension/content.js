"use strict";
// Script de page (tous les sites, cadre principal) :
//  1. repère un formulaire d'inscription et propose « nouvelle identité + remplir » ;
//  2. si une adresse jetable de ce site attend un code, l'attend et le colle dès qu'il arrive.
// Rien n'est envoyé tant que l'utilisateur ne clique pas ; seule l'attente du code (après un
// remplissage) interroge le serveur Throwaway Mail, via le script de fond.
(() => {
  if (window.top !== window || window.__fableContent) return;
  window.__fableContent = true;

  const SIGNUP_WORDS = /(sign\s?up|register|registration|create (an |your )?account|join|get started|inscri|cr[ée]er (un|votre) compte|nouveau compte|registrieren|crear cuenta)/i;
  const LOGIN_WORDS = /(sign\s?in|log\s?in|connexion|se connecter|anmelden|iniciar sesi)/i;
  const shown = el => !!el && !el.disabled && el.offsetParent !== null && el.getClientRects().length > 0;

  function signupForm() {
    const inputs = [...document.querySelectorAll("input")].filter(shown);
    const passwords = inputs.filter(el => el.type === "password");
    const emails = inputs.filter(el => el.type === "email" || /e-?mail|courriel/i.test(`${el.name} ${el.id} ${el.autocomplete} ${el.placeholder}`));
    if (inputs.some(el => el.autocomplete === "new-password") || passwords.length >= 2) return true;
    if (!emails.length) return false;
    const scope = (emails[0].closest("form") || document.body);
    const text = `${location.pathname} ${document.title} ${(scope.innerText || "").slice(0, 3000)}`;
    if (passwords.some(el => el.autocomplete === "current-password")) return false;
    return SIGNUP_WORDS.test(text) && !(LOGIN_WORDS.test(document.title) && !SIGNUP_WORDS.test(document.title));
  }

  // ---------- Interface (Shadow DOM) ----------
  let host = null, root = null;
  function ui() {
    if (root) return root;
    host = document.createElement("fable-throwaway");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px";
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host{all:initial}
      .card{font:13px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#18181b;background:#fff;border:1px solid #e4e4e7;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.12);padding:12px 14px;width:300px;animation:in .16s ease-out}
      @keyframes in{from{opacity:0;transform:translateY(6px)}}
      .top{display:flex;align-items:center;gap:8px;margin-bottom:6px}
      .mark{width:18px;height:18px;border-radius:5px;background:#18181b;color:#fff;display:grid;place-items:center;font:700 11px ui-monospace,monospace}
      .title{font-weight:600;flex:1}
      .x{all:unset;cursor:pointer;color:#71717a;padding:2px 6px;border-radius:6px}.x:hover{background:#f4f4f5}
      p{margin:0 0 10px;color:#52525b}
      .code{font:600 22px ui-monospace,monospace;letter-spacing:3px;margin:4px 0 10px;color:#18181b}
      .row{display:flex;gap:6px}
      button.b{all:unset;cursor:pointer;text-align:center;padding:7px 10px;border-radius:8px;font-weight:600;font-size:12px}
      .primary{background:#18181b;color:#fff;flex:1}.primary:hover{background:#3f3f46}
      .ghost{color:#3f3f46;border:1px solid #e4e4e7}.ghost:hover{background:#f4f4f5}
      .muted{color:#71717a;font-size:11px}
      .spin{display:inline-block;width:8px;height:8px;border-radius:50%;background:#16a34a;margin-right:6px;animation:p 1.2s infinite}
      @keyframes p{50%{opacity:.25}}
      @media (prefers-color-scheme:dark){.card{background:#18181b;color:#fafafa;border-color:#3f3f46}.mark{background:#fafafa;color:#18181b}p{color:#a1a1aa}.code{color:#fafafa}.primary{background:#fafafa;color:#18181b}.primary:hover{background:#d4d4d8}.ghost{color:#e4e4e7;border-color:#3f3f46}.ghost:hover,.x:hover{background:#27272a}}
    </style><div class="card" part="card"></div>`;
    document.documentElement.append(host);
    return root;
  }
  function render(html) {
    const card = ui().querySelector(".card");
    card.innerHTML = `<div class="top"><span class="mark">F</span><span class="title">Fable</span><button class="x" data-a="close" title="Fermer">✕</button></div>${html}`;
    return card;
  }
  function close() { host?.remove(); host = root = null; }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const send = msg => browser.runtime.sendMessage(msg);

  // ---------- 1. Proposition d'inscription ----------
  let proposed = false;
  function propose() {
    if (proposed || !signupForm()) return;
    proposed = true;
    const card = render(`<p>Formulaire d’inscription détecté. Générer une nouvelle identité et la remplir ?</p>
      <div class="row"><button class="b primary" data-a="fill">Générer et remplir</button><button class="b ghost" data-a="later">Plus tard</button></div>
      <p class="muted" style="margin:8px 0 0"><a data-a="never" href="#" style="color:inherit">Ne plus proposer sur ce site</a></p>`);
    card.addEventListener("click", async e => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (!a) return;
      e.preventDefault();
      if (a === "close" || a === "later") return close();
      if (a === "never") { await send({ type: "dismiss-host" }); return close(); }
      if (a === "fill") {
        render(`<p><span class="spin"></span>Création de l’identité…</p>`);
        const r = await send({ type: "fill-new" }).catch(err => ({ error: err.message }));
        if (r?.error) return render(`<p>${esc(r.error)}</p><div class="row"><button class="b ghost" data-a="close">Fermer</button></div>`).addEventListener("click", close);
        const n = r?.report?.filled || 0;
        if (r?.bitwarden) {
          render(`<p><strong>${esc(r.name)}</strong></p><p>${n} champ${n > 1 ? "s" : ""} rempli${n > 1 ? "s" : ""}. Remplissez maintenant l’e-mail (générateur d’alias) et le mot de passe avec Bitwarden.</p><p class="muted">Le code sera collé dès son arrivée.</p>`)
            .addEventListener("click", e2 => e2.target.closest("[data-a=close]") && close());
          return void watchEmail();
        }
        render(`<p><strong>${esc(r.name)}</strong><br><span class="muted">${esc(r.email)}</span></p><p>${n} champ${n > 1 ? "s" : ""} rempli${n > 1 ? "s" : ""}. Vérifiez puis validez le formulaire vous-même.</p>`)
          .addEventListener("click", e2 => e2.target.closest("[data-a=close]") && close());
        void watchCode();
      }
    });
  }

  // Mode Bitwarden : attendre que l'e-mail soit rempli, puis vérifier que c'est une de nos adresses.
  let watchingEmail = false;
  async function watchEmail() {
    if (watchingEmail) return;
    watchingEmail = true;
    const tried = new Set();
    try {
      for (let i = 0; i < 600; i++) { // 10 min
        await new Promise(res => setTimeout(res, 1000));
        const values = [...document.querySelectorAll("input")].filter(el => el.type === "email" || /e-?mail|courriel/i.test(`${el.name} ${el.id} ${el.autocomplete} ${el.placeholder}`))
          .map(el => el.value.trim().toLowerCase()).filter(v => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(v) && !tried.has(v));
        for (const email of values) {
          tried.add(email);
          const r = await send({ type: "adopt-email", email }).catch(() => null);
          if (r?.ok) {
            render(`<p>Adresse jetable reconnue : <span class="muted">${esc(r.email)}</span></p><p class="muted">Validez le formulaire ; le code sera collé dès son arrivée.</p>`)
              .addEventListener("click", e => e.target.closest("[data-a=close]") && close());
            return void watchCode();
          }
        }
      }
    } finally { watchingEmail = false; }
  }

  // ---------- 2. Attente et collage du code ----------
  function codeTarget(len) {
    const inputs = [...document.querySelectorAll("input")].filter(el => shown(el) && !el.readOnly && !["hidden", "password", "email", "checkbox", "radio", "submit", "button"].includes(el.type));
    const boxes = inputs.filter(el => el.maxLength === 1);
    if (len > 1 && boxes.length >= len) return { boxes };
    const hint = /code|otp|token|verif|pin|2fa|mfa|one.?time|confirm/i;
    const el = inputs.find(i => i.autocomplete === "one-time-code") || inputs.find(i => hint.test(`${i.name} ${i.id} ${i.placeholder} ${i.getAttribute("aria-label") || ""}`))
      || inputs.find(isOtpShape);
    return el ? { el } : null;
  }
  // Champ « code à usage unique » sans indice dans le nom : numérique et 4 à 8 caractères.
  const isOtpShape = i => i.maxLength >= 4 && i.maxLength <= 8 && (i.inputMode === "numeric" || i.getAttribute("pattern") === "[0-9]*" || i.type === "number");
  // Détection stricte (pour proposer le code sans attente en cours) : évite les champs « code promo ».
  function otpField() {
    const inputs = [...document.querySelectorAll("input")].filter(el => shown(el) && !el.readOnly && ["text", "number", "tel", ""].includes(el.type));
    const hint = /\b(otp|2fa|mfa)\b|one.?time|verif|(^|[^a-z])code/i;
    const boxes = inputs.filter(el => el.maxLength === 1 && (el.inputMode === "numeric" || el.type === "tel" || el.type === "number" || el.autocomplete === "one-time-code"));
    return inputs.find(i => i.autocomplete === "one-time-code")
      || inputs.find(i => hint.test(`${i.name} ${i.id} ${i.placeholder}`) && !/promo|coupon|postal|zip|gift|referr/i.test(`${i.name} ${i.id} ${i.placeholder}`) && !(i.maxLength >= 0 && i.maxLength < 4))
      || inputs.find(isOtpShape)
      || (boxes.length >= 4 && boxes.length <= 8 ? boxes[0] : null);
  }

  // ---------- 3. Puce « Remplir le code » près d'un champ de code ----------
  let chip = null;
  function showChip(field, code) {
    chip?.remove();
    chip = document.createElement("fable-throwaway-chip");
    const r = field.getBoundingClientRect();
    chip.style.cssText = `all:initial;position:absolute;z-index:2147483647;left:${Math.round(r.left + scrollX)}px;top:${Math.round(r.bottom + scrollY + 4)}px`;
    const sh = chip.attachShadow({ mode: "closed" });
    sh.innerHTML = `<style>button{all:unset;cursor:pointer;font:600 12px ui-sans-serif,system-ui,sans-serif;background:#18181b;color:#fff;padding:5px 10px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.18)}button:hover{background:#3f3f46}span{font-family:ui-monospace,monospace;letter-spacing:1px}</style><button title="Throwaway Mail">Remplir le code <span>${esc(code)}</span></button>`;
    sh.querySelector("button").addEventListener("click", e => {
      e.preventDefault();
      pasteCode(code);
      usedCodes.add(code);
      chip?.remove(); chip = null;
    });
    document.documentElement.append(chip);
  }
  let offering = false;
  const usedCodes = new Set();
  let lastOffer = 0;
  async function offerCode() {
    if (offering || watching || usedCodes.size || Date.now() - lastOffer < 60_000) return;
    const field = otpField();
    if (!field) return;
    offering = true;
    try {
      for (let i = 0; i < 15 && !watching; i++) { // ~5 min (20 s par appel)
        const r = await send({ type: "site-code", wait: i ? 20 : 0 }).catch(() => ({ error: "extension" }));
        if (r?.done) return;
        if (r?.code) { const f = otpField(); if (f && !usedCodes.has(r.code)) showChip(f, r.code); return; }
        if (r?.error) await new Promise(res => setTimeout(res, 5000));
        if (!otpField()) return;
      }
    } finally { offering = false; lastOffer = Date.now(); }
  }
  function setValue(el, v) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function pasteCode(code) {
    const t = codeTarget(code.length);
    if (!t) return false;
    if (t.boxes) code.split("").forEach((ch, i) => setValue(t.boxes[i], ch));
    else { setValue(t.el, code); t.el.focus(); }
    return true;
  }
  function showCode(code, pasted) {
    const card = render(`<p>${pasted ? "Code reçu et collé dans la page." : "Code reçu. Aucun champ de code trouvé sur cette page."}</p><div class="code">${esc(code)}</div>
      <div class="row"><button class="b ${pasted ? "ghost" : "primary"}" data-a="copy">Copier</button>${pasted ? "" : `<button class="b ghost" data-a="retry">Coller</button>`}</div>`);
    card.addEventListener("click", async e => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "close") close();
      if (a === "copy") { await navigator.clipboard.writeText(code).catch(() => {}); e.target.textContent = "Copié"; }
      if (a === "retry" && pasteCode(code)) showCode(code, true);
    });
  }
  let watching = false;
  async function watchCode() {
    if (watching) return;
    watching = true;
    try {
      for (let i = 0; i < 45; i++) { // ~15 min au plus (20 s par appel)
        const r = await send({ type: "poll-code" }).catch(() => ({ error: "extension" }));
        if (r?.done) return;
        if (r?.code) {
          let pasted = pasteCode(r.code);
          // La page de saisie du code apparaît parfois juste après : on réessaie quelques secondes.
          for (let k = 0; !pasted && k < 10; k++) { await new Promise(res => setTimeout(res, 500)); pasted = pasteCode(r.code); }
          return showCode(r.code, pasted);
        }
        if (r?.link && /^https?:\/\//i.test(r.link)) {
          return render(`<p>E-mail de confirmation reçu (lien, pas de code).</p><div class="row"><a class="b primary" style="all:unset;cursor:pointer;background:#18181b;color:#fff;padding:7px 10px;border-radius:8px;font-weight:600;font-size:12px" href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">Ouvrir le lien</a></div>`)
            .addEventListener("click", e => e.target.closest("[data-a=close]") && close());
        }
        if (r?.error) await new Promise(res => setTimeout(res, 5000));
      }
    } finally { watching = false; }
  }

  // ---------- Démarrage ----------
  send({ type: "state" }).then(state => {
    if (state?.autoCode && !state?.pending) {
      // Champ de code (même sans remplissage préalable) : proposer le dernier code de l'adresse du site.
      let ot = null;
      new MutationObserver(() => { if (!offering && !chip && !ot) ot = setTimeout(() => { ot = null; void offerCode(); }, 800); })
        .observe(document.documentElement, { childList: true, subtree: true });
      void offerCode();
    }
    if (state?.pending) {
      proposed = true; // déjà inscrit sur ce site : on attend le code au lieu de reproposer
      void watchCode();
      return;
    }
    if (!state?.autoPrompt) return;
    // Throttle (pas debounce) : sur les applis web (Discord…) le DOM bouge en continu.
    // On surveille tant que rien n'est proposé, y compris après un changement d'URL sans rechargement.
    let t = null, url = location.href;
    const check = () => {
      t = null;
      if (location.href !== url) { url = location.href; if (!host) proposed = false; }
      propose();
    };
    new MutationObserver(() => { if (!proposed && !t) t = setTimeout(check, 700); })
      .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["type", "autocomplete"] });
    setInterval(() => { if (location.href !== url) check(); }, 1000);
    check();
  }).catch(() => {});

  // Le popup peut demander de surveiller le code après un remplissage manuel.
  browser.runtime.onMessage.addListener(msg => { if (msg?.type === "watch-code") void watchCode(); if (msg?.type === "watch-email") void watchEmail(); });
})();
