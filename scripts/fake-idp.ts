/**
 * Minimal OpenID Connect provider for tests and local development only. NEVER expose it.
 * Auto-approves every authorization request as the "current user" (settable via /_as).
 */
import http from "node:http";
import crypto from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

export interface FakeUser {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  groups?: string[];
}

export const FAKE_USERS: Record<string, FakeUser> = {
  admin: { sub: "sub-admin", email: "admin@example.test", name: "Admin", preferred_username: "admin", groups: ["admins"] },
  alice: { sub: "sub-alice", email: "alice@example.test", name: "Alice", preferred_username: "alice", groups: ["family"] },
  bob: { sub: "sub-bob", email: "bob@example.test", name: "Bob", preferred_username: "bob", groups: ["family"] },
};

export async function startFakeIdp(opts: { port?: number; clientId: string; clientSecret: string }) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "fake-1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { user: FakeUser; nonce?: string; challenge: string; redirectUri: string }>();
  const tokens = new Map<string, FakeUser>();
  let current: FakeUser = FAKE_USERS.admin!;
  let issuer = "";
  let denyNext: string | null = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname === "/jwks") return send(200, { keys: [jwk] });
    if (url.pathname === "/_as") {
      const u = FAKE_USERS[url.searchParams.get("user") ?? ""];
      if (u) current = u;
      return send(200, { current });
    }
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      const redirect = new URL(p.get("redirect_uri")!);
      if (p.get("client_id") !== opts.clientId) return send(400, { error: "invalid_client" });
      if (denyNext) {
        redirect.searchParams.set("error", denyNext);
        redirect.searchParams.set("error_description", "denied by fake idp");
        denyNext = null;
      } else {
        const code = crypto.randomBytes(16).toString("hex");
        codes.set(code, {
          user: current,
          nonce: p.get("nonce") ?? undefined,
          challenge: p.get("code_challenge") ?? "",
          redirectUri: redirect.href.split("?")[0]!,
        });
        redirect.searchParams.set("code", code);
      }
      redirect.searchParams.set("state", p.get("state") ?? "");
      redirect.searchParams.set("iss", issuer);
      res.writeHead(302, { location: redirect.href });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const basic = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
      const [id, secret] = basic.split(":").map(decodeURIComponent);
      if (id !== opts.clientId || secret !== opts.clientSecret) return send(401, { error: "invalid_client" });
      const entry = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (!entry) return send(400, { error: "invalid_grant" });
      const challenge = crypto
        .createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (challenge !== entry.challenge) return send(400, { error: "invalid_grant", error_description: "PKCE mismatch" });
      const access = crypto.randomBytes(16).toString("hex");
      tokens.set(access, entry.user);
      const idToken = await new SignJWT({ nonce: entry.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "fake-1" })
        .setIssuer(issuer)
        .setAudience(opts.clientId)
        .setSubject(entry.user.sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return send(200, { access_token: access, token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    if (url.pathname === "/userinfo") {
      const u = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!u) return send(401, { error: "invalid_token" });
      return send(200, u);
    }
    send(404, { error: "not_found" });
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  issuer = `http://127.0.0.1:${port}`;
  return {
    issuer,
    setUser(u: FakeUser) {
      current = u;
    },
    denyNext(error = "access_denied") {
      denyNext = error;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// CLI: pnpm fake-oidc  (port 3298, client throwaway-mail / dev-secret)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const port = Number(process.env.FAKE_IDP_PORT ?? 3298);
  startFakeIdp({
    port,
    clientId: process.env.OIDC_CLIENT_ID ?? "throwaway-mail",
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? "dev-oidc-secret",
  }).then((idp) => {
    console.log(`fake OIDC provider on ${idp.issuer} (switch user: ${idp.issuer}/_as?user=alice)`);
  });
}
