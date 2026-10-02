import { useEffect, useState } from "react";
import { RANGES, type Filters } from "@/lib/filters";
import { useApi, useAppSlug, useFilters, useSetSearch } from "@/lib/hooks";
import { Input, Select } from "./ui";

interface Option { platforms: string[]; releases: string[] }
interface Person { id: number; name: string }

/** Keeps the current choice in the list even when it has no data in this app. */
const withCurrent = (values: string[], current?: string) => (current && !values.includes(current) ? [current, ...values] : values);

/** Range and filters. They are in the URL, so every view can be shared. */
export function FilterBar({ filters = true, range = true, omit = [] }: { filters?: boolean; range?: boolean; omit?: ("platform" | "release" | "person")[] }) {
  const app = useAppSlug();
  const f: Filters = useFilters();
  const set = useSetSearch();
  const options = useApi<Option>(filters ? `/api/apps/${app}/filters` : null);
  const people = useApi<{ people: Person[] }>(filters ? "/api/people" : null);
  const [from, setFrom] = useState(f.from ?? "");
  const [to, setTo] = useState(f.to ?? "");
  useEffect(() => { setFrom(f.from ?? ""); setTo(f.to ?? ""); }, [f.from, f.to]);

  const days = f.days ?? "30";
  const dates = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    // Both dates are needed before the range means anything.
    if (nextFrom && nextTo && nextFrom <= nextTo) set({ from: nextFrom, to: nextTo });
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {range ? (
        <>
          <Select aria-label="时间范围" value={days} onChange={(e) => set({ days: e.target.value, ...(e.target.value === "custom" ? {} : { from: undefined, to: undefined }) })}>
            {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
          {days === "custom" ? (
            <>
              <Input type="date" aria-label="开始日期" value={from} onChange={(e) => dates(e.target.value, to)} />
              <span className="text-muted-foreground">–</span>
              <Input type="date" aria-label="结束日期" value={to} onChange={(e) => dates(from, e.target.value)} />
            </>
          ) : null}
        </>
      ) : null}
      {filters ? (
        <>
          {omit.includes("platform") ? null : <Select aria-label="平台" value={f.platform ?? ""} onChange={(e) => set({ platform: e.target.value || undefined })}>
            <option value="">全部平台</option>
            {withCurrent(options.data?.platforms ?? [], f.platform).map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>}
          {omit.includes("release") ? null : <Select aria-label="版本" value={f.release ?? ""} onChange={(e) => set({ release: e.target.value || undefined })}>
            <option value="">全部版本</option>
            {withCurrent(options.data?.releases ?? [], f.release).map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>}
          {omit.includes("person") ? null : <Select aria-label="人员" value={f.person ?? ""} onChange={(e) => set({ person: e.target.value || undefined })}>
            <option value="">所有人</option>
            <option value="none">未归属</option>
            {(people.data?.people ?? []).map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
          </Select>}
        </>
      ) : null}
    </div>
  );
}
