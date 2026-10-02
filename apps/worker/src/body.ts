import { LIMITS } from "@moli-insight/protocol";

export class BodyTooLarge extends Error {}
export class UnsupportedEncoding extends Error {}

/** Reads a stream, giving up as soon as it passes the limit. */
async function readLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * The text of a request body, with both size limits enforced: the size as sent,
 * and the size after gzip decompression, so a small body cannot expand into a large one.
 */
export async function readBodyText(
  request: Request,
  limits: { sent: number; decompressed: number } = {
    sent: LIMITS.maxBodyBytes,
    decompressed: LIMITS.maxDecompressedBytes,
  },
): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limits.sent) throw new BodyTooLarge();

  const encoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "identity" && encoding !== "gzip") throw new UnsupportedEncoding(encoding);
  if (!request.body) return "";

  const sent = await readLimited(request.body, limits.sent);
  if (encoding === "identity") return new TextDecoder().decode(sent);

  const decompressed = new Response(sent).body!.pipeThrough(new DecompressionStream("gzip"));
  try {
    return new TextDecoder().decode(await readLimited(decompressed, limits.decompressed));
  } catch (error) {
    if (error instanceof BodyTooLarge) throw error;
    // A corrupt gzip stream.
    throw new SyntaxError("invalid gzip");
  }
}
