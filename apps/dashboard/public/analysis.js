// The analysis pages: funnels and metrics, sessions, release comparison, friction,
// performance, navigation, feature usage. They read the dashboard API, and the only
// thing they write is saved funnels. Everything from the API goes in through textContent.
import { barChart, hbars } from "./charts.js";
import { controls, currentApp, duration, emptyState, query, stat } from "./data.js";
import { act, api, errorBox, fmt, h, num } from "./lib.js";

const pct = (r) => (r == null ? "—" : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`);
const ms = (v) => (v == null ? "—" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);
const per = (v) => (v == null ? "—" : v.toFixed(2));
const failure = (e) => h("p", { class: "error" }, `加载失败：${e.code ?? e.message}`);

function table(head, rows, empty = "这个范围内没有数据。") {
  if (!rows.length) return h("p", { class: "muted" }, empty);
  return h("table", {}, h("thead", {}, h("tr", {}, head.map((t) => h("th", {}, t)))),
    h("tbody", {}, rows.map((cells) => h("tr", {}, cells.map((c) => h("td", {}, c))))));
}

const code = (text) => h("code", {}, text ?? "—");

/** Wraps a page: picks the app, draws the controls, and loads the data. */
async function page(title, rerender, body, { filters = true, intro } = {}) {
  const slug = await currentApp();
  if (!slug) return h("section", {}, h("h2", {}, title), emptyState());
  const { bar } = await controls(slug, rerender, { filters });
  let content;
  try {
    content = await body(slug);
  } catch (e) {
    content = failure(e);
  }
  return h("section", {}, h("h2", {}, title), bar, intro ? h("p", { class: "muted" }, intro) : null, content);
}

// ---------------------------------------------------------------------------
// funnels and metrics

const builder = { steps: [{ event: "", where: "" }, { event: "", where: "" }], minutes: "30", by: "session" };

export function funnelsPage(rerender) {
  return page("漏斗与指标", rerender, async (slug) => {
    const { catalog, savedFunnels } = await api(`/api/apps/${slug}/catalog`);
    const metrics = catalog?.metrics ?? [];
    const funnels = [
      ...(catalog?.funnels ?? []).map((f) => ({ ...f, saved: false })),
      ...savedFunnels.map((f) => ({ ...f, saved: true })),
    ];
    const results = await Promise.all([
      ...metrics.map((m) => api(`/api/apps/${slug}/metrics/${encodeURIComponent(m.name)}?${query()}`).catch(() => null)),
    ]);

    const metricCards = metrics.map((m, i) => {
      const r = results[i];
      return h("div", { class: "card" },
        h("div", { class: "row between" }, h("b", {}, code(m.name)),
          h("span", { class: "stat-inline" }, r ? pct(r.ratio) : "—")),
        h("p", { class: "muted" }, m.description),
        r ? h("p", { class: "muted" }, `${num(r.numerator)} / ${num(r.denominator)}`,
          m.goodDirection ? `，${m.goodDirection === "up" ? "越高越好" : "越低越好"}` : "") : null,
        r && r.groups.length ? table(["分组", "分子", "分母", "比率"], r.groups.map((g) => [g.group, num(g.numerator), num(g.denominator), pct(g.ratio)])) : null,
        r ? barChart(r.daily.map((d) => d.day), [{ key: "分母", values: r.daily.map((d) => d.denominator) }], { height: 90 }) : null,
        r?.truncated ? h("p", { class: "note" }, "数据太多，只统计了最新的一部分。缩小时间范围可以看全。") : null,
      );
    });

    const funnelBox = h("div", {});
    const showFunnel = async (def) => {
      funnelBox.replaceChildren(h("p", { class: "muted" }, "计算中…"));
      try {
        const r = await api(`/api/apps/${slug}/funnel?${query()}`, "POST", def);
        funnelBox.replaceChildren(funnelResult(r));
      } catch (e) {
        funnelBox.replaceChildren(failure(e));
      }
    };

    const error = errorBox();
    const stepRows = h("div", {});
    const nameInput = h("input", { placeholder: "保存为…", size: 14 });
    const minutes = h("input", { type: "number", min: 1, max: 10080, value: builder.minutes, size: 5, onchange: () => (builder.minutes = minutes.value) });
    const by = h("select", { onchange: () => (builder.by = by.value) },
      [["session", "按会话"], ["device", "按设备"]].map(([v, l]) => h("option", { value: v, selected: v === builder.by }, l)));
    const datalist = h("datalist", { id: "mi-events" }, (catalog?.events ?? []).map((e) => h("option", { value: e.name })));
    const drawSteps = () => {
      stepRows.replaceChildren(...builder.steps.map((s, i) => h("div", { class: "controls" },
        `${i + 1}.`,
        h("input", { list: "mi-events", placeholder: "事件名", value: s.event, size: 22, oninput: (e) => (s.event = e.target.value) }),
        h("input", { placeholder: "条件，如 kind=income", value: s.where, size: 20, oninput: (e) => (s.where = e.target.value) }),
        builder.steps.length > 2 ? h("button", { type: "button", onclick: () => { builder.steps.splice(i, 1); drawSteps(); } }, "删除") : null,
      )));
    };
    drawSteps();
    const definition = () => {
      const steps = builder.steps.filter((s) => s.event.trim()).map((s) => {
        const step = { event: s.event.trim() };
        const where = s.where.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
          const [prop, ...rest] = t.split("=");
          return { prop: prop.trim(), op: "eq", value: rest.join("=").trim() };
        });
        return where.length ? { ...step, where } : step;
      });
      return { steps, windowMs: Math.max(1, Number(builder.minutes) || 30) * 60_000, by: builder.by };
    };
    const run = act(error, async () => showFunnel(definition()));
    const save = act(error, async () => {
      const name = nameInput.value.trim();
      await api(`/api/apps/${slug}/funnels/${encodeURIComponent(name)}`, "PUT", definition());
      rerender();
    });

    const list = funnels.length
      ? h("div", { class: "controls" }, funnels.map((f) => h("span", {},
        h("button", { type: "button", onclick: () => showFunnel({ steps: f.steps, windowMs: f.windowMs, by: f.by }) }, f.name),
        f.saved ? h("button", { type: "button", title: "删除", onclick: act(error, async () => {
          await api(`/api/apps/${slug}/funnels/${encodeURIComponent(f.name)}`, "DELETE");
          rerender();
        }) }, "×") : null)))
      : h("p", { class: "muted" }, "还没有漏斗。可以在下面搭一个，或者在事件目录里定义。");

    return h("div", {},
      h("h3", {}, "比率指标"),
      metrics.length ? h("div", { class: "grid2" }, metricCards)
        : h("p", { class: "muted" }, "这个应用的事件目录里没有指标。用 moli-insight catalog 上传。"),
      h("h3", {}, "漏斗"),
      list,
      h("div", { class: "card" },
        h("b", {}, "自己搭一个"), datalist, stepRows,
        h("div", { class: "controls" },
          h("button", { type: "button", onclick: () => { if (builder.steps.length < 6) { builder.steps.push({ event: "", where: "" }); drawSteps(); } } }, "加一步"),
          "窗口（分钟）", minutes, by,
          h("button", { type: "button", onclick: run }, "计算"),
          nameInput, h("button", { type: "button", onclick: save }, "保存")),
        error),
      funnelBox,
    );
  }, { intro: "指标和漏斗来自应用的事件目录。比率按所选范围和筛选计算。" });
}

function funnelResult(r) {
  const top = r.steps[0]?.entities ?? 0;
  return h("div", { class: "card" },
    h("p", { class: "muted" }, `${num(r.entities)} 个${r.by === "device" ? "设备" : "会话"}进入。`),
    hbars(r.steps.map((s, i) => ({
      label: `${i + 1}. ${s.event}`, value: s.entities,
      note: `· ${pct(top ? s.entities / top : null)}${i ? `（上一步 ${pct(s.fromPrevious)}，中位 ${ms(s.medianMsFromPrevious)}）` : ""}`,
    }))),
    r.truncated ? h("p", { class: "note" }, "数据太多，只统计了最新的一部分。") : null);
}

// ---------------------------------------------------------------------------
// sessions

export function sessionsPage(rerender, id) {
  if (id) return sessionTimeline(rerender, id);
  return page("会话", rerender, async (slug) => {
    const rows = h("tbody", {});
    const more = h("button", { type: "button" }, "更多");
    const error = errorBox();
    let next = null;
    const load = async (before) => {
      const r = await api(`/api/apps/${slug}/sessions?${query({ before, limit: 30 })}`);
      for (const s of r.sessions) {
        rows.append(h("tr", {},
          h("td", {}, h("a", { href: `#/sessions/${encodeURIComponent(s.sessionId)}` }, fmt(s.startedAt))),
          h("td", {}, duration(s.durationMs)), h("td", {}, num(s.events)),
          h("td", {}, s.deviceId ? code(s.deviceId.slice(0, 12)) : "服务端", s.person ? ` ${s.person}` : ""),
          h("td", {}, `${s.platform ?? ""} ${s.release}`)));
      }
      next = r.next;
      more.hidden = !next;
      if (!rows.children.length) rows.append(h("tr", {}, h("td", { colspan: 5, class: "muted" }, "这个范围内没有会话。")));
    };
    more.addEventListener("click", () => load(next).catch(() => {}));
    more.hidden = true;
    load().catch((e) => { error.textContent = `加载失败：${e.code ?? e.message}`; });
    return h("div", { class: "card" },
      h("table", {}, h("thead", {}, h("tr", {}, ["开始", "时长", "事件", "设备", "平台 版本"].map((t) => h("th", {}, t)))), rows),
      more, error);
  });
}

async function sessionTimeline(rerender, id) {
  const slug = await currentApp();
  if (!slug) return h("section", {}, h("h2", {}, "会话"), emptyState());
  let t;
  try {
    t = await api(`/api/apps/${slug}/sessions/${encodeURIComponent(id)}`);
  } catch (e) {
    return h("section", {}, h("p", {}, h("a", { href: "#/sessions" }, "← 会话")), failure(e));
  }
  const first = t.events[0];
  return h("section", {},
    h("p", {}, h("a", { href: "#/sessions" }, "← 会话")),
    h("h2", {}, "会话时间线"),
    h("p", { class: "muted" },
      code(t.sessionId), ` · ${fmt(t.startedAt)} · ${t.release} · `,
      t.device?.platform ?? "", t.device?.os ? ` ${t.device.os}` : "", t.device?.person ? ` · ${t.device.person}` : "",
      ` · ${num(t.events.length)} 个事件`),
    t.truncated ? h("p", { class: "note" }, "事件太多，只显示了前 1000 个。") : null,
    h("div", { class: "card" }, table(["+时间", "间隔", "事件", "页面", "属性"],
      t.events.map((e) => [
        ms(e.offsetMs), e.sincePreviousMs ? `+${ms(e.sincePreviousMs)}` : "", code(e.name), e.route ?? "",
        h("pre", { class: "props" }, e.props ? JSON.stringify(e.props) : ""),
      ]), first ? "" : "没有事件。")));
}

// ---------------------------------------------------------------------------
// release comparison

const cmp = { a: "", b: "" };

export async function comparePage(rerender) {
  return page("版本对比", rerender, async (slug) => {
    const { releases } = await api(`/api/apps/${slug}/filters`);
    if (releases.length < 2) return h("p", { class: "muted" }, "至少要有两个版本的数据才能对比。");
    if (!releases.includes(cmp.a)) cmp.a = releases[1];
    if (!releases.includes(cmp.b)) cmp.b = releases[0];
    const pick = (key) => {
      const el = h("select", { onchange: () => { cmp[key] = el.value; rerender(); } },
        releases.map((r) => h("option", { value: r, selected: r === cmp[key] }, r)));
      return el;
    };
    const c = await api(`/api/apps/${slug}/compare?${query({ a: cmp.a, b: cmp.b })}`);
    const rows = [
      ["会话", (s) => num(s.sessions)], ["设备", (s) => num(s.devices)], ["事件", (s) => num(s.events)],
      ["平均会话时长", (s) => duration(s.avgSessionMs)],
      ["错误 / 会话", (s) => `${per(s.errorsPerSession)}（${num(s.errors)}）`],
      ["连点 / 会话", (s) => `${per(s.rageTapsPerSession)}（${num(s.rageTaps)}）`],
      ["无响应点击 / 会话", (s) => `${per(s.deadTapsPerSession)}（${num(s.deadTaps)}）`],
      ["操作失败率", (s) => `${pct(s.opFailureRate)}（${num(s.ops)} 次）`],
      ...c.a.metrics.map((m, i) => [`指标 ${m.name}`, (s) => `${pct(s.metrics[i]?.ratio)}（${num(s.metrics[i]?.numerator)}/${num(s.metrics[i]?.denominator)}）`]),
    ];
    return h("div", {},
      h("div", { class: "controls" }, "A", pick("a"), "对比 B", pick("b")),
      h("div", { class: "card" }, table(["", `A ${c.a.release}`, `B ${c.b.release}`], rows.map(([label, f]) => [label, f(c.a), f(c.b)]))));
  }, { intro: "两个版本在同一个时间范围内的会话和比率。样本小的时候，差别不一定说明问题。" });
}

// ---------------------------------------------------------------------------
// friction, performance, navigation, usage

export function frictionPage(rerender) {
  return page("摩擦点", rerender, async (slug) => {
    const f = await api(`/api/apps/${slug}/friction?${query()}`);
    const targets = (rows) => table(["目标", "次数", "设备"], rows.map((r) => [code(r.target), num(r.events), num(r.devices)]));
    return h("div", { class: "grid2" },
      h("div", { class: "card" }, h("b", {}, "连点（rage tap）"), targets(f.rageTaps)),
      h("div", { class: "card" }, h("b", {}, "无响应点击（dead tap）"), targets(f.deadTaps)),
      h("div", { class: "card" }, h("b", {}, "错误"),
        table(["类型", "信息", "次数", "设备"], f.errors.map((r) => [code(r.kind), r.message ?? "", num(r.events), num(r.devices)]))),
      h("div", { class: "card" }, h("b", {}, "提示（toast）"),
        table(["级别", "提示", "次数", "设备"], f.toasts.map((r) => [code(r.level), r.message ?? "", num(r.events), num(r.devices)]))),
      h("div", { class: "card" }, h("b", {}, "对话框"),
        table(["对话框", "动作", "关闭方式", "次数"], f.dialogs.map((r) => [code(r.dialog), r.action ?? "", r.closeBy ?? "", num(r.events)]))),
    );
  }, { intro: "Web 应用专用：用户在哪里卡住、点不动、遇到错误。" });
}

export function performancePage(rerender) {
  return page("性能", rerender, async (slug) => {
    const p = await api(`/api/apps/${slug}/performance?${query()}`);
    return h("div", {},
      h("div", { class: "card" }, h("b", {}, "页面体验（Web Vitals）"),
        table(["指标", "页面", "样本", "p50", "p75", "p95", "良好占比"],
          p.vitals.map((v) => [code(v.metric), v.screen ?? "", num(v.samples), v.p50, v.p75, v.p95, pct(v.goodShare)]))),
      h("div", { class: "card" }, h("b", {}, "操作耗时"),
        table(["操作", "次数", "失败率", "p50", "p95", "最常见错误"],
          p.ops.map((o) => [code(o.op), num(o.calls), pct(o.failureRate), ms(o.p50), ms(o.p95), o.topErrorKind ?? ""]))));
  }, { intro: "分位数在样本里直接计算。LCP/INP/TTFB 的单位是毫秒，CLS 没有单位。" });
}

export function navigationPage(rerender) {
  return page("导航", rerender, async (slug) => {
    const n = await api(`/api/apps/${slug}/navigation?${query()}`);
    return h("div", { class: "grid2" },
      h("div", { class: "card" }, h("b", {}, "页面和下一步"),
        n.screens.length ? n.screens.map((s) => h("div", {},
          h("div", { class: "row between" }, code(s.screen), h("span", { class: "muted" }, `${num(s.events)} 次`)),
          s.next?.length ? hbars(s.next.slice(0, 5).map((x) => ({ label: `→ ${x.screen}`, value: x.events }))) : null))
          : h("p", { class: "muted" }, "这个范围内没有页面访问。")),
      h("div", { class: "card" }, h("b", {}, "最常见的路径"),
        table(["从", "到", "次数", "设备"], n.edges.map((e) => [code(e.from), code(e.to), num(e.events), num(e.devices)]))));
  }, { intro: "Web 应用专用：用户在页面之间怎么走。" });
}

export function usagePage(rerender) {
  return page("功能使用", rerender, async (slug) => {
    const u = await api(`/api/apps/${slug}/usage?${query()}`);
    return h("div", {},
      u.hasCatalog ? null : h("p", { class: "note" }, "这个应用还没有事件目录，下面的「没人用」和「没登记」没有意义。用 moli-insight catalog 上传。"),
      h("div", { class: "grid2" },
        h("div", { class: "card" }, h("b", {}, "目录里有、这个范围内没出现的事件"),
          table(["事件", "说明", "层级"], u.unused.map((e) => [code(e.name), e.description, e.tier]), "都用到了。")),
        h("div", { class: "card" }, h("b", {}, "出现了、目录里没登记的事件"),
          table(["事件", "次数"], u.uncataloged.map((e) => [code(e.name), num(e.events)]), "都登记了。"))),
      h("div", { class: "grid2" },
        h("div", { class: "card" }, h("b", {}, "点击最多的控件"),
          table(["目标", "次数", "设备"], u.taps.map((t) => [code(t.target), num(t.events), num(t.devices)]))),
        h("div", { class: "card" }, h("b", {}, "访问最多的页面"),
          table(["页面", "次数", "设备"], u.screens.map((t) => [code(t.screen), num(t.events), num(t.devices)])))));
  }, { intro: "功能有没有人用，要靠事件目录和实际数据对照。" });
}
