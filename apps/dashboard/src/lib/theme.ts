import { useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";
const KEY = "mi_theme";
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let current: Theme = read();

function apply() {
  const dark = current === "dark" || (current === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function setTheme(theme: Theme) {
  current = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {}
  apply();
  for (const l of listeners) l();
}

export function initTheme() {
  apply();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", apply);
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
