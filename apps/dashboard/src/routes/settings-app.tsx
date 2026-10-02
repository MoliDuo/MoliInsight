import { useNavigate, useSearch } from "@tanstack/react-router";
import clsx from "clsx";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ConnectGuide } from "@/components/connect";
import {
  Button, Card, Code, ConfirmDialog, DataTable, Input, Muted, Note, PageHeader, Select, SecretBox,
} from "@/components/ui";
import { api, reason } from "@/lib/api";
import { downloadExport } from "@/lib/export";
import { fmt, num } from "@/lib/format";
import { Loaded, useApi, useAppSlug, useInvalidate, useSetSearch, type AppRow } from "@/lib/hooks";
import type { ImportPlatform, planUsageImport } from "@moli-insight/protocol";
import { validateSettingsSearch, type SettingsTab } from "@/lib/search";

const TABS: [SettingsTab, string][] = [
  ["connect", "接入"], ["keys", "密钥"], ["devices", "设备"], ["catalog", "事件目录"], ["data", "导入导出"], ["advanced", "保留期与删除"],
];

export function AppSettingsPage() {
  const app = useAppSlug();
  const tab = validateSettingsSearch(useSearch({ strict: false }) as Record<string, unknown>).tab ?? "connect";
  const set = useSetSearch();
  const apps = useApi<{ apps: AppRow[] }>("/api/apps");
  return (
    <>
      <PageHeader title={apps.data?.apps.find((a) => a.slug === app)?.name ?? app} intro={<>应用 <code>{app}</code> 的接入、密钥、设备和数据。</>} />
      <div className="mb-4 flex flex-wrap gap-1 border-b border-border" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => set({ tab: id })}
            className={clsx("-mb-px border-b-2 px-3 py-2 text-sm", tab === id ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>{label}</button>
        ))}
      </div>
      {tab === "connect" ? <Connect app={app} /> : null}
      {tab === "keys" ? <Keys app={app} /> : null}
      {tab === "devices" ? <Devices app={app} /> : null}
      {tab === "catalog" ? <CatalogTab app={app} /> : null}
      {tab === "data" ? <DataTab app={app} /> : null}
      {tab === "advanced" ? <Advanced app={app} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------

function Connect({ app }: { app: string }) {
  const apps = useApi<{ apps: AppRow[] }>(`/api/apps`, { refetchInterval: 10000 });
  const mine = apps.data?.apps.find((a) => a.slug === app);
  return (
    <div className="space-y-4">
      <Card title="状态">
        <p>{mine?.lastEventAt ? <>最近一条事件：{fmt(mine.lastEventAt)}，共 {num(mine.deviceCount)} 台设备上报过。</> : "还没有收到任何事件。"}</p>
      </Card>
      <Note tone="muted">密钥只在生成时显示一次。下面的代码里是占位符，到「密钥」页生成新的一把再替换。</Note>
      <ConnectGuide keyText="mi_…" />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Key { id: number; prefix: string; label: string; lastUsedAt: number | null; revokedAt: number | null }

function Keys({ app }: { app: string }) {
  const q = useApi<{ keys: Key[] }>(`/api/apps/${app}/keys`);
  const invalidate = useInvalidate();
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<Key | null>(null);
  return (
    <div className="space-y-4">
      <Card title="生成密钥">
        <Muted className="mb-3">密钥只能写入数据，不能读取。直连模式的密钥会随客户端发出，泄露后在这里作废即可。</Muted>
        <form className="flex flex-wrap gap-2" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const r = await api<{ key: string }>(`/api/apps/${app}/keys`, "POST", { label });
            setCreated(r.key);
            setLabel("");
            await invalidate(`/api/apps/${app}/keys`);
          } catch (error) { toast.error(`失败：${reason(error)}`); } finally { setBusy(false); }
        }}>
          <Input required placeholder="备注，如 release-ci" aria-label="备注" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button type="submit" variant="primary" busy={busy}>生成密钥</Button>
        </form>
        {created ? <div className="mt-4"><SecretBox label="摄入密钥" value={created} /></div> : null}
      </Card>
      <Loaded q={q}>
        {({ keys }) => (
          <Card title="已有密钥">
            {keys.length === 0 ? <Muted>还没有密钥。</Muted> : (
              <ul className="divide-y divide-border">
                {keys.map((k) => (
                  <li key={k.id} className={clsx("flex flex-wrap items-center justify-between gap-2 py-2", k.revokedAt && "opacity-50")}>
                    <span><Code>{k.prefix}…</Code> <span className={k.revokedAt ? "line-through" : ""}>{k.label}</span></span>
                    <span className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">最近使用 {fmt(k.lastUsedAt)}</span>
                      {k.revokedAt ? <span className="text-xs text-muted-foreground">已作废</span> : <Button size="sm" variant="danger" onClick={() => setRevoking(k)}>作废</Button>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </Loaded>
      <ConfirmDialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)} title="作废这把密钥？"
        description={<>使用 <code>{revoking?.prefix}…</code>（{revoking?.label}）的客户端将立即收到 401。</>} confirmLabel="作废"
        onConfirm={async () => {
          try { await api(`/api/keys/${revoking!.id}/revoke`, "POST"); await invalidate(`/api/apps/${app}/keys`); toast.success("已作废"); }
          catch (e) { toast.error(`失败：${reason(e)}`); }
        }} />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Device { id: number; deviceId: string; platform: string; lastRelease: string | null; lastSeenAt: number | null; personId: number | null }

function Devices({ app }: { app: string }) {
  const q = useApi<{ devices: Device[] }>(`/api/apps/${app}/devices`);
  const people = useApi<{ people: { id: number; name: string }[] }>("/api/people");
  const invalidate = useInvalidate();
  const [removing, setRemoving] = useState<Device | null>(null);
  return (
    <>
      <Loaded q={q}>
        {({ devices }) => (
          <Card title="设备">
            <DataTable head={["设备", "平台", "版本", "最近", "归属", ""]} empty="还没有设备上报过数据。"
              rows={devices.map((d) => [
                <Code key="d">{d.deviceId}</Code>, d.platform, d.lastRelease ?? "—", fmt(d.lastSeenAt),
                <Select key="p" aria-label="归属" value={d.personId ?? ""} onChange={async (e) => {
                  try {
                    await api(`/api/devices/${d.id}`, "PUT", { personId: e.target.value ? Number(e.target.value) : null });
                    await invalidate(`/api/apps/${app}/devices`);
                    toast.success("已保存");
                  } catch (error) { toast.error(`失败：${reason(error)}`); }
                }}>
                  <option value="">未归属</option>
                  {(people.data?.people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>,
                <Button key="x" size="sm" variant="danger" onClick={() => setRemoving(d)}>删除数据</Button>,
              ])} />
          </Card>
        )}
      </Loaded>
      <ConfirmDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)} title="删除这台设备？"
        description={<>设备 <code>{removing?.deviceId}</code> 及其全部事件会被删除，此操作不可撤销。</>} confirmLabel="删除"
        onConfirm={async () => {
          try { await api(`/api/devices/${removing!.id}`, "DELETE"); await invalidate(`/api/apps/${app}`); toast.success("已删除"); }
          catch (e) { toast.error(`失败：${reason(e)}`); }
        }} />
    </>
  );
}

// ---------------------------------------------------------------------------

interface CatalogData {
  catalog: {
    events: { name: string; description: string; tier?: string }[];
    metrics?: { name: string; description: string }[];
    funnels?: { name: string; steps: { event: string }[] }[];
  } | null;
}
interface CatalogResult { ok?: boolean; events?: number; metrics?: number; funnels?: number; dryRun?: boolean; error?: string; issues?: { path: string; message: string }[] }

async function putCatalog(app: string, text: string, dryRun: boolean): Promise<CatalogResult & { status: number }> {
  const response = await fetch(`/api/apps/${app}/catalog${dryRun ? "?dryRun=1" : ""}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: text,
  });
  return { status: response.status, ...(await response.json().catch(() => ({}))) };
}

function CatalogTab({ app }: { app: string }) {
  const q = useApi<CatalogData>(`/api/apps/${app}/catalog`);
  const invalidate = useInvalidate();
  const file = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [result, setResult] = useState<(CatalogResult & { status: number }) | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [confirming, setConfirming] = useState(false);

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? "check" : "save");
    try {
      const r = await putCatalog(app, text, dryRun);
      setResult(r);
      if (!dryRun && r.ok) { toast.success("事件目录已替换"); await invalidate(`/api/apps/${app}/catalog`); setText(""); setResult(null); }
    } catch (e) { toast.error(`失败：${reason(e)}`); } finally { setBusy(null); }
  };
  const checked = result?.ok && result.dryRun;

  return (
    <div className="space-y-4">
      <Card title="上传事件目录">
        <Muted className="mb-3">事件目录描述一个应用的事件、比率指标和漏斗，通常放在应用自己的仓库里。上传会替换现有的整份目录。</Muted>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) { setText(await f.text()); setResult(null); }
            e.target.value = "";
          }} />
          <Button onClick={() => file.current?.click()}>选择 JSON 文件…</Button>
          <span className="text-xs text-muted-foreground">或者把内容粘贴在下面</span>
        </div>
        <textarea aria-label="事件目录 JSON" spellCheck={false} value={text} onChange={(e) => { setText(e.target.value); setResult(null); }}
          placeholder='{ "schemaVersion": 1, "events": [ … ] }'
          className="mt-3 h-48 w-full rounded-md border border-border bg-card p-2 font-mono text-xs" />
        <div className="mt-3 flex gap-2">
          <Button busy={busy === "check"} disabled={!text.trim()} onClick={() => run(true)}>先校验</Button>
          <Button variant="primary" disabled={!checked || busy !== null} onClick={() => setConfirming(true)}>替换事件目录</Button>
        </div>
        {result && !result.ok ? (
          <div role="alert" className="mt-3 rounded-md border border-border p-3 text-sm">
            <p className="text-danger">{result.error === "invalid_catalog" ? "这份目录有问题：" : `失败：${result.error ?? result.status}`}</p>
            {result.issues?.length ? <ul className="mt-1 list-disc pl-5">{result.issues.map((i, k) => <li key={k}><Code>{i.path || "（根）"}</Code> {i.message}</li>)}</ul> : null}
          </div>
        ) : null}
        {checked ? <Note tone="muted">校验通过：{result.events} 个事件，{result.metrics} 个指标，{result.funnels} 个漏斗。点「替换事件目录」才会生效。</Note> : null}
      </Card>
      <Loaded q={q}>
        {({ catalog }) => !catalog ? <Muted>这个应用还没有事件目录。</Muted> : (
          <>
            <Card title={`事件（${catalog.events.length}）`}>
              <DataTable head={["事件", "说明", "层级"]} rows={catalog.events.map((e) => [<Code key="n">{e.name}</Code>, e.description, e.tier ?? ""])} />
            </Card>
            <Card title={`指标（${catalog.metrics?.length ?? 0}）`}>
              <DataTable head={["指标", "说明"]} empty="没有指标。" rows={(catalog.metrics ?? []).map((m) => [<Code key="n">{m.name}</Code>, m.description])} />
            </Card>
            <Card title={`漏斗（${catalog.funnels?.length ?? 0}）`}>
              <DataTable head={["漏斗", "步骤"]} empty="没有漏斗。" rows={(catalog.funnels ?? []).map((f) => [<Code key="n">{f.name}</Code>, f.steps.map((s) => s.event).join(" → ")])} />
            </Card>
          </>
        )}
      </Loaded>
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="替换事件目录？" confirmLabel="替换"
        description="现有的整份目录会被这一份替换。通过看板保存的漏斗不受影响。" onConfirm={() => run(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------

const PLATFORMS: ImportPlatform[] = ["macos", "windows", "ios", "android", "web", "server"];
const names = (s: string) => new Set(s.split(",").map((t) => t.trim()).filter(Boolean));

function DataTab({ app }: { app: string }) {
  return <div className="space-y-4"><ImportCard app={app} /><ExportCard app={app} /></div>;
}

type Plan = Awaited<ReturnType<typeof planUsageImport>>;
/** The import planner pulls in the protocol schemas, so it is loaded when an import starts. */
const planner = async () => (await import("@moli-insight/protocol")).planUsageImport;

function ImportCard({ app }: { app: string }) {
  const invalidate = useInvalidate();
  const file = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [platform, setPlatform] = useState<ImportPlatform>("macos");
  const [deviceId, setDeviceId] = useState(() => `dev_import${Math.random().toString(36).slice(2, 10)}`);
  const [release, setRelease] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; accepted: number; duplicates: number; rejected: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const options = () => ({
    platform, deviceId,
    ...(release ? { release } : {}),
    ...(include.trim() ? { include: names(include) } : {}),
    ...(exclude.trim() ? { exclude: names(exclude) } : {}),
  });
  const preview = async () => {
    setError("");
    setProgress(null);
    setPlan(await (await planner())(text, options(), Date.now()));
  };
  const start = async () => {
    setRunning(true);
    setError("");
    const p = await (await planner())(text, options(), Date.now());
    const total = { done: 0, total: p.batches.length, accepted: 0, duplicates: 0, rejected: 0 };
    setProgress({ ...total });
    try {
      for (const body of p.batches) {
        const r = await api<{ accepted: number; duplicates: number; rejected: unknown[] }>(`/api/apps/${app}/import`, "POST", body);
        total.done += 1;
        total.accepted += r.accepted;
        total.duplicates += r.duplicates;
        total.rejected += r.rejected.length;
        setProgress({ ...total });
      }
      toast.success(`导入完成：新增 ${total.accepted} 条`);
      await invalidate(`/api/apps/${app}`);
    } catch (e) {
      setError(`第 ${total.done + 1} 批失败：${reason(e)}。已经导入的不会重复，修好后可以重新导入。`);
    } finally { setRunning(false); }
  };

  return (
    <Card title="导入 MoliSwitch 使用日志">
      <Muted className="mb-3">选一个 <code>usage-YYYY-MM-DD.jsonl</code>。重复导入同一个文件不会多出数据；服务端只收最近 7 天的事件，更早的会被跳过。</Muted>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={file} type="file" accept=".jsonl,.json,.txt,application/json" className="hidden" onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) { setText(await f.text()); setFileName(f.name); setPlan(null); setProgress(null); }
          e.target.value = "";
        }} />
        <Button onClick={() => file.current?.click()}>选择文件…</Button>
        <span className="text-sm text-muted-foreground">{fileName || "还没有选文件"}</span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="text-xs text-muted-foreground">平台
          <Select className="mt-1 block w-full" value={platform} onChange={(e) => { setPlatform(e.target.value as ImportPlatform); setPlan(null); }}>
            {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </label>
        <label className="text-xs text-muted-foreground">设备 ID
          <Input className="mt-1 block w-full" value={deviceId} onChange={(e) => { setDeviceId(e.target.value); setPlan(null); }} />
        </label>
        <label className="text-xs text-muted-foreground">版本（留空则用日志里 appStart 的版本）
          <Input className="mt-1 block w-full" value={release} onChange={(e) => { setRelease(e.target.value); setPlan(null); }} />
        </label>
        <label className="text-xs text-muted-foreground">只导入这些事件（逗号分隔，可留空）
          <Input className="mt-1 block w-full" value={include} onChange={(e) => { setInclude(e.target.value); setPlan(null); }} />
        </label>
        <label className="text-xs text-muted-foreground">不导入这些事件（逗号分隔，可留空）
          <Input className="mt-1 block w-full" value={exclude} onChange={(e) => { setExclude(e.target.value); setPlan(null); }} />
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <Button disabled={!text || running} onClick={preview}>预览</Button>
        <Button variant="primary" busy={running} disabled={!plan || plan.events === 0} onClick={start}>开始导入</Button>
      </div>
      {plan ? (
        <p className="mt-3 text-sm">共 {num(plan.lines)} 行：将导入 <b>{num(plan.events)}</b> 个事件（{plan.batches.length} 批）；
          无法读取 {num(plan.unreadable)}，被筛掉 {num(plan.filtered)}，超过 7 天 {num(plan.tooOld)}。</p>
      ) : null}
      {progress ? (
        <div className="mt-3">
          <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 100}%` }} /></div>
          <p className="mt-1 text-sm text-muted-foreground">{progress.done} / {progress.total} 批 · 新增 {num(progress.accepted)} · 已存在 {num(progress.duplicates)} · 被拒 {num(progress.rejected)}</p>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
    </Card>
  );
}

function ExportCard({ app }: { app: string }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="导出数据">
      <Muted className="mb-3">下载这个应用的原始事件（NDJSON，格式见 docs/export-v1.md），可以交给 AI 或脚本分析。不填日期就是全部。</Muted>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" aria-label="开始日期" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-muted-foreground">–</span>
        <Input type="date" aria-label="结束日期（不含）" value={to} onChange={(e) => setTo(e.target.value)} />
        <Button variant="primary" busy={busy} onClick={async () => {
          setBusy(true);
          setCount(0);
          try {
            const { blob, events } = await downloadExport(app, { from, to }, setCount);
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `${app}-${new Date().toISOString().slice(0, 10)}.ndjson`;
            a.click();
            URL.revokeObjectURL(a.href);
            toast.success(`已导出 ${num(events)} 个事件`);
          } catch (e) { toast.error(`导出失败：${reason(e)}`); } finally { setBusy(false); }
        }}>下载</Button>
        {busy && count !== null ? <span className="text-sm text-muted-foreground">已取 {num(count)} 个事件…</span> : null}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function Advanced({ app }: { app: string }) {
  const apps = useApi<{ apps: AppRow[] }>("/api/apps");
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const mine = apps.data?.apps.find((a) => a.slug === app);
  const [days, setDays] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const value = days ?? String(mine?.retentionDays ?? 90);
  return (
    <div className="space-y-4">
      <Card title="保留期">
        <div className="flex flex-wrap items-center gap-2">
          原始事件保留
          <Input type="number" min={1} max={3650} className="w-24" aria-label="保留天数" value={value} onChange={(e) => setDays(e.target.value)} />
          天
          <Button busy={saving} onClick={async () => {
            setSaving(true);
            try { await api(`/api/apps/${app}`, "PATCH", { retentionDays: Number(value) }); await invalidate("/api/apps"); toast.success("已保存"); setDays(null); }
            catch (e) { toast.error(`失败：${reason(e)}`); } finally { setSaving(false); }
          }}>保存</Button>
        </div>
      </Card>
      <Card title="危险操作">
        <Muted className="mb-3">删除应用会同时删除它的全部数据、密钥和事件目录。</Muted>
        <Button variant="danger" onClick={() => setDeleting(true)}>删除应用与全部数据</Button>
      </Card>
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} title="删除应用？" phrase={app} confirmLabel="删除"
        description={<>应用 <code>{app}</code> 及其全部数据会被删除，此操作不可撤销。</>}
        onConfirm={async () => {
          try {
            await api(`/api/apps/${app}`, "DELETE");
            await invalidate("/api/apps");
            toast.success("已删除");
            navigate({ to: "/" });
          } catch (e) { toast.error(`失败：${reason(e)}`); }
        }} />
    </div>
  );
}
