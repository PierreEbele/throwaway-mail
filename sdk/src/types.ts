// Response models mirror the API's JSON exactly (snake_case). Timestamps are epoch milliseconds.

export type AddressStatus = "active" | "paused" | "archived";
export type CategoryColor = "zinc" | "red" | "orange" | "amber" | "green" | "teal" | "blue" | "indigo" | "violet" | "pink";

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
  category_id: string | null;
  pinned: boolean;
  blocked_senders: string[];
  trusted_senders: string[];
  block_promos: boolean;
  site_lock: boolean;
  feed_token: string | null;
  max_messages: number | null;
  burn_after_code: boolean;
  /** Reverse-alias replies (forwarded mail carries a per-sender reply address). */
  replies_enabled: boolean;
  /** Single-address responses only: why replies cannot be enabled (null: they can). */
  replies_unavailable?: string | null;
  burned: { reason: string; at: number | null } | null;
  leak: { sender: string; at: number | null } | null;
  unread_count: number;
  message_count: number;
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

export interface Attachment {
  filename: string | null;
  mime_type: string;
  size: number;
  inline: boolean;
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
  attachments: Attachment[];
  preview: string;
  trackers_removed: number;
  auth_warning: string | null;
  is_bulk: boolean;
  unsubscribe: { url: string | null; mailto: string | null; one_click: boolean; done_at: number | null } | null;
  code: string | null;
  has_links: boolean;
}

export interface Message extends MessageSummary {
  envelope_from: string | null;
  envelope_to: string | null;
  forward_to: string | null;
  raw_size: number;
  auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  text: string | null;
  html: string | null;
  headers: Array<{ key: string; value: string }>;
  extracted: { code: ExtractedCode | null; alternatives: ExtractedCode[]; links: ExtractedLink[] };
}

/** Result of `GET /v1/addresses/:id/code`. */
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

export interface SmartFolder {
  id: string;
  name: string;
  params: Record<string, string>;
  position: number;
  created_at: number;
}

export interface Directory {
  id: string;
  name: string;
  created_at: number;
}

export interface Destination {
  id: string;
  email: string;
  verified: boolean;
  verified_at: number | null;
  last_error: string | null;
  created_at: number;
  pgp: { fingerprint: string; hide_subject: boolean } | null;
}

export type NotifyKind = "ntfy" | "gotify" | "telegram" | "webhook" | "webpush";
export type NotifyEvent =
  | "message.received"
  | "code.received"
  | "leak.detected"
  | "address.expiring"
  | "address.burned"
  | "system.alert"
  | "message.sent"
  | "address.created"
  | "address.deleted"
  | "address.expired"
  | "message.blocked"
  | "forward.failed";

export interface NotifyTarget {
  id: string;
  kind: NotifyKind;
  name: string;
  url: string | null;
  chat_id: string | null;
  has_token: boolean;
  secret: string | null;
  events: NotifyEvent[];
  enabled: boolean;
  last_ok_at: number | null;
  last_error: string | null;
  /** Webhooks: deliveries that failed for good in a row. */
  consecutive_failures: number;
  /** Webhooks: set when paused automatically after repeated failures. */
  paused_at: number | null;
  created_at: number;
}

export interface WebhookDelivery {
  id: string;
  event_id: string;
  event_type: NotifyEvent;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  next_attempt_at: number | null;
  last_status: number | null;
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
  payload: WebhookPayload;
}

/** Body of every webhook request (see docs/api.md). */
export interface WebhookPayload {
  id: string;
  type: NotifyEvent;
  created_at: number;
  title: string;
  body: string;
  url: string | null;
  data: Record<string, unknown>;
}

export interface AddressStats {
  total: number;
  unread: number;
  with_code: number;
  first_at: number | null;
  last_at: number | null;
  /** Message counts for the last 12 weeks, oldest first. */
  per_week: number[];
  top_senders: Array<{ domain: string; count: number }>;
}

export interface Leak {
  sender_domain: string;
  count: number;
  first_at: number;
  last_at: number;
  senders: string[];
  addresses: Address[];
}

export interface Digest {
  days: number;
  since: number;
  received: number;
  created: Address[];
  busiest: Array<{ address: Address; count: number }>;
  leaks: Address[];
  expiring: Address[];
  silent: Address[];
}

export interface ExportCategory {
  name: string;
  color?: CategoryColor;
  pinned?: boolean;
  hidden?: boolean;
  auto_match?: string | null;
  retention_days?: number | null;
}

export interface ExportAddress {
  email: string;
  site_name: string;
  site_url?: string | null;
  label?: string | null;
  status?: AddressStatus;
  pinned?: boolean;
  category?: string | null;
  expires_at?: number | null;
  blocked_senders?: string[];
  trusted_senders?: string[];
  created_at?: number;
}

export interface ExportData {
  version: number;
  exported_at: string;
  categories: ExportCategory[];
  addresses: ExportAddress[];
}

export interface ImportResult {
  categories_created: number;
  addresses_created: number;
  skipped: Array<{ email: string; reason: string }>;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix?: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  [key: string]: unknown;
}

// --- Server-sent events ---------------------------------------------------------------------

export interface MessageReceivedEvent {
  type: "message.received";
  address_id: string;
  message_id: string;
  subject: string | null;
  from: string | null;
  received_at: number;
  has_code: boolean;
}
export interface AddressChangedEvent {
  type: "address.created" | "address.updated" | "address.deleted";
  address_id: string;
}
export interface CategoryChangedEvent {
  type: "category.changed";
}
export type ApiEvent = MessageReceivedEvent | AddressChangedEvent | CategoryChangedEvent;

/** Format of random local parts: `words` (amber-otter-4821), `random`, `word.word` or a `template` ({word}-{rand6}). */
export type AliasFormat = "words" | "random" | "word.word" | "template";
export interface AddressSettings {
  format: AliasFormat;
  /** Length of `random` local parts (6-32). */
  length: number;
  /** `template` format: {word}, {randN}, {digitsN}, {site}. */
  template: string | null;
  /** Applied to new addresses created without an expiry; null = never. */
  default_expires_in_days: number | null;
  /** Applied to new addresses created without max_messages; null = unlimited. */
  default_max_messages: number | null;
}
