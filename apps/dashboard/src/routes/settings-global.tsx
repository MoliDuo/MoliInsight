import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button, Card, ConfirmDialog, Input, Muted, PageHeader, SecretBox, CodeBlock } from "@/components/ui";
import { api, reason } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Loaded, useApi, useInvalidate } from "@/lib/hooks";
import { Code } from "@/components/ui";

interface Token { id: number; prefix: string; label: string; lastUsedAt: number | null; revokedAt: number | null }

export function TokensPage() {
  const q = useApi<{ tokens: Token[] }>("/api/admin-tokens");
  const invalidate = useInvalidate();
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<Token | null>(null);
  const origin = location.origin;

  return (
    <>
      <PageHeader title="管理令牌" intro="给导出接口和 MCP 用的只读令牌，不能用来写入数据。" />
      <div className="space-y-4">
        <Card title="生成令牌">
          <form className="flex flex-wrap gap-2" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await api<{ token: string }>("/api/admin-tokens", "POST", { label });
              setCreated(r.token);
              setLabel("");
              await invalidate("/api/admin-tokens");
            } catch (error) { toast.error(`失败：${reason(error)}`); } finally { setBusy(false); }
          }}>
            <Input required placeholder="备注，如 claude-mcp" aria-label="备注" value={label} onChange={(e) => setLabel(e.target.value)} />
            <Button type="submit" variant="primary" busy={busy}>生成令牌</Button>
          </form>
          {created ? (
            <div className="mt-4 space-y-3">
              <SecretBox label="管理令牌" value={created} />
              <CodeBlock label="让 Claude 通过 MCP 读这里的数据" code={`claude mcp add --transport http moli-insight ${origin}/mcp --header "Authorization: Bearer ${created}"`} />
              <CodeBlock label="导出数据" code={`curl -H "authorization: Bearer ${created}" "${origin}/v1/export?app=<应用>&limit=1000"`} />
            </div>
          ) : null}
        </Card>
        <Loaded q={q}>
          {({ tokens }) => (
            <Card title="已有令牌">
              {tokens.length === 0 ? <Muted>还没有令牌。</Muted> : (
                <ul className="divide-y divide-border">
                  {tokens.map((t) => (
                    <li key={t.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 ${t.revokedAt ? "opacity-50" : ""}`}>
                      <span><Code>{t.prefix}…</Code> <span className={t.revokedAt ? "line-through" : ""}>{t.label}</span></span>
                      <span className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">最近使用 {fmt(t.lastUsedAt)}</span>
                        {t.revokedAt ? <span className="text-xs text-muted-foreground">已作废</span> : <Button size="sm" variant="danger" onClick={() => setRevoking(t)}>作废</Button>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </Loaded>
      </div>
      <ConfirmDialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)} title="作废这个令牌？"
        description={<>使用 <code>{revoking?.prefix}…</code>（{revoking?.label}）的导出和 MCP 会立即收到 401。</>} confirmLabel="作废"
        onConfirm={async () => {
          try { await api(`/api/admin-tokens/${revoking!.id}/revoke`, "POST"); await invalidate("/api/admin-tokens"); toast.success("已作废"); }
          catch (e) { toast.error(`失败：${reason(e)}`); }
        }} />
    </>
  );
}

interface Person { id: number; name: string; deviceCount: number }

export function PeoplePage() {
  const q = useApi<{ people: Person[] }>("/api/people");
  const invalidate = useInvalidate();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Person | null>(null);
  const refresh = async () => { await invalidate("/api/people"); await invalidate("/api/apps"); client.invalidateQueries({ queryKey: ["api"] }); };

  return (
    <>
      <PageHeader title="人员" intro="把同一个人在不同应用、不同设备上的使用串起来。在「当前应用」的设备列表里把设备归属给人。" />
      <div className="space-y-4">
        <Card title="添加">
          <form className="flex flex-wrap gap-2" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try { await api("/api/people", "POST", { name }); setName(""); await refresh(); toast.success("已添加"); }
            catch (error) { toast.error(reason(error) === "name_taken" ? "这个名字已经有了" : `失败：${reason(error)}`); } finally { setBusy(false); }
          }}>
            <Input required maxLength={40} placeholder="名字" aria-label="名字" value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" variant="primary" busy={busy}>添加</Button>
          </form>
        </Card>
        <Loaded q={q}>
          {({ people }) => (
            <Card title="全部人员">
              {people.length === 0 ? <Muted>还没有人员。</Muted> : (
                <ul className="divide-y divide-border">
                  {people.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                      <span>{p.name}</span>
                      <span className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">{p.deviceCount} 台设备</span>
                        <Button size="sm" variant="danger" onClick={() => setRemoving(p)}>删除</Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </Loaded>
      </div>
      <ConfirmDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)} title={`删除 ${removing?.name ?? ""}？`}
        description="设备会保留，只是不再归属。" confirmLabel="删除"
        onConfirm={async () => {
          try { await api(`/api/people/${removing!.id}`, "DELETE"); await refresh(); toast.success("已删除"); }
          catch (e) { toast.error(`失败：${reason(e)}`); }
        }} />
    </>
  );
}
