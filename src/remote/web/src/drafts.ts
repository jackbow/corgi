import { useSyncExternalStore } from "react";
const listeners = new Set<() => void>(),
  fallback = new Map<string, string>();
export function readDraft(key: string): string {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return sessionStorage.getItem(key) ?? "";
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === "object" &&
      "text" in value &&
      "expires" in value &&
      typeof value.text === "string" &&
      typeof value.expires === "number" &&
      value.expires > Date.now()
    )
      return value.text;
    localStorage.removeItem(key);
    return "";
  } catch {
    return fallback.get(key) ?? "";
  }
}
function write(key: string, value: string) {
  try {
    value
      ? localStorage.setItem(key, JSON.stringify({ text: value, expires: Date.now() + 48 * 3600_000 }))
      : localStorage.removeItem(key);
    if (sessionStorage !== localStorage) sessionStorage.removeItem(key);
    fallback.delete(key);
  } catch {
    fallback.set(key, value);
  }
  listeners.forEach(listener => listener());
}
export function clearSubmitted(key: string, text: string) {
  if (readDraft(key) === text) write(key, "");
}
export function forgetDrafts() {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      for (const key of Object.keys(storage)) if (key.startsWith("corgi-draft:")) storage.removeItem(key);
    } catch {}
  }
  fallback.clear();
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useDraft(key: string): [string, (value: string) => void] {
  return [useSyncExternalStore(subscribe, () => readDraft(key)), value => write(key, value)];
}
