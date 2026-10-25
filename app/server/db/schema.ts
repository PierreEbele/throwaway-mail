import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";

/** Users exist only through SSO: created on first OpenID Connect login, role synced from IdP groups. */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  oidcSub: text("oidc_sub").notNull().unique(),
  email: text("email").notNull(),
  name: text("name"),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  lastLoginAt: integer("last_login_at"),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256 of the cookie token
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("api_keys_user_idx").on(t.userId)],
);

export const domains = sqliteTable("domains", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  cfZoneId: text("cf_zone_id"),
  status: text("status", { enum: ["pending", "active", "error"] }).notNull().default("pending"),
  statusDetail: text("status_detail"),
  dnsMissingJson: text("dns_missing_json"),
  unknownPolicy: text("unknown_policy", { enum: ["reject", "inbox", "auto_create"] }).notNull().default("reject"),
  /** Catch-all rule that existed in Cloudflare before the app took it over (JSON), restored when the domain is removed. */
  previousCatchAllJson: text("previous_catch_all_json"),
  /** While set, mail to unknown addresses keeps being forwarded here (the old catch-all) and is queued for review. */
  catchallForwardTo: text("catchall_forward_to"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  lastCheckedAt: integer("last_checked_at"),
});

export const destinations = sqliteTable(
  "destinations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    cfDestinationId: text("cf_destination_id"),
    verifiedAt: integer("verified_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    /** Armored OpenPGP public key: forwarded mail is encrypted for it (PGP/MIME). */
    pgpPublicKey: text("pgp_public_key"),
    pgpFingerprint: text("pgp_fingerprint"),
    /** Replace the visible subject of encrypted forwards with "...". */
    pgpHideSubject: integer("pgp_hide_subject", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("destinations_user_email_uq").on(t.userId, t.email)],
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("zinc"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    /** Comma-separated keywords: new addresses whose site name/URL contains one land in this category. */
    autoMatch: text("auto_match"),
    /** Messages of this category's addresses are deleted after this many days (null: global setting). */
    retentionDays: integer("retention_days"),
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("categories_user_name_uq").on(t.userId, t.name)],
);

export const addresses = sqliteTable(
  "addresses",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    domainId: text("domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
    localPart: text("local_part").notNull(),
    siteName: text("site_name").notNull(),
    siteUrl: text("site_url"),
    label: text("label"),
    forwardEnabled: integer("forward_enabled", { mode: "boolean" }).notNull().default(false),
    destinationId: text("destination_id").references(() => destinations.id, { onDelete: "set null" }),
    status: text("status", { enum: ["active", "paused", "archived"] }).notNull().default("active"),
    isUnassigned: integer("is_unassigned", { mode: "boolean" }).notNull().default(false),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastMessageAt: integer("last_message_at"),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    /** Set when the user dismissed the "never received any mail" suggestion for this address. */
    staleDismissedAt: integer("stale_dismissed_at"),
    /** JSON array of sender domains whose mail is rejected for this address. */
    blockedSendersJson: text("blocked_senders_json"),
    /** JSON array of sender domains accepted as legitimate for this site (no leak warning). */
    trustedSendersJson: text("trusted_senders_json"),
    /** Last sender whose domain does not match the site: the address has probably leaked or been sold. */
    leakSender: text("leak_sender"),
    leakAt: integer("leak_at"),
    /** Reject newsletters / promotional bulk mail (mail with a verification code still gets through). */
    blockPromos: integer("block_promos", { mode: "boolean" }).notNull().default(false),
    /** Only accept mail whose sender domain matches the site (others are rejected and logged as leaks). */
    siteLock: integer("site_lock", { mode: "boolean" }).notNull().default(false),
    /** Pause the address automatically after this many mails. */
    maxMessages: integer("max_messages"),
    /** Pause the address automatically after the first mail with a verification code. */
    burnAfterCode: integer("burn_after_code", { mode: "boolean" }).notNull().default(false),
    /** Why the address was paused automatically ("max_messages", "after_code", "panic"). */
    burnReason: text("burn_reason"),
    burnedAt: integer("burned_at"),
    /** Set when the "expires soon" reminder was sent for the current expires_at. */
    expiryRemindedAt: integer("expiry_reminded_at"),
    /** Secret token of the address's RSS / JSON feed (null: feed disabled). */
    feedToken: text("feed_token").unique(),
  },
  (t) => [uniqueIndex("addresses_domain_local_uq").on(t.domainId, t.localPart), index("addresses_user_idx").on(t.userId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    addressId: text("address_id").notNull().references(() => addresses.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    messageIdHeader: text("message_id_header"),
    envelopeFrom: text("envelope_from"),
    envelopeTo: text("envelope_to").notNull(),
    fromAddr: text("from_addr"),
    fromName: text("from_name"),
    subject: text("subject"),
    receivedAt: integer("received_at").notNull(),
    text: text("text"),
    html: text("html"),
    rawSize: integer("raw_size").notNull(),
    headersJson: text("headers_json"),
    spf: text("spf"),
    dkim: text("dkim"),
    dmarc: text("dmarc"),
    readAt: integer("read_at"),
    archivedAt: integer("archived_at"),
    forwarded: integer("forwarded", { mode: "boolean" }).notNull().default(false),
    forwardTo: text("forward_to"),
    /** sha256 of sender + subject + body: deduplicates retried deliveries of mail without a Message-ID. */
    bodyHash: text("body_hash"),
    /** JSON [{filename, mime_type, size}] — attachments are not stored, only described. */
    attachmentsJson: text("attachments_json"),
    /** Tracking pixels and tracking link parameters removed from the stored HTML. */
    trackersRemoved: integer("trackers_removed").notNull().default(0),
    /** "auth_failed" | "lookalike": possible phishing. */
    authWarning: text("auth_warning"),
    /** Newsletter / bulk mail (List-Unsubscribe, List-Id, Precedence: bulk). */
    isBulk: integer("is_bulk", { mode: "boolean" }).notNull().default(false),
    unsubscribeUrl: text("unsubscribe_url"),
    unsubscribeMailto: text("unsubscribe_mailto"),
    unsubscribeOneClick: integer("unsubscribe_one_click", { mode: "boolean" }).notNull().default(false),
    unsubscribedAt: integer("unsubscribed_at"),
  },
  (t) => [
    uniqueIndex("messages_address_msgid_uq").on(t.addressId, t.messageIdHeader),
    index("messages_address_received_idx").on(t.addressId, t.receivedAt),
    index("messages_user_idx").on(t.userId),
    index("messages_received_idx").on(t.receivedAt),
  ],
);

export const extractedItems = sqliteTable(
  "extracted_items",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["code", "link"] }).notNull(),
    value: text("value").notNull(),
    confidence: real("confidence").notNull(),
    method: text("method").notNull(),
    label: text("label"),
    rank: integer("rank").notNull().default(0),
  },
  (t) => [index("extracted_message_idx").on(t.messageId)],
);

/** Extra forwarding destinations of an address (mail goes to every verified one). */
export const addressDestinations = sqliteTable(
  "address_destinations",
  {
    addressId: text("address_id").notNull().references(() => addresses.id, { onDelete: "cascade" }),
    destinationId: text("destination_id").notNull().references(() => destinations.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("address_destinations_uq").on(t.addressId, t.destinationId)],
);

/**
 * On-the-fly addresses: mail to <name>.<site>@domain creates an address for <site>
 * owned by the directory's user, without visiting the app first.
 */
export const directories = sqliteTable("directories", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

/** Smart folders: a named set of /v1/addresses filters shown in the sidebar. */
export const savedSearches = sqliteTable(
  "saved_searches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** JSON object of /v1/addresses query parameters. */
    paramsJson: text("params_json").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("saved_searches_user_idx").on(t.userId)],
);

/** Where to push events: ntfy / Gotify / Telegram, or a signed generic webhook. */
export const notifyTargets = sqliteTable(
  "notify_targets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["ntfy", "gotify", "telegram", "webhook"] }).notNull(),
    name: text("name").notNull(),
    /** ntfy topic URL, Gotify server URL or webhook URL (unused for Telegram). */
    url: text("url"),
    /** ntfy access token, Gotify app token or Telegram bot token. */
    token: text("token"),
    /** Telegram chat id. */
    chatId: text("chat_id"),
    /** HMAC secret for webhooks. */
    secret: text("secret"),
    /** JSON array of event types. */
    eventsJson: text("events_json").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastOkAt: integer("last_ok_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("notify_targets_user_idx").on(t.userId)],
);

/** Every mail whose sender does not match the address's site (the address column only keeps the latest). */
export const leakEvents = sqliteTable(
  "leak_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    addressId: text("address_id").notNull().references(() => addresses.id, { onDelete: "cascade" }),
    sender: text("sender").notNull(),
    senderDomain: text("sender_domain").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [index("leak_events_user_idx").on(t.userId, t.senderDomain), index("leak_events_address_idx").on(t.addressId)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    action: text("action").notNull(),
    target: text("target"),
    metaJson: text("meta_json"),
    ip: text("ip"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Domain = typeof domains.$inferSelect;
export type Address = typeof addresses.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Destination = typeof destinations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NotifyTarget = typeof notifyTargets.$inferSelect;
export type ExtractedItem = typeof extractedItems.$inferSelect;
