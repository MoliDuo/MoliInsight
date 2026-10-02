import { vi } from "vitest";
import { processIngest } from "@moli-insight/protocol";
import { createClient } from "../src/client.ts";
import type { InsightWeb } from "../src/types.ts";

export interface Posted {
  url: string;
  body: { schemaVersion: number; sentAt: string; context: Record<string, unknown>; events: any[] };
  headers: Record<string, string>;
}

export interface Net {
  posts: Posted[];
  beacons: Posted[];
  /** Answers the next requests in order; after that, 204. */
  script: (Response | Error)[];
  beaconResult: boolean;
}

/** Fake fetch and sendBeacon, and the batches they received. */
export function stubNetwork(): Net {
  const net: Net = { posts: [], beacons: [], script: [], beaconResult: true };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    net.posts.push({ url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
    const next = net.script.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response(null, { status: 204 });
  });
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string, blob: Blob) => {
      // The blob is read synchronously through the polyfill below.
      net.beacons.push({ url, body: (blob as any).__json, headers: {} });
      return net.beaconResult;
    },
  });
  const RealBlob = globalThis.Blob;
  vi.stubGlobal(
    "Blob",
    class extends RealBlob {
      __json: unknown;
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        if (options?.type === "application/json" && typeof parts?.[0] === "string") this.__json = JSON.parse(parts[0]);
      }
    },
  );
  return net;
}

export function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

export function newClient(options: Partial<Parameters<InsightWeb["init"]>[0]> = {}) {
  const client = createClient();
  client.init({ endpoint: "/api/telemetry", release: "abc123", autoCapture: false, ...options });
  return client;
}

/** Everything the SDK sends must pass the server's own validation. */
export function expectAccepted(body: Posted["body"]) {
  const result = processIngest(body, Date.parse(body.sentAt));
  if (!result.ok) throw new Error(`the server would refuse the batch: ${result.error}`);
  if (result.rejected.length) throw new Error(`the server would reject events: ${JSON.stringify(result.rejected)}`);
}

export const names = (events: { name: string }[]) => events.map((e) => e.name);
