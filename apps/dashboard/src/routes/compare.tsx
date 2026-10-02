import { useSearch } from "@tanstack/react-router";
import { FilterBar } from "@/components/filter-bar";
import { Card, DataTable, Muted, PageHeader, Select } from "@/components/ui";
import { toQuery } from "@/lib/filters";
import { validateCompareSearch } from "@/lib/search";
import { duration, num, pct, per } from "@/lib/format";
import { Loaded, useApi, useAppSlug, useSetSearch } from "@/lib/hooks";

interface Side {
  release: string; sessions: number; devices: number; events: number; avgSessionMs: number;
  errors: number; errorsPerSession: number; rageTaps: number; rageTapsPerSession: number;
  deadTaps: number; deadTapsPerSession: number; ops: number; opFailureRate: number | null;
  metrics: { name: string; ratio: number | null; numerator: number; denominator: number }[];
}

export function ComparePage() {
  const app = useAppSlug();
  const search = validateCompareSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const set = useSetSearch();
  const options = useApi<{ releases: string[] }>(`/api/apps/${app}/filters`);
  const releases = options.data?.releases ?? [];
  // Releases are listed newest first; the default is the latest against the one before it.
  const a = search.a && releases.includes(search.a) ? search.a : releases[1];
  const b = search.b && releases.includes(search.b) ? search.b : releases[0];
  const compare = useApi<{ a: Side; b: Side }>(a && b ? `/api/apps/${app}/compare?${toQuery({ ...search, release: undefined }, { a, b })}` : null);

  return (
    <>
      <PageHeader title="版本对比" intro="两个版本在同一个时间范围内的会话和比率。样本小的时候，差别不一定说明问题。" />
      <FilterBar omit={["release"]} />
      <Loaded q={options}>
        {() => releases.length < 2 ? <Muted>至少要有两个版本的数据才能对比。</Muted> : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              A
              <Select aria-label="版本 A" value={a} onChange={(e) => set({ a: e.target.value })}>{releases.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
              对比 B
              <Select aria-label="版本 B" value={b} onChange={(e) => set({ b: e.target.value })}>{releases.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
            </div>
            <Loaded q={compare}>
              {(c) => {
                const rows: [string, (s: Side) => string][] = [
                  ["会话", (s) => num(s.sessions)], ["设备", (s) => num(s.devices)], ["事件", (s) => num(s.events)],
                  ["平均会话时长", (s) => duration(s.avgSessionMs)],
                  ["错误 / 会话", (s) => `${per(s.errorsPerSession)}（${num(s.errors)}）`],
                  ["连点 / 会话", (s) => `${per(s.rageTapsPerSession)}（${num(s.rageTaps)}）`],
                  ["无响应点击 / 会话", (s) => `${per(s.deadTapsPerSession)}（${num(s.deadTaps)}）`],
                  ["操作失败率", (s) => `${pct(s.opFailureRate)}（${num(s.ops)} 次）`],
                  ...c.a.metrics.map((m, i): [string, (s: Side) => string] => [
                    `指标 ${m.name}`,
                    (s) => `${pct(s.metrics[i]?.ratio)}（${num(s.metrics[i]?.numerator)}/${num(s.metrics[i]?.denominator)}）`,
                  ]),
                ];
                return (
                  <Card>
                    <DataTable head={["", `A ${c.a.release}`, `B ${c.b.release}`]} rows={rows.map(([label, f]) => [label, f(c.a), f(c.b)])} />
                  </Card>
                );
              }}
            </Loaded>
          </>
        )}
      </Loaded>
    </>
  );
}
