import type { RuleCondition } from "../../types";
import { authLabels, conditionLabels, defaultCondition } from "./describe";
import { useT } from "../../i18n";

export function ConditionRow({
  c,
  onChange,
  onRemove,
  categories,
}: {
  c: RuleCondition;
  onChange: (c: RuleCondition) => void;
  onRemove?: () => void;
  categories: Array<{ id: string; name: string }>;
}) {
  const t = useT().rules.condition;
  const tc = useT().common;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={t.condition}
        className="input w-auto"
        value={c.type}
        onChange={(e) => onChange({ ...defaultCondition(e.target.value as RuleCondition["type"]), negate: c.negate })}
      >
        {Object.entries(conditionLabels()).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      <select
        aria-label={t.isOrNot}
        className="input w-auto"
        value={c.negate ? "not" : "is"}
        onChange={(e) => onChange({ ...c, negate: e.target.value === "not" })}
      >
        <option value="is">{t.yes}</option>
        <option value="not">{t.not}</option>
      </select>
      {c.type === "sender" && (
        <select
          aria-label={t.comparison}
          className="input w-auto"
          value={c.op}
          onChange={(e) => onChange({ ...c, op: e.target.value as "is" | "contains" | "ends_with" })}
        >
          <option value="is">{t.is}</option>
          <option value="contains">{t.contains}</option>
          <option value="ends_with">{t.endsWith}</option>
        </select>
      )}
      {(c.type === "sender" || c.type === "sender_domain" || c.type === "subject_contains" || c.type === "recipient_matches") && (
        <input
          aria-label={t.value}
          className={`input w-56 ${c.type === "recipient_matches" ? "font-mono" : ""}`}
          required
          maxLength={200}
          placeholder={
            c.type === "sender_domain"
              ? "example.com"
              : c.type === "recipient_matches"
                ? "^shop-"
                : c.type === "sender"
                  ? "news@example.com"
                  : t.subjectPlaceholder
          }
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
        />
      )}
      {c.type === "recipient_matches" && <span className="text-xs text-zinc-500">{t.regexHelp}</span>}
      {c.type === "category" && (
        <select
          aria-label={t.category}
          className="input w-auto"
          required
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
        >
          <option value="">{tc.choose}</option>
          {categories.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      )}
      {c.type === "size_over_kb" && (
        <input
          aria-label={t.size}
          type="number"
          min={0}
          className="input w-28"
          value={c.value}
          onChange={(e) => onChange({ ...c, value: Math.max(0, Number(e.target.value) || 0) })}
        />
      )}
      {(c.type === "header_exists" || c.type === "header_equals") && (
        <input
          aria-label={t.headerName}
          className="input w-44 font-mono"
          required
          placeholder="List-Id"
          pattern="[A-Za-z0-9-]+"
          value={c.name}
          onChange={(e) => onChange({ ...c, name: e.target.value })}
        />
      )}
      {c.type === "header_equals" && (
        <input
          aria-label={t.headerValue}
          className="input w-44"
          placeholder={t.valuePlaceholder}
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
        />
      )}
      {c.type === "auth_failed" && (
        <select
          aria-label={t.which}
          className="input w-auto"
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value as "any" | "spf" | "dkim" | "dmarc" })}
        >
          {Object.entries(authLabels()).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      )}
      {onRemove && (
        <button type="button" className="btn-ghost text-sm" aria-label={t.remove} onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  );
}
