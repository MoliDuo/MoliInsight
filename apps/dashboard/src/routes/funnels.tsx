import { useMutation, useQueries, type UseQueryResult } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { BarsByDay, HBars } from "@/charts/charts";
import { FilterBar } from "@/components/filter-bar";
import { Button, Card, ConfirmDialog, DataTable, Input, Muted, Note, PageHeader, Select } from "@/components/ui";
import { api, reason } from "@/lib/api";
import { toQuery } from "@/lib/filters";
import { ms, num, pct } from "@/lib/format";
import { Loaded, useApi, useAppSlug, useFilters, useInvalidate } from "@/lib/hooks";
import { ErrorBlock } from "@/components/ui";

interface FunnelDef { steps: { event: string; where?: { prop: string; op: string; value: string }[] }[]; windowMs: number; by: "session" | "device" }
interface Metric { name: string; description: string; goodDirection?: "up" | "down" }
interface Catalog {
  catalog: { events: { name: string }[]; metrics?: Metric[]; funnels?: (FunnelDef & { name: string })[] } | null;
  savedFunnels: (FunnelDef & { name: string })[];
}
interface MetricResult {
  ratio: number | null; numerator: number; denominator: number; truncated?: boolean;
  groups: { group: string; numerator: number; denominator: number; ratio: number | null }[];
  daily: { day: string; denominator: number }[];
}
interface FunnelResult {
  entities: number; by: string; truncated?: boolean;
  steps: { event: string; entities: number; fromPrevious?: number | null; medianMsFromPrevious?: number | null }[];
}

type Step = { event: string; where: string };

export function FunnelsPage() {
  const app = useAppSlug();
  const filters = useFilters();
  const catalog = useApi<Catalog>(`/api/apps/${app}/catalog`);
  return (
    <>
      <PageHeader title="漏斗与指标" intro="指标和漏斗来自应用的事件目录。比率按所选范围和筛选计算。" />
      <FilterBar />
      <Loaded q={catalog}>{(c) => <Body app={app} query={toQuery(filters)} catalog={c} />}</Loaded>
    </>
  );
}

function Body({ app, query, catalog }: { app: string; query: string; catalog: Catalog }) {
  const metrics = catalog.catalog?.metrics ?? [];
  const results: UseQueryResult<MetricResult>[] = useQueries({
    queries: metrics.map((m) => ({
      queryKey: ["api", `/api/apps/${app}/metrics/${m.name}`, query],
      queryFn: () => api<MetricResult>(`/api/apps/${app}/metrics/${encodeURIComponent(m.name)}?${query}`),
    })),
  }) as UseQueryResult<MetricResult>[];
  const funnels = [
    ...(catalog.catalog?.funnels ?? []).map((f) => ({ ...f, saved: false })),
    ...catalog.savedFunnels.map((f) => ({ ...f, saved: true })),
  ];
  const [result, setResult] = useState<FunnelResult | null>(null);
  const run = useMutation({
    mutationFn: (def: FunnelDef) => api<FunnelResult>(`/api/apps/${app}/funnel?${query}`, "POST", def),
    onSuccess: setResult,
  });
  const [removing, setRemoving] = useState<string | null>(null);
  const invalidate = useInvalidate();

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-base font-semibold">比率指标</h2>
        {metrics.length === 0 ? <Muted>这个应用的事件目录里没有指标。到「当前应用 → 事件目录」上传。</Muted> : (
          <div className="grid gap-4 md:grid-cols-2">
            {metrics.map((m, i) => <MetricCard key={m.name} metric={m} q={results[i]!} />)}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold">漏斗</h2>
        {funnels.length === 0 ? <Muted>还没有漏斗。可以在下面搭一个，或者在事件目录里定义。</Muted> : (
          <div className="flex flex-wrap gap-2">
            {funnels.map((f) => (
              <span key={`${f.saved}-${f.name}`} className="inline-flex">
                <Button className={f.saved ? "rounded-r-none" : ""} onClick={() => run.mutate({ steps: f.steps, windowMs: f.windowMs, by: f.by })}>{f.name}</Button>
                {f.saved ? <Button aria-label={`删除 ${f.name}`} className="rounded-l-none border-l-0" onClick={() => setRemoving(f.name)}><X className="size-3.5" /></Button> : null}
              </span>
            ))}
          </div>
        )}
        {run.isPending ? <Muted className="mt-3">计算中…</Muted> : null}
        {run.isError ? <div className="mt-3"><ErrorBlock error={run.error} /></div> : null}
        {result && !run.isPending ? <FunnelCard r={result} /> : null}
      </section>

      <Builder app={app} events={(catalog.catalog?.events ?? []).map((e) => e.name)} onRun={(def) => run.mutate(def)} running={run.isPending}
        onSaved={() => invalidate(`/api/apps/${app}/catalog`)} />

      <ConfirmDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)} title="删除这个漏斗？"
        description={<>漏斗 <code>{removing}</code> 会被删除。</>} confirmLabel="删除"
        onConfirm={async () => {
          try {
            await api(`/api/apps/${app}/funnels/${encodeURIComponent(removing!)}`, "DELETE");
            invalidate(`/api/apps/${app}/catalog`);
            toast.success("已删除");
          } catch (e) { toast.error(`失败：${reason(e)}`); }
        }} />
    </div>
  );
}

function MetricCard({ metric, q }: { metric: Metric; q: UseQueryResult<MetricResult> }) {
  const r = q.data;
  return (
    <Card title={<code>{metric.name}</code>} action={<span className="text-2xl font-semibold">{r ? pct(r.ratio) : q.isError ? "—" : "…"}</span>}>
      <Muted>{metric.description}</Muted>
      {r ? (
        <>
          <Muted className="mt-1">
            {num(r.numerator)} / {num(r.denominator)}{metric.goodDirection ? `，${metric.goodDirection === "up" ? "越高越好" : "越低越好"}` : ""}
          </Muted>
          {r.groups.length ? <div className="mt-3"><DataTable head={["分组", "分子", "分母", "比率"]} rows={r.groups.map((g) => [g.group, num(g.numerator), num(g.denominator), pct(g.ratio)])} /></div> : null}
          <div className="mt-3"><BarsByDay height={110} days={r.daily.map((d) => d.day)} series={[{ key: "分母", values: r.daily.map((d) => d.denominator) }]} /></div>
          {r.truncated ? <Note>数据太多，只统计了最新的一部分。缩小时间范围可以看全。</Note> : null}
        </>
      ) : q.isError ? <Note>这个指标算不出来：{reason(q.error)}</Note> : null}
    </Card>
  );
}

function FunnelCard({ r }: { r: FunnelResult }) {
  const top = r.steps[0]?.entities ?? 0;
  return (
    <Card className="mt-3">
      <Muted className="mb-3">{num(r.entities)} 个{r.by === "device" ? "设备" : "会话"}进入。</Muted>
      <HBars items={r.steps.map((s, i) => ({
        label: `${i + 1}. ${s.event}`, value: s.entities,
        note: `· ${pct(top ? s.entities / top : null)}${i ? `（上一步 ${pct(s.fromPrevious)}，中位 ${ms(s.medianMsFromPrevious)}）` : ""}`,
      }))} />
      {r.truncated ? <Note>数据太多，只统计了最新的一部分。</Note> : null}
    </Card>
  );
}

function Builder({ app, events, onRun, onSaved, running }: { app: string; events: string[]; onRun: (d: FunnelDef) => void; onSaved: () => void; running: boolean }) {
  const [steps, setSteps] = useState<Step[]>([{ event: "", where: "" }, { event: "", where: "" }]);
  const [minutes, setMinutes] = useState("30");
  const [by, setBy] = useState<"session" | "device">("session");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const patch = (i: number, p: Partial<Step>) => setSteps(steps.map((s, k) => (k === i ? { ...s, ...p } : s)));

  const definition = (): FunnelDef => ({
    steps: steps.filter((s) => s.event.trim()).map((s) => {
      const where = s.where.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
        const [prop = "", ...rest] = t.split("=");
        return { prop: prop.trim(), op: "eq", value: rest.join("=").trim() };
      });
      return where.length ? { event: s.event.trim(), where } : { event: s.event.trim() };
    }),
    windowMs: Math.max(1, Number(minutes) || 30) * 60_000,
    by,
  });
  const valid = definition().steps.length >= 2;

  return (
    <Card title="自己搭一个">
      <datalist id="mi-events">{events.map((e) => <option key={e} value={e} />)}</datalist>
      <div className="space-y-2">
        {steps.map((s, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <span className="w-5 text-muted-foreground">{i + 1}.</span>
            <Input list="mi-events" placeholder="事件名" aria-label={`第 ${i + 1} 步事件`} className="w-56" value={s.event} onChange={(e) => patch(i, { event: e.target.value })} />
            <Input placeholder="条件，如 kind=income" aria-label={`第 ${i + 1} 步条件`} className="w-52" value={s.where} onChange={(e) => patch(i, { where: e.target.value })} />
            {steps.length > 2 ? <Button size="sm" variant="ghost" aria-label="删除这一步" onClick={() => setSteps(steps.filter((_, k) => k !== i))}><X className="size-3.5" /></Button> : null}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={steps.length >= 6} onClick={() => setSteps([...steps, { event: "", where: "" }])}><Plus className="size-3.5" />加一步</Button>
        <span className="text-muted-foreground">窗口（分钟）</span>
        <Input type="number" min={1} max={10080} className="w-20" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        <Select value={by} onChange={(e) => setBy(e.target.value as "session" | "device")}>
          <option value="session">按会话</option>
          <option value="device">按设备</option>
        </Select>
        <Button variant="primary" busy={running} disabled={!valid} onClick={() => onRun(definition())}>计算</Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Input placeholder="保存为…" aria-label="漏斗名称" value={name} onChange={(e) => setName(e.target.value)} />
        <Button busy={saving} disabled={!valid || !name.trim()} onClick={async () => {
          setSaving(true);
          try {
            await api(`/api/apps/${app}/funnels/${encodeURIComponent(name.trim())}`, "PUT", definition());
            toast.success("已保存");
            setName("");
            onSaved();
          } catch (e) { toast.error(`失败：${reason(e)}`); } finally { setSaving(false); }
        }}>保存</Button>
      </div>
    </Card>
  );
}
