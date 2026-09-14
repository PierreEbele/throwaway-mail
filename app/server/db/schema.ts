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
  },
  (t) => [uniqueIndex("destinations_user_email_uq").on(t.userId, t.email)],
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
    forwarded: integer("forwarded", { mode: "boolean" }).notNull().default(false),
    forwardTo: text("forward_to"),
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
export type Destination = typeof destinations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ExtractedItem = typeof extractedItems.$inferSelect;
