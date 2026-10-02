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
// Signed cookie values: `<payload>.<signature>`. The payload names its own purpose (`typ`), so a cookie
// signed for one use cannot be presented for another.

export async function signPayload(secret: string, typ: string, payload: Record<string, unknown>): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify({ ...payload, typ })));
  return `${body}.${await hmacHex(secret, body)}`;
}

/** The payload if the signature is ours, the purpose matches and `exp` (ms) has not passed. */
export async function verifyPayload<T extends { exp: number }>(
  secret: string,
  typ: string,
  value: string,
  nowMs: number,
): Promise<T | null> {
  const [body, signature] = value.split(".");
  if (!body || !signature) return null;
  if (!timingSafeEqual(await hmacHex(secret, body), signature)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as T & { typ?: unknown };
    return payload.typ === typ && typeof payload.exp === "number" && payload.exp > nowMs ? payload : null;
  } catch {
    return null;
  }
}

export async function sha256Base64url(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}
