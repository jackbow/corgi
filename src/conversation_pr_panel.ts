//! A conversation's PR list stays beside the independent PR detail viewer.
import type { Action } from "./action";
import { sorted, type Mention, type Sort } from "./conversation_prs";
import * as pr from "./pull_request";
import { Rect } from "./layout";
import { Writer, ellipsis } from "./text";
import * as palette from "./palette";

export interface Details {
  title: string;
  createdAt: string;
  updatedAt: string;
}
export type Load = (ref: pr.Ref) => Promise<Details>;
export const load: Load = async ref => {
  const raw: unknown = JSON.parse(await pr.run(["pr", "view", ref.url, "--json", "title,createdAt,updatedAt"]));
  if (!raw || typeof raw !== "object") throw Error("Invalid GitHub PR metadata");
  const value = raw as Record<string, unknown>;
  if (![value.title, value.createdAt, value.updatedAt].every(v => typeof v === "string"))
    throw Error("Invalid GitHub PR metadata");
  return value as unknown as Details;
};
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const date = (text?: string) => (text ? text.replace("T", " ").slice(0, 16) + "Z" : "—");
export class Panel {
  open = false;
  focused = false;
  sort: Sort = "recent";
  items: Mention[] = [];
  selected = 0;
  top = 0;
  changed: () => void = () => {};
  private owner = "";
  private rect = new Rect(0, 0, 0, 0);
  private details = new Map<string, Details>();
  private errors = new Set<string>();
  private pending = new Set<string>();
  private pressed: string | null = null;
  constructor(private readDetails: Load = load) {}
  follow(owner: string, mentions: Mention[]) {
    const same = owner === this.owner;
    if (!same) {
      this.owner = owner;
      this.selected = this.top = 0;
    }
    const selected = same ? this.items[this.selected]?.url : undefined;
    this.items = sorted(mentions, this.sort);
    this.selected = Math.max(
      0,
      this.items.findIndex(item => item.url === selected),
    );
    if (this.open) this.fetch();
  }
  private fetch() {
    for (const ref of this.items) {
      if (this.pending.size >= 4) break;
      if (this.details.has(ref.url) || this.errors.has(ref.url) || this.pending.has(ref.url)) continue;
      this.pending.add(ref.url);
      void this.readDetails(ref)
        .then(
          details => this.details.set(ref.url, details),
          () => this.errors.add(ref.url),
        )
        .finally(() => {
          this.pending.delete(ref.url);
          this.changed();
          if (this.open) this.fetch();
        });
    }
  }
  key(key: string): Action | null {
    switch (key) {
      case "escape":
        this.focused = false;
        break;
      case "up":
      case "k":
        this.selected = Math.max(0, this.selected - 1);
        break;
      case "down":
      case "j":
        this.selected = Math.min(this.items.length - 1, this.selected + 1);
        break;
      case "n":
        this.sort = this.sort === "recent" ? "number" : "recent";
        this.follow(this.owner, this.items);
        break;
      case "r":
        this.details.clear();
        this.errors.clear();
        this.fetch();
        break;
      case "enter": {
        const ref = this.items[this.selected];
        return ref ? { name: "pull-request", value: ref.url } : null;
      }
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
      this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + (button === 64 ? -1 : 1)));
      return null;
    }
    if (button !== 0) return null;
    if (!release) this.focused = true;
    const row = y - this.rect.y;
    if (row === 1) {
      if (release) this.key("n");
      return null;
    }
    const index = this.top + Math.floor((row - 3) / 5),
      ref = row >= 3 ? this.items[index] : undefined;
    if (!release) {
      this.pressed = ref?.url ?? null;
      if (ref) this.selected = index;
      return null;
    }
    const pressed = this.pressed;
    this.pressed = null;
    return ref && ref.url === pressed ? { name: "pull-request", value: ref.url } : null;
  }
  draw(w: Writer, rect: Rect) {
    this.rect = rect;
    const normal = new palette.Style({ fg: "text", bg: "bg" }).sgr();
    const line = (row: number, text: string, color: palette.Token = "text", selected = false) => {
      if (row >= rect.h) return;
      w.write(
        w.cup(rect.y + row + 1, rect.x + 1) + new palette.Style({ fg: color, bg: selected ? "selected" : "bg" }).sgr(),
      );
      w.splat(" ", rect.w);
      w.write(w.cup(rect.y + row + 1, rect.x + 2) + ellipsis(clean(text), Math.max(0, rect.w - 2)));
    };
    for (let row = 0; row < rect.h; row++) line(row, "");
    line(0, "Conversation PRs", this.focused ? "strong" : "text");
    line(1, this.sort === "recent" ? "n Sort: latest mention" : "n Sort: PR number", "accent");
    if (!this.items.length) line(3, "No PR links mentioned yet", "muted");
    const count = Math.max(1, Math.floor((rect.h - 4) / 5));
    this.top = Math.max(0, Math.min(this.top, this.selected));
    if (this.selected >= this.top + count) this.top = this.selected - count + 1;
    this.items.slice(this.top, this.top + count).forEach((ref, i) => {
      const row = 3 + i * 5,
        details = this.details.get(ref.url),
        selected = this.top + i === this.selected;
      line(row, `${selected ? "›" : " "} #${ref.number} ${ref.repo}`, "accent", selected);
      line(
        row + 1,
        details?.title ?? (this.errors.has(ref.url) ? "Unavailable · r to retry" : "Loading…"),
        "text",
        selected,
      );
      line(row + 2, `Created ${date(details?.createdAt)}`, "muted", selected);
      line(row + 3, `Updated ${date(details?.updatedAt)}`, "muted", selected);
    });
    line(rect.h - 1, "↵ open · r refresh · q close", "muted");
    w.write(normal);
  }
}
