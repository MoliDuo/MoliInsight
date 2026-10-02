import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { signSession, verifySession } from "./crypto.ts";
import type { AppEnv } from "./env.ts";

export const SESSION_COOKIE = "mi_session";
const SESSION_DAYS = 30;

function isSecure(url: string): boolean {
  return new URL(url).protocol === "https:";
}

export async function startSession(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<void> {
  const { now } = c.get("deps");
  const expires = now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  setCookie(c, SESSION_COOKIE, await signSession(c.env.SESSION_SECRET, expires), {
    httpOnly: true,
    secure: isSecure(c.req.url),
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export function endSession(c: Parameters<MiddlewareHandler<AppEnv>>[0]): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isSecure(c.req.url) });
}

export async function hasSession(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<boolean> {
  const value = getCookie(c, SESSION_COOKIE);
  if (!value || !c.env.SESSION_SECRET) return false;
  return verifySession(c.env.SESSION_SECRET, value, c.get("deps").now());
}

/** Rejects requests without a valid dashboard session. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await hasSession(c))) return c.json({ error: "unauthorized" }, 401);
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
