import { area } from "../widen";

export const account = area(
  {
    title: "Account",
    signedInAs: "Signed in as",
    since: (created: string, last: string) => `Member since ${created} · last sign-in ${last}`,
    local: "Local account: an admin manages your role.",
    sso: (p: string) =>
      `Your identity, password and two-factor settings are managed by ${p}. Your role here follows your ${p} groups and is refreshed at every sign-in.`,
    languageTitle: "Language",
    languageHelp: "Language of this interface. Detected from your browser at first visit, then remembered in this browser.",
  },
  {
    title: "Compte",
    signedInAs: "Connecté en tant que",
    since: (created, last) => `Membre depuis le ${created} · dernière connexion ${last}`,
    local: "Compte local : un administrateur gère votre rôle.",
    sso: (p) =>
      `Votre identité, votre mot de passe et la double authentification sont gérés par ${p}. Votre rôle ici suit vos groupes ${p} et est actualisé à chaque connexion.`,
    languageTitle: "Langue",
    languageHelp: "Langue de cette interface. Détectée depuis votre navigateur à la première visite, puis mémorisée dans ce navigateur.",
  },
);
