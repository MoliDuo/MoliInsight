import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { num } from "@/lib/format";

/** Series colours; the last one is for "其他". They read on both light and dark. */
export const PALETTE = ["#0d9488", "#3b82f6", "#f59e0b", "#a855f7", "#ef4444", "#06b6d4", "#84cc16", "#ec4899", "#78716c"];
export const colour = (k: number) => PALETTE[Math.min(k, PALETTE.length - 1)]!;

export interface Series {
  key: string;
  values: number[];
  total?: number;
}

/** Stacked bars, one column per day. `series` is aligned with `days`. */
export function BarsByDay({ days, series, height = 200 }: { days: string[]; series: Series[]; height?: number }) {
  const data = days.map((day, i) => {
    const row: Record<string, string | number> = { day: day.slice(5) };
    for (const s of series) row[s.key] = s.values[i] ?? 0;
    return row;
  });
  return (
    <div style={{ height }} role="img" aria-label="按天统计的柱状图">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -12 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" minTickGap={16} />
          <YAxis tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" allowDecimals={false} width={44} tickFormatter={(v) => num(v)} />
          <Tooltip
            cursor={{ fill: "var(--muted)" }}
            contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
            formatter={(v) => num(Number(v))}
          />
          {series.map((s, k) => <Bar key={s.key} dataKey={s.key} stackId="a" fill={colour(k)} radius={k === series.length - 1 ? [2, 2, 0, 0] : 0} isAnimationActive={false} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Legend({ series }: { series: Series[] }) {
  if (series.length <= 1) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {series.map((s, k) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <i className="inline-block size-2.5 rounded-sm" style={{ background: colour(k) }} />
          {s.key} · {num(s.total ?? s.values.reduce((a, b) => a + b, 0))}
        </span>
      ))}
    </div>
  );
}

/** Horizontal bars: `[{ label, value, note? }]`. */
export function HBars({ items }: { items: { label: string; value: number; note?: string }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="space-y-1.5">
      {items.map((i, k) => (
        <div key={k} className="grid grid-cols-[minmax(70px,30%)_1fr_auto] items-center gap-2 text-xs">
          <span className="truncate" title={i.label}>{i.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-primary" style={{ width: `${(i.value / max) * 100}%` }} />
          </span>
          <span className="text-muted-foreground">{num(i.value)}{i.note ? ` ${i.note}` : ""}</span>
        </div>
      ))}
    </div>
  );
}
