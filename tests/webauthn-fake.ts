import crypto from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest();

/** A software passkey (ES256, "none" attestation), enough for @simplewebauthn/server to verify. */
export class FakeAuthenticator {
  readonly credentialId = crypto.randomBytes(16);
  private keys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  private counter = 0;
  userHandle: string | null = null;
  constructor(
    readonly origin = "http://localhost:3000",
    readonly rpId = new URL(origin).hostname,
  ) {}

  get id() {
    return b64u(this.credentialId);
  }

  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  private flags(uv: boolean, attested: boolean) {
    return 0x01 | (uv ? 0x04 : 0) | (attested ? 0x40 : 0);
  }

  /** Answer to navigator.credentials.create() for `options` (from the server). */
  create(options: { challenge: string; user: { id: string } }, uv = true) {
    this.userHandle = options.user.id;
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([this.flags(uv, true)]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      idLen,
      this.credentialId,
      Buffer.from(isoCBOR.encode(cose as never)),
    ]);
    const att = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]) as never,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge)),
        attestationObject: b64u(att),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  /** Answer to navigator.credentials.get() for `options` (from the server). */
  get(options: { challenge: string }, uv = true) {
    this.counter++;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([this.flags(uv, false)]), counter]);
    const clientData = this.clientData("webauthn.get", options.challenge);
    const signature = crypto.sign("sha256", Buffer.concat([authData, sha256(clientData)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: this.userHandle ?? undefined,
      },
      clientExtensionResults: {},
    };
  }
}
