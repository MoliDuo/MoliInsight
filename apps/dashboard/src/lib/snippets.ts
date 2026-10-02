/**
 * Ready-to-paste setup code. A browser never holds the key: it posts to a relay in the app's
 * own backend. Only a native client or a script with no backend uses the key directly.
 */
export function snippets(origin: string, key: string) {
  return {
    relay: `// src/app/api/telemetry/route.ts  (Next.js)
import { createInsight } from "@moli-insight/node";

const insight = createInsight({ url: process.env.INSIGHT_URL, key: process.env.INSIGHT_KEY });

export const POST = insight.relayHandler({
  authorize: async (req) => Boolean(await getSession(req)),
});

// Server environment:
//   INSIGHT_URL=${origin}
//   INSIGHT_KEY=${key}`,
    browser: `import { init } from "@moli-insight/web";

init({ endpoint: "/api/telemetry", release: process.env.NEXT_PUBLIC_GIT_SHA });`,
    swift: `import MoliInsight

var config = InsightConfig(endpoint: URL(string: "${origin}")!, key: "${key}", release: appVersion)
let sink = InsightSink(config: config, directory: appSupport.appendingPathComponent("insight"))
sink.start()`,
    curl: `curl -X POST ${origin}/v1/ingest \\
  -H "authorization: Bearer ${key}" \\
  -H "content-type: application/json" \\
  -d '{"schemaVersion":1,"sentAt":"'$(date -u +%FT%TZ)'","context":{"platform":"server","release":"1.0.0","deviceId":"dev_example0001"},"events":[{"id":"'$(uuidgen)'","name":"app.started","occurredAt":"'$(date -u +%FT%TZ)'"}]}'`,
  };
}
