/** In-process counters exposed as Prometheus text on /metrics and summarised on the admin health page. */

type Labels = Record<string, string>;

class Counter {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const k = JSON.stringify(Object.entries(labels).sort());
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  entries(): Array<[Labels, number]> {
    return [...this.values].map(([k, v]) => [Object.fromEntries(JSON.parse(k) as Array<[string, string]>), v]);
  }
  reset() {
    this.values.clear();
  }
}

export const metrics = {
  startedAt: Date.now(),
  ingest: new Counter("throwaway_ingest_total", "Mails received by /ingest, by decision"),
  http: new Counter("throwaway_http_requests_total", "HTTP requests by status class"),
  notify: new Counter("throwaway_notifications_total", "Push notifications / webhooks sent, by kind and result"),
  imapPolls: new Counter("throwaway_imap_polls_total", "IMAP mailbox polls, by domain and result"),
  imapMessages: new Counter("throwaway_imap_messages_total", "Messages found in IMAP mailboxes, by domain and outcome"),
  imapForwards: new Counter("throwaway_imap_forwards_total", "Mails forwarded over SMTP, by result"),
  jobs: new Map<string, { at: number; ok: boolean; detail: string }>(),
  job(name: string, ok: boolean, detail = "") {
    this.jobs.set(name, { at: Date.now(), ok, detail });
  },
};

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function renderPrometheus(gauges: Array<{ name: string; help: string; value: number; labels?: Labels }>): string {
  const out: string[] = [];
  for (const c of [metrics.ingest, metrics.http, metrics.notify, metrics.imapPolls, metrics.imapMessages, metrics.imapForwards]) {
    out.push(`# HELP ${c.name} ${c.help}`, `# TYPE ${c.name} counter`);
    for (const [labels, v] of c.entries()) {
      const l = Object.entries(labels)
        .map(([k, x]) => `${k}="${esc(x)}"`)
        .join(",");
      out.push(`${c.name}${l ? `{${l}}` : ""} ${v}`);
    }
  }
  const seen = new Set<string>();
  for (const g of gauges) {
    if (!seen.has(g.name)) {
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
      seen.add(g.name);
    }
    const l = Object.entries(g.labels ?? {})
      .map(([k, x]) => `${k}="${esc(x)}"`)
      .join(",");
    out.push(`${g.name}${l ? `{${l}}` : ""} ${g.value}`);
  }
  return out.join("\n") + "\n";
}
