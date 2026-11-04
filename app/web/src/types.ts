export type Role = "admin" | "user";
export interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  /** "local": e-mail + password; "sso": single sign-on. */
  auth: "local" | "sso";
  disabled: boolean;
  /** Local accounts: TOTP second factor on. */
  two_factor: boolean;
  created_at: number;
  last_login_at: number | null;
}
export type AddressStatus = "active" | "paused" | "archived";
export interface Address {
  id: string;
  email: string;
  local_part: string;
  domain: string;
  domain_id: string;
  site_name: string;
  site_url: string | null;
  label: string | null;
  forward_enabled: boolean;
  destination_id: string | null;
  status: AddressStatus;
  is_unassigned: boolean;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_message_at: number | null;
  unread_count: number;
  message_count: number;
  category_id: string | null;
  pinned: boolean;
  blocked_senders: string[];
  trusted_senders: string[];
  block_promos: boolean;
  site_lock: boolean;
  feed_token: string | null;
  extra_destination_ids?: string[];
  max_messages: number | null;
  burn_after_code: boolean;
  replies_enabled: boolean;
  /** Destination ids tried in order when forwarding fails (empty: the user's fallback chain). */
  fallback_destination_ids: string[];
  /** Only on single-address responses: why reverse-alias replies cannot be used (null: they can). */
  replies_unavailable?: string | null;
  burned: { reason: string; at: number } | null;
  leak: { sender: string; at: number } | null;
}
export type CategoryColor = "zinc" | "red" | "orange" | "amber" | "green" | "teal" | "blue" | "indigo" | "violet" | "pink";
export interface Category {
  id: string;
  name: string;
  color: CategoryColor;
  pinned: boolean;
  hidden: boolean;
  auto_match: string | null;
  retention_days: number | null;
  position: number;
  created_at: number;
  address_count: number;
  unread_count: number;
}
export interface MessageSummary {
  id: string;
  address_id: string;
  from: string | null;
  from_name: string | null;
  subject: string | null;
  received_at: number;
  read_at: number | null;
  archived_at: number | null;
  forwarded: boolean;
  preview: string;
  code: string | null;
  has_links: boolean;
  attachments: Array<{ filename: string | null; mime_type: string; size: number; inline: boolean }>;
  trackers_removed: number;
  auth_warning: "auth_failed" | "lookalike" | null;
  is_bulk: boolean;
  unsubscribe: { url: string | null; mailto: string | null; one_click: boolean; done_at: number | null } | null;
  quarantined_at: number | null;
  matched_rules: Array<{ id: string; name: string }>;
}
export interface ExtractedCode {
  value: string;
  confidence: number;
  method: string;
  raw: string | null;
}
export interface ExtractedLink {
  url: string;
  label: string | null;
  confidence: number;
  method: string;
}
export interface MessageFull extends MessageSummary {
  envelope_from: string | null;
  envelope_to: string;
  forward_to: string | null;
  raw_size: number;
  auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  text: string | null;
  html: string | null;
  headers: Array<{ key: string; value: string }>;
  /** The original header section as received (null for older mail). */
  raw_headers: string | null;
  extracted: { code: ExtractedCode | null; alternatives: ExtractedCode[]; links: ExtractedLink[] };
}
export interface CodeResult {
  code: string | null;
  confidence: number | null;
  alternatives: ExtractedCode[];
  links: ExtractedLink[];
  message_id: string;
  received_at: number;
  subject: string | null;
  from: string | null;
}
export interface DnsRecord {
  type: string;
  name: string;
  content: string;
  priority?: number;
}
export interface Domain {
  id: string;
  name: string;
  transport: "cloudflare" | "imap";
  status: "pending" | "active" | "error";
  unknown_policy: "reject" | "inbox" | "auto_create";
  mailbox?: Mailbox;
  last_ingest_at?: number | null;
  cf_zone_id?: string | null;
  status_detail?: string | null;
  owner?: { id: string; name: string | null; email: string } | null;
  previous_catch_all?: { enabled: boolean; actions: Array<{ type: string; value?: string[] }> } | null;
  catchall_forward_to?: string | null;
  auto_create_user_id?: string | null;
  auto_create_category_id?: string | null;
  auto_create_category?: string | null;
  dns_missing?: DnsRecord[];
  created_at?: number;
  last_checked_at?: number | null;
}
/** IMAP/SMTP settings of a mailbox domain; passwords are never returned. */
export interface Mailbox {
  imap_host: string;
  imap_port: number;
  imap_tls: boolean;
  imap_user: string;
  has_imap_password: boolean;
  imap_folder: string;
  imap_done_folder: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: "tls" | "starttls" | "none" | null;
  smtp_user: string | null;
  has_smtp_password: boolean;
  smtp_from: string | null;
  poll_seconds: number;
  last_poll_at: number | null;
  last_poll_error: string | null;
}
export interface Destination {
  id: string;
  email: string;
  verified: boolean;
  verified_at: number | null;
  last_error: string | null;
  created_at: number;
  pgp: { fingerprint: string; hide_subject: boolean } | null;
  verification: "cloudflare" | "app";
  verify_sent_at: number | null;
  fallback_position: number | null;
}
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
export interface AuditEntry {
  id: string;
  user_id: string | null;
  user_email: string | null;
  action: string;
  target: string | null;
  meta: unknown;
  ip: string | null;
  created_at: number;
}
export interface AddressStats {
  total: number;
  unread: number;
  with_code: number;
  first_at: number | null;
  last_at: number | null;
  per_week: number[];
  top_senders: Array<{ domain: string; count: number }>;
}
export interface Digest {
  days: number;
  since: number;
  received: number;
  created: Address[];
  leaks: Address[];
  silent: Address[];
  expiring: Address[];
  busiest: Array<{ address: Address; count: number }>;
}
export interface LeakGroup {
  sender_domain: string;
  count: number;
  first_at: number;
  last_at: number;
  senders: string[];
  addresses: Address[];
}
export type NotifyKind = "ntfy" | "gotify" | "telegram" | "webhook";
export interface NotifyTarget {
  id: string;
  kind: NotifyKind;
  name: string;
  url: string | null;
  chat_id: string | null;
  has_token: boolean;
  secret: string | null;
  events: string[];
  enabled: boolean;
  last_ok_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  paused_at: number | null;
  created_at: number;
}
export interface WebhookDelivery {
  id: string;
  event_id: string;
  event_type: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  next_attempt_at: number | null;
  last_status: number | null;
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
  payload: unknown;
}
export interface SmtpPassword {
  id: string;
  name: string;
  hint: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
export interface SendingInfo {
  submission:
    { enabled: false } | { enabled: true; host: string; port: number; security: "starttls" | "implicit" | "none"; username: string };
  rate_limit_per_hour: number;
  max_recipients: number;
  passwords: SmtpPassword[];
}
export interface SavedSearch {
  id: string;
  name: string;
  params: Record<string, string>;
  position: number;
  created_at: number;
}

export type RuleCondition =
  | { type: "sender"; op: "is" | "contains" | "ends_with"; value: string; negate?: boolean }
  | { type: "sender_domain"; value: string; negate?: boolean }
  | { type: "subject_contains"; value: string; negate?: boolean }
  | { type: "recipient_matches"; value: string; negate?: boolean }
  | { type: "category"; value: string; negate?: boolean }
  | { type: "has_attachments"; negate?: boolean }
  | { type: "size_over_kb"; value: number; negate?: boolean }
  | { type: "header_exists"; name: string; negate?: boolean }
  | { type: "header_equals"; name: string; value: string; negate?: boolean }
  | { type: "auth_failed"; value: "any" | "spf" | "dkim" | "dmarc"; negate?: boolean }
  | { type: "is_newsletter"; negate?: boolean }
  | { type: "has_code"; negate?: boolean };
export type RuleAction =
  | { type: "block" }
  | { type: "quarantine" }
  | { type: "strip_attachments" }
  | { type: "forward_to"; destination_id: string }
  | { type: "set_category"; category_id: string }
  | { type: "mark_read" }
  | { type: "block_sender" }
  | { type: "pause_address" }
  | { type: "stop" };
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  match: "all" | "any";
  conditions: RuleCondition[];
  actions: RuleAction[];
  address_id: string | null;
  category_id: string | null;
  match_count: number;
  last_matched_at: number | null;
  created_at: number;
  updated_at: number;
}
export interface RuleTestResult {
  tested: number;
  matched: number;
  results: Array<{
    message_id: string;
    address_id: string;
    from: string | null;
    subject: string | null;
    received_at: number;
    matched: boolean;
  }>;
}
export interface QuarantinedMessage {
  id: string;
  address_id: string;
  address: string;
  site_name: string;
  from: string | null;
  from_name: string | null;
  subject: string | null;
  received_at: number;
  quarantined_at: number;
  matched_rules: Array<{ id: string; name: string }>;
  auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  raw_size: number;
}
export interface DeliveryFailure {
  id: string;
  message_id: string | null;
  address_id: string | null;
  address: string | null;
  subject: string | null;
  from: string | null;
  destination: string;
  transport: "cloudflare" | "smtp";
  kind: "failed" | "rejected" | "bounced";
  reason: string;
  detail: string | null;
  delivered_to: string | null;
  retry_count: number;
  last_retry_at: number | null;
  resolved_at: number | null;
  created_at: number;
  can_retry: boolean;
}
