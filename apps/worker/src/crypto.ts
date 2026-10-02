const encoder = new TextEncoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function randomToken(byteLength: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Compares two strings without stopping at the first difference. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Passwords. Workers cap PBKDF2 at 100,000 iterations.

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_PREFIX = "pbkdf2-sha256";

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** `pbkdf2-sha256$<iterations>$<salt>$<hash>`, the salt and hash in base64url. */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return [PBKDF2_PREFIX, iterations, base64url(salt), base64url(hash)].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [prefix, iterations, salt, hash] = stored.split("$");
  if (prefix !== PBKDF2_PREFIX || !iterations || !salt || !hash) return false;
  const count = Number(iterations);
  if (!Number.isInteger(count) || count < 1 || count > PBKDF2_ITERATIONS) return false;
  const derived = await pbkdf2(password, fromBase64url(salt), count);
  return timingSafeEqual(base64url(derived), hash);
}

// ---------------------------------------------------------------------------
// Signed session cookie value: `<payload>.<signature>`.

export async function signSession(secret: string, expiresAtMs: number): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify({ exp: expiresAtMs })));
  return `${payload}.${await hmacHex(secret, payload)}`;
}

export async function verifySession(secret: string, value: string, nowMs: number): Promise<boolean> {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return false;
  if (!timingSafeEqual(await hmacHex(secret, payload), signature)) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { exp?: unknown };
    return typeof exp === "number" && exp > nowMs;
  } catch {
    return false;
  }
}
