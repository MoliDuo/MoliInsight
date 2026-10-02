import { Link, Outlet, useParams, useSearch } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { useState } from "react";
import { BarsByDay, Legend } from "@/charts/charts";
import { FilterBar } from "@/components/filter-bar";
import { Button, Card, DataTable, ErrorBlock, Empty, Input, Muted, Note, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { toQuery } from "@/lib/filters";
import { validateEventSearch } from "@/lib/search";
import { fmt, num, shortDevice } from "@/lib/format";
import { Loaded, useApi, useAppSlug, useFilters, useSetSearch } from "@/lib/hooks";

/** The list of event names on the left, the chosen event on the right. */
export function EventsPage() {
  const app = useAppSlug();
  const filters = useFilters();
  const { name } = useParams({ strict: false }) as { name?: string };
  const names = useApi<{ names: { name: string; events: number }[] }>(`/api/apps/${app}/events/names?${toQuery(filters)}`);
  const [search, setSearch] = useState("");
  const keep = useSearch({ strict: false }) as Record<string, unknown>;

  return (
    <>
      <PageHeader title="事件" intro="每个事件的趋势和原始记录。" />
      <FilterBar />
      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        <div className="min-w-0">
          <Input className="mb-2 w-full" placeholder="搜索事件名" aria-label="搜索事件名" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Loaded q={names} skeleton={<Muted>加载中…</Muted>}>
            {({ names: all }) => {
              const shown = all.filter((n) => n.name.toLowerCase().includes(search.toLowerCase()));
              return (
                <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-card p-1">
                  {shown.length === 0 ? <Empty>没有事件。</Empty> : shown.map((n) => (
                    <Link key={n.name} to="/$app/events/$name" params={{ app, name: n.name }}
                      search={{ days: keep.days, from: keep.from, to: keep.to, platform: keep.platform, release: keep.release, person: keep.person } as never}
                      className={clsx("flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted", n.name === name && "bg-muted font-medium")}>
                      <code className="truncate">{n.name}</code>
                      <span className="text-xs text-muted-foreground">{num(n.events)}</span>
                    </Link>
                  ))}
                </div>
              );
            }}
          </Loaded>
        </div>
        <div className="min-w-0"><Outlet /></div>
      </div>
    </>
  );
}

export function EventsIndex() {
  return <Muted className="py-6">从左边选一个事件，看它的趋势和原始记录。</Muted>;
}

interface Trend { days: string[]; series: { key: string; values: number[]; total: number }[]; truncated?: boolean }
interface RawEvent {
  at: number; sessionId?: string | null; deviceId?: string | null; person?: string | null;
  platform: string; release: string; props?: unknown;
}

export function EventDetail() {
  const app = useAppSlug();
  const { name = "" } = useParams({ strict: false }) as { name?: string };
  const filters = useFilters();
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const { by, prop, value } = validateEventSearch(raw);
  const set = useSetSearch();
  const extra = { name, by, prop, value };
  const trend = useApi<Trend>(`/api/apps/${app}/events/trend?${toQuery(filters, extra)}`);
  const catalog = useApi<{ catalog: { events: { name: string; description: string }[] } | null }>(`/api/apps/${app}/catalog`);
  const [draft, setDraft] = useState({ by: by ?? "", prop: prop ?? "", value: value ?? "" });

  return (
    <div className="space-y-4">
      <Loaded q={trend}>
        {(t) => {
          const total = t.series.reduce((sum, s) => sum + s.total, 0);
          const entry = catalog.data?.catalog?.events.find((e) => e.name === name);
          return (
            <Card title={<><code>{name}</code> <span className="ml-2 font-normal text-muted-foreground">{num(total)} 次</span></>}>
              {entry ? <Muted className="mb-3">{entry.description}</Muted>
                : catalog.data?.catalog && !name.startsWith("$") ? <Note>这个事件没有登记在事件目录里。</Note> : null}
              <form className="mb-3 flex flex-wrap gap-2" onSubmit={(e) => {
                e.preventDefault();
                set({ by: draft.by.trim() || undefined, prop: draft.prop.trim() || undefined, value: draft.value || undefined });
              }}>
                <Input placeholder="按属性分组，如 kind" aria-label="按属性分组" value={draft.by} onChange={(e) => setDraft({ ...draft, by: e.target.value })} />
                <Input placeholder="只看属性" aria-label="只看属性" value={draft.prop} onChange={(e) => setDraft({ ...draft, prop: e.target.value })} />
                <Input placeholder="等于" aria-label="属性值" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
                <Button type="submit">应用</Button>
              </form>
              <BarsByDay days={t.days} series={t.series} />
              <Legend series={t.series} />
              {t.truncated ? <Note>这个事件太多，只统计了最新的 20000 条。缩小时间范围可以看全。</Note> : null}
            </Card>
          );
        }}
      </Loaded>
      <RawEvents app={app} name={name} prop={prop} value={value} />
    </div>
  );
}

function RawEvents({ app, name, prop, value }: { app: string; name: string; prop?: string | undefined; value?: string | undefined }) {
  const filters = useFilters();
  const q = useInfiniteQuery({
    queryKey: ["api", `/api/apps/${app}/events/raw`, name, toQuery(filters, { prop, value })],
    queryFn: ({ pageParam }) =>
      api<{ events: RawEvent[]; next: string | null }>(`/api/apps/${app}/events/raw?${toQuery(filters, { name, prop, value, before: pageParam, limit: 30 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const events = q.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <Card title="原始记录">
      {q.isError ? <ErrorBlock error={q.error} /> : (
        <>
          <DataTable head={["时间", "设备", "平台 版本", "属性"]} empty={q.isPending ? "加载中…" : "没有记录。"}
            rows={events.map((e) => [
              e.sessionId ? <Link key="t" to="/$app/sessions/$id" params={{ app, id: e.sessionId }} className="text-primary underline-offset-2 hover:underline" title="看这个会话的时间线">{fmt(e.at)}</Link> : fmt(e.at),
              <span key="d"><code>{shortDevice(e.deviceId)}</code>{e.person ? ` ${e.person}` : ""}</span>,
              `${e.platform} ${e.release}`,
              <pre key="p" className="whitespace-pre-wrap break-all text-xs">{e.props ? JSON.stringify(e.props) : ""}</pre>,
            ])} />
          {q.hasNextPage ? <div className="mt-3 text-center"><Button busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>更多</Button></div> : null}
        </>
      )}
    </Card>
  );
}
