export const num = (n: number | null | undefined) => Number(n ?? 0).toLocaleString();
export const fmt = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : "—");
export const pct = (r: number | null | undefined) => (r == null ? "—" : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`);
export const ms = (v: number | null | undefined) => (v == null ? "—" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);
export const per = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));
export const duration = (v: number | null | undefined) =>
  v == null || v < 1000 ? "—" : v < 60_000 ? `${Math.round(v / 1000)} 秒` : `${(v / 60_000).toFixed(1)} 分钟`;
export const shortDevice = (id: string | null | undefined) => (id ? id.slice(0, 12) : "服务端");
/** Vitals have no unit for CLS and milliseconds for the rest. */
export const vital = (metric: string, v: number | null | undefined) =>
  v == null ? "—" : metric === "CLS" ? v.toFixed(3) : ms(v);
