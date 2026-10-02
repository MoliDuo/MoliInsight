// Small charts, drawn as SVG and plain elements. No library.
import { h, num } from "./lib.js";

const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const child of children) el.append(child);
  return el;
};

/** Series colours; the last one is for "其他". */
export const PALETTE = ["#0f766e", "#2563eb", "#d97706", "#9333ea", "#dc2626", "#0891b2", "#65a30d", "#db2777", "#78716c"];

/**
 * Stacked bars, one column per day.
 * `series` is `[{ key, values: number[] }]`, aligned with `days`.
 */
export function barChart(days, series, { height = 160 } = {}) {
  const width = 720;
  const pad = { top: 8, right: 4, bottom: 20, left: 4 };
  const totals = days.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const slot = (width - pad.left - pad.right) / Math.max(1, days.length);
  const barWidth = Math.max(1, slot * 0.78);
  const plot = height - pad.top - pad.bottom;

  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", class: "chart", preserveAspectRatio: "none" });
  const every = Math.ceil(days.length / 8);
  days.forEach((day, i) => {
    let y = height - pad.bottom;
    const x = pad.left + i * slot + (slot - barWidth) / 2;
    const column = svg("g", {});
    const title = svg("title", {});
    title.textContent = `${day}  ${num(totals[i])}` + series.filter((s) => s.values[i]).map((s) => `\n${s.key}: ${num(s.values[i])}`).join("");
    column.append(title);
    series.forEach((s, k) => {
      const value = s.values[i] ?? 0;
      if (!value) return;
      const barHeight = Math.max(1, (value / max) * plot);
      y -= barHeight;
      column.append(svg("rect", { x, y, width: barWidth, height: barHeight, fill: PALETTE[Math.min(k, PALETTE.length - 1)] }));
    });
    // A transparent column makes empty days hoverable too.
    column.append(svg("rect", { x: pad.left + i * slot, y: pad.top, width: slot, height: plot, fill: "transparent" }));
    chart.append(column);
    if (i % every === 0) {
      const label = svg("text", { x: x + barWidth / 2, y: height - 5, "text-anchor": "middle", class: "axis" });
      label.textContent = day.slice(5);
      chart.append(label);
    }
  });
  const peak = svg("text", { x: width - pad.right, y: pad.top + 8, "text-anchor": "end", class: "axis" });
  peak.textContent = num(max);
  chart.append(peak);
  return chart;
}

export function legend(series) {
  if (series.length <= 1) return null;
  return h("div", { class: "legend" }, series.map((s, k) =>
    h("span", {}, h("i", { style: `background:${PALETTE[Math.min(k, PALETTE.length - 1)]}` }), `${s.key} · ${num(s.total ?? s.values.reduce((a, b) => a + b, 0))}`),
  ));
}

/** Horizontal bars: `[{ label, value, note? }]`. */
export function hbars(items) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return h("div", { class: "hbars" }, items.map((i) =>
    h("div", { class: "hbar" },
      h("span", { class: "hbar-label" }, i.label),
      h("span", { class: "hbar-track" }, h("span", { class: "hbar-fill", style: `width:${(i.value / max) * 100}%` })),
      h("span", { class: "hbar-value" }, num(i.value), i.note ? ` ${i.note}` : ""),
    ),
  ));
}
