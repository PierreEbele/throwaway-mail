export type CheckStatus = "ok" | "warn" | "error";

export interface Check {
  id: string;
  group: "app" | "sign-in" | "cloudflare" | "domains" | "operations";
  title: string;
  status: CheckStatus;
  /** What was found. */
  detail: string;
  /** What to do about it (warn / error). */
  hint?: string;
}

export interface Diagnostics {
  generated_at: number;
  summary: Record<CheckStatus, number>;
  checks: Check[];
}

export const DEFAULT_INGEST_SECRET = "dev-ingest-secret-change-me";
export const CLOUDFLARE_MX = /(^|\.)mx\.cloudflare\.net\.?$/i;
export const DAY = 86400_000;
/** No mail for this long on a domain is worth a warning. */
export const QUIET_DAYS = 14;
/** Newest backup older than this is a warning. */
export const BACKUP_MAX_AGE_DAYS = 2;
export const TIMEOUT_MS = 8000;

export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const ago = (now: number, t: number) => {
  const h = Math.round((now - t) / 3600_000);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};
