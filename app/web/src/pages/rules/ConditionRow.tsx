import type { RuleCondition } from "../../types";
import { AUTH_LABELS, CONDITION_LABELS, defaultCondition } from "./describe";

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
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Condition"
        className="input w-auto"
        value={c.type}
        onChange={(e) => onChange({ ...defaultCondition(e.target.value as RuleCondition["type"]), negate: c.negate })}
      >
        {Object.entries(CONDITION_LABELS).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      <select
        aria-label="Is or is not"
        className="input w-auto"
        value={c.negate ? "not" : "is"}
        onChange={(e) => onChange({ ...c, negate: e.target.value === "not" })}
      >
        <option value="is">yes</option>
        <option value="not">no (the opposite)</option>
      </select>
      {c.type === "sender" && (
        <select
          aria-label="Comparison"
          className="input w-auto"
          value={c.op}
          onChange={(e) => onChange({ ...c, op: e.target.value as "is" | "contains" | "ends_with" })}
        >
          <option value="is">is exactly</option>
          <option value="contains">contains</option>
          <option value="ends_with">ends with</option>
        </select>
      )}
      {(c.type === "sender" || c.type === "sender_domain" || c.type === "subject_contains" || c.type === "recipient_matches") && (
        <input
          aria-label="Value"
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
                  : "invoice"
          }
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
        />
      )}
      {c.type === "recipient_matches" && (
        <span className="text-xs text-zinc-500">A regular expression, checked against the full alias (e.g. ^news\.).</span>
      )}
      {c.type === "category" && (
        <select
          aria-label="Category"
          className="input w-auto"
          required
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
        >
          <option value="">Choose…</option>
          {categories.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      )}
      {c.type === "size_over_kb" && (
        <input
          aria-label="Size in KB"
          type="number"
          min={0}
          className="input w-28"
          value={c.value}
          onChange={(e) => onChange({ ...c, value: Math.max(0, Number(e.target.value) || 0) })}
        />
      )}
      {(c.type === "header_exists" || c.type === "header_equals") && (
        <input
          aria-label="Header name"
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
          aria-label="Header value"
          className="input w-44"
          placeholder="value"
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
        />
      )}
      {c.type === "auth_failed" && (
        <select
          aria-label="Which check"
          className="input w-auto"
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value as keyof typeof AUTH_LABELS })}
        >
          {Object.entries(AUTH_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      )}
      {onRemove && (
        <button type="button" className="btn-ghost text-sm" aria-label="Remove this condition" onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  );
}
