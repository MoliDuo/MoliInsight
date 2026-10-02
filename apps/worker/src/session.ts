import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { signPayload, verifyPayload } from "./crypto.ts";
import type { AppEnv, Env } from "./env.ts";

export const SESSION_COOKIE = "mi_session";
const SESSION_TYPE = "session";
const SESSION_DAYS = 30;

type Context = Parameters<MiddlewareHandler<AppEnv>>[0];

export function isSecure(url: string): boolean {
  return new URL(url).protocol === "https:";
}

/** Whether an Authelia username may use the dashboard. Checked at sign-in and again on every request. */
export function isAllowedUser(env: Env, user: string): boolean {
  const allowed = (env.OIDC_ALLOWED_USERS ?? "").split(",").map((u) => u.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(user.trim().toLowerCase());
}

export async function startSession(c: Context, user: string): Promise<void> {
  const { now } = c.get("deps");
  const expires = now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  setCookie(c, SESSION_COOKIE, await signPayload(c.env.SESSION_SECRET, SESSION_TYPE, { exp: expires, user }), {
    httpOnly: true,
    secure: isSecure(c.req.url),
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export function endSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isSecure(c.req.url) });
}

/** Who is signed in, or null. Taking someone off `OIDC_ALLOWED_USERS` ends their session at once. */
export async function sessionUser(c: Context): Promise<string | null> {
  const value = getCookie(c, SESSION_COOKIE);
  if (!value || !c.env.SESSION_SECRET) return null;
  const session = await verifyPayload<{ exp: number; user?: unknown }>(c.env.SESSION_SECRET, SESSION_TYPE, value, c.get("deps").now());
  if (!session || typeof session.user !== "string") return null;
  return isAllowedUser(c.env, session.user) ? session.user : null;
}

export async function hasSession(c: Context): Promise<boolean> {
  return (await sessionUser(c)) !== null;
}

/** Rejects requests without a valid dashboard session. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await sessionUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
};

/**
 * A request that changes something must come from the dashboard's own origin.
 * The cookie is SameSite=Strict already; this is the second lock.
 */
export const requireSameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  const origin = c.req.header("origin");
  if (origin && new URL(origin).host !== new URL(c.req.url).host) {
    return c.json({ error: "forbidden_origin" }, 403);
  }
  await next();
};
