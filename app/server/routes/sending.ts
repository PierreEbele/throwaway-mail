import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { smtpPasswords } from "../db/schema.js";
import { HttpError, notFound } from "../lib/errors.js";
import { clientIp } from "../lib/http.js";
import { ownedAddress } from "../services/addresses.js";
import { createSmtpPassword } from "../services/submission.js";
import { SendError, sendComposed } from "../services/sending.js";
import { domainOf, repliesUnavailableReason } from "../services/replies.js";

const passwordOut = (p: typeof smtpPasswords.$inferSelect) => ({
  id: p.id,
  name: p.name,
  hint: p.hint,
  created_at: p.createdAt,
  last_used_at: p.lastUsedAt,
  revoked_at: p.revokedAt,
});

const STATUS = { invalid: 400, forbidden: 403, rate_limited: 429, unavailable: 503, failed: 502 } as const;

const Emails = z.array(z.string().trim().email().max(254)).max(50);

/** Sending new mail from aliases: SMTP passwords for the submission server, and the compose / API endpoint. */
export function registerSending(r: ApiRouter) {
  r.add(
    {
      method: "get",
      path: "/v1/sending",
      summary: "SMTP submission settings for mail clients, and the own SMTP passwords",
      tags: ["sending"],
      auth: "user",
    },
    (c) => {
      const d = c.get("deps");
      const cfg = d.config;
      const rows = d.db
        .select()
        .from(smtpPasswords)
        .where(eq(smtpPasswords.userId, c.get("user")!.id))
        .orderBy(desc(smtpPasswords.createdAt))
        .all();
      return c.json({
        submission: cfg.SUBMISSION_PORT
          ? {
              enabled: true,
              host: cfg.SUBMISSION_HOSTNAME ?? new URL(cfg.APP_URL).hostname,
              port: cfg.SUBMISSION_PORT,
              security: cfg.SUBMISSION_TLS_CERT ? cfg.SUBMISSION_TLS : "none",
              username: c.get("user")!.email,
            }
          : { enabled: false },
        rate_limit_per_hour: cfg.SEND_RATE_LIMIT_PER_HOUR,
        max_recipients: cfg.SEND_MAX_RECIPIENTS,
        passwords: rows.map(passwordOut),
      });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/sending/passwords",
      summary: "Create an SMTP password (shown once)",
      tags: ["sending"],
      auth: "user",
      body: z.object({ name: z.string().trim().min(1).max(80) }),
      responses: { 201: "{ password, smtp_password }" },
    },
    (c, { body }) => {
      const d = c.get("deps");
      const { password, row } = createSmtpPassword(d, c.get("user")!.id, body.name);
      return c.json({ password, smtp_password: passwordOut({ ...row, lastUsedAt: null, revokedAt: null }) }, 201);
    },
  );

  r.add(
    { method: "delete", path: "/v1/sending/passwords/:id", summary: "Revoke an SMTP password", tags: ["sending"], auth: "user" },
    (c) => {
      const d = c.get("deps");
      const res = d.db
        .update(smtpPasswords)
        .set({ revokedAt: d.now() })
        .where(and(eq(smtpPasswords.id, c.req.param("id")!), eq(smtpPasswords.userId, c.get("user")!.id), isNull(smtpPasswords.revokedAt)))
        .run();
      if (!res.changes) throw notFound("SMTP password");
      return c.json({ ok: true });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/addresses/:id/send",
      summary: "Send a new mail from this address",
      description:
        "Recipients become reverse-alias contacts, so their answers come back through the address. Recipients may also be reverse addresses (r+…@domain) of this address's contacts. Errors: 403 not allowed, 429 hourly limit (Retry-After), 502 refused by the outbound server, 503 no outbound server.",
      tags: ["addresses", "sending"],
      auth: "user",
      body: z
        .object({
          to: z.union([z.string().trim().email(), Emails.min(1)]),
          cc: Emails.optional(),
          bcc: Emails.optional(),
          subject: z.string().max(998).default(""),
          text: z.string().max(1_000_000),
          html: z.string().max(5_000_000).optional(),
          from_name: z.string().trim().max(120).optional(),
          in_reply_to: z.string().trim().max(998).optional(),
        })
        .strict(),
      responses: { 200: "{ sent: { address_id, from, to, message_id, via } }" },
    },
    async (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a, domain } = ownedAddress(d, user, c.req.param("id")!);
      const why = repliesUnavailableReason(d, domainOf(d, a));
      if (why) throw new HttpError(503, "unavailable", why);
      try {
        const sent = await sendComposed(
          d,
          user,
          a,
          domain,
          { ...body, to: typeof body.to === "string" ? [body.to] : body.to },
          c.get("apiKeyId") ? "api" : "web",
          clientIp(c),
        );
        return c.json({ sent });
      } catch (e) {
        if (!(e instanceof SendError)) throw e;
        if (e.retryAfter) c.header("Retry-After", String(e.retryAfter));
        throw new HttpError(STATUS[e.code], e.code, e.message);
      }
    },
  );
}
