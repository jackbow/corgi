//! Inline directory completion for the review's repo / folder field.
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { TextArea, type Line } from "../text_area";
import { codepointWidth, displayWidth } from "../text";

export type Lister = (path: string) => Promise<string[]>;
export type Access = { list: Lister; home(): string };
export function path(base: string, typed: string, home: string): string {
  if (typed === "~" || typed.startsWith("~/")) return home ? resolve(home, "." + typed.slice(1)) : typed;
  return resolve(base, typed);
}
async function directories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const folders = await Promise.all(
    entries.map(async entry => {
      if (entry.isDirectory()) return entry.name;
      if (entry.isSymbolicLink())
        try {
          if ((await stat(resolve(path, entry.name))).isDirectory()) return entry.name;
        } catch {}
      return null;
    }),
  );
  return folders.filter((name): name is string => name !== null);
}
/** A subsequence match, preferring fewer skipped letters and shorter names. */
function score(name: string, query: string): number | null {
  const lower = name.toLowerCase(),
    needle = query.toLowerCase();
  let at = 0,
    gaps = 0;
  for (const ch of needle) {
    const next = lower.indexOf(ch, at);
    if (next < 0) return null;
    gaps += next - at;
    at = next + ch.length;
  }
  return gaps * 1000 + name.length;
}
export class Input extends TextArea {
  matches: string[] = [];
  selected: number | null = null;
  loading = false;
  problem: string | null = null;
  private request = 0;
  private listed: { parent: string; names: Promise<string[]> } | null = null;
  constructor(
    readonly base: string,
    private changed: () => void = () => {},
    private list: Lister = directories,
    private home: string | (() => string) = process.env.HOME ?? "",
  ) {
    super(!base || base.endsWith("/") ? base : base + "/", false);
  }
  async refresh(): Promise<void> {
    const ticket = ++this.request,
      cut = this.text.lastIndexOf("/"),
      prefix = this.text.slice(0, cut + 1),
      query = this.text.slice(cut + 1),
      typed = prefix || (this.text === "~" ? "~" : "."),
      parent = path(this.base, typed, typeof this.home === "string" ? this.home : this.home());
    this.selected = null;
    this.matches = [];
    this.problem = null;
    this.loading = true;
    try {
      if (this.listed?.parent !== parent) this.listed = { parent, names: this.list(parent) };
      const names = await this.listed.names;
      if (ticket !== this.request) return;
      this.matches = names
        .filter(name => query.startsWith(".") || !name.startsWith("."))
        .map(name => ({ name, score: score(name, this.text === "~" ? "" : query) }))
        .filter((item): item is { name: string; score: number } => item.score !== null)
        .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
        .map(({ name }) => (this.text === "~" ? "~/" : prefix) + name + "/");
    } catch {
      if (ticket !== this.request) return;
      this.problem = "Cannot read folders here; enter a path to open it.";
      this.listed = null;
    }
    if (ticket === this.request) {
      this.loading = false;
      this.changed();
    }
  }
  moveSuggestion(delta: number): void {
    if (!this.matches.length) return;
    this.selected =
      this.selected === null
        ? delta > 0
          ? 0
          : this.matches.length - 1
        : Math.max(0, Math.min(this.matches.length - 1, this.selected + delta));
  }
  complete(): boolean {
    const match = this.matches[this.selected ?? 0];
    if (!match) return false;
    this.apply("select_all");
    this.insert(match);
    void this.refresh();
    return true;
  }
  chosen(): string {
    return this.selected === null ? this.text : (this.matches[this.selected] ?? this.text);
  }
  /** Keep the caret visible while editing paths wider than the field. */
  viewport(width: number): { line: Line; caret: number } {
    let start = 0;
    const room = Math.max(1, width);
    let before = displayWidth(this.text.slice(0, this.caret));
    while (before >= room && start < this.caret) {
      const ch = String.fromCodePoint(this.text.codePointAt(start)!);
      before -= Math.max(0, codepointWidth(ch.codePointAt(0)!));
      start += ch.length;
    }
    let end = start,
      used = 0;
    for (const ch of this.text.slice(start)) {
      const columns = Math.max(0, codepointWidth(ch.codePointAt(0)!));
      if (used + columns > room) break;
      end += ch.length;
      used += columns;
    }
    return { line: { start, end }, caret: before };
  }
}
