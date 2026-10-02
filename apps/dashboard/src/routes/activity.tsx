import { useInfiniteQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Button, Card, DataTable, ErrorBlock, PageHeader, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { fmt } from "@/lib/format";

interface Entry { id: number; at: number; user: string; action: string; target: string; detail: Record<string, unknown> }
interface Page { entries: Entry[]; next: string | null; users: string[] }

const ACTIONS: Record<string, string> = {
  "auth.login": "登录",
  "auth.refused": "被拒绝登录",
  "auth.logout": "退出",
  "app.create": "新建应用",
  "app.update": "修改应用",
  "app.delete": "删除应用",
  "key.create": "生成接入密钥",
  "key.revoke": "作废接入密钥",
  "token.create": "生成管理令牌",
  "token.revoke": "作废管理令牌",
  "person.create": "新建人员",
  "person.delete": "删除人员",
  "device.assign": "设置设备归属",
  "device.delete": "删除设备",
  "catalog.replace": "替换事件目录",
  "import": "导入日志",
  "funnel.save": "保存漏斗",
  "funnel.delete": "删除漏斗",
};

const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** The numbers and names an action carries, as a short sentence. Unknown actions show their raw detail. */
function describe(e: Entry): ReactNode {
  const d = e.detail;
  switch (e.action) {
    case "app.create": return `名称 ${String(d.name)}，事件保留 ${num(d.retentionDays)} 天`;
    case "app.update": return [d.name !== undefined && `名称改为 ${String(d.name)}`, d.retentionDays !== undefined && `事件保留改为 ${num(d.retentionDays)} 天`].filter(Boolean).join("，");
    case "key.create": case "token.create": return `${String(d.label) || "（无备注）"}`;
    case "key.revoke": case "token.revoke": return `${String(d.label) || "（无备注）"}`;
    case "device.assign": return d.person ? `归到 ${String(d.person)}` : "取消归属";
    case "catalog.replace": return `${num(d.events)} 个事件，${num(d.metrics)} 个指标，${num(d.funnels)} 个漏斗`;
    case "import": return `${num(d.batches)} 批：新增 ${num(d.accepted)}，已存在 ${num(d.duplicates)}，被拒 ${num(d.rejected)}`;
    default: return Object.keys(d).length ? JSON.stringify(d) : "";
  }
}

export function ActivityPage() {
  const [user, setUser] = useState("");
  const q = useInfiniteQuery({
    queryKey: ["api", "/api/audit", user],
    queryFn: ({ pageParam }) => api<Page>(`/api/audit?${new URLSearchParams({ ...(pageParam ? { before: pageParam } : {}), ...(user ? { user } : {}) })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const users = q.data?.pages[0]?.users ?? [];

  return (
    <>
      <PageHeader title="操作记录" intro="谁在什么时候改了什么，只记改动和登录，不记查看。保留一年。" />
      <Card title="记录" action={users.length > 1 || user ? (
        <Select aria-label="按用户筛选" value={user} onChange={(e) => setUser(e.target.value)}>
          <option value="">所有人</option>
          {users.map((u) => <option key={u} value={u}>{u}</option>)}
        </Select>
      ) : undefined}>
        {q.isError ? <ErrorBlock error={q.error} /> : (
          <>
            <DataTable head={["时间", "用户", "操作", "对象", "详情"]} empty={q.isPending ? "加载中…" : "还没有记录。"}
              rows={entries.map((e) => [
                <span key="t" className="whitespace-nowrap">{fmt(e.at)}</span>,
                <span key="u" className="whitespace-nowrap">{e.user}</span>,
                <span key="a" className={e.action === "auth.refused" ? "whitespace-nowrap text-danger" : "whitespace-nowrap"}>{ACTIONS[e.action] ?? e.action}</span>,
                e.target ? <code key="g" className="whitespace-nowrap">{e.target}</code> : "",
                <span key="d" className="text-muted-foreground">{describe(e)}</span>,
              ])} />
            {q.hasNextPage ? <div className="mt-3 text-center"><Button busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>更多</Button></div> : null}
          </>
        )}
      </Card>
    </>
  );
}
