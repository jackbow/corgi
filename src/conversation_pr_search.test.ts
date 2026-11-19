import { expect, test } from "bun:test";
import { Popup, matches, type Entry } from "./conversation_pr_search";
import { Terminal } from "./pane/terminal";
import { Writer } from "./text";
import { Dialog } from "./name_dialog";
const ref = (number: number, repo = "acme/app", mentioned = 1) => ({
  number,
  repo,
  mentioned,
  url: `https://github.com/${repo}/pull/${number}`,
});
const entry = (key: string, number: number, repo = "acme/app"): Entry => ({
  key,
  target: { pane: Number(key) || 1 },
  title: `Agent ${key}`,
  workspace: `Workspace ${key}`,
  refs: [ref(number, repo)],
});
function draw(p: Popup, width = 80, height = 30) {
  const w = new Writer(),
    terminal = new Terminal(width, height);
  const rect = p.draw(w, width, height);
  try {
    terminal.feed(w.buffered());
    return { text: terminal.text(), rect };
  } finally {
    terminal.destroy();
  }
}
test("numbers match incrementally, exact numbers rank first, and full links disambiguate repositories", () => {
  const entries = [entry("1", 1234), entry("2", 123), entry("3", 9123), entry("4", 123, "other/repo")];
  expect(matches(entries, "123").map(e => e.key)).toEqual(["2", "4", "1", "3"]);
  expect(matches(entries, " #123 ").map(e => e.key)).toEqual(["2", "4", "1", "3"]);
  expect(matches(entries, "https://GitHub.com/ACME/APP/pull/123/files?diff=split#discussion").map(e => e.key)).toEqual([
    "2",
  ]);
  for (const query of [
    "",
    "#",
    "app",
    "-123",
    "0",
    "https://evil.test/acme/app/pull/123",
    "https://github.com/acme/app/issues/123",
  ])
    expect(matches(entries, query)).toEqual([]);
  expect(entries[0].refs).toEqual([ref(1234)]);
});
test("a conversation appears once when several PRs match or multiple panes show it", () => {
  const one = { ...entry("1", 123), refs: [ref(1234), ref(123)] },
    second = { ...one, target: { pane: 2 } };
  expect(matches([one, second], "123")).toHaveLength(1);
  expect(matches([one, second], "123")[0].ref.number).toBe(123);
  const headless = { ...entry("3", 123), target: { headless: 7 } };
  expect(matches([one, headless], "123").map(e => e.target)).toEqual([{ pane: 1 }, { headless: 7 }]);
});
test("query changes reset selection, snapshot updates preserve it, and disappearing results stay in bounds", () => {
  const p = new Popup(),
    entries = [entry("1", 12), entry("2", 12)];
  p.query = Dialog.init({ folder: null }, "12");
  p.follow(entries);
  p.move(1);
  expect(p.results[p.selected].key).toBe("2");
  p.follow([...entries].reverse());
  expect(p.results[p.selected].key).toBe("2");
  p.follow([entries[0]]);
  expect(p.selected).toBe(0);
  p.move(-1);
  expect(p.selected).toBe(0);
  p.move(1);
  expect(p.selected).toBe(0);
  p.query = Dialog.init({ folder: null }, "999");
  p.follow(entries);
  expect(p.selected).toBe(0);
  expect(p.results).toEqual([]);
});
test("the popup renders inline workspace and agent titles and supports keyboard and mouse navigation", () => {
  const p = new Popup();
  p.query = Dialog.init({ folder: null }, "12");
  p.follow(Array.from({ length: 15 }, (_, i) => entry(String(i + 1), 12)));
  let view = draw(p);
  expect(view.text).toContain("Find conversation by PR");
  expect(view.text).toContain("Agent 1");
  expect(view.text).toContain("Workspace 1 · #12 app");
  p.sequence("\x1b[B", "down");
  expect(p.selected).toBe(1);
  p.sequence("\x1b[A", "up");
  expect(p.selected).toBe(0);
  for (let i = 0; i < 20; i++) p.key(14);
  view = draw(p);
  expect(p.selected).toBe(14);
  expect(p.top).toBeGreaterThan(0);
  expect(view.text).toContain(p.results[14].title);
  const y = view.rect.y + 4;
  p.mouse(0, view.rect.x + 3, y, false);
  expect(p.mouse(0, view.rect.x + 3, y, true)).toBe("accept");
  expect(p.selected).toBe(p.top);
  expect(p.key(13)).toBe("accept");
  expect(p.key(27)).toBe("cancel");
  expect(p.mouse(0, 0, 0, false)).toBe("cancel");
  p.query = Dialog.init({ folder: null }, "");
  p.follow([]);
  expect(draw(p).text).toContain("Type a PR number");
  p.query = Dialog.init({ folder: null }, "999");
  p.follow([]);
  expect(draw(p).text).toContain("No matching conversations");
});
test("unsafe names are displayed without terminal controls and long links remain editable", () => {
  const p = new Popup(),
    one = { ...entry("1", 12), workspace: "work\x1b[31mspace", title: "Agent\nname" };
  const link = ref(12, "a".repeat(70) + "/" + "b".repeat(70)).url;
  for (const byte of Buffer.from(link)) p.query.pasteByte(byte);
  expect(p.query.raw()).toBe(link);
  p.follow([]);
  expect(draw(p, 40, 14).rect.w).toBe(36);
  p.query = Dialog.init({ folder: null }, "12");
  p.follow([one]);
  const view = draw(p);
  expect(view.text).toContain("Agent name");
  expect(view.text).toContain("work [31mspace");
});
