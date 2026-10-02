import { keepPreviousData, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import clsx from "clsx";
import type { ReactNode } from "react";
import { ErrorBlock, PageSkeleton } from "@/components/ui";
import { api } from "./api";
import { validateFilters, type Filters } from "./filters";

/** A GET that is cached by its path. While a new path loads, the old data stays on screen. */
export function useApi<T = any>(path: string | null, options: { refetchInterval?: number } = {}): UseQueryResult<T> {
  return useQuery<T>({
    queryKey: ["api", path],
    queryFn: () => api<T>(path!),
    enabled: path !== null,
    placeholderData: keepPreviousData,
    ...options,
  });
}

/** Forgets cached GETs whose path starts with the prefix, so the pages refetch them. */
export function useInvalidate() {
  const client = useQueryClient();
  return (prefix: string) =>
    client.invalidateQueries({ predicate: (q) => q.queryKey[0] === "api" && String(q.queryKey[1] ?? "").startsWith(prefix) });
}

export const useAppSlug = (): string => (useParams({ strict: false }) as { app?: string }).app ?? "";

export function useFilters(): Filters {
  return validateFilters(useSearch({ strict: false }) as Record<string, unknown>);
}

/** Changes some of the URL's search parameters and keeps the rest. */
export function useSetSearch() {
  const navigate = useNavigate();
  return (patch: Record<string, string | undefined>) =>
    navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, ...patch })) as never, replace: true });
}

export function Loaded<T>({ q, children, skeleton }: { q: UseQueryResult<T>; children: (data: T) => ReactNode; skeleton?: ReactNode }) {
  if (q.isPending) return <>{skeleton ?? <PageSkeleton />}</>;
  if (q.isError) return <ErrorBlock error={q.error} />;
  return <div className={clsx("transition-opacity", q.isPlaceholderData && "opacity-50")}>{children(q.data)}</div>;
}

const LAST_APP = "mi_app";
export const lastApp = (): string | null => {
  try {
    return localStorage.getItem(LAST_APP);
  } catch {
    return null;
  }
};
export const rememberApp = (slug: string) => {
  try {
    localStorage.setItem(LAST_APP, slug);
  } catch {}
};

export interface AppRow {
  slug: string;
  name: string;
  deviceCount: number;
  lastEventAt: number | null;
  retentionDays: number;
}
