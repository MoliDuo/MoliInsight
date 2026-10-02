
/** Pages through `/v1/export` and gathers the whole range as NDJSON: the header, every event, one end line. */
export async function downloadExport(
  app: string,
  range: { from?: string; to?: string },
  onProgress: (events: number) => void,
): Promise<{ blob: Blob; events: number }> {
  const parts: string[] = [];
  let after: string | null = null;
  let events = 0;
  let header = "";
  for (;;) {
    const q = new URLSearchParams({ app, limit: "10000" });
    if (range.from) q.set("from", range.from);
    if (range.to) q.set("to", range.to);
    if (after) q.set("after", after);
    const response = await fetch(`/v1/export?${q}`);
    if (!response.ok) {
      const json = await response.json().catch(() => ({}));
      throw new Error((json as { error?: string }).error ?? String(response.status));
    }
    const lines = (await response.text()).split("\n").filter(Boolean);
    const end = JSON.parse(lines[lines.length - 1]!) as { count: number; next: string | null };
    if (!after) header = lines[0]!;
    for (const line of lines.slice(1, -1)) parts.push(line);
    events += end.count;
    onProgress(events);
    if (!end.next) {
      const final = JSON.stringify({ type: "end", count: events, next: null });
      return { blob: new Blob([[header, ...parts, final].join("\n") + "\n"], { type: "application/x-ndjson" }), events };
    }
    after = end.next;
  }
}

