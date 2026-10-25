import { describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import { addDomain, ingest, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";
import { handleEmail, type EmailMessageLike } from "../../worker/src/index.js";

async function keypair() {
  return openpgp.generateKey({ type: "ecc", curve: "curve25519Legacy", userIDs: [{ email: "me@personal.example" }], format: "armored" });
}

async function setup() {
  const t = makeTestApp();
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const d = (await admin.post("/v1/destinations", { email: "me@personal.example" })).json.destination;
  await admin.post(`/v1/destinations/${d.id}/refresh`);
  const a = (await admin.post("/v1/addresses", { site_name: "Shop" })).json.address;
  await admin.patch(`/v1/addresses/${a.id}`, { forward_enabled: true, destination_id: d.id });
  return { t, admin, d, a };
}

describe("PGP-encrypted forwarding", () => {
  it("validates keys", async () => {
    const { admin, d } = await setup();
    const { publicKey, privateKey } = await keypair();
    expect((await admin.patch(`/v1/destinations/${d.id}`, { pgp_public_key: "nope" })).status).toBe(400);
    expect((await admin.patch(`/v1/destinations/${d.id}`, { pgp_public_key: privateKey })).json.error.message).toContain("PUBLIC");
    const ok = (await admin.patch(`/v1/destinations/${d.id}`, { pgp_public_key: publicKey })).json.destination;
    expect(ok.pgp.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    expect((await admin.patch(`/v1/destinations/${d.id}`, { pgp_public_key: null })).json.destination.pgp).toBe(null);
  });

  it("returns an encrypted PGP/MIME copy the Worker sends, decryptable by the key owner", async () => {
    const { t, admin, d, a } = await setup();
    const { publicKey, privateKey } = await keypair();
    await admin.patch(`/v1/destinations/${d.id}`, { pgp_public_key: publicKey, pgp_hide_subject: true });
    const res = (await ingest(t, a.email, simpleEml({ subject: "Secret stuff", text: "Your code is 777888", from: "Shop <news@shop.com>" }))).json;
    expect(res.forward_to).toBeUndefined();
    expect(res.send).toHaveLength(1);
    const mime = Buffer.from(res.send[0].raw_base64, "base64").toString("utf8");
    expect(res.send[0]).toMatchObject({ from: a.email, to: "me@personal.example" });
    expect(mime).toContain('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"');
    expect(mime).toContain("Subject: ...");
    expect(mime).toContain(`<${a.email}>`);
    expect(mime).not.toContain("777888");
    const armored = mime.slice(mime.indexOf("-----BEGIN PGP MESSAGE-----"), mime.indexOf("-----END PGP MESSAGE-----") + 25);
    const { data } = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: armored }),
      decryptionKeys: await openpgp.readPrivateKey({ armoredKey: privateKey }),
      format: "binary",
    });
    const inner = Buffer.from(data as Uint8Array).toString("utf8");
    expect(inner).toContain("Subject: Secret stuff");
    expect(inner).toContain("777888");

    // The Worker sends it through the binding
    const sent: Array<[string, string, string]> = [];
    const msg: EmailMessageLike = { from: "x@y", to: a.email, rawSize: 1, raw: new Response("x").body!, setReject() {}, async forward() {} };
    const answer = (async () => new Response(JSON.stringify(res))) as unknown as typeof fetch;
    const env = { APP_URL: "https://a", INGEST_SECRET: "s".repeat(20), SEND_EMAIL: { send: async (m: any) => void sent.push(m) } };
    expect(await handleEmail(msg, env, answer, (from, to, raw) => [from, to, raw])).toBe("forwarded");
    expect(sent[0]![0]).toBe(a.email);
    expect(sent[0]![2]).toContain("BEGIN PGP MESSAGE");
    // without the binding: stored, never forwarded in clear
    expect(await handleEmail({ ...msg, raw: new Response("x").body! }, { APP_URL: "https://a", INGEST_SECRET: "s".repeat(20) }, answer)).toBe("stored");
  });
});
