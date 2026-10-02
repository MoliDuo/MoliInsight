// Shared by the pages: element helper, API calls, small widgets.
// Everything from the API goes in through textContent, never as HTML.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const child of children.flat()) el.append(child instanceof Node ? child : String(child ?? ""));
  return el;
}

/** Set by the router: what to do when the session has ended. */
export const hooks = { unauthorized: () => {} };

export async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && path !== "/api/login") {
    hooks.unauthorized();
    throw new Error("unauthorized");
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(json.error ?? response.status), { status: response.status, code: json.error });
  return json;
}

export const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : "—");
export const num = (n) => Number(n ?? 0).toLocaleString();
export const errorBox = () => h("p", { class: "error" });

/** Runs an action, and shows its failure in the given box. */
export function act(box, fn) {
  return async (event) => {
    event?.preventDefault?.();
    box.textContent = "";
    try {
      await fn();
    } catch (error) {
      if (error.message !== "unauthorized") box.textContent = `失败：${error.code ?? error.message}`;
    }
  };
}

/** A secret that is shown once. */
export function secretBox(label, value) {
  return h("div", { class: "secret" },
    h("div", {}, `${label}（只显示这一次，请现在保存）`),
    h("code", {}, value),
  );
}
