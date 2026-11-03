import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { ImapConnector, ImapSession, ImapSettings, MailClients, SmtpSender, SmtpSettings } from "./types.js";
import { SmtpError } from "./types.js";

const TIMEOUT_MS = 30_000;

class ImapFlowSession implements ImapSession {
  constructor(private client: ImapFlow) {}

  async openFolder(folder: string) {
    const box = await this.client.mailboxOpen(folder);
    return { uidValidity: Number(box.uidValidity), exists: box.exists };
  }

  async uidsAfter(afterUid: number) {
    const found = await this.client.search({ uid: `${afterUid + 1}:*` }, { uid: true });
    // "n:*" always matches the last message, even when its UID is below n.
    return (found || []).filter((u) => u > afterUid).sort((a, b) => a - b);
  }

  async fetchRaw(uid: number) {
    const msg = await this.client.fetchOne(String(uid), { source: true }, { uid: true });
    return msg && msg.source ? msg.source : null;
  }

  async ensureFolder(folder: string) {
    const list = await this.client.list();
    if (!list.some((m) => m.path === folder)) await this.client.mailboxCreate(folder);
  }

  async move(uid: number, folder: string) {
    await this.client.messageMove(String(uid), folder, { uid: true });
  }

  async remove(uid: number) {
    await this.client.messageDelete(String(uid), { uid: true });
  }

  async close() {
    await this.client.logout().catch(() => this.client.close());
  }
}

export const imapflowConnector: ImapConnector = {
  async connect(s: ImapSettings) {
    const client = new ImapFlow({
      host: s.host,
      port: s.port,
      secure: s.tls,
      auth: { user: s.user, pass: s.password },
      logger: false,
      connectionTimeout: TIMEOUT_MS,
      socketTimeout: 5 * 60_000,
    });
    // Socket errors after connect() surface through the next command; unhandled they would crash the process.
    client.on("error", () => {});
    await client.connect();
    return new ImapFlowSession(client);
  },
};

function transport(s: SmtpSettings) {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === "tls",
    requireTLS: s.security === "starttls",
    ignoreTLS: s.security === "none",
    auth: s.user ? { user: s.user, pass: s.password ?? "" } : undefined,
    connectionTimeout: TIMEOUT_MS,
  });
}

export const nodemailerSender: SmtpSender = {
  async verify(s) {
    const t = transport(s);
    try {
      await t.verify();
    } finally {
      t.close();
    }
  },
  async send(s, envelope, raw) {
    const t = transport(s);
    try {
      await t.sendMail({ envelope: { from: envelope.from, to: envelope.to }, raw: Buffer.from(raw) });
    } catch (e) {
      const code = (e as { responseCode?: number }).responseCode;
      throw new SmtpError((e as Error).message, typeof code === "number" && code >= 500);
    } finally {
      t.close();
    }
  },
};

export const realMailClients: MailClients = { imap: imapflowConnector, smtp: nodemailerSender };
