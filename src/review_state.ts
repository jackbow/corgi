//! Viewer state survives process restarts, keyed by the provider's conversation ID.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import * as pr from "./pull_request";
import type { Saved as Diff } from "./review/panel";
import type { Tab } from "./pull_request_panel";
export interface PullRequest {
  url: string;
  tab: Tab;
  top: number;
  checksOpen: boolean;
  unresolvedOnly: boolean;
  openThreads: string[];
  foldedThreads: string[];
}
export interface State {
  prs_open?: boolean;
  active: "pr" | "diff" | "remote" | null;
  pr: PullRequest | null;
  diff: Diff | null;
}
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const counter = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const nullableString = (v: unknown) => v === null || typeof v === "string";
function read(file: string): Record<string, State> {
  try {
    const raw = object(JSON.parse(readFileSync(file, "utf8"))),
      result: Record<string, State> = Object.create(null);
    for (const [key, value] of Object.entries(raw)) {
      const state = object(value),
        p = object(state.pr),
        d = object(state.diff);
      if (![null, "pr", "diff", "remote"].includes(state.active as string | null)) continue;
      if (
        state.pr !== null &&
        (!pr.parse(String(p.url)) ||
          !["overview", "discussion", "stack"].includes(String(p.tab)) ||
          !counter(p.top) ||
          typeof p.checksOpen !== "boolean" ||
          typeof p.unresolvedOnly !== "boolean" ||
          ![p.openThreads, p.foldedThreads].every(a => Array.isArray(a) && a.every(v => typeof v === "string")))
      )
        continue;
      if (
        state.diff !== null &&
        (!nullableString(d.folder) ||
          !nullableString(d.path) ||
          !nullableString(d.pick) ||
          !["all", "uncommitted", "commits"].includes(String(d.scope)) ||
          !["tree", "diff"].includes(String(d.part)) ||
          ![d.top, d.cur, d.tree_top].every(counter) ||
          ![d.all, d.split, d.hide_tests, d.full_context, d.wrap].every(v => typeof v === "boolean"))
      )
        continue;
      result[key] = state as unknown as State;
    }
    return result;
  } catch {
    return Object.create(null);
  }
}
export class Store {
  private states: Record<string, State>;
  private pending = new Map<string, State>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly file: string) {
    this.states = read(file);
  }
  static open(socket: string): Store {
    const scope = createHash("sha256").update(socket).digest("hex").slice(0, 16);
    return new Store(
      join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "corgi", "reviews", scope + ".json"),
    );
  }
  get(key: string): State | null {
    return this.states[key] ? structuredClone(this.states[key]) : null;
  }
  put(key: string, state: State): void {
    if (JSON.stringify(this.states[key]) === JSON.stringify(state)) return;
    this.states[key] = structuredClone(state);
    this.pending.set(key, structuredClone(state));
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 250);
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.size) return;
    try {
      const latest = read(this.file);
      for (const [key, state] of this.pending) {
        delete latest[key];
        latest[key] = state;
      }
      const kept = Object.fromEntries(Object.entries(latest).slice(-256));
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + "." + randomUUID() + ".tmp";
      writeFileSync(temporary, JSON.stringify(kept), { mode: 0o600 });
      renameSync(temporary, this.file);
      this.pending.clear();
    } catch {
      /* A read-only state directory must not interrupt the viewer. */
    }
  }
}
