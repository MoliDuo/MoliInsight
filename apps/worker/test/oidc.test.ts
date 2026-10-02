import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { base64url, sha256Base64url } from "../src/crypto.ts";
import { CLIENT_ID, ISSUER, USER, createHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => void (h = await createHarness()));
afterAll(() => h.close());

// ---------------------------------------------------------------------------
// A stand-in for Authelia: just enough of discovery, the token endpoint and userinfo.

const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));

interface Fake {
  /** What the authorization request asked for, once the browser has been sent there. */
  asked?: URLSearchParams;
  tokenRequests: { authorization: string | null; body: URLSearchParams }[];
  /** Overrides for the ID token's claims, the userinfo and the token endpoint's status. */
  claims: Record<string, unknown>;
  profile: Record<string, unknown>;
  tokenStatus: number;
  discoveryStatus: number;
}
let fake: Fake;

beforeEach(() => {
  fake = { tokenRequests: [], claims: {}, profile: {}, tokenStatus: 200, discoveryStatus: 200 };
  h.authelia.fetch = async (input, init) => {
    const url = String(input);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return fake.discoveryStatus === 200
        ? json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, userinfo_endpoint: `${ISSUER}/userinfo` })
        : json({}, fake.discoveryStatus);
    }
    if (url === `${ISSUER}/token`) {
      const body = new URLSearchParams(String(init?.body));
      fake.tokenRequests.push({ authorization: new Headers(init?.headers).get("authorization"), body });
      if (body.get("client_id") !== CLIENT_ID || body.get("client_secret") !== "test-client-secret") return json({ error: "invalid_client" }, 401);
      if (fake.tokenStatus !== 200) return json({ error: "invalid_grant" }, fake.tokenStatus);
      // PKCE: the verifier must hash to the challenge sent in the authorization request.
      if ((await sha256Base64url(body.get("code_verifier") ?? "")) !== fake.asked?.get("code_challenge")) return json({ error: "invalid_grant" }, 400);
      const idToken = ["e30", encode({
        iss: ISSUER, aud: [CLIENT_ID], sub: "id-1", exp: Math.floor(h.clock.now / 1000) + 60, nonce: fake.asked?.get("nonce"), ...fake.claims,
      }), "sig"].join(".");
      return json({ id_token: idToken, access_token: "access-1", token_type: "bearer" });
    }
    if (url === `${ISSUER}/userinfo`) {
      return new Headers(init?.headers).get("authorization") === "Bearer access-1"
        ? json({ sub: "id-1", preferred_username: USER, ...fake.profile })
        : json({}, 401);
    }
    throw new Error(`unexpected ${url}`);
  };
});

const cookieOf = (response: Response, name: string) =>
  response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

/** Opens the sign-in page's link: the worker answers with Authelia's address and a cookie for the attempt. */
async function begin(next?: string) {
  const response = await h.request(`/auth/login${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  fake.asked = location.searchParams;
  return { response, location, pending: cookieOf(response, "mi_oidc")!.split(";")[0]! };
}

/** The browser coming back from Authelia. */
const finish = (pending: string | undefined, query: Record<string, string>) =>
  h.request(`/auth/callback?${new URLSearchParams(query)}`, { headers: pending ? { cookie: pending } : {} });

async function signIn(next?: string) {
  const { pending } = await begin(next);
  return finish(pending, { code: "code-1", state: fake.asked!.get("state")! });
}

describe("starting sign-in", () => {
  it("sends the browser to Authelia with PKCE, a state and a nonce", async () => {
    const { response, location, pending } = await begin();
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/authorize`);
    const q = location.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe("https://insight.test/auth/callback");
    expect(q.get("scope")).toBe("openid profile email groups");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("state")!.length).toBeGreaterThanOrEqual(16);
    expect(q.get("nonce")).toBeTruthy();
    // The attempt's cookie is Lax (the browser returns from another site), HttpOnly, and only for /auth.
    const cookie = cookieOf(response, "mi_oidc")!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/auth/);
    // The verifier itself is not in the URL.
    expect(location.search).not.toContain("code_verifier");
    expect(pending).toMatch(/^mi_oidc=/);
  });

  it("falls back to the login page when Authelia cannot be reached", async () => {
    fake.discoveryStatus = 503;
    const response = await h.request("/auth/login");
    expect(response.headers.get("location")).toBe("/?login_error=failed");
    expect(cookieOf(response, "mi_oidc")).toBeUndefined();
  });

  it("says so when it has not been configured", async () => {
    const saved = h.env.OIDC_CLIENT_SECRET;
    h.env.OIDC_CLIENT_SECRET = "";
    const response = await h.request("/auth/login");
    expect(response.headers.get("location")).toBe("/?login_error=unconfigured");
    h.env.OIDC_CLIENT_SECRET = saved;
  });
});

describe("finishing sign-in", () => {
  it("starts a session for an allowed user and returns to where they were", async () => {
    const response = await signIn("/switch/overview?days=7");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/switch/overview?days=7");

    const session = cookieOf(response, "mi_session")!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Strict/i);
    expect(await (await h.request("/api/me", { headers: { cookie: session.split(";")[0]! } })).json()).toEqual({ authenticated: true, user: USER });
    // The attempt's cookie is spent.
    expect(cookieOf(response, "mi_oidc")).toMatch(/mi_oidc=;/);
    // The sign-in is on record, under the Authelia username.
    const row = await h.env.DB.prepare("SELECT user, action FROM audit_log WHERE action = 'auth.login' ORDER BY id DESC").first();
    expect(row).toEqual({ user: USER, action: "auth.login" });

    // The worker proved who it is, and that the code was its own.
    const [token] = fake.tokenRequests;
    expect(token!.authorization).toBeNull(); // the secret goes in the body (client_secret_post), as the client is registered
    expect(token!.body.get("client_secret")).toBe("test-client-secret");
    expect(token!.body.get("grant_type")).toBe("authorization_code");
    expect(token!.body.get("code")).toBe("code-1");
    expect(token!.body.get("redirect_uri")).toBe("https://insight.test/auth/callback");
  });

  it("will not be sent off the site by `next`", async () => {
    for (const next of ["//evil.example", "/\\evil.example", "https://evil.example", "evil"]) {
      expect((await signIn(next)).headers.get("location")).toBe("/");
    }
  });

  it("matches the username case-insensitively", async () => {
    fake.profile = { preferred_username: USER.toUpperCase() };
    expect(cookieOf(await signIn(), "mi_session")).toBeTruthy();
  });

  it("refuses a user who is not on the allowed list", async () => {
    fake.profile = { preferred_username: "yilin-not-listed" };
    const response = await signIn();
    expect(response.headers.get("location")).toBe("/?login_error=forbidden");
    expect(cookieOf(response, "mi_session")).toBeUndefined();
    // The refusal is on record, with the name that was turned away.
    const row = await h.env.DB.prepare("SELECT user, action FROM audit_log WHERE action = 'auth.refused'").first();
    expect(row).toEqual({ user: "yilin-not-listed", action: "auth.refused" });
  });

  it("refuses everyone when the list is empty", async () => {
    h.env.OIDC_ALLOWED_USERS = "";
    const response = await signIn();
    h.env.OIDC_ALLOWED_USERS = `${USER},second`;
    expect(response.headers.get("location")).toBe("/?login_error=forbidden");
    expect(cookieOf(response, "mi_session")).toBeUndefined();
  });

  it("refuses a callback with the wrong state, no attempt cookie, or an old one", async () => {
    const { pending } = await begin();
    for (const response of [
      await finish(pending, { code: "code-1", state: "wrong-state-wrong-state" }),
      await finish(undefined, { code: "code-1", state: fake.asked!.get("state")! }),
      await finish("mi_oidc=garbage", { code: "code-1", state: fake.asked!.get("state")! }),
    ]) {
      expect(response.headers.get("location")).toBe("/?login_error=expired");
      expect(cookieOf(response, "mi_session")).toBeUndefined();
    }
    h.clock.now += 11 * 60_000;
    const late = await finish(pending, { code: "code-1", state: fake.asked!.get("state")! });
    h.clock.now -= 11 * 60_000;
    expect(late.headers.get("location")).toBe("/?login_error=expired");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("refuses a session cookie presented as an attempt cookie, and the other way round", async () => {
    const session = await h.login();
    const response = await finish(session.replace("mi_session=", "mi_oidc="), { code: "c", state: "s".repeat(20) });
    expect(response.headers.get("location")).toBe("/?login_error=expired");
    const { pending } = await begin();
    const asSession = pending.replace("mi_oidc=", "mi_session=");
    expect((await h.request("/api/apps", { headers: { cookie: asSession } })).status).toBe(401);
  });

  it("reports a refusal from Authelia", async () => {
    const { pending } = await begin();
    const response = await finish(pending, { error: "access_denied", state: fake.asked!.get("state")! });
    expect(response.headers.get("location")).toBe("/?login_error=denied");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it.each([
    ["a nonce from another attempt", { nonce: "someone-elses" }, {}],
    ["a token for another client", { aud: ["other-client"] }, {}],
    ["a token from another issuer", { iss: "https://evil.test" }, {}],
    ["a token that has expired", { exp: 1 }, {}],
    ["a token without a subject", { sub: undefined }, {}],
    ["a userinfo for another subject", {}, { sub: "id-2" }],
    ["a userinfo without a username", {}, { preferred_username: undefined }],
  ])("refuses %s", async (_name, claims, profile) => {
    fake.claims = claims;
    fake.profile = profile;
    const response = await signIn();
    expect(response.headers.get("location")).toBe("/?login_error=failed");
    expect(cookieOf(response, "mi_session")).toBeUndefined();
  });

  it("refuses when the token endpoint rejects the code", async () => {
    fake.tokenStatus = 400;
    const response = await signIn();
    expect(response.headers.get("location")).toBe("/?login_error=failed");
    expect(cookieOf(response, "mi_session")).toBeUndefined();
  });
});
