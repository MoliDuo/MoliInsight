// The data pages: overview and event browser. They read the dashboard API; nothing here writes.
import { barChart, hbars, legend } from "./charts.js";
import { api, errorBox, fmt, h, num } from "./lib.js";

const RANGES = [["7", "7 天"], ["30", "30 天"], ["90", "90 天"], ["180", "180 天"], ["custom", "自定义"]];

function load() {
  try {
    return { days: "30", ...JSON.parse(localStorage.getItem("mi_view") ?? "{}") };
  } catch {
    return { days: "30" };
  }
}
const view = load();
const save = () => {
  try {
    localStorage.setItem("mi_view", JSON.stringify(view));
  } catch {}
};

/** The query string for the current app-wide controls. */
function query(extra = {}) {
  const q = new URLSearchParams();
  if (view.days === "custom" && view.from && view.to) {
    q.set("from", view.from);
    q.set("to", view.to);
  } else {
    q.set("days", view.days === "custom" ? "30" : view.days);
  }
  for (const key of ["platform", "release", "person"]) if (view[key]) q.set(key, view[key]);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") q.set(k, v);
  return q.toString();
}

function select(value, options, onchange) {
  const el = h("select", { onchange: () => onchange(el.value) },
    options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
  return el;
}

/** App, range and filters. `rerender` runs after any change. */
async function controls(slug, rerender, { filters = true } = {}) {
  const [{ apps }, options, { people }] = await Promise.all([
    api("/api/apps"), api(`/api/apps/${slug}/filters`), api("/api/people"),
  ]);
  const set = (key) => (value) => {
    view[key] = value;
    save();
    rerender();
  };
  const bar = h("div", { class: "controls" },
    select(slug, apps.map((a) => [a.slug, a.name]), (v) => {
      view.app = v;
      view.platform = view.release = "";
      save();
      // An event name of one app means nothing in another.
      if (location.hash.startsWith("#/events/")) location.hash = "#/events";
      else rerender();
    }),
    select(view.days, RANGES, set("days")),
    view.days === "custom" ? [
      h("input", { type: "date", value: view.from ?? "", onchange: (e) => set("from")(e.target.value) }),
      "–",
      h("input", { type: "date", value: view.to ?? "", onchange: (e) => set("to")(e.target.value) }),
    ] : null,
    filters ? [
      select(view.platform ?? "", [["", "全部平台"], ...options.platforms.map((p) => [p, p])], set("platform")),
      select(view.release ?? "", [["", "全部版本"], ...options.releases.map((r) => [r, r])], set("release")),
      select(view.person ?? "", [["", "所有人"], ["none", "未归属"], ...people.map((p) => [String(p.id), p.name])], set("person")),
    ] : null,
  );
  return { bar, apps };
}

/** Picks the app to show: the remembered one if it still exists, else the first. */
async function currentApp(requested) {
  const { apps } = await api("/api/apps");
  const slug = [requested, view.app].find((s) => s && apps.some((a) => a.slug === s)) ?? apps[0]?.slug;
  if (slug) {
    view.app = slug;
    save();
  }
  return slug;
}

const emptyState = () => h("p", { class: "muted" }, "还没有应用。先到「应用」页新建一个并生成密钥。");

function stat(value, label) {
  return h("div", { class: "stat" }, h("b", {}, value), h("span", {}, label));
}

const duration = (ms) => (ms < 1000 ? "—" : ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${(ms / 60_000).toFixed(1)} 分钟`);

// ---------------------------------------------------------------------------

export async function overviewPage(rerender) {
  const slug = await currentApp();
  if (!slug) return h("section", {}, h("h2", {}, "概览"), emptyState());
  const [{ bar }, o] = await Promise.all([
    controls(slug, rerender),
    api(`/api/apps/${slug}/overview?${query()}`),
  ]);
  const t = o.totals;
  return h("section", {},
    h("h2", {}, "概览"),
    bar,
    h("p", { class: "muted" }, `${o.range.from} 至 ${o.range.to}，按会话开始时间统计。`),
    h("div", { class: "stats" },
      stat(num(t.sessions), "会话"), stat(num(t.devices), "活跃设备"), stat(num(t.activeDays), "有使用的天数"),
      stat(num(t.events), "事件"), stat(duration(t.avgSessionMs), "平均会话时长"),
    ),
    t.sessions === 0 ? h("p", { class: "muted" }, "这个范围内没有会话。") : null,
    h("div", { class: "card" }, h("b", {}, "每天的会话"),
      barChart(o.daily.map((d) => d.day), [{ key: "会话", values: o.daily.map((d) => d.sessions) }])),
    h("div", { class: "grid2" },
      h("div", { class: "card" }, h("b", {}, "会话时长"),
        hbars(o.durations.map((d) => ({ label: d.bucket, value: d.sessions })))),
      h("div", { class: "card" }, h("b", {}, "平台"),
        hbars(o.platforms.map((p) => ({ label: p.platform, value: p.sessions, note: `· ${p.devices} 台` })))),
    ),
    h("div", { class: "grid2" },
      h("div", { class: "card" }, h("b", {}, "按人"),
        h("table", {}, h("tbody", {}, o.people.map((p) => h("tr", {},
          h("td", {}, p.person ?? "未归属"), h("td", {}, `${num(p.sessions)} 会话`),
          h("td", {}, `${p.devices} 台`), h("td", {}, `${num(p.events)} 事件`)))))),
      h("div", { class: "card" }, h("b", {}, "版本"),
        h("table", {}, h("tbody", {}, o.releases.map((r) => h("tr", {},
          h("td", {}, h("code", {}, r.release)), h("td", {}, `${num(r.sessions)} 会话`), h("td", {}, `${r.devices} 台`)))))),
    ),
  );
}

// ---------------------------------------------------------------------------

const eventState = { by: "", prop: "", value: "", search: "" };
let eventsFor = "";

export async function eventsPage(rerender, name) {
  const slug = await currentApp();
  if (!slug) return h("section", {}, h("h2", {}, "事件"), emptyState());
  if (eventsFor !== `${slug}/${name}`) {
    Object.assign(eventState, { by: "", prop: "", value: "" });
    eventsFor = `${slug}/${name}`;
  }
  const [{ bar }, { names }] = await Promise.all([
    controls(slug, rerender),
    api(`/api/apps/${slug}/events/names?${query()}`),
  ]);

  const list = h("div", { class: "names card" });
  const search = h("input", { placeholder: "搜索事件名", value: eventState.search, oninput: () => {
    eventState.search = search.value;
    fill();
  } });
  const fill = () => {
    const q = eventState.search.toLowerCase();
    list.replaceChildren(...names.filter((n) => n.name.toLowerCase().includes(q)).map((n) =>
      h("a", { href: `#/events/${encodeURIComponent(n.name)}`, class: n.name === name ? "current" : "" },
        h("code", {}, n.name), h("span", {}, num(n.events)))));
    if (!list.children.length) list.append(h("p", { class: "muted" }, "没有事件。"));
  };
  fill();

  const detail = h("div", {});
  if (name) {
    detail.append(await eventDetail(slug, name, rerender));
  } else {
    detail.append(h("p", { class: "muted" }, names.length ? "从左边选一个事件，看它的趋势和原始记录。" : "这个范围内没有事件。"));
  }
  return h("section", {},
    h("h2", {}, "事件"),
    bar,
    h("div", { class: "split" }, h("div", {}, search, list), detail),
  );
}

async function eventDetail(slug, name, rerender) {
  const error = errorBox();
  const extra = { name, by: eventState.by, prop: eventState.prop, value: eventState.value };
  let trend;
  try {
    trend = await api(`/api/apps/${slug}/events/trend?${query(extra)}`);
  } catch (e) {
    return h("p", { class: "error" }, `加载失败：${e.code ?? e.message}`);
  }
  const apply = (event) => {
    event.preventDefault();
    eventState.by = by.value.trim();
    eventState.prop = prop.value.trim();
    eventState.value = value.value;
    rerender();
  };
  const by = h("input", { placeholder: "按属性分组，如 kind", value: eventState.by, size: 16 });
  const prop = h("input", { placeholder: "只看属性", value: eventState.prop, size: 12 });
  const value = h("input", { placeholder: "等于", value: eventState.value, size: 12 });
  const total = trend.series.reduce((sum, s) => sum + s.total, 0);

  const rows = h("tbody", {});
  const more = h("button", { type: "button" }, "更多");
  let next = null;
  const loadRaw = async (before) => {
    const raw = await api(`/api/apps/${slug}/events/raw?${query({ name, prop: eventState.prop, value: eventState.value, before, limit: 30 })}`);
    for (const e of raw.events) {
      rows.append(h("tr", {},
        h("td", {}, fmt(e.at)),
        h("td", {}, e.deviceId ? h("code", {}, e.deviceId.slice(0, 12)) : "服务端", e.person ? ` ${e.person}` : ""),
        h("td", {}, `${e.platform} ${e.release}`),
        h("td", {}, h("pre", { class: "props" }, e.props ? JSON.stringify(e.props) : "")),
      ));
    }
    next = raw.next;
    more.hidden = !next;
    if (!rows.children.length) rows.append(h("tr", {}, h("td", { colspan: 4, class: "muted" }, "没有记录。")));
  };
  more.addEventListener("click", () => loadRaw(next).catch(() => {}));
  more.hidden = true;
  loadRaw().catch((e) => { error.textContent = `加载失败：${e.code ?? e.message}`; });

  return h("div", {},
    h("div", { class: "card" },
      h("div", { class: "row between" }, h("b", {}, h("code", {}, name)), h("span", { class: "muted" }, `${num(total)} 次`)),
      h("form", { class: "controls", onsubmit: apply }, by, prop, value, h("button", { type: "submit" }, "应用")),
      barChart(trend.days, trend.series),
      legend(trend.series),
      trend.truncated ? h("p", { class: "note" }, "这个事件太多，只统计了最新的 20000 条。缩小时间范围可以看全。") : null,
    ),
    h("div", { class: "card" },
      h("b", {}, "原始记录"),
      h("table", {}, h("thead", {}, h("tr", {}, ["时间", "设备", "平台 版本", "属性"].map((t) => h("th", {}, t)))), rows),
      more, error,
    ),
  );
}
