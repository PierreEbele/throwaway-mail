import { sqliteTable, text, integer, real, blob, uniqueIndex, index, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * Users come from single sign-on (created at the first OpenID Connect login, role synced from IdP groups) or are
 * local accounts with a password (when local login is enabled).
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  /** OpenID Connect subject; null for local accounts. */
  oidcSub: text("oidc_sub").unique(),
  /** scrypt hash ("scrypt$N$r$p$salt$hash"); null for SSO-only accounts. */
  passwordHash: text("password_hash"),
  email: text("email").notNull(),
  name: text("name"),
  role: text("role", { enum: ["admin", "user"] })
    .notNull()
    .default("user"),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  lastLoginAt: integer("last_login_at"),
  /** TOTP secret (base32), "v1:…" when encrypted with APP_SECRET. Set during enrolment, active once totpEnabledAt is set. */
  totpSecret: text("totp_secret"),
  totpEnabledAt: integer("totp_enabled_at"),
  /** Last accepted TOTP time step, so a code cannot be replayed. */
  totpLastStep: integer("totp_last_step"),
  /**
   * JSON array of original header names kept when forwarding (lower case), besides the ones a mail needs to be read.
   * Null: forwards keep every original header.
   */
  forwardHeaderAllowlistJson: text("forward_header_allowlist_json"),
  /** Domain of new addresses when none is given: "first" active domain, a "random" one, or "rotate" through them. */
  domainChoice: text("domain_choice", { enum: ["first", "random", "rotate"] })
    .notNull()
    .default("first"),
  /** Flag addresses that received nothing this many minutes after creation (0: never). */
  noMailWarnMinutes: integer("no_mail_warn_minutes").notNull().default(15),
});

/** One-time two-factor recovery codes (sha256 hashes). */
export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: integer("used_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId)],
);

/** Password accepted, second factor pending: short-lived, limited attempts. id is the sha256 of the token. */
export const loginChallenges = sqliteTable("login_challenges", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  attempts: integer("attempts").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256 of the cookie token
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** One-time invitations to create a local account. */
export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  email: text("email").notNull(),
  role: text("role", { enum: ["admin", "user"] })
    .notNull()
    .default("user"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
});

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
  /** How mail reaches the app: Cloudflare Email Routing + Worker, or polling an IMAP catch-all mailbox. */
  transport: text("transport", { enum: ["cloudflare", "imap"] })
    .notNull()
    .default("cloudflare"),
  cfZoneId: text("cf_zone_id"),
  status: text("status", { enum: ["pending", "active", "error"] })
    .notNull()
    .default("pending"),
  statusDetail: text("status_detail"),
  dnsMissingJson: text("dns_missing_json"),
  unknownPolicy: text("unknown_policy", { enum: ["reject", "inbox", "auto_create"] })
    .notNull()
    .default("reject"),
  /** auto_create policy: owner of the created addresses (null: the domain owner). */
  autoCreateUserId: text("auto_create_user_id").references(() => users.id, { onDelete: "set null" }),
  /** auto_create policy: category of the created addresses (null: matched from the sender like a new address). */
  autoCreateCategoryId: text("auto_create_category_id").references((): AnySQLiteColumn => categories.id, { onDelete: "set null" }),
  /** Catch-all rule that existed in Cloudflare before the app took it over (JSON), restored when the domain is removed. */
  previousCatchAllJson: text("previous_catch_all_json"),
  /** While set, mail to unknown addresses keeps being forwarded here (the old catch-all) and is queued for review. */
  catchallForwardTo: text("catchall_forward_to"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  lastCheckedAt: integer("last_checked_at"),
  /** Last mail received for this domain (any outcome): shows whether MX / Worker still deliver. */
  lastIngestAt: integer("last_ingest_at"),
});

/** Mailbox settings of a domain whose transport is "imap": mail is polled over IMAP and forwarded over SMTP. */
export const domainMailboxes = sqliteTable("domain_mailboxes", {
  domainId: text("domain_id")
    .primaryKey()
    .references(() => domains.id, { onDelete: "cascade" }),
  imapHost: text("imap_host").notNull(),
  imapPort: integer("imap_port").notNull().default(993),
  imapTls: integer("imap_tls", { mode: "boolean" }).notNull().default(true),
  imapUser: text("imap_user").notNull(),
  /** Encrypted with APP_SECRET (lib/secrets.ts). */
  imapPasswordEnc: text("imap_password_enc").notNull(),
  imapFolder: text("imap_folder").notNull().default("INBOX"),
  /** Folder processed mail is moved to (created if missing); null deletes it after processing. */
  imapDoneFolder: text("imap_done_folder").default("Processed"),
  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port").default(465),
  /** "tls" (implicit, 465), "starttls" (587) or "none". */
  smtpSecurity: text("smtp_security", { enum: ["tls", "starttls", "none"] }).default("tls"),
  smtpUser: text("smtp_user"),
  smtpPasswordEnc: text("smtp_password_enc"),
  /** Envelope / From address used for forwarded and verification mail. */
  smtpFrom: text("smtp_from"),
  pollSeconds: integer("poll_seconds").notNull().default(60),
  lastPollAt: integer("last_poll_at"),
  lastPollError: text("last_poll_error"),
  /** Highest IMAP UID processed (with uidValidity) to never process a mail twice. */
  lastUid: integer("last_uid").notNull().default(0),
  uidValidity: integer("uid_validity"),
});

export const destinations = sqliteTable(
  "destinations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    cfDestinationId: text("cf_destination_id"),
    verifiedAt: integer("verified_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    /** Armored OpenPGP public key: forwarded mail is encrypted for it (PGP/MIME). */
    pgpPublicKey: text("pgp_public_key"),
    pgpFingerprint: text("pgp_fingerprint"),
    /** Verification by the app itself (destinations used without Cloudflare): hash of the emailed token. */
    verifyTokenHash: text("verify_token_hash"),
    verifySentAt: integer("verify_sent_at"),
    /** Replace the visible subject of encrypted forwards with "...". */
    pgpHideSubject: integer("pgp_hide_subject", { mode: "boolean" }).notNull().default(false),
    /** Position in the user's fallback chain (null: not a fallback): tried in order when forwarding to the primary fails. */
    fallbackPosition: integer("fallback_position"),
  },
  (t) => [uniqueIndex("destinations_user_email_uq").on(t.userId, t.email)],
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    localPart: text("local_part").notNull(),
    siteName: text("site_name").notNull(),
    siteUrl: text("site_url"),
    label: text("label"),
    forwardEnabled: integer("forward_enabled", { mode: "boolean" }).notNull().default(false),
    destinationId: text("destination_id").references(() => destinations.id, { onDelete: "set null" }),
    status: text("status", { enum: ["active", "paused", "archived"] })
      .notNull()
      .default("active"),
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
    /** Reverse-alias replies: forwarded mail gets a per-sender Reply-To so replies go out from the alias. */
    repliesEnabled: integer("replies_enabled", { mode: "boolean" }).notNull().default(false),
    /** Secret token of the address's RSS / JSON feed (null: feed disabled). */
    feedToken: text("feed_token").unique(),
    /** JSON array of destination ids tried in order when forwarding fails (null: the user's fallback chain). */
    fallbackDestinationIdsJson: text("fallback_destination_ids_json"),
  },
  (t) => [uniqueIndex("addresses_domain_local_uq").on(t.domainId, t.localPart), index("addresses_user_idx").on(t.userId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    addressId: text("address_id")
      .notNull()
      .references(() => addresses.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    /** The original header section as received (up to 256 KB), for the "original headers" view. */
    rawHeaders: text("raw_headers"),
    /** JSON [{id, name}] of the rules that matched this mail, in evaluation order. */
    matchedRulesJson: text("matched_rules_json"),
    /** Set while a rule holds the mail in quarantine (stored, not forwarded). */
    quarantinedAt: integer("quarantined_at"),
    /** A rule asked to remove attachments from the forwarded copy. */
    stripAttachments: integer("strip_attachments", { mode: "boolean" }).notNull().default(false),
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
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
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
    addressId: text("address_id")
      .notNull()
      .references(() => addresses.id, { onDelete: "cascade" }),
    destinationId: text("destination_id")
      .notNull()
      .references(() => destinations.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("address_destinations_uq").on(t.addressId, t.destinationId)],
);

/**
 * On-the-fly addresses: mail to <name>.<site>@domain creates an address for <site>
 * owned by the directory's user, without visiting the app first.
 */
export const directories = sqliteTable("directories", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

/** Smart folders: a named set of /v1/addresses filters shown in the sidebar. */
export const savedSearches = sqliteTable(
  "saved_searches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    /** Webhooks: deliveries that failed for good in a row (reset by a success). */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Webhooks: set when paused automatically after repeated failures (cleared by resuming). */
    pausedAt: integer("paused_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("notify_targets_user_idx").on(t.userId)],
);

/** Outbox of webhook deliveries: one row per (event, webhook target), retried with exponential backoff. */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    targetId: text("target_id")
      .notNull()
      .references(() => notifyTargets.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Stable event id, the same for every target and every attempt (receivers deduplicate on it). */
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    /** JSON body, signed again at every attempt. */
    payload: text("payload").notNull(),
    status: text("status", { enum: ["pending", "delivered", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    deliveredAt: integer("delivered_at"),
  },
  (t) => [
    index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt),
    index("webhook_deliveries_target_idx").on(t.targetId, t.createdAt),
  ],
);

/** App passwords for the SMTP submission server (only the SHA-256 of the random password is stored). */
export const smtpPasswords = sqliteTable(
  "smtp_passwords",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull().unique(),
    /** First characters, to tell passwords apart in the UI. */
    hint: text("hint").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("smtp_passwords_user_idx").on(t.userId)],
);

/** Every mail whose sender does not match the address's site (the address column only keeps the latest). */
export const leakEvents = sqliteTable(
  "leak_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addressId: text("address_id")
      .notNull()
      .references(() => addresses.id, { onDelete: "cascade" }),
    sender: text("sender").notNull(),
    senderDomain: text("sender_domain").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [index("leak_events_user_idx").on(t.userId, t.senderDomain), index("leak_events_address_idx").on(t.addressId)],
);

/**
 * Reverse-alias contacts: one per (address, external sender). Mail forwarded from the sender carries
 * Reply-To: r+<token>@<domain>; a reply from a verified destination to it is sent from the alias to `email`.
 */
export const reverseContacts = sqliteTable(
  "reverse_contacts",
  {
    id: text("id").primaryKey(),
    addressId: text("address_id")
      .notNull()
      .references(() => addresses.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    token: text("token").notNull().unique(),
    blocked: integer("blocked", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    lastReplyAt: integer("last_reply_at"),
    replyCount: integer("reply_count").notNull().default(0),
  },
  (t) => [uniqueIndex("reverse_contacts_address_email_uq").on(t.addressId, t.email)],
);

/**
 * A site refused an address on one of our domains ("this site rejected the address"). `site` is the normalised site
 * key (host without www, or the lower-case site name). Used to pick another domain for that site automatically.
 */
export const siteRejections = sqliteTable(
  "site_rejections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    site: text("site").notNull(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    addressId: text("address_id").references(() => addresses.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("site_rejections_user_site_domain_uq").on(t.userId, t.site, t.domainId),
    index("site_rejections_site_idx").on(t.site),
  ],
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
  (t) => [index("audit_created_idx").on(t.createdAt), index("audit_user_idx").on(t.userId), index("audit_action_idx").on(t.action)],
);

/** Small key/value store for instance-wide state: off-site backup status, end-to-end probe settings and results. */
export const systemState = sqliteTable("system_state", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Per-user mail rules, evaluated in `position` order for every stored mail. A rule applies to all the user's
 * addresses, or only to one address / one category.
 */
export const rules = sqliteTable(
  "rules",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addressId: text("address_id").references(() => addresses.id, { onDelete: "cascade" }),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    position: integer("position").notNull().default(0),
    /** "all": every condition must match; "any": one is enough. */
    match: text("match", { enum: ["all", "any"] })
      .notNull()
      .default("all"),
    conditionsJson: text("conditions_json").notNull(),
    actionsJson: text("actions_json").notNull(),
    matchCount: integer("match_count").notNull().default(0),
    lastMatchedAt: integer("last_matched_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("rules_user_idx").on(t.userId, t.position)],
);

/**
 * Raw MIME of a message, kept only while it may still be needed: quarantined mail (until released or deleted) and
 * recently forwarded mail (so a failed delivery can be retried).
 */
export const messageRaw = sqliteTable("message_raw", {
  messageId: text("message_id")
    .primaryKey()
    .references(() => messages.id, { onDelete: "cascade" }),
  raw: blob("raw", { mode: "buffer" }).notNull(),
  /** Deleted after this time (null: kept as long as the message is quarantined). */
  keepUntil: integer("keep_until"),
});

/** Forwards that failed or were refused, with a plain-English reason. */
export const deliveryFailures = sqliteTable(
  "delivery_failures",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addressId: text("address_id").references(() => addresses.id, { onDelete: "set null" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    destination: text("destination").notNull(),
    /** "cloudflare" (reported by the Worker) or "smtp" (IMAP domains, releases and retries). */
    transport: text("transport", { enum: ["cloudflare", "smtp"] }).notNull(),
    /** failed: temporary or unknown error; rejected: the destination refused it for good; bounced: returned later. */
    kind: text("kind", { enum: ["failed", "rejected", "bounced"] }).notNull(),
    reason: text("reason").notNull(),
    detail: text("detail"),
    /** The fallback destination that received the mail instead (null: nobody did). */
    deliveredTo: text("delivered_to"),
    retryCount: integer("retry_count").notNull().default(0),
    lastRetryAt: integer("last_retry_at"),
    /** Delivered by a retry, or dismissed by the user. */
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("delivery_failures_user_idx").on(t.userId, t.createdAt), index("delivery_failures_message_idx").on(t.messageId)],
);

export type User = typeof users.$inferSelect;
export type Domain = typeof domains.$inferSelect;
export type Address = typeof addresses.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Destination = typeof destinations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ReverseContact = typeof reverseContacts.$inferSelect;
export type NotifyTarget = typeof notifyTargets.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type SiteRejection = typeof siteRejections.$inferSelect;
export type ExtractedItem = typeof extractedItems.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type DeliveryFailure = typeof deliveryFailures.$inferSelect;
