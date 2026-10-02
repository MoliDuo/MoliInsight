import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Navigate, Outlet, RouterProvider, createRootRoute, createRoute, createRouter, redirect, type RouteComponent, type RouterHistory,
} from "@tanstack/react-router";
import { lazy, useEffect, type ComponentType } from "react";
import { Toaster } from "sonner";
import { LoginPage } from "@/components/login";
import { Shell } from "@/components/shell";
import { PageSkeleton } from "@/components/ui";
import { api, hooks } from "@/lib/api";
import { validateFilters } from "@/lib/filters";
import { lastApp, useApi, type AppRow } from "@/lib/hooks";
import { validateCompareSearch, validateEventSearch, validateSettingsSearch } from "@/lib/search";

/** Pages load when first visited, so the charts library is not part of the first download. */
const page = <T extends Record<string, unknown>>(load: () => Promise<T>, name: keyof T) =>
  lazy(async () => ({ default: (await load())[name] as ComponentType })) as unknown as RouteComponent;

const OverviewPage = page(() => import("@/routes/overview"), "OverviewPage");
const EventsPage = page(() => import("@/routes/events"), "EventsPage");
const EventsIndex = page(() => import("@/routes/events"), "EventsIndex");
const EventDetail = page(() => import("@/routes/events"), "EventDetail");
const SessionsPage = page(() => import("@/routes/sessions"), "SessionsPage");
const SessionTimelinePage = page(() => import("@/routes/sessions"), "SessionTimelinePage");
const FunnelsPage = page(() => import("@/routes/funnels"), "FunnelsPage");
const ComparePage = page(() => import("@/routes/compare"), "ComparePage");
const FrictionPage = page(() => import("@/routes/experience"), "FrictionPage");
const PerformancePage = page(() => import("@/routes/experience"), "PerformancePage");
const NavigationPage = page(() => import("@/routes/experience"), "NavigationPage");
const UsagePage = page(() => import("@/routes/experience"), "UsagePage");
const AppSettingsPage = page(() => import("@/routes/settings-app"), "AppSettingsPage");
const PeoplePage = page(() => import("@/routes/settings-global"), "PeoplePage");
const TokensPage = page(() => import("@/routes/settings-global"), "TokensPage");
const OnboardingPage = page(() => import("@/routes/onboarding"), "OnboardingPage");

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false } },
});

function Root() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<{ authenticated: boolean }>("/api/me") });
  useEffect(() => {
    // A 401 anywhere means the session ended: show the login page and drop what was cached.
    hooks.unauthorized = () => client.setQueryData(["me"], { authenticated: false });
  }, [client]);
  if (me.isPending) return <div className="p-8"><PageSkeleton /></div>;
  if (!me.data?.authenticated) return <LoginPage />;
  // Drop everything cached except `me`: clearing that one too would orphan the query this component watches.
  return (
    <Shell
      onLogout={() => {
        client.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
        client.setQueryData(["me"], { authenticated: false });
      }}
    />
  );
}

/** `/`: the app last looked at, the first app, or the setup page when there is none. */
function Home() {
  const apps = useApi<{ apps: AppRow[] }>("/api/apps");
  if (apps.isPending) return <PageSkeleton />;
  const list = apps.data?.apps ?? [];
  if (list.length === 0) return <Navigate to="/new" replace />;
  const slug = list.find((a) => a.slug === lastApp())?.slug ?? list[0]!.slug;
  return <Navigate to="/$app/overview" params={{ app: slug }} replace />;
}

const rootRoute = createRootRoute({ component: Root });
const route = (path: string, component: RouteComponent, validateSearch: (s: Record<string, unknown>) => unknown = validateFilters) =>
  createRoute({ getParentRoute: () => rootRoute, path, component, validateSearch });

const home = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });
const onboarding = route("/new", OnboardingPage);
const people = route("/settings/people", PeoplePage);
const tokens = route("/settings/tokens", TokensPage);

const appRoot = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$app",
  component: Outlet,
  beforeLoad: ({ params, location }) => {
    if (location.pathname.replace(/\/$/, "") === `/${params.app}`) throw redirect({ to: "/$app/overview", params });
  },
});
const child = (path: string, component: RouteComponent, validateSearch: (s: Record<string, unknown>) => unknown = validateFilters) =>
  createRoute({ getParentRoute: () => appRoot, path, component, validateSearch });

const events = child("events", EventsPage, validateEventSearch);
const eventsIndex = createRoute({ getParentRoute: () => events, path: "/", component: EventsIndex });
const eventDetail = createRoute({ getParentRoute: () => events, path: "$name", component: EventDetail });

const routeTree = rootRoute.addChildren([
  home, onboarding, people, tokens,
  appRoot.addChildren([
    child("overview", OverviewPage),
    events.addChildren([eventsIndex, eventDetail]),
    child("sessions", SessionsPage),
    child("sessions/$id", SessionTimelinePage),
    child("funnels", FunnelsPage),
    child("compare", ComparePage, validateCompareSearch),
    child("friction", FrictionPage),
    child("performance", PerformancePage),
    child("navigation", NavigationPage),
    child("usage", UsagePage),
    child("settings", AppSettingsPage, validateSettingsSearch),
  ]),
]);

// Every search value is text. The router's own format reads `days=7` as a number and writes it back
// as `days=%227%22`, which would turn every shared link into that.
const parseSearch = (search: string) => Object.fromEntries(new URLSearchParams(search));
const stringifySearch = (search: Record<string, unknown>) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) if (value !== undefined && value !== null && value !== "") q.set(key, String(value));
  const text = q.toString();
  return text ? `?${text}` : "";
};

export const createAppRouter = (history?: RouterHistory) =>
  createRouter({ routeTree, defaultPreload: false, parseSearch, stringifySearch, ...(history ? { history } : {}) });

const browserRouter = createAppRouter();

export function App({ router = browserRouter }: { router?: ReturnType<typeof createAppRouter> }) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}
