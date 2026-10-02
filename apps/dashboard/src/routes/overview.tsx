import { BarsByDay, HBars } from "@/charts/charts";
import { FilterBar } from "@/components/filter-bar";
import { Card, DataTable, Empty, PageHeader, Stat } from "@/components/ui";
import { duration, num } from "@/lib/format";
import { previousRange, toQuery } from "@/lib/filters";
import { Loaded, useApi, useAppSlug, useFilters } from "@/lib/hooks";

interface Totals { sessions: number; devices: number; activeDays: number; events: number; avgSessionMs: number }
interface Overview {
  range: { from: string; to: string };
  totals: Totals;
  daily: { day: string; sessions: number }[];
  durations: { bucket: string; sessions: number }[];
  platforms: { platform: string; sessions: number; devices: number }[];
  people: { person: string | null; sessions: number; devices: number; events: number }[];
  releases: { release: string; sessions: number; devices: number }[];
}

const change = (now: number, before?: number) => (before === undefined || before <= 0 ? null : (now - before) / before);

export function OverviewPage() {
  const app = useAppSlug();
  const filters = useFilters();
  const current = useApi<Overview>(`/api/apps/${app}/overview?${toQuery(filters)}`);
  // The period before, as long as this one, for the "versus" line under each number.
  const range = current.data?.range;
  const before = useApi<Overview>(range ? `/api/apps/${app}/overview?${toQuery(previousRange(filters, range))}` : null);
  const prev = before.data && !before.isPlaceholderData ? before.data.totals : undefined;

  return (
    <>
      <PageHeader title="概览" intro={range ? `${range.from} 至 ${range.to}，按会话开始时间统计。` : undefined} />
      <FilterBar />
      <Loaded q={current}>
        {(o) => {
          const t = o.totals;
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <Stat label="会话" value={num(t.sessions)} delta={change(t.sessions, prev?.sessions)} />
                <Stat label="活跃设备" value={num(t.devices)} delta={change(t.devices, prev?.devices)} />
                <Stat label="有使用的天数" value={num(t.activeDays)} />
                <Stat label="事件" value={num(t.events)} delta={change(t.events, prev?.events)} />
                <Stat label="平均会话时长" value={duration(t.avgSessionMs)} delta={change(t.avgSessionMs, prev?.avgSessionMs)} />
              </div>
              {t.sessions === 0 ? <Empty>这个范围内没有会话。</Empty> : null}
              <Card title="每天的会话">
                <BarsByDay days={o.daily.map((d) => d.day)} series={[{ key: "会话", values: o.daily.map((d) => d.sessions) }]} />
              </Card>
              <div className="grid gap-4 md:grid-cols-2">
                <Card title="会话时长">
                  {o.durations.length ? <HBars items={o.durations.map((d) => ({ label: d.bucket, value: d.sessions }))} /> : <Empty>没有数据。</Empty>}
                </Card>
                <Card title="平台">
                  {o.platforms.length ? <HBars items={o.platforms.map((p) => ({ label: p.platform, value: p.sessions, note: `· ${p.devices} 台` }))} /> : <Empty>没有数据。</Empty>}
                </Card>
                <Card title="按人">
                  <DataTable head={["人员", "会话", "设备", "事件"]} empty="没有数据。"
                    rows={o.people.map((p) => [p.person ?? "未归属", num(p.sessions), `${p.devices} 台`, num(p.events)])} />
                </Card>
                <Card title="版本">
                  <DataTable head={["版本", "会话", "设备"]} empty="没有数据。"
                    rows={o.releases.map((r) => [<code key="r">{r.release}</code>, num(r.sessions), `${r.devices} 台`])} />
                </Card>
              </div>
            </div>
          );
        }}
      </Loaded>
    </>
  );
}
