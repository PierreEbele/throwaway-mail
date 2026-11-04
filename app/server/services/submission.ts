import fs from "node:fs";
import { and, eq, isNull, sql } from "drizzle-orm";
import { SMTPServer, type SMTPServerAuthentication, type SMTPServerSession } from "smtp-server";
import type { Deps } from "../context.js";
import { smtpPasswords, users, type User } from "../db/schema.js";
import { newId, randomString, safeEqual, sha256 } from "../lib/crypto.js";
import { SendError, sendFromAlias } from "./sending.js";
import { audit } from "./audit.js";

/**
 * SMTP submission server (RFC 6409): lets any mail client send new mail from an alias. Users sign in with their
 * e-mail and an SMTP password (random, created in the web UI, stored as SHA-256, revocable). Off unless
 * SUBMISSION_PORT is set; passwords are only accepted over TLS (STARTTLS or implicit) unless
 * SUBMISSION_ALLOW_INSECURE is set for development.
 */

// --- SMTP passwords -------------------------------------------------------------------------------------------------

/** Four groups of four characters from an unambiguous alphabet (about 80 bits): easy to type on a phone. */
export function createSmtpPassword(deps: Deps, userId: string, name: string) {
  const password = [0, 1, 2, 3].map(() => randomString(4)).join("-") + "-" + randomString(4);
  const row = {
    id: newId("smp"),
    userId,
    name,
    passwordHash: sha256(password),
    hint: password.slice(0, 4),
    createdAt: deps.now(),
  };
  deps.db.insert(smtpPasswords).values(row).run();
  return { password, row };
}

/** The user owning this e-mail and SMTP password, or null. */
export function checkSmtpLogin(deps: Deps, email: string, password: string): User | null {
  const user = deps.db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
    .get();
  const hash = sha256(password.trim());
  if (!user || user.disabled) return null;
  const row = deps.db
    .select()
    .from(smtpPasswords)
    .where(and(eq(smtpPasswords.userId, user.id), eq(smtpPasswords.passwordHash, hash), isNull(smtpPasswords.revokedAt)))
    .get();
  if (!row || !safeEqual(row.passwordHash, hash)) return null;
  const now = deps.now();
  if (!row.lastUsedAt || now - row.lastUsedAt > 60_000)
    deps.db.update(smtpPasswords).set({ lastUsedAt: now }).where(eq(smtpPasswords.id, row.id)).run();
  return user;
}

// --- Server ---------------------------------------------------------------------------------------------------------

interface SessionUser {
  user: User;
}

function smtpError(message: string, responseCode: number) {
  return Object.assign(new Error(message), { responseCode });
}

/** Builds the server (not listening yet); `tls` overrides the key / cert files (tests). */
export function createSubmissionServer(deps: Deps, tls?: { key: Buffer | string; cert: Buffer | string }) {
  const cfg = deps.config;
  const log = deps.logger.child({ component: "submission" });
  const key = tls?.key ?? (cfg.SUBMISSION_TLS_KEY ? fs.readFileSync(cfg.SUBMISSION_TLS_KEY) : undefined);
  const cert = tls?.cert ?? (cfg.SUBMISSION_TLS_CERT ? fs.readFileSync(cfg.SUBMISSION_TLS_CERT) : undefined);
  const hasTls = !!(key && cert);
  const limits = deps.authLimits;

  return new SMTPServer({
    name: cfg.SUBMISSION_HOSTNAME ?? new URL(cfg.APP_URL).hostname,
    banner: "Throwaway Mail submission",
    secure: hasTls && cfg.SUBMISSION_TLS === "implicit",
    key,
    cert,
    // Without a certificate (development flag only), AUTH is allowed in clear text.
    allowInsecureAuth: !hasTls && cfg.SUBMISSION_ALLOW_INSECURE,
    disabledCommands: hasTls ? [] : ["STARTTLS"],
    authMethods: ["PLAIN", "LOGIN"],
    authOptional: false,
    size: cfg.MAX_INGEST_BYTES,
    hideSize: false,
    logger: false,
    maxClients: 50,
    socketTimeout: 60_000,

    onAuth(auth: SMTPServerAuthentication, session: SMTPServerSession, callback) {
      const ip = session.remoteAddress;
      const email = (auth.username ?? "").trim().toLowerCase();
      const now = deps.now();
      const wait = Math.max(limits.ip.hit(`smtp:${ip}`, now), limits.account.retryAfter(`smtp:${email}`, now));
      if (wait) return callback(smtpError(`Too many attempts, try again in ${wait} s`, 454));
      const user = checkSmtpLogin(deps, email, auth.password ?? "");
      if (!user) {
        limits.account.record(`smtp:${email}`, now);
        log.warn("SMTP sign-in failed", { ip, email });
        return callback(smtpError("Invalid e-mail or SMTP password", 535));
      }
      limits.account.reset(`smtp:${email}`);
      callback(null, { user: { user } satisfies SessionUser });
    },

    onRcptTo(_address, session, callback) {
      if (session.envelope.rcptTo.length >= cfg.SEND_MAX_RECIPIENTS)
        return callback(smtpError(`At most ${cfg.SEND_MAX_RECIPIENTS} recipients per mail`, 452));
      callback();
    },

    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("error", (e) => callback(e));
      stream.on("end", () => {
        if ((stream as unknown as { sizeExceeded?: boolean }).sizeExceeded) return callback(smtpError("Message too large", 552));
        const { user } = session.user as SessionUser;
        const rcpts = session.envelope.rcptTo.map((r) => r.address);
        sendFromAlias(deps, user, Buffer.concat(chunks), { envelopeTo: rcpts, channel: "smtp", ip: session.remoteAddress })
          .then((r) => callback(null, `Queued as ${r.message_id}`))
          .catch((e) => {
            if (!(e instanceof SendError)) {
              log.error("submission failed", { err: e as Error });
              return callback(smtpError("Internal error, try again later", 451));
            }
            if (e.code === "forbidden")
              audit(deps, user.id, "mail.refused", null, { reason: e.message, channel: "smtp" }, session.remoteAddress);
            const code = { invalid: 554, forbidden: 553, rate_limited: 451, unavailable: 451, failed: e.permanent ? 554 : 451 }[e.code];
            callback(smtpError(e.message, code));
          });
      });
    },
  });
}

/** Starts the server when SUBMISSION_PORT is set; returns a stop function. */
export function startSubmission(deps: Deps): (() => Promise<void>) | null {
  const cfg = deps.config;
  if (!cfg.SUBMISSION_PORT) return null;
  const server = createSubmissionServer(deps);
  server.on("error", (e) => deps.logger.error("SMTP submission server error", { err: e }));
  server.listen(cfg.SUBMISSION_PORT, cfg.SUBMISSION_HOST, () =>
    deps.logger.info("SMTP submission listening", {
      port: cfg.SUBMISSION_PORT,
      host: cfg.SUBMISSION_HOST,
      tls: cfg.SUBMISSION_TLS_CERT ? cfg.SUBMISSION_TLS : "none (SUBMISSION_ALLOW_INSECURE)",
    }),
  );
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}
