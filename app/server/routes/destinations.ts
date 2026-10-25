import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter, Ctx } from "../lib/http.js";
import { destinations } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { inspectPublicKey } from "../services/pgp.js";
import { refreshDestination, resendVerification, sharedWithOthers } from "../services/destinations.js";
import { destinationOut } from "../services/serialize.js";
import { CloudflareError } from "../cloudflare/index.js";

export function registerDestinations(r: ApiRouter) {
  const owned = (c: Ctx) => {
    const row = c
      .get("deps")
      .db.select()
      .from(destinations)
      .where(and(eq(destinations.id, c.req.param("id")!), eq(destinations.userId, c.get("user")!.id)))
      .get();
    if (!row) throw notFound("Destination");
    return row;
  };

  r.add({ method: "get", path: "/v1/destinations", summary: "List own forwarding destinations", tags: ["destinations"], auth: "user" }, (c) => {
    const rows = c.get("deps").db.select().from(destinations).where(eq(destinations.userId, c.get("user")!.id)).orderBy(asc(destinations.createdAt)).all();
    return c.json({ destinations: rows.map(destinationOut) });
  });

  r.add(
    {
      method: "post",
      path: "/v1/destinations",
      summary: "Add a personal mailbox; Cloudflare e-mails it a verification link",
      tags: ["destinations"],
      auth: "user",
      body: z.object({ email: z.string().trim().toLowerCase().email().max(254) }),
      responses: { 201: "Created" },
    },
    async (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      if (d.db.select().from(destinations).where(and(eq(destinations.userId, user.id), eq(destinations.email, body.email))).get()) {
        throw conflict("This destination already exists");
      }
      const row = { id: newId("dst"), userId: user.id, email: body.email, createdAt: d.now(), cfDestinationId: null as string | null, verifiedAt: null as number | null, lastError: null as string | null };
      try {
        const info = await d.cf.createDestination(body.email);
        row.cfDestinationId = info.id;
        row.verifiedAt = info.verified ? Date.parse(info.verified) || d.now() : null;
      } catch (e) {
        row.lastError = e instanceof CloudflareError ? e.message : (e as Error).message;
      }
      d.db.insert(destinations).values(row).run();
      return c.json({ destination: destinationOut(d.db.select().from(destinations).where(eq(destinations.id, row.id)).get()!) }, 201);
    },
  );

  r.add(
    {
      method: "patch",
      path: "/v1/destinations/:id",
      summary: "Set or remove the OpenPGP public key used to encrypt mail forwarded to this destination",
      tags: ["destinations"],
      auth: "user",
      body: z.object({ pgp_public_key: z.string().max(100_000).nullable().optional(), pgp_hide_subject: z.boolean().optional() }),
    },
    async (c, { body }) => {
      const d = c.get("deps");
      const row = owned(c);
      const set: Partial<typeof destinations.$inferSelect> = {};
      if (body.pgp_public_key === null || body.pgp_public_key?.trim() === "") Object.assign(set, { pgpPublicKey: null, pgpFingerprint: null });
      else if (body.pgp_public_key) {
        try {
          const info = await inspectPublicKey(body.pgp_public_key.trim());
          Object.assign(set, { pgpPublicKey: body.pgp_public_key.trim(), pgpFingerprint: info.fingerprint });
        } catch (e) {
          throw badRequest((e as Error).message);
        }
      }
      if (body.pgp_hide_subject !== undefined) set.pgpHideSubject = body.pgp_hide_subject;
      if (Object.keys(set).length) d.db.update(destinations).set(set).where(eq(destinations.id, row.id)).run();
      return c.json({ destination: destinationOut(d.db.select().from(destinations).where(eq(destinations.id, row.id)).get()!) });
    },
  );

  r.add({ method: "post", path: "/v1/destinations/:id/refresh", summary: "Refresh verification state from Cloudflare", tags: ["destinations"], auth: "user" }, async (c) => {
    return c.json({ destination: destinationOut(await refreshDestination(c.get("deps"), owned(c))) });
  });

  r.add({ method: "post", path: "/v1/destinations/:id/resend", summary: "Re-send the verification e-mail", tags: ["destinations"], auth: "user" }, async (c) => {
    return c.json({ destination: destinationOut(await resendVerification(c.get("deps"), owned(c))) });
  });

  r.add({ method: "delete", path: "/v1/destinations/:id", summary: "Remove a destination", tags: ["destinations"], auth: "user" }, async (c) => {
    const d = c.get("deps");
    const row = owned(c);
    if (row.cfDestinationId && !sharedWithOthers(d, row)) {
      await d.cf.deleteDestination(row.cfDestinationId).catch((e) => d.logger.warn("cloudflare destination delete failed", { err: (e as Error).message }));
    }
    d.db.delete(destinations).where(eq(destinations.id, row.id)).run();
    return c.json({ ok: true });
  });
}
