// Which URL search parameters each page understands. Kept apart from the pages so the router can read
// them without loading the pages.
import { validateFilters, type Filters } from "./filters";

const text = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));

export const validateEventSearch = (s: Record<string, unknown>) => ({
  ...validateFilters(s), by: text(s.by), prop: text(s.prop), value: text(s.value),
});

export const validateCompareSearch = (s: Record<string, unknown>) => ({ ...validateFilters(s), a: text(s.a), b: text(s.b) });

export const SETTINGS_TABS = ["connect", "keys", "devices", "catalog", "data", "advanced"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const validateSettingsSearch = (s: Record<string, unknown>): { tab?: SettingsTab } => ({
  tab: SETTINGS_TABS.find((t) => t === s.tab),
});

export type { Filters };
