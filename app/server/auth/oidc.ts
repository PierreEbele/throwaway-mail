import * as client from "openid-client";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { HttpError } from "../lib/errors.js";

export interface SsoIdentity {
  sub: string;
  email: string;
  name: string | null;
  groups: string[];
}

interface Pending {
  redirectUri: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60_000;

/** Only same-origin relative paths are accepted as post-login destinations. */
export function safeReturnTo(v: string | null | undefined): string {
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || v.startsWith("/v1/auth/")) return "/";
  return v;
}

/** OpenID Connect authorization-code flow with PKCE, nonce and state (bound to a browser cookie). */
export class OidcService {
  private configPromise: Promise<client.Configuration> | null = null;
  private pending = new Map<string, Pending>();

  constructor(
    private config: Config,
    private logger: Logger,
  ) {}

  get enabled() {
    return this.config.oidcEnabled;
  }

  get providerName() {
    return this.config.OIDC_PROVIDER_NAME;
  }

  private discover(): Promise<client.Configuration> {
    if (!this.enabled)
      return Promise.reject(
        new HttpError(503, "sso_not_configured", "Single sign-on is not configured (OIDC_ISSUER / OIDC_CLIENT_SECRET)"),
      );
    this.configPromise ??= client
      .discovery(
        new URL(this.config.OIDC_ISSUER!),
        this.config.OIDC_CLIENT_ID,
        undefined,
        client.ClientSecretBasic(this.config.OIDC_CLIENT_SECRET!),
        this.config.OIDC_ALLOW_INSECURE ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((e) => {
        this.configPromise = null; // retry discovery on the next attempt
        this.logger.error("oidc discovery failed", { err: (e as Error).message, issuer: this.config.OIDC_ISSUER });
        throw new HttpError(502, "sso_unavailable", `Cannot reach the identity provider: ${(e as Error).message}`);
      });
    return this.configPromise;
  }

  private sweep(now: number) {
    for (const [k, p] of this.pending) if (now - p.createdAt > PENDING_TTL_MS) this.pending.delete(k);
  }

  /** The callback URL on the origin the user is browsing (must be one of the configured app origins). */
  redirectUriFor(host: string | undefined): string {
    const origin = this.config.appOrigins.find((o) => host && new URL(o).host === host.toLowerCase()) ?? this.config.appOrigins[0]!;
    return `${origin}/v1/auth/oidc/callback`;
  }

  /** Returns the IdP authorization URL and the state to bind to the browser. */
  async start(returnTo: string, host?: string): Promise<{ url: string; state: string }> {
    const cfg = await this.discover();
    const now = Date.now();
    this.sweep(now);
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const redirectUri = this.redirectUriFor(host);
    this.pending.set(state, { redirectUri, verifier, nonce, returnTo: safeReturnTo(returnTo), createdAt: now });
    const url = client.buildAuthorizationUrl(cfg, {
      redirect_uri: redirectUri,
      scope: this.config.OIDC_SCOPES,
      response_type: "code",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return { url: url.href, state };
  }

  /** Validates the callback (state, PKCE, nonce, ID token) and returns the identity plus where to go next. */
  async finish(callbackUrl: URL, browserState: string | undefined): Promise<{ identity: SsoIdentity; returnTo: string }> {
    const cfg = await this.discover();
    const state = callbackUrl.searchParams.get("state") ?? "";
    const p = this.pending.get(state);
    if (!p || !browserState || browserState !== state || Date.now() - p.createdAt > PENDING_TTL_MS) {
      throw new HttpError(400, "sso_state_mismatch", "Login session expired or invalid, please try again");
    }
    this.pending.delete(state);
    // Use the registered redirect URI as the base (the app sits behind a reverse proxy).
    const current = new URL(p.redirectUri);
    current.search = callbackUrl.search;
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(cfg, current, {
        pkceCodeVerifier: p.verifier,
        expectedState: state,
        expectedNonce: p.nonce,
        idTokenExpected: true,
      });
    } catch (e) {
      this.logger.warn("oidc code exchange failed", { err: (e as Error).message });
      throw new HttpError(401, "sso_failed", `Sign-in failed: ${(e as Error).message}`);
    }
    const idClaims = tokens.claims()!;
    let info: Record<string, unknown> = {};
    try {
      info = (await client.fetchUserInfo(cfg, tokens.access_token, idClaims.sub)) as Record<string, unknown>;
    } catch (e) {
      this.logger.warn("oidc userinfo failed, using id_token claims", { err: (e as Error).message });
    }
    const all = { ...idClaims, ...info } as Record<string, unknown>;
    const groups = Array.isArray(all.groups) ? (all.groups as unknown[]).map(String) : [];
    const username = typeof all.preferred_username === "string" ? all.preferred_username : null;
    const email = typeof all.email === "string" && all.email ? all.email.toLowerCase() : `${username ?? idClaims.sub}@sso.invalid`;
    const name = typeof all.name === "string" && all.name ? all.name : username;
    return { identity: { sub: idClaims.sub, email, name, groups }, returnTo: p.returnTo };
  }
}
