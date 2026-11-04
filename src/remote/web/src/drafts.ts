import { useSyncExternalStore } from "react";
const listeners = new Set<() => void>(),
  fallback = new Map<string, string>();
export function readDraft(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return fallback.get(key) ?? "";
  }
}
function write(key: string, value: string) {
  try {
    value ? sessionStorage.setItem(key, value) : sessionStorage.removeItem(key);
    fallback.delete(key);
  } catch {
    fallback.set(key, value);
  }
  listeners.forEach(listener => listener());
}
export function clearSubmitted(key: string, text: string) {
  if (readDraft(key) === text) write(key, "");
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
