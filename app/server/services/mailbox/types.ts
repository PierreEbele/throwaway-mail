/** Narrow views of the IMAP and SMTP libraries, so the poller can be tested with fakes (see deps.mail). */

export interface ImapSettings {
  host: string;
  port: number;
  /** Implicit TLS (993); false = plain connection upgraded with STARTTLS when offered. */
  tls: boolean;
  user: string;
  password: string;
}

export interface SmtpSettings {
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  user: string | null;
  password: string | null;
}

export interface ImapSession {
  /** Selects a folder (fails when it does not exist). */
  openFolder(folder: string): Promise<{ uidValidity: number; exists: number }>;
  /** UIDs greater than `afterUid` in the open folder, ascending. */
  uidsAfter(afterUid: number): Promise<number[]>;
  /** Raw RFC 822 source of one message (null when it vanished meanwhile). */
  fetchRaw(uid: number): Promise<Buffer | null>;
  /** Creates the folder unless it exists. */
  ensureFolder(folder: string): Promise<void>;
  move(uid: number, folder: string): Promise<void>;
  remove(uid: number): Promise<void>;
  close(): Promise<void>;
}

export interface ImapConnector {
  connect(settings: ImapSettings): Promise<ImapSession>;
}

export interface SmtpEnvelope {
  from: string;
  to: string[];
}

export interface SmtpSender {
  verify(settings: SmtpSettings): Promise<void>;
  /** Sends `raw` unchanged with the given envelope. */
  send(settings: SmtpSettings, envelope: SmtpEnvelope, raw: Uint8Array): Promise<void>;
}

export interface MailClients {
  imap: ImapConnector;
  smtp: SmtpSender;
}

/** An SMTP failure; `permanent` (5xx) means retrying the same message cannot help. */
export class SmtpError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}
