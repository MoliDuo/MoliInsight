import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import {
  Activity, ChartColumn, Filter, Gauge, GitCompare, History, KeyRound, ListTree, LogOut, Menu, Monitor, MousePointerClick,
  Moon, Route as RouteIcon, Settings, Sun, User, Users, X, type LucideIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { rememberApp, useApi, useAppSlug, type AppRow } from "@/lib/hooks";
import { setTheme, useTheme, type Theme } from "@/lib/theme";
import { Button, PageSkeleton, Select } from "./ui";

interface NavItem { to: string; label: string; icon: LucideIcon }

const ANALYSIS: NavItem[] = [
  { to: "overview", label: "概览", icon: ChartColumn },
  { to: "events", label: "事件", icon: ListTree },
  { to: "sessions", label: "会话", icon: Activity },
  { to: "funnels", label: "漏斗与指标", icon: Filter },
  { to: "compare", label: "版本对比", icon: GitCompare },
];
const EXPERIENCE: NavItem[] = [
  { to: "friction", label: "摩擦点", icon: MousePointerClick },
  { to: "performance", label: "性能", icon: Gauge },
  { to: "navigation", label: "页面导航", icon: RouteIcon },
  { to: "usage", label: "功能使用", icon: ChartColumn },
];

function NavLink({ item, app, onNavigate }: { item: NavItem; app: string; onNavigate: () => void }) {
  const location = useLocation();
  const active = location.pathname.split("/")[2] === item.to;
  return (
    <Link
      to={`/$app/${item.to}` as string}
      params={{ app } as never}
      search={((prev: Record<string, unknown>) => ({ days: prev.days, from: prev.from, to: prev.to, platform: prev.platform, release: prev.release, person: prev.person })) as never}
      onClick={onNavigate}
      className={clsx("flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm", active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
    >
      <item.icon className="size-4" />
      {item.label}
    </Link>
  );
}

function Plain({ to, label, icon: Icon, onNavigate }: { to: string; label: string; icon: LucideIcon; onNavigate: () => void }) {
  const location = useLocation();
  const active = location.pathname === to;
  return (
    <Link to={to} onClick={onNavigate} className={clsx("flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm", active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
      <Icon className="size-4" />
      {label}
    </Link>
  );
}

const Group = ({ children }: { children: string }) => (
  <div className="px-2.5 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</div>
);

const THEMES: [Theme, LucideIcon, string][] = [["system", Monitor, "跟随系统"], ["light", Sun, "浅色"], ["dark", Moon, "深色"]];

export function Shell({ onLogout }: { onLogout: () => void }) {
  const app = useAppSlug();
  const apps = useApi<{ apps: AppRow[] }>("/api/apps");
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const user = useQueryClient().getQueryData<{ user?: string }>(["me"])?.user;
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const section = location.pathname.split("/")[2] ?? "overview";

  useEffect(() => { if (app) rememberApp(app); }, [app]);
  useEffect(close, [location.pathname]);

  const list = apps.data?.apps ?? [];
  const inApp = list.some((a) => a.slug === app);

  const switchApp = (slug: string) => {
    if (slug === "__new") return navigate({ to: "/new" });
    // An event name or a session of one app means nothing in another.
    const keep = ["events", "sessions"].includes(section) ? "overview" : section;
    navigate({ to: `/$app/${keep}` as string, params: { app: slug } as never, search: {} as never });
  };

  const sidebar = (
    <div className="flex h-full flex-col px-3 py-4">
      <Link to="/" className="mb-4 flex items-center gap-2 px-2.5">
        <img src="/favicon.svg" alt="" className="size-6" />
        <span className="text-base font-semibold tracking-tight">MoliInsight</span>
      </Link>
      <Select aria-label="应用" className="w-full" value={inApp ? app : ""} onChange={(e) => switchApp(e.target.value)}>
        {inApp ? null : <option value="">选择应用…</option>}
        {list.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
        <option value="__new">＋ 新建应用…</option>
      </Select>
      <nav className="mt-1 flex-1 overflow-y-auto">
        {inApp ? (
          <>
            <Group>分析</Group>
            {ANALYSIS.map((i) => <NavLink key={i.to} item={i} app={app} onNavigate={close} />)}
            <Group>体验（Web）</Group>
            {EXPERIENCE.map((i) => <NavLink key={i.to} item={i} app={app} onNavigate={close} />)}
            <Group>设置</Group>
            <NavLink item={{ to: "settings", label: "当前应用", icon: Settings }} app={app} onNavigate={close} />
          </>
        ) : <Group>设置</Group>}
        <Plain to="/settings/people" label="人员" icon={Users} onNavigate={close} />
        <Plain to="/settings/tokens" label="管理令牌" icon={KeyRound} onNavigate={close} />
        <Plain to="/settings/activity" label="操作记录" icon={History} onNavigate={close} />
      </nav>
      {user ? (
        <div className="mt-3 flex items-center gap-2 border-t border-border px-1 pt-3 text-sm" title="当前登录的 Authelia 用户">
          <User className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{user}</span>
        </div>
      ) : null}
      <div className={clsx("flex items-center justify-between gap-2 pt-3", user ? "" : "mt-3 border-t border-border")}>
        <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="主题">
          {THEMES.map(([value, Icon, label]) => (
            <button key={value} type="button" title={label} aria-label={label} aria-pressed={theme === value} onClick={() => setTheme(value)}
              className={clsx("grid size-6 place-items-center rounded", theme === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="size-3.5" />
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={async () => {
          try { await api("/api/logout", "POST"); } catch { toast.error("退出失败"); return; }
          onLogout();
        }}>
          <LogOut className="size-3.5" />退出
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 hidden h-screen border-r border-border bg-card md:block">{sidebar}</aside>
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2 md:hidden">
        <Button size="sm" variant="ghost" aria-label="打开菜单" onClick={() => setOpen(true)}><Menu className="size-4" /></Button>
        <span className="font-semibold">MoliInsight</span>
      </div>
      {open ? (
        <div className="fixed inset-0 z-30 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={close} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-card shadow-xl">
            <Button size="sm" variant="ghost" aria-label="关闭菜单" className="absolute right-2 top-2" onClick={close}><X className="size-4" /></Button>
            {sidebar}
          </aside>
        </div>
      ) : null}
      <main className="min-w-0 px-4 py-5 md:px-8"><div className="mx-auto max-w-6xl"><Suspense fallback={<PageSkeleton />}><Outlet /></Suspense></div></main>
    </div>
  );
}
