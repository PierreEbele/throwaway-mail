export type Role = "admin" | "user";
export interface User { id: string; email: string; role: Role; disabled: boolean; created_at: number }
export type AddressStatus = "active" | "paused" | "archived";
export interface Address {
  id: string; email: string; local_part: string; domain: string; domain_id: string;
  site_name: string; site_url: string | null; label: string | null;
  forward_enabled: boolean; destination_id: string | null; status: AddressStatus; is_unassigned: boolean;
  expires_at: number | null; created_at: number; updated_at: number; last_message_at: number | null;
  unread_count: number; message_count: number;
}
export interface MessageSummary {
  id: string; address_id: string; from: string | null; from_name: string | null; subject: string | null;
  received_at: number; read_at: number | null; forwarded: boolean; preview: string; code: string | null; has_links: boolean;
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
  cf_zone_id?: string | null; status_detail?: string | null; dns_missing?: DnsRecord[]; created_at?: number; last_checked_at?: number | null;
}
export interface Destination { id: string; email: string; verified: boolean; verified_at: number | null; last_error: string | null; created_at: number }
export interface ApiKey { id: string; name: string; prefix: string; created_at: number; last_used_at: number | null; revoked_at: number | null }
export interface Invite { id: string; email: string | null; role: Role; created_at: number; expires_at: number; used_at: number | null; state: "pending" | "used" | "expired" }
export interface AuditEntry { id: string; user_id: string | null; action: string; target: string | null; meta: unknown; ip: string | null; created_at: number }
