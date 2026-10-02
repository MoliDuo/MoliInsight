import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { FilterBar } from "@/components/filter-bar";
import { Button, Card, Code, DataTable, ErrorBlock, Muted, Note, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { toQuery } from "@/lib/filters";
import { duration, fmt, ms, num, shortDevice } from "@/lib/format";
import { Loaded, useApi, useAppSlug, useFilters } from "@/lib/hooks";

interface SessionRow {
  sessionId: string; startedAt: number; durationMs: number; events: number;
  deviceId?: string | null; person?: string | null; platform?: string | null; release: string;
}

export function SessionsPage() {
  const app = useAppSlug();
  const filters = useFilters();
  const q = useInfiniteQuery({
    queryKey: ["api", `/api/apps/${app}/sessions`, toQuery(filters)],
    queryFn: ({ pageParam }) => api<{ sessions: SessionRow[]; next: string | null }>(`/api/apps/${app}/sessions?${toQuery(filters, { before: pageParam, limit: 30 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const sessions = q.data?.pages.flatMap((p) => p.sessions) ?? [];
  return (
    <>
      <PageHeader title="会话" intro="一次使用从打开到离开。点开一行看里面发生了什么。" />
      <FilterBar />
      <Card>
        {q.isError ? <ErrorBlock error={q.error} /> : (
          <>
            <DataTable head={["开始", "时长", "事件", "设备", "平台 版本"]} empty={q.isPending ? "加载中…" : "这个范围内没有会话。"}
              rows={sessions.map((s) => [
                <Link key="s" to="/$app/sessions/$id" params={{ app, id: s.sessionId }} className="text-primary underline-offset-2 hover:underline">{fmt(s.startedAt)}</Link>,
                duration(s.durationMs), num(s.events),
                <span key="d"><Code>{shortDevice(s.deviceId)}</Code>{s.person ? ` ${s.person}` : ""}</span>,
                `${s.platform ?? ""} ${s.release}`,
              ])} />
            {q.hasNextPage ? <div className="mt-3 text-center"><Button busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>更多</Button></div> : null}
          </>
        )}
      </Card>
    </>
  );
}

interface Timeline {
  sessionId: string; startedAt: number; release: string; truncated?: boolean;
  device?: { platform?: string; os?: string; person?: string } | null;
  events: { offsetMs: number; sincePreviousMs?: number; name: string; route?: string | null; props?: unknown }[];
}

export function SessionTimelinePage() {
  const app = useAppSlug();
  const { id = "" } = useParams({ strict: false }) as { id?: string };
  const q = useApi<Timeline>(`/api/apps/${app}/sessions/${encodeURIComponent(id)}`);
  return (
    <>
      <p className="mb-2 text-sm"><Link to="/$app/sessions" params={{ app }} className="text-primary hover:underline">← 会话</Link></p>
      <PageHeader title="会话时间线" />
      <Loaded q={q}>
        {(t) => (
          <>
            <Muted className="mb-3">
              <Code>{t.sessionId}</Code> · {fmt(t.startedAt)} · {t.release} · {t.device?.platform ?? ""}{t.device?.os ? ` ${t.device.os}` : ""}
              {t.device?.person ? ` · ${t.device.person}` : ""} · {num(t.events.length)} 个事件
            </Muted>
            {t.truncated ? <Note>事件太多，只显示了前 1000 个。</Note> : null}
            <Card>
              <DataTable head={["+时间", "间隔", "事件", "页面", "属性"]} empty="没有事件。"
                rows={t.events.map((e) => [
                  ms(e.offsetMs), e.sincePreviousMs ? `+${ms(e.sincePreviousMs)}` : "", <Code key="n">{e.name}</Code>, e.route ?? "",
                  <pre key="p" className="whitespace-pre-wrap break-all text-xs">{e.props ? JSON.stringify(e.props) : ""}</pre>,
                ])} />
            </Card>
          </>
        )}
      </Loaded>
    </>
  );
}
