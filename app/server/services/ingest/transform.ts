import type { Email } from "postal-mime";
import { displayName, field, FORWARD_DROP, join, split, type Field } from "../replies.js";

/**
 * Changes made to the forwarded copy (never to the stored message): attachments removed by a rule, original headers
 * reduced to the user's allowlist. A changed copy cannot be a plain Cloudflare forward, so it is sent as a new
 * message from the alias (like reverse-alias forwards), with the original sender in Reply-To.
 */

/** Headers every forwarded copy keeps, whatever the allowlist: without them the mail cannot be read or threaded. */
export const ESSENTIAL_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "reply-to",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
]);

const BODY_HEADERS = new Set(["content-type", "content-transfer-encoding", "mime-version", "content-disposition"]);

function base64Lines(s: string) {
  return (
    Buffer.from(s, "utf8")
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? ""
  );
}

/** The mail rebuilt from its text and HTML parts only, with a note listing what was removed. */
export function stripAttachments(raw: Uint8Array, email: Email): Buffer {
  const { fields } = split(raw);
  const removed = email.attachments.map((a) => a.filename || a.mimeType);
  const note = removed.length ? `[${removed.length} attachment(s) removed by Throwaway Mail: ${removed.join(", ")}]` : "";
  const text = [note, email.text ?? ""].filter(Boolean).join("\n\n");
  const html = email.html ? `${note ? `<p><em>${escapeHtml(note)}</em></p>` : ""}${email.html}` : null;
  const boundary = `tm-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const part = (type: string, body: string) =>
    `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(body)}\r\n`;
  const kept = fields.filter((f) => !BODY_HEADERS.has(f.name));
  if (!html) {
    return join(
      [
        ...kept,
        field("MIME-Version", "1.0"),
        field("Content-Type", "text/plain; charset=utf-8"),
        field("Content-Transfer-Encoding", "base64"),
      ],
      Buffer.from(base64Lines(text) + "\r\n"),
    );
  }
  const body = `--${boundary}\r\n${part("text/plain", text)}--${boundary}\r\n${part("text/html", html)}--${boundary}--\r\n`;
  return join(
    [...kept, field("MIME-Version", "1.0"), field("Content-Type", `multipart/alternative; boundary="${boundary}"`)],
    Buffer.from(body),
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Keeps only the essential headers and the allowed ones (names compared in lower case). */
export function filterHeaders(raw: Uint8Array, allow: string[]): Buffer {
  const { fields, body } = split(raw);
  const ok = new Set(allow.map((x) => x.toLowerCase()));
  return join(
    fields.filter((f) => ESSENTIAL_HEADERS.has(f.name) || ok.has(f.name)),
    body,
  );
}

/** From becomes the alias (so it may be sent as a new message), the original sender goes to Reply-To. */
export function fromAlias(raw: Uint8Array, alias: string, sender: string | null, senderName: string | null): Buffer {
  const { fields, body } = split(raw);
  const kept: Field[] = fields.filter((f) => !FORWARD_DROP.has(f.name) && !f.name.startsWith("arc-"));
  const shown = sender ? displayName(senderName ? `${senderName} (${sender})` : sender) : null;
  return join(
    [
      field("From", shown ? `${shown} <${alias}>` : alias),
      ...(sender ? [field("Reply-To", shown ? `${shown} <${sender}>` : sender), field("X-Original-From", sender)] : []),
      ...kept,
    ],
    body,
  );
}

/** Parses the stored allowlist (null: keep every header). */
export function headerAllowlist(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}
