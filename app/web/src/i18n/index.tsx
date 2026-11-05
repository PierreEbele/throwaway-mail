import { createContext, Fragment, useCallback, useContext, useState, type ReactNode } from "react";
import type { Widen } from "./widen";
import { en, fr } from "./catalog";

/**
 * Lightweight in-house i18n: one typed dictionary per language.
 * `en` is the reference catalog; every other catalog is typed from it (see widen.ts), so a missing or extra key fails typecheck.
 * Entries are plain strings or functions for interpolated / plural text.
 */
export type Messages = Widen<typeof en>;

export const LANGS = { en: "English", fr: "Français" } as const;
export type Lang = keyof typeof LANGS;
const CATALOGS: Record<Lang, Messages> = { en, fr };
const STORAGE_KEY = "lang";

function isLang(v: unknown): v is Lang {
  return typeof v === "string" && v in LANGS;
}

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    // Storage blocked: fall back to the browser language.
  }
  for (const l of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const base = l?.toLowerCase().split("-")[0];
    if (isLang(base)) return base;
  }
  return "en";
}

let current: Lang = detectLang();
document.documentElement.lang = current;

/** Current language, for code outside React components (formatters, plain helpers). */
export const getLang = () => current;
/** Current catalog, for code outside React components. Components use `useT()`. */
export const msg = (): Messages => CATALOGS[current];

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: current, setLang: () => {} });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);
  const setLang = useCallback((l: Lang) => {
    current = l;
    document.documentElement.lang = l;
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Not persisted; the choice still applies to this tab.
    }
    setLangState(l);
  }, []);
  // Keyed on the language so every component, including ones that read `msg()` outside hooks, renders again.
  return (
    <Ctx.Provider value={{ lang, setLang }}>
      <Fragment key={lang}>{children}</Fragment>
    </Ctx.Provider>
  );
}

export const useLang = () => useContext(Ctx);
export function useT(): Messages {
  return CATALOGS[useContext(Ctx).lang];
}
