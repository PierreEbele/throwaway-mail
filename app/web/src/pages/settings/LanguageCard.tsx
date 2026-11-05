import { LANGS, useLang, useT, type Lang } from "../../i18n";

/** Interface language: detected from the browser at first visit, then kept in this browser. */
export function LanguageCard() {
  const { lang, setLang } = useLang();
  const t = useT().account;
  return (
    <section className="card mt-6 max-w-xl space-y-2 p-5 text-sm">
      <h2 className="font-semibold">{t.languageTitle}</h2>
      <p className="text-zinc-500">{t.languageHelp}</p>
      <label className="sr-only" htmlFor="ui-lang">
        {t.languageTitle}
      </label>
      <select id="ui-lang" className="input w-auto" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
        {Object.entries(LANGS).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
    </section>
  );
}
