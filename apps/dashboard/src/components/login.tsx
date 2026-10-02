const MESSAGES: Record<string, string> = {
  unconfigured: "这个服务还没配置好 Authelia 登录",
  denied: "Authelia 拒绝了这次登录",
  expired: "登录已超时，请重新开始",
  failed: "登录没有完成，请重试",
  forbidden: "这个账号没有权限使用看板",
};

/** Sign-in is Authelia's: the worker starts the flow and brings the browser back here with a session. */
export function LoginPage() {
  const here = new URL(window.location.href);
  const error = MESSAGES[here.searchParams.get("login_error") ?? ""];
  here.searchParams.delete("login_error");
  const next = `${here.pathname}${here.search}`;
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-7" />
          <h1 className="text-lg font-semibold tracking-tight">MoliInsight</h1>
        </div>
        {error ? <p role="alert" className="mb-4 text-sm text-danger">{error}</p> : null}
        {/* A page load, not a router link: the worker answers with a redirect to Authelia. */}
        <a
          href={`/auth/login?next=${encodeURIComponent(next)}`}
          className="inline-flex h-9 w-full items-center justify-center rounded-md border border-primary bg-primary text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          用 Authelia 登录
        </a>
      </div>
    </main>
  );
}
