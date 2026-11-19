//! A conversation's PR list stays beside the independent PR detail viewer.
import type { Action } from "./action";
import { sorted, type Mention, type Sort as MentionSort } from "./conversation_prs";
import * as pr from "./pull_request";
import { Rect } from "./layout";
import { Writer, ellipsis } from "./text";
import * as palette from "./palette";

export interface Details {
  title: string;
  createdAt: string;
  updatedAt: string;
  state: "OPEN" | "CLOSED" | "MERGED";
}
export type Load = (ref: pr.Ref) => Promise<Details>;
export const load: Load = async ref => {
  const raw: unknown = JSON.parse(await pr.run(["pr", "view", ref.url, "--json", "title,createdAt,updatedAt,state"]));
  if (!raw || typeof raw !== "object") throw Error("Invalid GitHub PR metadata");
  const value = raw as Record<string, unknown>;
  if (
    ![value.title, value.createdAt, value.updatedAt].every(v => typeof v === "string") ||
    !["OPEN", "CLOSED", "MERGED"].includes(String(value.state))
  )
    throw Error("Invalid GitHub PR metadata");
  return value as unknown as Details;
};
type Sort = MentionSort | "created" | "updated";
const sorts: Sort[] = ["recent", "number", "created", "updated"];
const sortLabels: Record<Sort, string> = {
  recent: "latest mention",
  number: "PR number",
  created: "created (newest)",
  updated: "updated (newest)",
};
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const repoName = (ref: Mention) => ref.repo.split("/").pop()!;
function age(text: string | undefined, now: number): string {
  const date = text ? Date.parse(text) : NaN;
  if (!Number.isFinite(date)) return "—";
  const seconds = Math.max(0, (now - date) / 1000);
  for (const [unit, size] of [
    ["y", 31536000],
    ["mo", 2592000],
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ] as const)
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
  return `${Math.floor(seconds)}s ago`;
}
interface Row {
  text: string;
  color: palette.Token;
  index: number | null;
}
export class Panel {
  open = false;
  focused = false;
  sort: Sort = "recent";
  grouped = true;
  mergedOpen = false;
  items: Mention[] = [];
  selected = 0;
  top = 0;
  changed: () => void = () => {};
  private owner = "";
  private mentions: Mention[] = [];
  private merged: Mention[] = [];
  private rect = new Rect(0, 0, 0, 0);
  private details = new Map<string, Details>();
  private mergedURLs = new Set<string>();
  private errors = new Set<string>();
  private pending = new Set<string>();
  private wanted = new Map<string, Mention>();
  private pressed: string | null = null;
  constructor(private readDetails: Load = load) {}
  sidebar(refs: Mention[]): Mention[] {
    for (const ref of refs) this.wanted.set(ref.url, ref);
    this.fetch();
    return refs.filter(ref => !this.isMerged(ref));
  }
  update(ref: pr.Ref, details: Pick<Details, "state">) {
    if (details.state === "MERGED" && !this.mergedURLs.has(ref.url)) {
      this.mergedURLs.add(ref.url);
      this.arrange();
    }
  }
  private isMerged(ref: pr.Ref) {
    return this.mergedURLs.has(ref.url) || this.details.get(ref.url)?.state === "MERGED";
  }
  follow(owner: string, mentions: Mention[]) {
    if (owner !== this.owner) {
      this.owner = owner;
      this.selected = this.top = 0;
      this.mergedOpen = false;
      this.items = [];
    }
    this.mentions = mentions;
    this.arrange();
    if (this.open) this.fetch();
  }
  private arrange() {
    const selected = this.items[this.selected]?.url,
      toggle = this.selected === -1,
      order = sorted(this.mentions, this.sort === "number" ? "number" : "recent");
    if (this.sort === "created" || this.sort === "updated") {
      const field = this.sort === "created" ? "createdAt" : "updatedAt";
      const timestamp = (ref: Mention) => Date.parse(this.details.get(ref.url)?.[field] ?? "") || 0;
      order.sort((a, b) => timestamp(b) - timestamp(a));
    }
    if (this.grouped) order.sort((a, b) => repoName(a).localeCompare(repoName(b)) || a.repo.localeCompare(b.repo));
    this.merged = order.filter(ref => this.isMerged(ref));
    this.items = order.filter(ref => !this.isMerged(ref));
    if (this.mergedOpen) this.items.push(...this.merged);
    this.selected = toggle && this.merged.length ? -1 : this.items.findIndex(ref => ref.url === selected);
    if (this.selected < 0 && !(toggle && this.merged.length)) this.selected = this.items.length ? 0 : -1;
  }
  private fetch() {
    for (const ref of this.mentions) this.wanted.set(ref.url, ref);
    for (const ref of [...this.mentions, ...this.wanted.values()]) {
      if (this.pending.size >= 4) break;
      if (this.details.has(ref.url) || this.errors.has(ref.url) || this.pending.has(ref.url)) continue;
      this.pending.add(ref.url);
      void this.readDetails(ref)
        .then(
          details => {
            if (!this.details.has(ref.url)) this.details.set(ref.url, details);
            if (details.state === "MERGED") this.mergedURLs.add(ref.url);
          },
          () => this.errors.add(ref.url),
        )
        .finally(() => {
          this.pending.delete(ref.url);
          this.arrange();
          this.changed();
          this.fetch();
        });
    }
  }
  private rows(now = Date.now(), width = this.rect.w - 2): Row[] {
    const rows: Row[] = [];
    let repo = "";
    const append = (refs: Mention[]) => {
      for (const ref of refs) {
        const index = this.items.indexOf(ref),
          details = this.details.get(ref.url),
          created = age(details?.createdAt, now),
          updated = age(details?.updatedAt, now),
          timestamps = `Created ${created} · Updated ${updated}`;
        if (this.grouped && repo !== ref.repo) {
          repo = ref.repo;
          rows.push({ text: repoName(ref), color: "strong", index: null });
        }
        rows.push(
          { text: `${index === this.selected ? "›" : " "} #${ref.number} ${repoName(ref)}`, color: "muted", index },
          {
            text: details?.title ?? (this.errors.has(ref.url) ? "Unavailable · r to retry" : "Loading…"),
            color: "text",
            index,
          },
          {
            text: timestamps.length <= width ? timestamps : `C ${created} · U ${updated}`,
            color: "muted",
            index,
          },
        );
      }
    };
    append(this.items.filter(ref => !this.isMerged(ref)));
    if (this.merged.length) {
      rows.push({ text: `${this.mergedOpen ? "▾" : "▸"} Merged (${this.merged.length})`, color: "accent", index: -1 });
      repo = "";
      if (this.mergedOpen) append(this.merged);
    }
    return rows;
  }
  private move(delta: number) {
    const indices = [...new Set(this.rows().flatMap(row => (row.index === null ? [] : [row.index])))];
    const position = Math.max(0, indices.indexOf(this.selected));
    this.selected = indices[Math.max(0, Math.min(indices.length - 1, position + delta))] ?? -1;
  }
  private activate(): Action | null {
    if (this.selected === -1) {
      if (this.merged.length) this.key("m");
      return null;
    }
    const ref = this.items[this.selected];
    return ref ? { name: "pull-request", value: ref.url } : null;
  }
  key(key: string): Action | null {
    switch (key) {
      case "escape":
        this.focused = false;
        break;
      case "up":
      case "k":
        this.move(-1);
        break;
      case "down":
      case "j":
        this.move(1);
        break;
      case "s":
        this.sort = sorts[(sorts.indexOf(this.sort) + 1) % sorts.length];
        this.arrange();
        break;
      case "n":
      case "c":
      case "u":
        this.sort = key === "n" ? (this.sort === "number" ? "recent" : "number") : key === "c" ? "created" : "updated";
        this.arrange();
        break;
      case "g":
        this.grouped = !this.grouped;
        this.arrange();
        break;
      case "m":
        this.mergedOpen = !this.mergedOpen;
        this.arrange();
        break;
      case "r":
        this.details.clear();
        this.errors.clear();
        this.arrange();
        this.fetch();
        break;
      case "enter":
        return this.activate();
      case "q":
        this.open = this.focused = false;
        break;
    }
    return null;
  }
  mouse(button: number, x: number, y: number, release: boolean): Action | null {
    if (!this.rect.contains(x, y)) {
      if (release) this.pressed = null;
      return null;
    }
    if (!release && (button === 64 || button === 65)) {
      this.move(button === 64 ? -1 : 1);
      return null;
    }
    if (button !== 0) return null;
    if (!release) this.focused = true;
    const row = y - this.rect.y;
    const control = row === 1 ? "s" : row === 2 ? "g" : null;
    const index = row >= 4 && row < this.rect.h - 1 ? this.rows()[this.top + row - 4]?.index : null;
    const target = control ?? (index === -1 ? "merged" : index != null ? this.items[index]?.url : null);
    if (!release) {
      this.pressed = target ?? null;
      if (index != null) this.selected = index;
      return null;
    }
    const pressed = this.pressed;
    this.pressed = null;
    if (!target || target !== pressed) return null;
    if (control) return this.key(control);
    return this.activate();
  }
  draw(w: Writer, rect: Rect, now = Date.now()) {
    this.rect = rect;
    const normal = new palette.Style({ fg: "text", bg: "bg" }).sgr();
    const line = (row: number, text: string, color: palette.Token = "text", selected = false) => {
      if (row < 0 || row >= rect.h) return;
      w.write(
        w.cup(rect.y + row + 1, rect.x + 1) + new palette.Style({ fg: color, bg: selected ? "selected" : "bg" }).sgr(),
      );
      w.splat(" ", rect.w);
      w.write(w.cup(rect.y + row + 1, rect.x + 2) + ellipsis(clean(text), Math.max(0, rect.w - 2)));
    };
    for (let row = 0; row < rect.h; row++) line(row, "");
    line(0, "Conversation PRs", this.focused ? "strong" : "text");
    line(1, `s Sort: ${sortLabels[this.sort]}`, "accent");
    line(2, `g ${this.grouped ? "Grouped by repo" : "Ungrouped"}`, "accent");
    const rows = this.rows(now, rect.w - 2),
      count = Math.max(0, rect.h - 5);
    const start = rows.findIndex(row => row.index === this.selected),
      end = rows.findLastIndex(row => row.index === this.selected);
    if (start >= 0) {
      this.top = Math.min(this.top, start);
      if (end >= this.top + count) this.top = Math.min(start, end - count + 1);
    }
    this.top = Math.max(0, Math.min(this.top, Math.max(0, rows.length - count)));
    if (!rows.length && count) line(4, "No PR links mentioned yet", "muted");
    rows
      .slice(this.top, this.top + count)
      .forEach((row, i) => line(4 + i, row.text, row.color, row.index !== null && row.index === this.selected));
    line(rect.h - 1, "↵ open · m merged · r refresh · q close", "muted");
    w.write(normal);
  }
}
