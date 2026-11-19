import { expect, test } from "bun:test";
import { Panel, type Details } from "./conversation_pr_panel";
import { parse } from "./pull_request";
import { Rect } from "./layout";
import { Writer } from "./text";
import * as palette from "./palette";
import { Terminal } from "./pane/terminal";
const ref = (n: number, repo = "acme/app") => ({ ...parse(`https://github.com/${repo}/pull/${n}`)!, mentioned: n });
const details: Details = {
  title: "Fix widgets",
  createdAt: "2026-11-01T12:00:00Z",
  updatedAt: "2026-11-18T15:30:00Z",
  state: "OPEN",
};
const now = Date.parse("2026-11-18T16:30:00Z");
function draw(p: Panel, height = 24) {
  const w = new Writer();
  p.draw(w, new Rect(0, 1, 45, height), now);
  return w.buffered();
}
function screen(output: string, width = 45, height = 24) {
  const terminal = new Terminal(width, height + 1);
  try {
    terminal.feed(output);
    return terminal.text();
  } finally {
    terminal.destroy();
  }
}
test("the PR list changes sort, renders compact metadata, and stays open when opening different PRs", async () => {
  const p = new Panel(async () => details);
  p.open = p.focused = true;
  p.follow("one", [ref(12), ref(9)]);
  await Bun.sleep(0);
  expect(p.items.map(p => p.number)).toEqual([12, 9]);
  p.key("n");
  expect(p.items.map(p => p.number)).toEqual([9, 12]);
  p.key("up");
  expect(p.key("enter")).toEqual({ name: "pull-request", value: ref(9).url });
  const out = draw(p);
  expect(out).toContain("Fix widgets");
  expect(out).toContain("Created 17d ago · Updated 1h ago");
  expect(screen(out)).toContain("#9 app");
  expect(out).not.toContain("acme/");
  expect(out).toContain(new palette.Style({ fg: "muted", bg: "selected" }).sgr());
  expect(out).toContain(new palette.Style({ fg: "strong", bg: "selected", bold: true }).sgr() + "› #9");
  p.mouse(0, 5, 10, false);
  expect(p.mouse(0, 5, 10, true)).toEqual({ name: "pull-request", value: ref(12).url });
  expect(p.open).toBe(true);
  p.follow("two", [ref(5)]);
  expect(p.items.map(p => p.number)).toEqual([5]);
  expect(p.selected).toBe(0);
});
test("both relative timestamps fit the default sidebar width on one line", async () => {
  const p = new Panel(async () => details);
  p.open = true;
  p.follow("one", [ref(12)]);
  await Bun.sleep(0);
  const w = new Writer();
  p.draw(w, new Rect(0, 1, 27, 20), now);
  expect(w.buffered()).toContain("C 17d ago · U 1h ago");
});
test("created and updated sorts use newest first and unknown dates last, preserving selection as metadata loads", async () => {
  let finish!: (details: Details) => void;
  const p = new Panel(async r =>
    r.number === 5
      ? await new Promise<Details>(resolve => (finish = resolve))
      : {
          ...details,
          createdAt: r.number === 9 ? "2026-11-17T00:00:00Z" : details.createdAt,
          updatedAt: r.number === 12 ? "2026-11-18T16:00:00Z" : details.updatedAt,
        },
  );
  p.open = true;
  p.follow("one", [ref(12), ref(9), ref(5)]);
  p.key("c");
  await Bun.sleep(0);
  expect(p.items.map(p => p.number)).toEqual([9, 12, 5]);
  expect(p.items[p.selected].number).toBe(12);
  p.key("u");
  expect(p.items.map(p => p.number)).toEqual([12, 9, 5]);
  finish({ ...details, createdAt: "2026-11-18T16:00:00Z", updatedAt: "2026-11-18T16:20:00Z" });
  await Bun.sleep(0);
  expect(p.items.map(p => p.number)).toEqual([5, 12, 9]);
  expect(p.items[p.selected].number).toBe(12);
  p.key("s");
  expect(p.sort).toBe("recent");
});
test("repo grouping defaults on, keeps distinct owners separate, and can be toggled without changing selection", async () => {
  const p = new Panel(async () => details);
  p.open = true;
  p.follow("one", [ref(12, "acme/zebra"), ref(9), ref(8, "other/app"), ref(7)]);
  await Bun.sleep(0);
  expect(p.grouped).toBe(true);
  expect(p.items.map(p => p.number)).toEqual([9, 7, 8, 12]);
  expect(p.items[p.selected].number).toBe(9);
  expect(draw(p)).toContain("Grouped by repo");
  const grouped = screen(draw(p));
  expect(grouped).toContain("╭─ app ");
  expect(grouped).toContain("╰──");
  expect(grouped).toContain("│ Fix widgets");
  p.key("g");
  expect(p.items.map(p => p.number)).toEqual([12, 9, 8, 7]);
  expect(p.items[p.selected].number).toBe(9);
  expect(draw(p)).toContain("Ungrouped");
  expect(screen(draw(p))).not.toContain("╭");
  p.mouse(0, 5, 3, false);
  p.mouse(0, 5, 3, true);
  expect(p.grouped).toBe(true);
});
test("merged PRs collapse at the bottom and expand with mouse or keyboard", async () => {
  const p = new Panel(async r => ({
    ...details,
    state: r.number === 12 ? "MERGED" : r.number === 9 ? "CLOSED" : "OPEN",
  }));
  p.open = true;
  const refs = [ref(12), ref(9), ref(5)];
  p.follow("one", refs);
  await Bun.sleep(0);
  expect(p.items.map(p => p.number)).toEqual([9, 5]);
  let out = draw(p);
  expect(out).toContain("▸ Merged (1)");
  expect(screen(out)).not.toContain("#12");
  p.key("down");
  p.key("down");
  expect(p.key("enter")).toBeNull();
  expect(p.mergedOpen).toBe(true);
  expect(p.items.map(p => p.number)).toEqual([9, 5, 12]);
  out = draw(p);
  expect(screen(out).indexOf("Merged (1)")).toBeGreaterThan(screen(out).indexOf("#5"));
  p.key("down");
  expect(p.key("enter")?.value).toBe(ref(12).url);
  const mergedRow = screen(draw(p))
    .split("\n")
    .findIndex(row => row.includes("Merged (1)"));
  p.mouse(0, 5, mergedRow, false);
  p.mouse(0, 5, mergedRow, true);
  expect(p.mergedOpen).toBe(false);
  p.key("m");
  p.follow("two", [ref(12)]);
  expect(p.mergedOpen).toBe(false);
  draw(p);
  expect(p.key("enter")).toBeNull();
  expect(p.mergedOpen).toBe(true);
});
test("PR viewer updates hide merged PRs without changing mention order", async () => {
  let finish!: (details: Details) => void;
  const p = new Panel(async r =>
    r.number === 12 ? await new Promise<Details>(resolve => (finish = resolve)) : details,
  );
  const refs = [ref(12), ref(9), ref(5)];
  p.open = true;
  p.follow("one", refs);
  await Bun.sleep(0);
  p.update(ref(12), { state: "MERGED" });
  p.update(ref(12), { state: "OPEN" });
  finish(details);
  await Bun.sleep(0);
  expect(p.items.map(p => p.number)).toEqual([9, 5]);
  p.update(ref(5), { state: "OPEN" });
  expect(p.items.map(p => p.number)).toEqual([9, 5]);
  expect(refs.map(p => p.number)).toEqual([12, 9, 5]);
});
test("unavailable metadata preserves links and refresh retries", async () => {
  let calls = 0;
  const p = new Panel(async () => {
    if (++calls === 1) throw Error("offline");
    return details;
  });
  p.open = true;
  p.follow("one", [ref(12)]);
  await Bun.sleep(0);
  expect(draw(p)).toContain("Unavailable");
  expect(p.key("enter")?.value).toBe(ref(12).url);
  p.key("r");
  await Bun.sleep(0);
  expect(calls).toBe(2);
});
test("scrolling grouped and expanded lists keeps keyboard and mouse on the same PR", async () => {
  const p = new Panel(async () => details);
  p.open = true;
  p.follow(
    "one",
    Array.from({ length: 20 }, (_, i) => ref(i + 1, `acme/repo-${i % 2}`)),
  );
  await Bun.sleep(0);
  for (let i = 0; i < 19; i++) p.key("down");
  expect(p.selected).toBe(19);
  draw(p, 12);
  expect(p.top).toBeGreaterThan(0);
  const lastRow = screen(draw(p, 12), 45, 12)
    .split("\n")
    .findIndex(row => row.includes(`#${p.items[19].number} `));
  p.mouse(0, 5, lastRow, false);
  expect(p.mouse(0, 5, lastRow, true)?.value).toBe(p.items[19].url);
  p.follow("one", [ref(1)]);
  draw(p, 12);
  expect(p.top).toBe(0);
});
test("hovering the PR list leaves the detail viewer's keyboard focus alone", () => {
  const p = new Panel(async () => details);
  p.open = true;
  p.follow("one", [ref(12)]);
  draw(p);
  p.mouse(35, 5, 6, false);
  expect(p.focused).toBe(false);
  p.mouse(0, 5, 6, false);
  expect(p.focused).toBe(true);
});
test("full titles wrap inside repo boxes, and every wrapped line opens its PR", async () => {
  const title = "Preserve the complete pull request title while navigating between repositories and reviewing changes";
  for (const grouped of [true, false]) {
    const p = new Panel(async () => ({ ...details, title }));
    p.open = true;
    p.grouped = grouped;
    p.follow("one", [ref(12), ref(9)]);
    await Bun.sleep(0);
    const text = screen(draw(p, 45), 45, 45),
      lines = text.split("\n");
    const start = lines.findIndex(line => line.includes("#12 app"));
    const titleRows = lines.slice(start + 1).slice(
      0,
      lines.slice(start + 1).findIndex(line => /Created |C 17d/.test(line)),
    );
    expect(titleRows.map(line => line.replace(/^\s*│ ?| ?│\s*$/g, "").trim()).join(" ")).toBe(title);
    for (let i = 0; i < titleRows.length; i++) {
      p.mouse(0, 6, start + 1 + i, false);
      expect(p.mouse(0, 6, start + 1 + i, true)?.value).toBe(ref(12).url);
    }
  }
});
test("long Unicode titles keep their tail accessible by scrolling within one PR", async () => {
  const title = "完整标题 ".repeat(18) + "FINAL-TITLE-WORDS";
  const p = new Panel(async () => ({ ...details, title }));
  p.open = true;
  p.follow("one", [ref(12)]);
  await Bun.sleep(0);
  const render = () => {
    const w = new Writer();
    p.draw(w, new Rect(0, 1, 27, 12), now);
    return screen(w.buffered(), 27, 12);
  };
  expect(render()).not.toContain("FINAL-TITLE-WORDS");
  for (let i = 0; i < 10; i++) {
    p.mouse(65, 6, 7, false);
    render();
  }
  expect(render()).toContain("FINAL-TITLE-WORDS");
  expect(p.selected).toBe(0);
  expect(p.top).toBeGreaterThan(0);
  p.key("up");
  expect(render()).toContain("#12 app");
});
