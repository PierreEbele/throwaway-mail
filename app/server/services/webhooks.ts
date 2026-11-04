import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { Deps } from "../context.js";
import { notifyTargets, users, webhookDeliveries, type NotifyTarget, type WebhookDelivery } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { checkOutboundUrl } from "../lib/outbound.js";
import { metrics } from "./metrics.js";
import { webhookSignature, type NotifyEvent } from "./notify.js";

/**
 * Signed webhooks with a persistent outbox. Every event for a webhook target becomes a row of webhook_deliveries,
 * tried at once and then retried with exponential backoff (30 s, 1 min, 2 min... capped at 6 h) up to MAX_ATTEMPTS.
 * After PAUSE_AFTER deliveries failed for good in a row, the target is paused (paused_at) until the user resumes it.
 * Each attempt is signed again: x-tm-signature = hex HMAC-SHA256(secret, `${x-tm-timestamp}.${body}`).
 */

export const MAX_ATTEMPTS = 8;
export const PAUSE_AFTER = 5;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 6 * 3600_000;
/** An attempt in flight holds the row this long (a crash mid-request releases it afterwards). */
const LEASE_MS = 60_000;
/** Delivered / failed rows are kept this long for the UI. */
export const KEEP_DELIVERIES_MS = 14 * 86400_000;

export const backoffMs = (attempts: number) => Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));

/**
 * The JSON body. Stable fields: id, type, created_at, data. title / body / url are human-readable; sent_at and the
 * fields of `data` repeated at the top level keep payloads of earlier versions working.
 */
export function webhookPayload(eventId: string, e: NotifyEvent, now: number): string {
  return JSON.stringify({
    ...e.data,
    id: eventId,
    type: e.type,
    created_at: now,
    sent_at: now,
    title: e.title,
    body: e.body,
    url: e.url ?? null,
    data: e.data ?? {},
  });
}

/** Queues one event for webhook targets and tries them at once (without waiting for slow endpoints). */
export function enqueueWebhooks(deps: Deps, targets: NotifyTarget[], e: NotifyEvent, eventId = newId("evt")): Promise<unknown> {
  if (!targets.length) return Promise.resolve();
  const now = deps.now();
  const payload = webhookPayload(eventId, e, now);
  const ids = targets.map((t) => {
    const id = newId("whd");
    deps.db
      .insert(webhookDeliveries)
      .values({ id, targetId: t.id, userId: t.userId, eventId, eventType: e.type, payload, nextAttemptAt: now, createdAt: now })
      .run();
    return id;
  });
  return Promise.all(ids.map((id) => attempt(deps, id)));
}

/** Claims a due delivery (so the background job and an immediate attempt never send it twice). */
function claim(deps: Deps, id: string, now: number): WebhookDelivery | null {
  const res = deps.db
    .update(webhookDeliveries)
    .set({ nextAttemptAt: now + LEASE_MS })
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now)))
    .run();
  if (!res.changes) return null;
  return deps.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).get() ?? null;
}

/** One attempt of one delivery. Returns the outcome (null: not due, already taken, or target paused / disabled). */
export async function attempt(deps: Deps, id: string): Promise<{ ok: boolean; error?: string } | null> {
  const now = deps.now();
  const d = claim(deps, id, now);
  if (!d) return null;
  const t = deps.db.select().from(notifyTargets).where(eq(notifyTargets.id, d.targetId)).get();
  if (!t || !t.enabled || t.pausedAt) {
    // Left pending; picked up again once the target is resumed.
    deps.db.update(webhookDeliveries).set({ nextAttemptAt: now }).where(eq(webhookDeliveries.id, d.id)).run();
    return null;
  }
  const ts = String(Math.floor(now / 1000));
  let status: number | null = null;
  try {
    // Re-checked at every attempt: the target's DNS may have changed since it was saved.
    const owner = deps.db.select({ role: users.role }).from(users).where(eq(users.id, t.userId)).get();
    await checkOutboundUrl(t.url!, { resolve: deps.resolve, allowPrivate: owner?.role === "admin" });
    const res = await deps.fetch(t.url!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "ThrowawayMail-Webhook/1",
        "x-tm-event": d.eventType,
        "x-tm-event-id": d.eventId,
        "x-tm-delivery": d.id,
        "x-tm-timestamp": ts,
        ...(t.secret ? { "x-tm-signature": webhookSignature(t.secret, ts, d.payload) } : {}),
      },
      body: d.payload,
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    status = res.status;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const error = (err as Error).message.slice(0, 300);
    const attempts = d.attempts + 1;
    const gaveUp = attempts >= MAX_ATTEMPTS;
    deps.db
      .update(webhookDeliveries)
      .set({
        attempts,
        lastStatus: status,
        lastError: error,
        status: gaveUp ? "failed" : "pending",
        nextAttemptAt: gaveUp ? now : now + backoffMs(attempts),
      })
      .where(eq(webhookDeliveries.id, d.id))
      .run();
    const failures = gaveUp ? t.consecutiveFailures + 1 : t.consecutiveFailures;
    const pause = gaveUp && failures >= PAUSE_AFTER;
    deps.db
      .update(notifyTargets)
      .set({ lastError: error, consecutiveFailures: failures, ...(pause ? { pausedAt: now } : {}) })
      .where(eq(notifyTargets.id, t.id))
      .run();
    if (pause) deps.logger.warn("webhook paused after repeated failures", { target: t.id, failures });
    metrics.notify.inc({ kind: "webhook", result: "error" });
    deps.logger.warn("webhook delivery failed", { target: t.id, delivery: d.id, attempts, err: error });
    return { ok: false, error };
  }
  deps.db
    .update(webhookDeliveries)
    .set({ attempts: d.attempts + 1, status: "delivered", lastStatus: status, lastError: null, deliveredAt: now })
    .where(eq(webhookDeliveries.id, d.id))
    .run();
  deps.db.update(notifyTargets).set({ lastOkAt: now, lastError: null, consecutiveFailures: 0 }).where(eq(notifyTargets.id, t.id)).run();
  metrics.notify.inc({ kind: "webhook", result: "ok" });
  return { ok: true };
}

/** Background job: retries due deliveries of active targets and prunes old rows. Returns the number attempted. */
export async function processWebhookOutbox(deps: Deps, limit = 50): Promise<number> {
  const now = deps.now();
  deps.db
    .delete(webhookDeliveries)
    .where(and(inArray(webhookDeliveries.status, ["delivered", "failed"]), lt(webhookDeliveries.createdAt, now - KEEP_DELIVERIES_MS)))
    .run();
  const due = deps.db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .innerJoin(notifyTargets, eq(notifyTargets.id, webhookDeliveries.targetId))
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        lte(webhookDeliveries.nextAttemptAt, now),
        eq(notifyTargets.enabled, true),
        sql`${notifyTargets.pausedAt} is null`,
      ),
    )
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(limit)
    .all();
  for (const { id } of due) await attempt(deps, id);
  return due.length;
}

/** Queues a delivery again (same event id and payload, fresh attempts). */
export function redeliver(deps: Deps, d: WebhookDelivery): WebhookDelivery {
  const now = deps.now();
  const row = {
    ...d,
    id: newId("whd"),
    status: "pending" as const,
    attempts: 0,
    nextAttemptAt: now,
    lastStatus: null,
    lastError: null,
    createdAt: now,
    deliveredAt: null,
  };
  deps.db.insert(webhookDeliveries).values(row).run();
  return row;
}

export const deliveryOut = (d: WebhookDelivery) => ({
  id: d.id,
  event_id: d.eventId,
  event_type: d.eventType,
  status: d.status,
  attempts: d.attempts,
  next_attempt_at: d.status === "pending" ? d.nextAttemptAt : null,
  last_status: d.lastStatus,
  last_error: d.lastError,
  created_at: d.createdAt,
  delivered_at: d.deliveredAt,
  payload: JSON.parse(d.payload) as unknown,
});
