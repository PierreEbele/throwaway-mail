/** Strong keywords: explicitly about a code. Weak: verbs that often precede a code. */
export const STRONG_KEYWORDS = [
  "verification code", "verify code", "security code", "confirmation code", "authentication code", "login code",
  "log-in code", "sign-in code", "sign in code", "signin code", "one-time code", "one time code", "one-time password",
  "one time password", "one-time passcode", "otp", "passcode", "pass code", "access code", "2fa code", "two-factor",
  "2-step", "steam guard code", "steam guard", "auth code", "temporary code", "single-use code", "your code", "the code",
  "code is", "code:", "pin code", "pin:", "your pin", "pin is", "verification code below", "code below",
  // French
  "code de vérification", "code de verification", "votre code", "code de sécurité", "code de securite",
  "code de confirmation", "code d'accès", "code d’accès", "code d'acces", "code de connexion", "code temporaire",
  "à usage unique", "a usage unique", "mot de passe à usage unique", "code unique", "code d'authentification",
  "code d’authentification", "code de validation", "code :", "le code",
];

export const WEAK_KEYWORDS = [
  "code", "verify", "verification", "confirm", "enter", "use this", "type", "authenticate", "sign in", "log in",
  "saisissez", "saisir", "entrez", "entrer", "utilisez", "vérification", "verification", "confirmer", "valider",
  "connexion", "copy",
];

export const ORDER_CONTEXT_RE =
  /(?:order|commande|invoice|facture|ticket|tracking|suivi|colis|ref|réf|référence|reference|n°|numéro|numero|number|no\.|#|id|transaction|case|dossier|account number|customer number|client|ending in|ends in|se terminant par|terminant par|carte|card)\s*(?:number|no\.?|n°|#|id)?\s*[:#°.-]?\s*$/i;

export const PHONE_CONTEXT_RE = /(?:tel|tél|phone|téléphone|telephone|call|appel(?:ez)?|fax|mobile|whatsapp|sms au)\b[^\n]{0,20}$/i;

export const UNIT_AFTER_RE =
  /^\s?(?:px|pt|km|kg|mb|gb|ko|mo|go|points?|pts|items?|articles?|users?|people|personnes|jours|days|hours|heures|minutes|mins?|ans|years|followers|members|membres|stars|étoiles|reviews|avis|calories|steps|pas|m²|sq|ft|miles)\b/i;

export const UPPERCASE_STOPWORDS = new Set([
  "HTTPS", "HTTP", "EMAIL", "VERIFY", "STEAM", "CODE", "PAYPAL", "AMAZON", "GOOGLE", "NOTICE", "IMPORTANT", "ACCOUNT",
  "SECURITY", "DISCORD", "GITHUB", "APPLE", "MICROSOFT", "CONFIRM", "WELCOME", "BONJOUR", "HELLO", "SIGNIN", "LOGIN",
  "PASSWORD", "ACTION", "REQUIRED", "URGENT", "ALERT", "FRANCE", "PARIS", "UNITED", "STATES", "CEDEX", "TODAY", "NOREPLY",
  "REPLY", "SUPPORT", "PRIVACY", "POLICY", "TERMS", "ORANGE", "FREE", "VALIDER", "ACTIVER", "VERIFIER", "COMPTE",
  "SECURITE", "AVERTISSEMENT", "ATTENTION", "INFO", "UPDATE", "NETFLIX", "SPOTIFY", "LINKEDIN", "TWITTER", "FACEBOOK",
  "BUTTON", "CLICK", "HERE", "VALID", "EXPIRES", "MINUTES", "SAMSUNG", "OUTLOOK", "OFFICE", "WINDOWS", "XBOX", "TWITCH",
  "SLACK", "NOTION", "ADOBE", "DROPBOX", "UBER", "AIRBNB", "STRIPE", "SHOPIFY", "LEBONCOIN", "DOCTOLIB", "AMELI", "CAF",
]);

/** "1355 Market Street", "24 rue des Jeûneurs", "410 Terry Avenue" … */
export const STREET_AFTER_RE =
  /^\s+(?:(?:[A-Z][\wà-ÿ.'-]*\s+){0,3}(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|way|drive|dr\.?|lane|ln\.?|place|plaza|parkway|square|suite|floor)\b|(?:rue|avenue|av\.|boulevard|bd|quai|place|allée|chemin|impasse|route|cours)\b)/i;
