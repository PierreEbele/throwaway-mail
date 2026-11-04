import type { ImapSession, ImapSettings, MailClients, SmtpSettings } from "../app/server/services/mailbox/types.js";
import { SmtpError } from "../app/server/services/mailbox/types.js";

/** In-memory IMAP server: folders of { uid, raw }, one UIDVALIDITY for the watched folder. */
export class FakeImap {
  folders = new Map<string, Array<{ uid: number; raw: Buffer }>>([["INBOX", []]]);
  uidValidity = 1;
  nextUid = 1;
  logins: ImapSettings[] = [];
  password = "imap-pass";
  /** Throws after this many fetches (simulates a crash mid-poll). */
  failAfterFetches = Infinity;

  deliver(raw: string, folder = "INBOX") {
    const uid = this.nextUid++;
    this.folders.get(folder)!.push({ uid, raw: Buffer.from(raw) });
    return uid;
  }

  /** The server renumbers everything (e.g. the folder was recreated). */
  renumber() {
    this.uidValidity++;
    for (const msgs of this.folders.values()) for (const m of msgs) m.uid = this.nextUid++;
  }

  uids(folder = "INBOX") {
    return (this.folders.get(folder) ?? []).map((m) => m.uid);
  }

  async connect(s: ImapSettings): Promise<ImapSession> {
    this.logins.push(s);
    if (s.password !== this.password) throw new Error("AUTHENTICATIONFAILED Invalid credentials");
    let open = "";
    const box = () => this.folders.get(open)!;
    let fetches = 0;
    return {
      openFolder: async (f) => {
        if (!this.folders.has(f)) throw new Error(`Mailbox doesn't exist: ${f}`);
        open = f;
        return { uidValidity: this.uidValidity, exists: box().length };
      },
      uidsAfter: async (after) =>
        box()
          .map((m) => m.uid)
          .filter((u) => u > after)
          .sort((a, b) => a - b),
      fetchRaw: async (uid) => {
        if (++fetches > this.failAfterFetches) throw new Error("connection lost");
        return box().find((m) => m.uid === uid)?.raw ?? null;
      },
      ensureFolder: async (f) => {
        if (!this.folders.has(f)) this.folders.set(f, []);
      },
      move: async (uid, f) => {
        const i = box().findIndex((m) => m.uid === uid);
        const [m] = box().splice(i, 1);
        this.folders.get(f)!.push({ uid: this.nextUid++, raw: m!.raw });
      },
      remove: async (uid) => {
        box().splice(
          box().findIndex((m) => m.uid === uid),
          1,
        );
      },
      close: async () => {},
    };
  }
}

export class FakeSmtp {
  sent: Array<{ settings: SmtpSettings; from: string; to: string[]; raw: string }> = [];
  verified = 0;
  failWith: SmtpError | null = null;
  /** Fails only for these recipients. */
  failFor = new Map<string, SmtpError>();

  async verify() {
    this.verified++;
  }

  async send(settings: SmtpSettings, env: { from: string; to: string[] }, raw: Uint8Array) {
    if (this.failWith) throw this.failWith;
    const fail = env.to.map((t) => this.failFor.get(t)).find(Boolean);
    if (fail) throw fail;
    this.sent.push({ settings, from: env.from, to: env.to, raw: Buffer.from(raw).toString("utf8") });
  }
}

export function fakeMail(): { imap: FakeImap; smtp: FakeSmtp; clients: MailClients } {
  const imap = new FakeImap();
  const smtp = new FakeSmtp();
  return { imap, smtp, clients: { imap: { connect: (s) => imap.connect(s) }, smtp } };
}

export { SmtpError };
