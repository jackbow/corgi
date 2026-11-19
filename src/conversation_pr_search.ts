//! Find a tracked conversation by a PR mentioned in it, without GitHub requests.
import { Dialog, View as FieldView, writeField } from "./name_dialog";
import { Rect } from "./layout";
import { Writer, displayWidth, ellipsis } from "./text";
import * as palette from "./palette";
import { parse } from "./pull_request_ref";
import type { Mention } from "./conversation_prs";
import type { Target } from "./sidebar";

export interface Entry {
  key: string;
  target: Target;
  workspace: string;
  title: string;
  refs: Mention[];
}
export interface Match extends Entry {
  ref: Mention;
  rank: number;
}
export function matches(entries: Entry[], input: string): Match[] {
  const query = input.trim(),
    link = parse(query),
    number = query.replace(/^#/, "");
  if (!link && !/^[1-9]\d*$/.test(number)) return [];
  const found = new Map<string, Match>();
  for (const entry of entries) {
    const refs = entry.refs.filter(ref =>
      link ? ref.url.toLowerCase() === link.url.toLowerCase() : String(ref.number).includes(number),
    );
    const rank = (ref: Mention) =>
      link || String(ref.number) === number ? 0 : String(ref.number).startsWith(number) ? 1 : 2;
    refs.sort((a, b) => rank(a) - rank(b) || b.mentioned - a.mentioned || a.url.localeCompare(b.url));
    const ref = refs[0];
    if (ref && !found.has(entry.key)) found.set(entry.key, { ...entry, ref, rank: rank(ref) });
  }
  return [...found.values()].sort(
    (a, b) =>
      a.rank - b.rank ||
      b.ref.mentioned - a.ref.mentioned ||
      a.workspace.localeCompare(b.workspace) ||
      a.title.localeCompare(b.title) ||
      a.key.localeCompare(b.key),
  );
}
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
export class Popup {
  query = Dialog.init({ folder: null }, "");
  results: Match[] = [];
  selected = 0;
  top = 0;
  private input = "";
  private rect = new Rect(0, 0, 0, 0);
  private pressed: string | null = null;
  follow(entries: Entry[]) {
    const selected = this.results[this.selected]?.key,
      query = this.query.raw();
    this.results = matches(entries, query);
    this.selected =
      query === this.input
        ? Math.max(
            0,
            this.results.findIndex(entry => entry.key === selected),
          )
        : 0;
    if (query !== this.input) this.top = 0;
    this.input = query;
  }
  move(delta: number) {
    this.selected = Math.max(0, Math.min(this.results.length - 1, this.selected + delta));
  }
  key(byte: number): "accept" | "cancel" | null {
    switch (byte) {
      case 27:
        return "cancel";
      case 13:
        return "accept";
      case 9:
      case 14:
        this.move(1);
        break;
      case 16:
        this.move(-1);
        break;
      default:
        this.query.key(byte);
    }
    return null;
  }
  sequence(text: string, key: string | null) {
    if (key === "up" || key === "shift_tab") this.move(-1);
    else if (key === "down") this.move(1);
    else this.query.sequence(text);
  }
  bounds(width: number, height: number) {
    const w = Math.max(0, Math.min(88, width - 4)),
      h = Math.max(0, Math.min(25, height - 4));
    return new Rect(Math.floor((width - w) / 2), Math.floor((height - h) / 3), w, h);
  }
  mouse(button: number, x: number, y: number, release: boolean): "accept" | "cancel" | null {
    if (!this.rect.contains(x, y)) {
      this.pressed = null;
      return !release && button === 0 ? "cancel" : null;
    }
    if (!release && (button === 64 || button === 65)) {
      this.move(button === 64 ? -1 : 1);
      return null;
    }
    if (button !== 0) return null;
    if (y === this.rect.y + 2) {
      if (!release)
        this.query.position(FieldView.scroll(this.query, this.rect.w - 4) + Math.max(0, x - this.rect.x - 2));
      return null;
    }
    const row = y - this.rect.y - 4,
      capacity = Math.max(0, Math.floor((this.rect.h - 7) / 2));
    const index = row >= 0 && row < capacity * 2 ? this.top + Math.floor(row / 2) : -1;
    const entry = this.results[index];
    if (!release) {
      this.pressed = entry?.key ?? null;
      if (entry) this.selected = index;
      return null;
    }
    const pressed = this.pressed;
    this.pressed = null;
    return entry && entry.key === pressed ? "accept" : null;
  }
  draw(w: Writer, width: number, height: number): Rect {
    const b = (this.rect = this.bounds(width, height));
    if (b.w < 8 || b.h < 8) return b;
    const ink = (fg: palette.Token, selected = false, bold = false) =>
      new palette.Style({ fg, bg: selected ? "selected" : "surface", bold }).sgr();
    const line = (row: number, text: string, color: palette.Token = "text", selected = false, bold = false) => {
      w.write(w.cup(b.y + row + 1, b.x + 1) + ink("line") + "│" + ink(color, selected, bold));
      const value = ellipsis(clean(text), b.w - 4);
      w.write(" " + value + " ".repeat(Math.max(0, b.w - 3 - displayWidth(value))) + ink("line") + "│");
    };
    for (let row = 1; row < b.h - 1; row++) line(row, "");
    const label = ellipsis(" Find conversation by PR ", b.w - 4);
    w.write(
      w.cup(b.y + 1, b.x + 1) +
        ink("line") +
        "╭─" +
        ink("strong", false, true) +
        label +
        ink("line") +
        "─".repeat(Math.max(0, b.w - 3 - displayWidth(label))) +
        "╮",
    );
    w.write(w.cup(b.y + b.h, b.x + 1) + ink("line") + "╰" + "─".repeat(b.w - 2) + "╯");
    w.write(w.cup(b.y + 3, b.x + 3));
    writeField(w, this.query, FieldView.scroll(this.query, b.w - 4), b.w - 4, ink("text"), { caret: true });
    const capacity = Math.max(1, Math.floor((b.h - 7) / 2));
    this.top = Math.max(0, Math.min(this.top, this.selected, Math.max(0, this.results.length - capacity)));
    if (this.selected >= this.top + capacity) this.top = this.selected - capacity + 1;
    if (!this.results.length)
      line(
        4,
        this.query.raw().trim() ? "No matching conversations" : "Type a PR number, #123, or GitHub PR link",
        "muted",
      );
    this.results.slice(this.top, this.top + capacity).forEach((entry, i) => {
      const selected = this.top + i === this.selected;
      line(4 + i * 2, `${selected ? "›" : " "} ${entry.title}`, "strong", selected, true);
      line(
        5 + i * 2,
        `  ${entry.workspace} · #${entry.ref.number} ${entry.ref.repo.split("/").pop()}`,
        "muted",
        selected,
      );
    });
    line(b.h - 2, "↑/↓ choose · ↵ open · esc close", "muted");
    w.write("\x1b[0m\x1b[?25l");
    return b;
  }
}
