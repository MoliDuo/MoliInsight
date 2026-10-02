import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { fromBase64url, randomToken, sha256Base64url, signPayload, timingSafeEqual, verifyPayload } from "./crypto.ts";
import { audit } from "./audit.ts";
import type { AppEnv } from "./env.ts";
import { isAllowedUser, isSecure, startSession } from "./session.ts";

// Sign-in is Authelia's: the authorization code flow with PKCE, the worker being a confidential client.
// The dashboard never sees a password.

const PENDING_COOKIE = "mi_oidc";
const PENDING_TYPE = "oidc";
const PENDING_MINUTES = 10;
const SCOPES = "openid profile email groups";

/** Why a sign-in ended; the login page words it. Nothing else about the failure leaves the worker. */
export type LoginError = "unconfigured" | "denied" | "expired" | "failed" | "forbidden";

interface Pending {
  exp: number;
  state: string;
  nonce: string;
  verifier: string;
  next: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

export const oidc = new Hono<AppEnv>();

const failure = (error: LoginError) => `/?login_error=${error}`;

/** Only paths on this site: `//host` and `/\host` would leave it. */
const safeNext = (next: string | undefined): string => (next && /^\/(?![/\\])/.test(next) ? next : "/");

const trimmed = (url: string) => url.replace(/\/+$/, "");

async function discover(issuer: string, fetcher: typeof fetch): Promise<Discovery> {
  const response = await fetcher(`${trimmed(issuer)}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`discovery ${response.status}`);
  const found = (await response.json()) as Discovery;
  if (trimmed(found.issuer) !== trimmed(issuer)) throw new Error("issuer mismatch");
  return found;
}

oidc.get("/auth/login", async (c) => {
  const { OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, PUBLIC_URL, SESSION_SECRET } = c.env;
  if (!OIDC_ISSUER || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET || !PUBLIC_URL || !SESSION_SECRET) return c.redirect(failure("unconfigured"));

  const { now, fetch: fetcher } = c.get("deps");
  let found: Discovery;
  try {
    found = await discover(OIDC_ISSUER, fetcher);
  } catch {
    return c.redirect(failure("failed"));
  }

  const pending: Pending = {
    exp: now() + PENDING_MINUTES * 60_000,
    state: randomToken(24),
    nonce: randomToken(24),
    verifier: randomToken(48),
    next: safeNext(c.req.query("next")),
  };
  // Lax, not Strict: the browser comes back from another site, and Strict would hold the cookie back.
  setCookie(c, PENDING_COOKIE, await signPayload(SESSION_SECRET, PENDING_TYPE, { ...pending }), {
    httpOnly: true,
    secure: isSecure(PUBLIC_URL),
    sameSite: "Lax",
    path: "/auth",
    maxAge: PENDING_MINUTES * 60,
  });

  const url = new URL(found.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: OIDC_CLIENT_ID,
    redirect_uri: `${trimmed(PUBLIC_URL)}/auth/callback`,
    scope: SCOPES,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await sha256Base64url(pending.verifier),
    code_challenge_method: "S256",
  }).toString();
  return c.redirect(url.toString());
});

oidc.get("/auth/callback", async (c) => {
  const { OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, PUBLIC_URL, SESSION_SECRET } = c.env;
  if (!OIDC_ISSUER || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET || !PUBLIC_URL || !SESSION_SECRET) return c.redirect(failure("unconfigured"));
  const { now, fetch: fetcher } = c.get("deps");

  // One attempt, one cookie: it is spent whatever happens next.
  const cookie = getCookie(c, PENDING_COOKIE);
  deleteCookie(c, PENDING_COOKIE, { path: "/auth", secure: isSecure(PUBLIC_URL) });
  const pending = cookie ? await verifyPayload<Pending>(SESSION_SECRET, PENDING_TYPE, cookie, now()) : null;
  const state = c.req.query("state");
  if (!pending || !state || !timingSafeEqual(state, pending.state)) return c.redirect(failure("expired"));
  if (c.req.query("error")) return c.redirect(failure("denied"));
  const code = c.req.query("code");
  if (!code) return c.redirect(failure("failed"));

  try {
    const found = await discover(OIDC_ISSUER, fetcher);
    const token = await fetcher(found.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      // `moli-authelia add` registers confidential clients for client_secret_post.
      body: new URLSearchParams({
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: `${trimmed(PUBLIC_URL)}/auth/callback`,
        code_verifier: pending.verifier,
      }),
    });
    if (!token.ok) return c.redirect(failure("failed"));
    const { id_token: idToken, access_token: accessToken } = (await token.json()) as { id_token?: string; access_token?: string };
    if (!idToken || !accessToken) return c.redirect(failure("failed"));

    // The ID token came straight from the token endpoint over TLS, so its signature is not re-checked
    // (OIDC Core 3.1.3.7); what is checked is that it was issued to us, now, for this attempt.
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(idToken.split(".")[1] ?? ""))) as {
      iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string;
    };
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      !claims.sub ||
      trimmed(claims.iss ?? "") !== trimmed(found.issuer) ||
      !audience.includes(OIDC_CLIENT_ID) ||
      typeof claims.exp !== "number" || claims.exp * 1000 <= now() ||
      !claims.nonce || !timingSafeEqual(claims.nonce, pending.nonce)
    ) return c.redirect(failure("failed"));

    const info = await fetcher(found.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!info.ok) return c.redirect(failure("failed"));
    const profile = (await info.json()) as { sub?: string; preferred_username?: string };
    if (profile.sub !== claims.sub || !profile.preferred_username) return c.redirect(failure("failed"));

    if (!isAllowedUser(c.env, profile.preferred_username)) {
      await audit(c, "auth.refused", "", {}, profile.preferred_username);
      return c.redirect(failure("forbidden"));
    }
    await startSession(c, profile.preferred_username);
    await audit(c, "auth.login", "", {}, profile.preferred_username);
    return c.redirect(pending.next);
  } catch {
    return c.redirect(failure("failed"));
  }
});
