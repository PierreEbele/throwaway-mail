// Chrome MV3 background entry (Firefox loads the same files through "background.scripts").
importScripts(
  "compat.js",
  "generator.js",
  "throwaway.js",
  "providers/index.js",
  "providers/local.js",
  "providers/throwaway.js",
  "providers/simplelogin.js",
  "providers/addy.js",
  "providers/firefox-relay.js",
  "providers/fastmail.js",
  "providers/forward-email.js",
  "providers/duckduckgo.js",
  "background.js",
);
