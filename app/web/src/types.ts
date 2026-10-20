export type Role = "admin" | "user";
export interface User { id: string; email: string; name: string | null; role: Role; disabled: boolean; created_at: number; last_login_at: number | null }
export type AddressStatus = "active" | "paused" | "archived";
export interface Address {
  id: string; email: string; local_part: string; domain: string; domain_id: string;
  site_name: string; site_url: string | null; label: string | null;
  forward_enabled: boolean; destination_id: string | null; status: AddressStatus; is_unassigned: boolean;
  expires_at: number | null; created_at: number; updated_at: number; last_message_at: number | null;
  unread_count: number; message_count: number; category_id: string | null; pinned: boolean;
  blocked_senders: string[]; trusted_senders: string[]; block_promos: boolean; site_lock: boolean; max_messages: number | null; burn_after_code: boolean;
  burned: { reason: string; at: number } | null; leak: { sender: string; at: number } | null;
}
export type CategoryColor = "zinc" | "red" | "orange" | "amber" | "green" | "teal" | "blue" | "indigo" | "violet" | "pink";
export interface Category { id: string; name: string; color: CategoryColor; pinned: boolean; hidden: boolean; auto_match: string | null; retention_days: number | null; position: number; created_at: number; address_count: number; unread_count: number }
export interface MessageSummary {
  id: string; address_id: string; from: string | null; from_name: string | null; subject: string | null;
  received_at: number; read_at: number | null; archived_at: number | null; forwarded: boolean; preview: string; code: string | null; has_links: boolean;
  attachments: Array<{ filename: string | null; mime_type: string; size: number; inline: boolean }>;
  trackers_removed: number; auth_warning: "auth_failed" | "lookalike" | null; is_bulk: boolean;
  unsubscribe: { url: string | null; mailto: string | null; one_click: boolean; done_at: number | null } | null;
}
export interface ExtractedCode { value: string; confidence: number; method: string; raw: string | null }
export interface ExtractedLink { url: string; label: string | null; confidence: number; method: string }
export interface MessageFull extends MessageSummary {
  envelope_from: string | null; envelope_to: string; forward_to: string | null; raw_size: number;
  auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  text: string | null; html: string | null; headers: Array<{ key: string; value: string }>;
  extracted: { code: ExtractedCode | null; alternatives: ExtractedCode[]; links: ExtractedLink[] };
}
export interface CodeResult {
  code: string | null; confidence: number | null; alternatives: ExtractedCode[]; links: ExtractedLink[];
  message_id: string; received_at: number; subject: string | null; from: string | null;
}
export interface DnsRecord { type: string; name: string; content: string; priority?: number }
export interface Domain {
  id: string; name: string; status: "pending" | "active" | "error"; unknown_policy: "reject" | "inbox" | "auto_create";
  cf_zone_id?: string | null; status_detail?: string | null;
  owner?: { id: string; name: string | null; email: string } | null;
  previous_catch_all?: { enabled: boolean; actions: Array<{ type: string; value?: string[] }> } | null; catchall_forward_to?: string | null; dns_missing?: DnsRecord[]; created_at?: number; last_checked_at?: number | null;
}
export interface Destination { id: string; email: string; verified: boolean; verified_at: number | null; last_error: string | null; created_at: number }
export interface ApiKey { id: string; name: string; prefix: string; created_at: number; last_used_at: number | null; revoked_at: number | null }
export interface AuditEntry { id: string; user_id: string | null; action: string; target: string | null; meta: unknown; ip: string | null; created_at: number }
export interface AddressStats {
  total: number; unread: number; with_code: number; first_at: number | null; last_at: number | null;
  per_week: number[]; top_senders: Array<{ domain: string; count: number }>;
}
export interface Digest {
  days: number; since: number; received: number; created: Address[]; leaks: Address[]; silent: Address[]; expiring: Address[];
  busiest: Array<{ address: Address; count: number }>;
}
export interface LeakGroup { sender_domain: string; count: number; first_at: number; last_at: number; senders: string[]; addresses: Address[] }
export type NotifyKind = "ntfy" | "gotify" | "telegram" | "webhook";
export interface NotifyTarget {
  id: string; kind: NotifyKind; name: string; url: string | null; chat_id: string | null; has_token: boolean; secret: string | null;
  events: string[]; enabled: boolean; last_ok_at: number | null; last_error: string | null; created_at: number;
}
export interface SavedSearch { id: string; name: string; params: Record<string, string>; position: number; created_at: number }
