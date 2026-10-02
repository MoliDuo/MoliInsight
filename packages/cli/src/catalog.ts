import { CatalogSchema } from "@moli-insight/protocol";

export interface CatalogOptions {
  url: string;
  key: string;
  dryRun?: boolean;
  fetch?: typeof fetch;
}

export interface CatalogSummary {
  events: number;
  metrics: number;
  funnels: number;
  /** True when nothing was sent. */
  dryRun: boolean;
}

/**
 * Checks a catalog file against the schema, then replaces the app's catalog on
 * the server with it. Problems are thrown with the path of the first one.
 */
export async function uploadCatalog(text: string, options: CatalogOptions): Promise<CatalogSummary> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("the file is not valid JSON");
  }
  const parsed = CatalogSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  const catalog = parsed.data;
  const summary = {
    events: catalog.events.length,
    metrics: catalog.metrics?.length ?? 0,
    funnels: catalog.funnels?.length ?? 0,
    dryRun: options.dryRun === true,
  };
  if (options.dryRun) return summary;

  const response = await (options.fetch ?? fetch)(new URL("/v1/catalog", options.url), {
    method: "PUT",
    headers: { authorization: `Bearer ${options.key}`, "content-type": "application/json" },
    body: JSON.stringify(catalog),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; issues?: { path?: string; message?: string }[] } | null;
    const first = body?.issues?.[0];
    throw new Error(
      `the server answered ${response.status}${body?.error ? ` ${body.error}` : ""}${first ? ` (${first.path}: ${first.message})` : ""}`,
    );
  }
  return summary;
}
