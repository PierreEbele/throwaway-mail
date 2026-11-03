import { eq } from "drizzle-orm";
import type { Deps } from "../../context.js";
import { domainMailboxes, domains } from "../../db/schema.js";
import { pollMailbox } from "./poller.js";
import { MIN_POLL_SECONDS } from "./settings.js";

interface Poller {
  timer: NodeJS.Timeout;
  intervalMs: number;
  running: boolean;
}

/**
 * Keeps one interval poller per IMAP domain. sync() is called after domains are added, edited or removed;
 * it does nothing until start() (tests and one-off scripts never poll in the background).
 */
export class MailboxRunner {
  private pollers = new Map<string, Poller>();
  private started = false;

  constructor(private deps: Deps) {}

  start() {
    this.started = true;
    this.sync();
  }

  stop() {
    this.started = false;
    for (const p of this.pollers.values()) clearInterval(p.timer);
    this.pollers.clear();
  }

  sync() {
    if (!this.started) return;
    const rows = this.deps.db
      .select({ id: domains.id, pollSeconds: domainMailboxes.pollSeconds })
      .from(domains)
      .innerJoin(domainMailboxes, eq(domainMailboxes.domainId, domains.id))
      .where(eq(domains.transport, "imap"))
      .all();
    const wanted = new Map(rows.map((r) => [r.id, Math.max(MIN_POLL_SECONDS, r.pollSeconds) * 1000]));
    for (const [id, p] of this.pollers) {
      if (wanted.get(id) !== p.intervalMs) {
        clearInterval(p.timer);
        this.pollers.delete(id);
      }
    }
    for (const [id, intervalMs] of wanted) {
      if (this.pollers.has(id)) continue;
      const p: Poller = { timer: setInterval(() => void this.run(id, p), intervalMs), intervalMs, running: false };
      p.timer.unref();
      this.pollers.set(id, p);
      void this.run(id, p);
    }
  }

  private async run(id: string, p: Poller) {
    if (p.running) return;
    const domain = this.deps.db.select().from(domains).where(eq(domains.id, id)).get();
    if (!domain) return;
    p.running = true;
    try {
      await pollMailbox(this.deps, domain);
    } catch {
      // Recorded on the mailbox row (last_poll_error) and in the metrics.
    } finally {
      p.running = false;
    }
  }
}
