import type { ReactNode } from "react";
import { HBars } from "@/charts/charts";
import { FilterBar } from "@/components/filter-bar";
import { Card, Code, DataTable, Muted, Note, PageHeader } from "@/components/ui";
import { toQuery } from "@/lib/filters";
import { ms, num, pct, vital } from "@/lib/format";
import { Loaded, useApi, useAppSlug, useFilters } from "@/lib/hooks";

function Page<T>({ title, intro, path, children }: { title: string; intro: string; path: string; children: (data: T) => ReactNode }) {
  const app = useAppSlug();
  const filters = useFilters();
  const q = useApi<T>(`/api/apps/${app}/${path}?${toQuery(filters)}`);
  return (
    <>
      <PageHeader title={title} intro={intro} />
      <FilterBar />
      <Loaded q={q}>{children}</Loaded>
    </>
  );
}

const targets = (rows: { target: string; events: number; devices: number }[]) => (
  <DataTable head={["目标", "次数", "设备"]} rows={rows.map((r) => [<Code key="t">{r.target}</Code>, num(r.events), num(r.devices)])} />
);

export function FrictionPage() {
  return (
    <Page<any> title="摩擦点" intro="Web 应用专用：用户在哪里卡住、点不动、遇到错误。" path="friction">
      {(f) => (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="连点（rage tap）">{targets(f.rageTaps)}</Card>
          <Card title="无响应点击（dead tap）">{targets(f.deadTaps)}</Card>
          <Card title="错误">
            <DataTable head={["类型", "信息", "次数", "设备"]} rows={f.errors.map((r: any) => [<Code key="k">{r.kind}</Code>, r.message ?? "", num(r.events), num(r.devices)])} />
          </Card>
          <Card title="提示（toast）">
            <DataTable head={["级别", "提示", "次数", "设备"]} rows={f.toasts.map((r: any) => [<Code key="k">{r.level}</Code>, r.message ?? "", num(r.events), num(r.devices)])} />
          </Card>
          <Card title="对话框">
            <DataTable head={["对话框", "动作", "关闭方式", "次数"]} rows={f.dialogs.map((r: any) => [<Code key="k">{r.dialog}</Code>, r.action ?? "", r.closeBy ?? "", num(r.events)])} />
          </Card>
        </div>
      )}
    </Page>
  );
}

export function PerformancePage() {
  return (
    <Page<any> title="性能" intro="分位数在样本里直接计算。LCP、INP、TTFB 的单位是毫秒，CLS 没有单位。" path="performance">
      {(p) => (
        <div className="space-y-4">
          <Card title="页面体验（Web Vitals）">
            <DataTable head={["指标", "页面", "样本", "p50", "p75", "p95", "良好占比"]}
              rows={p.vitals.map((v: any) => [<Code key="m">{v.metric}</Code>, v.screen ?? "", num(v.samples), vital(v.metric, v.p50), vital(v.metric, v.p75), vital(v.metric, v.p95), pct(v.goodShare)])} />
          </Card>
          <Card title="操作耗时">
            <DataTable head={["操作", "次数", "失败率", "p50", "p95", "最常见错误"]}
              rows={p.ops.map((o: any) => [<Code key="o">{o.op}</Code>, num(o.calls), pct(o.failureRate), ms(o.p50), ms(o.p95), o.topErrorKind ?? ""])} />
          </Card>
        </div>
      )}
    </Page>
  );
}

export function NavigationPage() {
  return (
    <Page<any> title="页面导航" intro="Web 应用专用：用户在页面之间怎么走。" path="navigation">
      {(n) => (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="页面和下一步">
            {n.screens.length === 0 ? <Muted>这个范围内没有页面访问。</Muted> : (
              <div className="space-y-4">
                {n.screens.map((s: any) => (
                  <div key={s.screen}>
                    <div className="mb-1 flex justify-between"><Code>{s.screen}</Code><span className="text-muted-foreground">{num(s.events)} 次</span></div>
                    {s.next?.length ? <HBars items={s.next.slice(0, 5).map((x: any) => ({ label: `→ ${x.screen}`, value: x.events }))} /> : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="最常见的路径">
            <DataTable head={["从", "到", "次数", "设备"]} rows={n.edges.map((e: any) => [<Code key="f">{e.from}</Code>, <Code key="t">{e.to}</Code>, num(e.events), num(e.devices)])} />
          </Card>
        </div>
      )}
    </Page>
  );
}

export function UsagePage() {
  return (
    <Page<any> title="功能使用" intro="功能有没有人用，要靠事件目录和实际数据对照。" path="usage">
      {(u) => (
        <div className="space-y-4">
          {u.hasCatalog ? null : <Note>这个应用还没有事件目录，下面的「没人用」和「没登记」没有意义。到「当前应用 → 事件目录」上传。</Note>}
          <div className="grid gap-4 md:grid-cols-2">
            <Card title="目录里有、这个范围内没出现的事件">
              <DataTable head={["事件", "说明", "层级"]} empty="都用到了。" rows={u.unused.map((e: any) => [<Code key="n">{e.name}</Code>, e.description, e.tier])} />
            </Card>
            <Card title="出现了、目录里没登记的事件">
              <DataTable head={["事件", "次数"]} empty="都登记了。" rows={u.uncataloged.map((e: any) => [<Code key="n">{e.name}</Code>, num(e.events)])} />
            </Card>
            <Card title="点击最多的控件">{targets(u.taps)}</Card>
            <Card title="访问最多的页面">
              <DataTable head={["页面", "次数", "设备"]} rows={u.screens.map((t: any) => [<Code key="s">{t.screen}</Code>, num(t.events), num(t.devices)])} />
            </Card>
          </div>
        </div>
      )}
    </Page>
  );
}
