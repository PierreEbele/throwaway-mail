import { common } from "./messages/common";
import { account } from "./messages/account";
import { admin } from "./messages/admin";
import { rules } from "./messages/rules";
import { domainSetup } from "./messages/domainSetup";
import { ops } from "./messages/ops";
import { auth } from "./messages/auth";
import { settings } from "./messages/settings";
import { security } from "./messages/security";
import { addressPrefs } from "./messages/addressPrefs";
import { destinations } from "./messages/destinations";
import { push } from "./messages/push";
import { overview } from "./messages/overview";
import { newAddress } from "./messages/newAddress";
import { mailbox } from "./messages/mailbox";
import { menus } from "./messages/menus";
import { address } from "./messages/address";
import { addressHeader } from "./messages/addressHeader";
import { addressCards } from "./messages/addressCards";
import { messages } from "./messages/messages";

/** All catalog areas, one entry per file in ./messages. */
const areas = {
  common,
  account,
  admin,
  rules,
  domainSetup,
  ops,
  auth,
  settings,
  security,
  addressPrefs,
  destinations,
  push,
  overview,
  newAddress,
  mailbox,
  menus,
  address,
  addressHeader,
  addressCards,
  messages,
};

type Areas = typeof areas;
const pick = <L extends "en" | "fr">(lang: L) =>
  Object.fromEntries(Object.entries(areas).map(([k, v]) => [k, v[lang]])) as { [K in keyof Areas]: Areas[K][L] };

export const en = pick("en");
export const fr = pick("fr");
