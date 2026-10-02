// The admin pages: sign in, apps and their keys, admin tokens, people, devices.
// The data pages (overview, events) are in data.js. Everything from the API goes in
// through textContent, never as HTML.
import { act, api, errorBox, fmt, h, hooks, secretBox } from "./lib.js";
import { eventsPage, overviewPage } from "./data.js";

const main = document.getElementById("main");
const nav = document.getElementById("nav");

const show = (...nodes) => {
  nav.hidden = nodes[0]?.dataset.page === "login";
  main.replaceChildren(...nodes);
};
hooks.unauthorized = () => show(loginPage());

// ---------------------------------------------------------------------------

function loginPage() {
  const error = errorBox();
  const input = h("input", { type: "password", placeholder: "口令", autocomplete: "current-password", required: true });
  const form = h("form", { class: "card", onsubmit: act(error, async () => {
    try {
      await api("/api/login", "POST", { password: input.value });
    } catch (e) {
      throw e.status === 429 ? new Error("尝试次数过多，请稍后再试") : e.status === 401 ? new Error("口令不对") : e;
    }
    route();
  }) },
    h("div", { class: "row" }, input, h("button", { class: "primary", type: "submit" }, "登录")),
    error,
  );
  const page = h("section", {}, form);
  page.dataset.page = "login";
  return page;
}

async function appsPage() {
  const { apps } = await api("/api/apps");
  const error = errorBox();
  const slug = h("input", { placeholder: "slug（小写字母、数字、-）", pattern: "[a-z0-9-]{1,40}", required: true });
  const name = h("input", { placeholder: "名称", required: true });
  const form = h("form", { class: "card row", onsubmit: act(error, async () => {
    await api("/api/apps", "POST", { slug: slug.value, name: name.value });
    location.hash = `#/apps/${slug.value}`;
  }) }, slug, name, h("button", { class: "primary", type: "submit" }, "新建应用"));

  return h("section", {},
    h("h2", {}, "应用"),
    apps.length === 0 ? h("p", { class: "muted" }, "还没有应用。新建一个，再为它生成密钥。") : null,
    apps.map((a) => h("div", { class: "card row between" },
      h("div", {}, h("a", { href: `#/apps/${a.slug}` }, a.name), " ", h("code", {}, a.slug)),
      h("span", { class: "muted" }, `${a.deviceCount} 台设备 · 最近事件 ${fmt(a.lastEventAt)} · 保留 ${a.retentionDays} 天`),
    )),
    form, error,
  );
}

async function appPage(slug) {
  const [{ apps }, { keys }, { devices }, { people }] = await Promise.all([
    api("/api/apps"), api(`/api/apps/${slug}/keys`), api(`/api/apps/${slug}/devices`), api("/api/people"),
  ]);
  const app = apps.find((a) => a.slug === slug);
  if (!app) return h("p", {}, "没有这个应用。");

  const error = errorBox();
  const secret = h("div", {});
  const label = h("input", { placeholder: "备注，如 release-ci" });
  const retention = h("input", { type: "number", min: 1, max: 3650, value: app.retentionDays, style: "width:6em" });

  const keyForm = h("form", { class: "row", onsubmit: act(error, async () => {
    const created = await api(`/api/apps/${slug}/keys`, "POST", { label: label.value });
    secret.replaceChildren(secretBox("摄入密钥", created.key));
    label.value = "";
  }) }, label, h("button", { class: "primary", type: "submit" }, "生成密钥"));

  return h("section", {},
    h("p", {}, h("a", { href: "#/apps" }, "← 应用")),
    h("h2", {}, app.name, " ", h("code", {}, app.slug)),
    h("div", { class: "card row" }, "保留", retention, "天",
      h("button", { type: "button", onclick: act(error, async () => {
        await api(`/api/apps/${slug}`, "PATCH", { retentionDays: Number(retention.value) });
      }) }, "保存"),
    ),

    h("h2", {}, "摄入密钥"),
    h("p", { class: "muted" }, "密钥只能写入数据，不能读取。直连模式的密钥会随客户端发出，泄露后在这里作废即可。"),
    secret,
    keys.map((k) => h("div", { class: `card row between ${k.revokedAt ? "revoked" : ""}` },
      h("div", {}, h("code", {}, `${k.prefix}…`), " ", k.label),
      h("div", { class: "row" },
        h("span", { class: "muted" }, `最近使用 ${fmt(k.lastUsedAt)}`),
        k.revokedAt ? null : h("button", { class: "danger", type: "button", onclick: act(error, async () => {
          if (!confirm("作废后使用此密钥的客户端将立即收到 401。继续？")) return;
          await api(`/api/keys/${k.id}/revoke`, "POST");
          route();
        }) }, "作废"),
      ),
    )),
    keyForm,

    h("h2", {}, "设备"),
    devices.length === 0 ? h("p", { class: "muted" }, "还没有设备上报过数据。") : h("table", {},
      h("thead", {}, h("tr", {}, ["设备", "平台", "版本", "最近", "归属", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, devices.map((d) => {
        const select = h("select", { onchange: act(error, async () => {
          await api(`/api/devices/${d.id}`, "PUT", { personId: select.value ? Number(select.value) : null });
        }) },
          h("option", { value: "" }, "未归属"),
          people.map((p) => h("option", { value: p.id, selected: p.id === d.personId }, p.name)),
        );
        return h("tr", {},
          h("td", {}, h("code", {}, d.deviceId)), h("td", {}, d.platform), h("td", {}, d.lastRelease ?? "—"),
          h("td", {}, fmt(d.lastSeenAt)), h("td", {}, select),
          h("td", {}, h("button", { class: "danger", type: "button", onclick: act(error, async () => {
            if (!confirm("删除这台设备及其全部事件？此操作不可撤销。")) return;
            await api(`/api/devices/${d.id}`, "DELETE");
            route();
          }) }, "删除数据")),
        );
      })),
    ),

    h("h2", {}, "危险操作"),
    h("div", { class: "card" }, h("button", { class: "danger", type: "button", onclick: act(error, async () => {
      if (prompt(`输入 ${slug} 确认删除该应用及其全部数据`) !== slug) return;
      await api(`/api/apps/${slug}`, "DELETE");
      location.hash = "#/apps";
    }) }, "删除应用与全部数据")),
    error,
  );
}

async function tokensPage() {
  const { tokens } = await api("/api/admin-tokens");
  const error = errorBox();
  const secret = h("div", {});
  const label = h("input", { placeholder: "备注，如 claude-mcp" });
  return h("section", {},
    h("h2", {}, "管理令牌"),
    h("p", { class: "muted" }, "给导出接口和 MCP 用的只读令牌，不能用来写入数据。"),
    secret,
    tokens.map((t) => h("div", { class: `card row between ${t.revokedAt ? "revoked" : ""}` },
      h("div", {}, h("code", {}, `${t.prefix}…`), " ", t.label),
      h("div", { class: "row" },
        h("span", { class: "muted" }, `最近使用 ${fmt(t.lastUsedAt)}`),
        t.revokedAt ? null : h("button", { class: "danger", type: "button", onclick: act(error, async () => {
          await api(`/api/admin-tokens/${t.id}/revoke`, "POST");
          route();
        }) }, "作废"),
      ),
    )),
    h("form", { class: "row", onsubmit: act(error, async () => {
      const created = await api("/api/admin-tokens", "POST", { label: label.value });
      secret.replaceChildren(secretBox("管理令牌", created.token));
      label.value = "";
    }) }, label, h("button", { class: "primary", type: "submit" }, "生成令牌")),
    error,
  );
}

async function peoplePage() {
  const { people } = await api("/api/people");
  const error = errorBox();
  const name = h("input", { placeholder: "名字", required: true, maxlength: 40 });
  return h("section", {},
    h("h2", {}, "人员"),
    h("p", { class: "muted" }, "把同一个人在不同应用、不同设备上的使用串起来。在应用页的设备列表里归属。"),
    people.map((p) => h("div", { class: "card row between" },
      h("span", {}, p.name), 
      h("div", { class: "row" }, h("span", { class: "muted" }, `${p.deviceCount} 台设备`),
        h("button", { class: "danger", type: "button", onclick: act(error, async () => {
          if (!confirm(`删除 ${p.name}？设备会保留，只是不再归属。`)) return;
          await api(`/api/people/${p.id}`, "DELETE");
          route();
        }) }, "删除")),
    )),
    h("form", { class: "row", onsubmit: act(error, async () => {
      await api("/api/people", "POST", { name: name.value });
      route();
    }) }, name, h("button", { class: "primary", type: "submit" }, "添加")),
    error,
  );
}

// ---------------------------------------------------------------------------

/** Pages that are about data are wider, and the current menu entry is marked. */
function mark(page) {
  main.classList.toggle("wide", page === "overview" || page === "events");
  for (const a of nav.querySelectorAll("a")) a.classList.toggle("current", a.getAttribute("href") === `#/${page}`);
}

let token = 0;
async function route() {
  const [, page = "overview", arg] = location.hash.split("/");
  const mine = ++token;
  try {
    const { authenticated } = await api("/api/me");
    if (!authenticated) return show(loginPage());
    const again = () => route();
    const view = page === "tokens" ? await tokensPage()
      : page === "people" ? await peoplePage()
      : page === "apps" ? (arg ? await appPage(decodeURIComponent(arg)) : await appsPage())
      : page === "events" ? await eventsPage(again, arg ? decodeURIComponent(arg) : "")
      : await overviewPage(again);
    if (mine !== token) return; // a newer navigation has taken over
    mark(page);
    show(view);
  } catch (error) {
    if (error.message !== "unauthorized" && mine === token) show(h("p", { class: "error" }, `加载失败：${error.message}`));
  }
}

document.getElementById("logout").addEventListener("click", async () => {
  await api("/api/logout", "POST");
  route();
});
addEventListener("hashchange", route);
route();
