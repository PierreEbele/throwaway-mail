import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { badRequest } from "../lib/errors.js";
import { normalizeRecipient } from "../lib/email.js";
import { audit } from "../services/audit.js";
import { backupStatus, scheduledBackup } from "../services/backup/index.js";
import { probeConfig, probeStatus, probeTick, saveProbeConfig } from "../services/probe.js";
import { getState, setState } from "../services/state.js";

/** Admin endpoints for off-site backups and the end-to-end delivery probe. */
export function registerReliability(r: ApiRouter) {
  r.add(
    {
      method: "post",
      path: "/v1/admin/backup/run",
      summary: "Make a backup now (local copy, plus the encrypted off-site upload when configured)",
      tags: ["admin"],
      auth: "admin",
    },
    async (c) => {
      const d = c.get("deps");
      const status = await scheduledBackup(d);
      audit(d, c.get("user")!.id, "backup.run", null, { ok: status.last_ok }, clientIp(c));
      return c.json({ backup: backupStatus(d) }, status.last_ok ? 200 : 502);
    },
  );

  r.add(
    {
      method: "put",
      path: "/v1/admin/probe",
      summary: "Configure the end-to-end delivery probe",
      description: "Needs PROBE_SMTP_URL. The address should be an existing address of this instance that stores mail.",
      tags: ["admin"],
      auth: "admin",
      body: z.object({
        enabled: z.boolean(),
        address: z.string().trim().toLowerCase().max(254),
        interval_minutes: z
          .number()
          .int()
          .min(5)
          .max(7 * 24 * 60)
          .default(60),
        timeout_minutes: z
          .number()
          .int()
          .min(1)
          .max(24 * 60)
          .default(10),
      }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      if (body.enabled && !normalizeRecipient(body.address)) throw badRequest("address: a valid e-mail address is required");
      if (body.timeout_minutes >= body.interval_minutes) throw badRequest("timeout_minutes must be shorter than interval_minutes");
      saveProbeConfig(d, body);
      audit(d, c.get("user")!.id, "probe.configured", null, { ...body }, clientIp(c));
      return c.json({ probe: probeStatus(d) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/admin/probe/run",
      summary: "Send a probe mail now (the result arrives within the timeout)",
      tags: ["admin"],
      auth: "admin",
    },
    async (c) => {
      const d = c.get("deps");
      const cfg = probeConfig(d);
      if (!cfg.enabled || !cfg.address || !d.config.PROBE_SMTP_URL) throw badRequest("The probe is not enabled");
      const s = getState<Record<string, unknown>>(d, "probe.state") ?? {};
      if (!s.pending) setState(d, "probe.state", { ...s, last_run_at: null });
      await probeTick(d);
      return c.json({ probe: probeStatus(d) });
    },
  );
}
