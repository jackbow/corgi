import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "../pane/terminal";
import { Writer } from "../text";
import * as panel from "./panel";
import { runGit } from "../fixtures/git";
import { text } from "../fixtures/screen";
import { local } from "../fixtures/review";
import * as errors from "../errors";
import * as i18n from "../i18n";
import * as remote from "./remote";
import * as palette from "../palette";
import * as codePalette from "../code_palette";
import * as syntax from "./syntax";
import type { Request as SyntaxRequest, Response as SyntaxResponse } from "./syntax_types";

let root = "";
const run = (...args: string[]) => runGit(root, ...args);
const write = (path: string, text: string) => writeFileSync(join(root, path), text);
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n") + "\n";

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-review-panel-")));
  run("init", "-q", "-b", "main");
  write(
    "app.ts",
    lines(40, i => `export const v${i} = ${i};`),
  );
  write("notes.md", "# Notes\n");
  run("add", ".");
  run("commit", "-q", "-m", "base");
  run("checkout", "-q", "-b", "topic");
  write("notes.md", "# Notes\n\nMore.\n");
  run("commit", "-qam", "docs: more notes");
  write(
    "app.ts",
    lines(40, i =>
      i === 5 ? "export const v5 = 50;" : i === 30 ? "export const v30 = 300;" : `export const v${i} = ${i};`,
    ),
  );
  write("bun.lock", "{}\n{}\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The panel as a terminal shows it, row by row. */
function screen(p: panel.Panel, width = 70, height = 34): string[] {
  const w = new Writer();
  p.draw(w, 0, 0, width, height, true);
  return text(w.buffered(), width, height).split("\n");
}
const settle = async (p: panel.Panel) => {
  // A refresh already in flight queues another; wait for that one too.
  await p.refresh();
  await p.refresh();
};

test("remote PR snapshots use the diff viewer without following or rereading the local checkout", async () => {
  const p = new panel.Panel(local());
  const url = "https://github.com/acme/app/pull/12";
  p.showRemote(
    url,
    "acme/app #12",
    "b".repeat(40),
    "a".repeat(40),
    remote.files(
      "diff --git a/widget.ts b/widget.ts\n--- a/widget.ts\n+++ b/widget.ts\n@@ -1 +1 @@\n-old widget\n+new widget\n",
    ),
    null,
  );
  try {
    p.follow({ pane: 1, cwd: root, name: "local" });
    p.keep(new Set([1]));
    await p.refresh();
    const text = screen(p).join("\n");
    expect(text).toContain("widget.ts");
    expect(text).toContain("old widget");
    expect(text).toContain("new widget");
    expect(p.remote).toBe(url);
    p.hide();
    expect(p.remote).toBeNull();
    p.follow({ pane: 1, cwd: root, name: "local" });
    expect(p.pane).toBe(1);
  } finally {
    p.hide();
  }
});
const key = (p: panel.Panel, k: string | panel.Named) =>
  p.key(k.length === 1 ? { text: k } : { named: k as panel.Named });

function remotePanel(paths: string[]) {
  const p = new panel.Panel(local());
  p.showRemote(
    "https://github.com/acme/app/pull/12",
    "PR",
    "b".repeat(40),
    "a".repeat(40),
    remote.files(paths.map(path => `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new\n`).join("")),
    null,
  );
  return p;
}

test("the fullscreen tree divider drags horizontally and keeps room for the diff", () => {
  const p = remotePanel(["app.ts", "other.ts"]);
  p.toggleFullscreen();
  try {
    let rows = screen(p, 120, 30);
    const y = rows.findIndex(row => row.includes(" old")),
      x = rows[y].indexOf("│", 1),
      before = rows[y].indexOf("old");
    p.mouse("press", x, y);
    expect(p.resizing).toBe("horizontal");
    p.mouse("drag", x + 10, y);
    p.mouse("release", x + 10, y);
    expect(p.resizing).toBeNull();
    rows = screen(p, 120, 30);
    expect(rows[y].indexOf("old")).toBe(before + 10);
    const kept = p.review(-3).tree_width;
    p.toggleFullscreen();
    p.toggleFullscreen();
    expect(p.review(-3).tree_width).toBe(kept);
    const divider = rows[y].indexOf("│", 1);
    p.mouse("press", divider, y);
    p.mouse("drag", 999, y);
    p.mouse("release", 999, y);
    expect(p.review(-3).tree_width).toBeLessThanOrEqual(78);
    expect(screen(p, 120, 30).join("\n")).toContain("old");
  } finally {
    p.hide();
  }
});

test("the tree button collapses and expands every directory", () => {
  const p = remotePanel(["src/a.ts", "src/nested/b.ts", "docs/a.md"]);
  try {
    const click = (label: string) => {
      const rows = screen(p, 100, 35),
        y = rows.findIndex(row => row.includes(label));
      expect(y).toBeGreaterThanOrEqual(0);
      p.mouse("press", rows[y].indexOf(label), y);
      p.mouse("release", rows[y].indexOf(label), y);
    };
    click("Collapse all");
    let rows = screen(p, 100, 35);
    expect(rows.slice(0, p.splitRow!).join("\n")).not.toContain("a.ts");
    click("Expand all");
    rows = screen(p, 100, 35);
    expect(rows.slice(0, p.splitRow!).join("\n")).toContain("a.ts");
    expect(rows.slice(0, p.splitRow!).join("\n")).toContain("b.ts");
  } finally {
    p.hide();
  }
});

test("PR diffs expose refresh and stale state without interpreting typed r as a shortcut", () => {
  const p = remotePanel(["app.ts"]);
  try {
    p.remote_stale = true;
    const rows = screen(p, 120, 30),
      y = rows.findIndex(row => row.includes("Refresh · r"));
    expect(rows[y]).toContain("stale");
    p.mouse("press", rows[y].indexOf("Refresh"), y);
    expect(p.takeEffect()).toEqual({ kind: "refresh" });
    expect(key(p, "r")).toEqual({ kind: "refresh" });
    key(p, "/");
    expect(key(p, "r")).toEqual({ kind: "none" });
    expect(p.typingArea()?.text).toBe("r");
  } finally {
    p.hide();
  }
});

test("files toggle is clickable and z hides the tree in fullscreen and pane mode", () => {
  const p = remotePanel(["app.ts", "other.ts"]);
  try {
    const r = p.review(-3);
    key(p, "down");
    for (const fullscreen of [true, false]) {
      if (p.fullscreen !== fullscreen) p.toggleFullscreen();
      let rows = screen(p, 100, 25);
      const y = rows.findIndex(row => row.includes("z files")),
        x = rows[y].indexOf("z files");
      p.mouse("press", x, y);
      expect(r.tree_hidden).toBe(true);
      expect(r.part).toBe("diff");
      rows = screen(p, 100, 25);
      expect(rows.join("\n")).not.toContain("other.ts");
      expect(p.splitRow).toBeNull();
      key(p, "z");
      expect(screen(p, 100, 25).join("\n")).toContain("other.ts");
      expect(r.tree_hidden).toBe(false);
    }
  } finally {
    p.hide();
  }
});

test("tree search filters paths, accepts pasted text, navigates results and opens a file", () => {
  const p = remotePanel(["app.ts", "src/Widget.ts", "src/WidgetView.ts", "docs/widget.md"]);
  try {
    const r = p.review(-3);
    key(p, "/");
    expect(p.typing).toBe(true);
    for (const byte of Buffer.from("SRC/WIDGET")) p.pasteByte(byte);
    let rows = screen(p, 100, 28);
    expect(rows.join("\n")).toContain("Widget.ts");
    expect(rows.join("\n")).toContain("WidgetView.ts");
    expect(rows.slice(0, p.splitRow!).join("\n")).not.toContain("widget.md");
    expect(r.tree_sel).toBe("f:src/Widget.ts");
    key(p, "down");
    expect(r.tree_sel).toBe("f:src/WidgetView.ts");
    key(p, "up");
    key(p, "enter");
    expect(r.path).toBe("src/Widget.ts");
    expect(r.part).toBe("diff");
    expect(p.typing).toBe(false);
    key(p, "/");
    expect(r.find).not.toBeNull();
    expect(r.tree_find?.editing).toBe(false);
    key(p, "escape");
    key(p, "tab");
    key(p, "escape");
    expect(r.tree_find).toBeNull();
    rows = screen(p, 100, 28);
    expect(rows.join("\n")).toContain("widget.md");
  } finally {
    p.hide();
  }
});

test("an empty tree search cannot open a file and Escape restores the tree", () => {
  const p = remotePanel(["app.ts"]);
  try {
    key(p, "/");
    for (const ch of "missing") key(p, ch);
    expect(screen(p).join("\n")).toContain("no match");
    const before = p.review(-3).path;
    key(p, "down");
    key(p, "enter");
    expect(p.review(-3).path).toBe(before);
    expect(p.typing).toBe(true);
    key(p, "escape");
    expect(p.typing).toBe(false);
    expect(screen(p).join("\n")).toContain("All files");
  } finally {
    p.hide();
  }
});

test("the full-file minimap marks both change types and clicks jump in unified and split views", () => {
  const p = new panel.Panel(local()),
    patch =
      "diff --git a/long.ts b/long.ts\n@@ -1,180 +1,180 @@\n" +
      Array.from({ length: 180 }, (_, i) =>
        i === 10 || i === 150 ? `-old${i}\n+new${i}` : ` line${i}${i === 80 ? " long".repeat(60) : ""}`,
      ).join("\n") +
      "\n";
  p.showRemote("https://github.com/acme/app/pull/12", "PR", "b".repeat(40), "a".repeat(40), remote.files(patch), null);
  try {
    const r = p.review(-3);
    key(p, "tab");
    key(p, "z");
    expect(screen(p, 100, 25).some(row => /[−+]│\s*$/.test(row))).toBe(false);
    key(p, "Z");
    key(p, "home");
    key(p, "c");
    p.key({ text: "a wrapped comment ".repeat(12) });
    key(p, "enter");
    expect(r.notes).toHaveLength(1);
    for (const split of [false, true]) {
      r.split = split;
      let rows = screen(p, 100, 25);
      const marks = rows.map((row, y) => ({ row, y })).filter(({ row }) => /−\+[│▐]\s*$/.test(row));
      expect(marks.length).toBeGreaterThan(0);
      expect(rows.some(row => /▐\s*$/.test(row))).toBe(true);
      const w = new Writer();
      p.draw(w, 0, 0, 100, 25, true);
      const raw = w.buffered();
      expect(raw).toContain(palette.fgRgb(palette.colors.hot) + palette.bgRgb(palette.colors.surface) + "−");
      expect(raw).toContain(palette.fgRgb(palette.colors.accent) + palette.bgRgb(palette.colors.surface) + "+");
      const last = marks.at(-1)!;
      p.mouse("press", last.row.indexOf("−+"), last.y);
      rows = screen(p, 100, 25);
      expect(r.top).toBeGreaterThan(100);
      expect(rows.join("\n")).toContain("new150");
      expect(r.anchor).toBeNull();
      const first = marks[0];
      p.mouse("press", first.row.indexOf("−+"), first.y);
      expect(screen(p, 100, 25).join("\n")).toContain("new10");
      expect(r.top).toBeLessThan(25);
      rows = screen(p, 100, 25);
      const viewport = rows.map((row, y) => ({ row, y })).filter(({ row }) => /▐\s*$/.test(row)),
        grab = viewport[Math.floor(viewport.length / 2)],
        x = grab.row.lastIndexOf("▐"),
        before = r.top;
      p.mouse("press", x, grab.y);
      expect(r.top).toBe(before);
      p.mouse("drag", x - 20, grab.y + 2);
      expect(r.top).toBeGreaterThan(before);
      const moved = r.top;
      screen(p, 100, 25);
      p.mouse("drag", x, grab.y + 3);
      expect(r.top).toBeGreaterThan(moved);
      expect(r.anchor).toBeNull();
      p.mouse("drag", x, -100);
      expect(r.top).toBe(0);
      p.mouse("drag", x, 999);
      expect(r.top).toBeGreaterThan(150);
      const bottom = r.top;
      p.mouse("release", x, 999);
      p.mouse("drag", x, 0);
      expect(r.top).toBe(bottom);
    }
    key(p, "z");
    p.toggleFullscreen();
    const full = screen(p, 120, 25),
      last = full
        .map((row, y) => ({ row, y }))
        .filter(({ row }) => /−\+[│▐]\s*$/.test(row))
        .at(-1)!;
    p.mouse("press", last.row.indexOf("−+"), last.y);
    expect(screen(p, 120, 25).join("\n")).toContain("new150");
    key(p, "Z");
    expect(screen(p, 100, 25).some(row => /−\+[│▐]\s*$/.test(row))).toBe(false);
  } finally {
    p.hide();
  }
});

function folderCheckout(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "corgi-review-folder-")));
  const git = (...args: string[]) => runGit(dir, ...args);
  mkdirSync(join(dir, "src/nested"), { recursive: true });
  mkdirSync(join(dir, "src-other"));
  for (const file of ["src/inside.ts", "src/nested/child.ts", "src-other/outside.ts", "app.ts"])
    writeFileSync(join(dir, file), "before\n");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "base");
  for (const file of ["src/inside.ts", "src/nested/child.ts", "src-other/outside.ts", "app.ts"])
    writeFileSync(join(dir, file), "after\n");
  return dir;
}

test("Z loads pinned PR file context once, shows the whole file, and folds back to hunks", async () => {
  const p = new panel.Panel(local()),
    url = "https://github.com/acme/app/pull/12",
    content =
      Array.from({ length: 40 }, (_, i) => (i === 11 ? "new widget" : `outside context ${i + 1}`)).join("\n") + "\n",
    files = remote.files(
      "diff --git a/widget.ts b/widget.ts\n--- a/widget.ts\n+++ b/widget.ts\n@@ -12 +12 @@\n-old widget\n+new widget\n",
    );
  let reads = 0;
  p.showRemote(url, "PR", "b".repeat(40), "a".repeat(40), files, null, async file => {
    reads++;
    return remote.context(file, content);
  });
  try {
    expect(screen(p, 90, 80).join("\n")).not.toContain("outside context 1");
    p.key({ text: "Z" });
    await settle(p);
    expect(p.review(-3).full_context).toBe(true);
    expect(screen(p, 90, 80).join("\n")).toContain("outside context 1");
    expect(screen(p, 90, 80).join("\n")).toContain("outside context 40");
    p.key({ text: "Z" });
    expect(p.review(-3).full_context).toBe(false);
    expect(screen(p, 90, 80).join("\n")).not.toContain("outside context 40");
    expect(screen(p, 90, 80).join("\n")).toContain("new widget");
    p.key({ text: "Z" });
    await settle(p);
    expect(reads).toBe(1);
  } finally {
    p.hide();
  }
});

test("PR context failures retain readable hunks and Z can retry the load", async () => {
  const p = new panel.Panel(local()),
    files = remote.files("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n");
  let reads = 0;
  p.showRemote("https://github.com/acme/app/pull/12", "PR", "b".repeat(40), "a".repeat(40), files, null, async file => {
    if (++reads === 1) throw Error("offline");
    return remote.context(file, "new\n");
  });
  try {
    p.key({ text: "Z" });
    await settle(p);
    expect(p.review(-3).full_context).toBe(false);
    expect(screen(p).join("\n")).toContain("offline");
    expect(screen(p).join("\n")).toContain("new");
    p.key({ text: "Z" });
    await settle(p);
    expect(p.review(-3).full_context).toBe(true);
    expect(reads).toBe(2);
  } finally {
    p.hide();
  }
});

test("restored whole-file PR views load context for all visible files", async () => {
  const p = new panel.Panel(local()),
    files = remote.files(
      ["a.ts", "b.ts"].map(path => `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new\n`).join(""),
    ),
    seen: string[] = [];
  p.showRemote("https://github.com/acme/app/pull/12", "PR", "b".repeat(40), "a".repeat(40), files, null, async file => {
    seen.push(file.change.path);
    return remote.context(file, "new\n");
  });
  try {
    p.restoreView({ ...p.saved()!, full_context: true, all: true });
    await settle(p);
    expect(seen.sort()).toEqual(["a.ts", "b.ts"]);
    expect(p.review(-3).full_context).toBe(true);
  } finally {
    p.hide();
  }
});

test("PR note editors and search accept shortcut letters and notes send to the conversation pane", () => {
  const p = new panel.Panel(local()),
    files = remote.files("diff --git a/app.ts b/app.ts\n@@ -1 +1 @@\n-old\n+new\n"),
    destination = { pane: 42, cwd: "/repo", name: "Agent chat" },
    body = "Please review r g G u P";
  try {
    for (const comment of ["c", "C"]) {
      p.showRemote("https://github.com/acme/app/pull/12", "PR", "b".repeat(40), "a".repeat(40), files, destination);
      p.key({ text: comment });
      for (const text of body) p.key({ text });
      expect(p.typingArea()?.text).toBe(body);
      p.key({ named: "enter" });
      let effect: panel.Effect;
      if (comment === "C") {
        const rows = screen(p, 110, 40),
          y = rows.findIndex(row => row.includes("send 1 to Agent chat"));
        expect(y).toBeGreaterThanOrEqual(0);
        const x = rows[y].indexOf("send 1 to Agent chat") + 1;
        p.mouse("press", x, y);
        p.mouse("release", x, y);
        effect = p.takeEffect();
      } else effect = p.key({ text: "s" });
      expect(effect).toMatchObject({ kind: "send", pane: 42, from: -3, notes: [{ text: body, path: "app.ts" }] });
      if (effect.kind === "send") expect(effect.text).toContain(body);
      expect(p.noteCount(-3)).toBe(0);
    }
    p.key({ text: "/" });
    for (const text of "r g G u P") p.key({ text });
    expect(p.typingArea()?.text).toBe("r g G u P");
    p.key({ named: "escape" });
    p.key({ text: "r" });
    expect(p.typing).toBe(false);
  } finally {
    p.hide();
  }
});

test("PR notes are retained without a conversation destination and can still be copied", () => {
  const p = new panel.Panel(local());
  p.showRemote(
    "https://github.com/acme/app/pull/12",
    "PR",
    "b".repeat(40),
    "a".repeat(40),
    remote.files("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"),
    null,
  );
  try {
    p.key({ text: "C" });
    for (const text of "review") p.key({ text });
    p.key({ named: "enter" });
    expect(p.key({ text: "s" })).toEqual({ kind: "none" });
    expect(p.noteCount(-3)).toBe(1);
    expect(screen(p).join("\n")).toContain("notes are kept");
    expect(p.key({ text: "y" })).toMatchObject({ kind: "copy", text: "a.ts (file)\nreview" });
  } finally {
    p.hide();
  }
});

test("a chosen folder filters changed files and survives closing and reopening", async () => {
  const dir = folderCheckout(),
    p = new panel.Panel(local());
  try {
    p.follow({ pane: 100, conversation: 1000, cwd: dir, name: "Agent" });
    p.show();
    await settle(p);
    expect(await p.setFolder("src")).toBe(true);
    await settle(p);
    let body = screen(p, 90, 50).join("\n");
    expect(body).toContain("inside.ts");
    expect(body).toContain("child.ts");
    expect(body).not.toContain("outside.ts");
    expect(body).not.toContain("app.ts");
    key(p, "u");
    await settle(p);
    expect(screen(p, 90, 50).join("\n")).not.toContain("outside.ts");
    p.hide();
    p.follow({ pane: 100, conversation: 1000, cwd: dir, name: "Agent" });
    p.show();
    await settle(p);
    expect(p.review(100).folder).toBe(join(dir, "src"));
    expect(screen(p, 90, 50).join("\n")).not.toContain("outside.ts");
    key(p, "r");
    expect(screen(p).join("\n")).toContain("Repo / folder");
    expect(p.typingArea()?.text).toBe(join(dir, "src") + "/");
    expect(p.typingArea()?.selection()).toBeNull();
    key(p, "escape");
    expect(p.typing).toBe(false);
    expect(await p.setFolder("")).toBe(true);
    await settle(p);
    expect(screen(p, 90, 50).join("\n")).toContain("outside.ts");
  } finally {
    p.hide();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("folder selection validates paths without replacing the current view", async () => {
  const dir = folderCheckout(),
    p = new panel.Panel(local());
  try {
    p.follow({ pane: 101, cwd: dir, name: "Agent" });
    p.show();
    await settle(p);
    symlinkSync(join(dir, "src"), join(dir, "source link"));
    expect(await p.setFolder("source link")).toBe(true);
    expect(p.review(101).folder).toBe(join(dir, "src"));
    for (const path of [join(dir, "missing"), join(dir, "app.ts"), tmpdir()]) {
      expect(await p.setFolder(path)).toBe(false);
      expect(p.review(101).folder).toBe(join(dir, "src"));
      expect(p.review(101).folder_error).toBeTruthy();
    }
  } finally {
    p.hide();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the folder selector fuzzy completes with arrows and Tab without selecting its text", async () => {
  const dir = folderCheckout(),
    p = new panel.Panel(local());
  try {
    p.follow({ pane: 113, conversation: 1013, cwd: dir, name: "Agent" });
    p.show();
    await settle(p);
    key(p, "r");
    const input = p.review(113).folder_input!;
    expect(input.selection()).toBeNull();
    expect(input.caret).toBe(input.text.length);
    key(p, "s");
    key(p, "c");
    await input.refresh();
    expect(input.matches).toEqual([join(dir, "src") + "/", join(dir, "src-other") + "/"]);
    key(p, "down");
    key(p, "down");
    expect(input.chosen()).toBe(join(dir, "src-other") + "/");
    expect(input.text).toBe(dir + "/sc");
    key(p, "up");
    key(p, "tab");
    await input.refresh();
    expect(input.text).toBe(join(dir, "src") + "/");
    expect(screen(p, 40).join("\n")).toContain("nested/");
    key(p, "left");
    key(p, "right");
    expect(input.text).toBe(join(dir, "src") + "/");
    key(p, "right");
    await input.refresh();
    expect(input.text).toBe(join(dir, "src/nested") + "/");
    expect(input.selection()).toBeNull();
    key(p, "escape");
    expect(p.review(113).folder).toBeNull();
    key(p, "r");
    for (const byte of Buffer.from("src/n")) p.pasteByte(byte);
    await p.review(113).folder_input!.refresh();
    key(p, "down");
    key(p, "enter");
    await settle(p);
    expect(p.review(113).folder).toBe(join(dir, "src/nested"));
    expect(p.typing).toBe(false);
  } finally {
    p.hide();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("folder suggestions can be clicked and Enter opens the typed folder without selecting a child", async () => {
  const dir = folderCheckout(),
    p = new panel.Panel(local());
  try {
    p.follow({ pane: 114, cwd: dir, name: "Agent" });
    p.show();
    await settle(p);
    key(p, "r");
    const input = p.review(114).folder_input!;
    await input.refresh();
    let rows = screen(p, 40);
    const row = rows.findIndex(line => line.includes("src/"));
    expect(row).toBeGreaterThan(0);
    p.mouse("press", 5, row);
    p.mouse("release", 5, row);
    await input.refresh();
    expect(input.text).toBe(join(dir, "src") + "/");
    expect(input.matches).toEqual([join(dir, "src/nested") + "/"]);
    rows = screen(p, 40);
    const y = rows.findIndex(line => line.includes("Repo / folder")) + 2;
    p.mouse("press", 5, y);
    p.mouse("release", 5, y);
    expect(input.caret).toBeLessThan(input.text.length);
    key(p, "enter");
    await settle(p);
    expect(p.review(114).folder).toBe(join(dir, "src"));
  } finally {
    p.hide();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test filtering matches only test filenames and test folders and stays with the conversation", async () => {
  const dir = folderCheckout(),
    p = new panel.Panel(local()),
    hidden = [
      "unit.test.ts",
      "src/check.test.py",
      "test/unit.rb",
      "tests/integration.ts",
      "src/nested/tests/helper.ts",
    ],
    kept = [
      "contest/entry.ts",
      "src/test_helper.py",
      "src/check.spec.ts",
      "__tests__/special.ts",
      "src/WidgetTest.java",
    ];
  try {
    for (const file of [...hidden, ...kept]) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), "export const value = 1;\n");
    }
    p.tree_rows = 30;
    p.follow({ pane: 110, conversation: 1010, cwd: dir, name: "Agent" });
    p.show();
    await settle(p);
    const body = () => screen(p, 120, 130).join("\n");
    expect(p.review(110).hide_tests).toBe(true);
    expect(body()).toContain("t show tests");
    key(p, "t");
    await settle(p);
    for (const file of hidden) expect(body()).toContain(file.split("/").pop()!);
    key(p, "t");
    await settle(p);
    expect(body()).toContain("t show tests");
    for (const file of hidden) expect(body()).not.toContain(file.split("/").pop()!);
    for (const file of kept) expect(body()).toContain(file.split("/").pop()!);
    expect(screen(p, 40, 40).join("\n")).toContain("r folder  t show tests");
    key(p, "u");
    await settle(p);
    for (const file of hidden) expect(body()).not.toContain(file.split("/").pop()!);
    expect(await p.setFolder("src")).toBe(true);
    await settle(p);
    expect(body()).toContain("check.spec.ts");
    expect(body()).not.toContain("check.test.py");
    p.hide();
    p.follow({ pane: 111, conversation: 1011, cwd: dir, name: "Other" });
    p.show();
    await settle(p);
    expect(p.review(111).hide_tests).toBe(true);
    expect(body()).not.toContain("unit.test.ts");
    key(p, "t");
    await settle(p);
    expect(body()).toContain("unit.test.ts");
    p.follow({ pane: 110, conversation: 1010, cwd: dir, name: "Agent" });
    p.show();
    expect(p.review(110).hide_tests).toBe(true);
    expect(body()).not.toContain("check.test.py");
    key(p, "t");
    await settle(p);
    expect(body()).toContain("check.test.py");
  } finally {
    p.hide();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filtering a selected test keeps its notes and note navigation reveals it", async () => {
  const dir = folderCheckout(),
    p = new panel.Panel(local());
  try {
    const file = "app.test.ts";
    writeFileSync(join(dir, file), "export const value = 1;\n");
    p.follow({ pane: 112, conversation: 1012, cwd: dir, name: "Agent" });
    p.show();
    await settle(p);
    const r = p.review(112);
    key(p, "t");
    await settle(p);
    r.all = false;
    r.path = file;
    r.tree_sel = "f:" + file;
    await settle(p);
    key(p, "C");
    for (const ch of "Keep this note") key(p, ch);
    key(p, "enter");
    key(p, "t");
    await settle(p);
    expect(r.path).not.toBe(file);
    expect(r.all).toBe(false);
    expect(p.noteCount(112)).toBe(1);
    expect(screen(p).join("\n")).not.toContain(file);
    key(p, "l");
    expect(screen(p).join("\n")).toContain(file);
    key(p, "enter");
    await settle(p);
    expect(r.hide_tests).toBe(false);
    expect(r.path).toBe(file);
    expect(screen(p).join("\n")).toContain("Keep this note");
    expect(await p.setFolder("")).toBe(true);
    expect(await p.setFolder("src/nested")).toBe(true);
    writeFileSync(join(dir, "src/nested/child.ts"), "before\n");
    writeFileSync(join(dir, "src/nested/only.test.ts"), "export const test = 1;\n");
    await settle(p);
    key(p, "t");
    await settle(p);
    expect(r.path).toBeNull();
    const rows = screen(p);
    expect(rows.join("\n")).toContain("No changes match this view");
    const toggle = rows.findIndex(row => row.includes("t show tests"));
    p.mouse("press", rows[toggle].indexOf("t show tests") + 3, toggle);
    await settle(p);
    expect(r.hide_tests).toBe(false);
    expect(screen(p).join("\n")).toContain("only.test.ts");
  } finally {
    p.hide();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each LLM conversation keeps its own visibility, folder and notes, even when resumed in another pane", async () => {
  const dir = folderCheckout(),
    p = new panel.Panel(local());
  try {
    p.follow({ pane: 102, conversation: 1001, cwd: dir, name: "First" });
    p.show();
    await settle(p);
    await p.setFolder("src");
    const first = p.review(102);
    first.top = 12;
    p.follow({ pane: 103, conversation: 1002, cwd: dir, name: "Second" });
    expect(p.open).toBe(false);
    expect(p.review(103)).not.toBe(first);
    expect(p.review(103).folder).toBeNull();
    p.show();
    p.hide();
    p.follow({ pane: 102, conversation: 1001, cwd: dir, name: "First" });
    expect(p.open).toBe(true);
    expect(p.review(102)).toBe(first);
    expect(first.folder).toBe(join(dir, "src"));
    expect(first.top).toBe(12);
    p.follow({ pane: 102, conversation: 1003, cwd: dir, name: "Replacement" });
    expect(p.open).toBe(false);
    expect(p.review(102).folder).toBeNull();
    p.keep(new Set([103]));
    p.follow({ pane: 104, conversation: 1001, cwd: dir, name: "Resumed" });
    expect(p.open).toBe(true);
    expect(p.review(104)).toBe(first);
  } finally {
    p.hide();
    await settle(p);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notes retain their checkout when switching to a repo with the same file name", async () => {
  const dir = folderCheckout(),
    p = new panel.Panel(local());
  try {
    p.follow({ pane: 105, cwd: root, name: "Agent" });
    p.show();
    await settle(p);
    key(p, "tab");
    key(p, "c");
    for (const ch of "original checkout") key(p, ch);
    key(p, "enter");
    expect(p.noteCount(105)).toBe(1);
    expect(await p.setFolder(dir)).toBe(true);
    await settle(p);
    expect(screen(p, 90, 50).join("\n")).not.toContain("original checkout");
    const effect = key(p, "y");
    expect(effect.kind).toBe("copy");
    if (effect.kind === "copy") expect(effect.text).toContain(root + "/app.ts:");
  } finally {
    p.hide();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("references open a commit outside the branch list and a range without dirty files", async () => {
  const p = new panel.Panel(local());
  try {
    p.openReference(root, { kind: "commit", hash: "main" });
    await settle(p);
    expect(screen(p).join("\n")).toContain("app.ts");
    expect(screen(p).join("\n")).not.toContain("No commit picked");
    p.openReference(root, { kind: "range", from: "main", to: "HEAD" });
    await settle(p);
    const text = screen(p).join("\n");
    expect(text).toContain("notes.md");
    expect(text).toContain("More.");
    expect(text).not.toContain("app.ts");
    expect(text).not.toContain("bun.lock");
    expect(text).toContain("..");
    key(p, "tab");
    key(p, "c");
    for (const text of "keep this note") key(p, text);
    key(p, "enter");
    const rangePane = p.pane!;
    expect(p.noteCount(rangePane)).toBe(1);
    p.openReference(root, { kind: "commit", hash: "missing-revision" });
    await settle(p);
    expect(screen(p).join("\n")).toContain("No commit: missing-revision");
    p.openReference(root, { kind: "commit", hash: "HEAD" });
    await settle(p);
    expect(screen(p).join("\n")).toContain("More.");
    p.openReference(root, { kind: "range", from: "main", to: "HEAD" });
    await settle(p);
    p.keep(new Set());
    expect(p.pane).toBe(rangePane);
    expect(key(p, "y")).toMatchObject({ kind: "copy", text: expect.stringContaining("keep this note") });
  } finally {
    p.hide();
  }
});

test("a reference read again unchanged shows its own error, not the last one's", async () => {
  const p = new panel.Panel(local());
  try {
    p.openReference(root, { kind: "commit", hash: "HEAD" });
    await settle(p);
    p.openReference(root, { kind: "commit", hash: "missing-revision" });
    await settle(p);
    expect(screen(p).join("\n")).toContain("No commit: missing-revision");
    p.openReference(root, { kind: "commit", hash: "HEAD" });
    await settle(p);
    const text = screen(p).join("\n");
    expect(text).not.toContain("missing-revision");
    expect(text).toContain("More.");
  } finally {
    p.hide();
  }
});

test("opens on all: commits and working copy together", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 1, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  const rows = screen(p);
  expect(rows[0]).toContain("Review");
  // The title is the panel's own; the pane it follows isn't named.
  expect(rows[0]).not.toContain("Fix app");
  expect(rows[0]).toContain("Review p pin");
  expect(rows.slice(0, 34).every(row => row.startsWith("│"))).toBe(true);
  // The scope tabs sit beside the title, and what the scope compares under it.
  expect(rows[0]).toContain(" all │ uncommitted │ commits ▾ 1 ");
  expect(rows[1]).toContain("topic vs main  1 commit + uncommitted");
  expect(rows[1]).toContain("3 files");
  // Too narrow to share the title row, the tabs take their own.
  const narrow = screen(p, 44);
  expect(narrow[1]).toContain(" all │ uncommitted │ commits ▾ 1 ");
  expect(narrow[2]).toContain("topic vs main");
  // How to close it stays at the bottom right when the other keys run out of room.
  expect(rows.at(-2)).toContain("S split");
  expect(rows.at(-2)).toMatch(/q close $/);
  expect(screen(p, 110).at(-2)).toMatch(/\? keys +q close $/);
  expect(narrow.at(-2)).toMatch(/q close $/);
  expect(narrow.at(-2)).not.toContain("? keys");
  const tree = rows.slice(3, 7).join("\n");
  expect(rows[3]).toContain("≡ All files");
  expect(tree).toContain("app.ts");
  expect(tree).toContain("bun.lock");
  expect(tree).toContain("gen");
  expect(tree).toContain("notes.md");
  // The first file opens with its first change in view, folded around it.
  const body = rows.join("\n");
  expect(body).toContain("export const v5 = 50;");
  expect(body).toMatch(/⋯ {2}\d+ unmodified lines/);
  // A fold before a change names the line that holds it, like git's hunk header.
  expect(body).toMatch(/⋯ {2}\d+ unmodified lines {2}· {2}export const v\d+ = \d+;/);
  p.hide();
});

test("Z switches every file between hunks and full context and remembers the mode", async () => {
  const p = new panel.Panel(local());
  try {
    p.follow({ pane: 108, conversation: 1008, cwd: root, name: "Agent" });
    p.show();
    await settle(p);
    key(p, "tab");
    expect(screen(p, 100, 100).join("\n")).toContain("unmodified lines");
    key(p, "Z");
    let body = screen(p, 100, 100).join("\n");
    expect(body).not.toContain("unmodified lines");
    expect(body).toContain("export const v0 = 0;");
    expect(body).toContain("export const v39 = 39;");
    expect(body).toContain("Generated file");
    await settle(p);
    expect(p.review(108).full_context).toBe(true);
    p.hide();
    p.show();
    p.toggleFullscreen();
    p.follow({ pane: 109, conversation: 1009, cwd: root, name: "Other" });
    expect(p.open).toBe(false);
    expect(p.fullscreen).toBe(false);
    p.follow({ pane: 108, conversation: 1008, cwd: root, name: "Agent" });
    expect(p.fullscreen).toBe(true);
    expect(p.review(108).full_context).toBe(true);
    key(p, "Z");
    body = screen(p, 100, 100).join("\n");
    expect(body).toContain("unmodified lines");
    expect(body).not.toContain("export const v0 = 0;");
  } finally {
    p.hide();
  }
});

test("S switches unified and split diffs, with a clickable footer and per-conversation mode", async () => {
  const p = new panel.Panel(local());
  try {
    p.follow({ pane: 120, conversation: 1020, cwd: root, name: "Agent" });
    p.show();
    await settle(p);
    const r = p.review(120);
    expect(r.split).toBe(false);
    expect(screen(p).at(-2)).toContain("S split");
    key(p, "tab");
    const before = screen(p, 140, 100);
    expect(before.find(line => line.includes("export const v5 = 5;"))).not.toContain("export const v5 = 50;");
    const cur = r.cur;
    key(p, "S");
    let rows = screen(p, 140, 100);
    expect(r.cur).toBe(cur);
    expect(rows.find(line => line.includes("export const v5 = 5;"))).toContain("export const v5 = 50;");
    expect(rows.at(-2)).toContain("S unified");
    expect(screen(p, 40, 60).at(-2)).toContain("S unified");
    rows = screen(p, 140, 100);
    p.mouse(
      "press",
      rows.at(-2)!.indexOf("S unified"),
      rows.findIndex(line => line.includes("S unified")),
    );
    expect(r.split).toBe(false);
    rows = screen(p, 140, 100);
    expect(rows.find(line => line.includes("export const v5 = 5;"))).not.toContain("export const v5 = 50;");
    key(p, "S");
    key(p, "?");
    expect(screen(p, 140, 100).join("\n")).toContain("Unified / split diff");
    key(p, "escape");
    p.hide();
    p.follow({ pane: 121, conversation: 1021, cwd: root, name: "Other" });
    expect(p.review(121).split).toBe(false);
    p.follow({ pane: 122, conversation: 1020, cwd: root, name: "Agent" });
    p.show();
    expect(p.review(122).split).toBe(true);
  } finally {
    p.hide();
  }
});

test("split clicks comment on the correct side and vertical movement follows aligned rows", async () => {
  const p = new panel.Panel(local());
  try {
    p.follow({ pane: 123, cwd: root, name: "Agent" });
    p.show();
    await settle(p);
    const r = p.review(123);
    r.all = false;
    r.path = "app.ts";
    r.part = "diff";
    r.full_context = true;
    key(p, "S");
    let rows = screen(p, 140, 100);
    const y = rows.findIndex(line => line.includes("export const v5 = 5;"));
    expect(y).toBeGreaterThan(0);
    p.mouse("press", 15, y);
    key(p, "c");
    expect(r.compose?.side).toBe("old");
    expect(r.compose?.snippet).toBe("-export const v5 = 5;");
    key(p, "escape");
    rows = screen(p, 140, 100);
    p.mouse("press", 100, y);
    key(p, "c");
    expect(r.compose?.side).toBe("new");
    expect(r.compose?.snippet).toBe("+export const v5 = 50;");
    key(p, "escape");
    key(p, "v");
    key(p, "j");
    key(p, "c");
    expect(r.compose?.side).toBe("new");
    expect(r.compose?.start).toBe(6);
    expect(r.compose?.end).toBe(7);
    key(p, "escape");
    key(p, "home");
    key(p, "end");
    key(p, "c");
    expect(r.compose?.end).toBe(40);
  } finally {
    p.hide();
  }
});

test("split additions keep an empty old side and navigate in screen order", async () => {
  const dir = folderCheckout(),
    p = new panel.Panel(local());
  try {
    writeFileSync(join(dir, "app.ts"), "after\nextra\nlast\n");
    p.follow({ pane: 124, cwd: dir, name: "Agent" });
    p.show();
    await settle(p);
    const r = p.review(124);
    r.all = false;
    r.path = "app.ts";
    r.part = "diff";
    key(p, "S");
    const rows = screen(p, 140, 60),
      y = rows.findIndex(line => line.includes("before"));
    expect(rows[y]).toContain("after");
    expect(rows[y + 1].slice(1, 70).trim()).toBe("");
    expect(rows[y + 1]).toContain("extra");
    expect(rows[y + 2]).toContain("last");
    p.mouse("press", 100, y);
    key(p, "j");
    key(p, "c");
    expect(r.compose?.snippet).toBe("+extra");
    key(p, "escape");
    key(p, "k");
    key(p, "c");
    expect(r.compose?.snippet).toBe("+after");
    key(p, "escape");
    key(p, "end");
    key(p, "c");
    expect(r.compose?.snippet).toBe("+last");
  } finally {
    p.hide();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file comments can be composed, edited and sent without selecting a line", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 106, conversation: 1006, cwd: root, name: "Agent" });
  p.show();
  try {
    await settle(p);
    key(p, "C");
    expect(screen(p).join("\n")).toContain("file note · app.ts");
    for (const ch of "review the module") key(p, ch);
    key(p, "enter");
    expect(p.review(106).notes[0].file).toBe(true);
    key(p, "x");
    expect(screen(p).join("\n")).toContain("review the module");
    key(p, "l");
    key(p, "e");
    expect(p.typingArea()?.text).toBe("review the module");
    key(p, "select_all");
    for (const ch of "split the module") key(p, ch);
    key(p, "enter");
    expect(p.noteCount(106)).toBe(1);
    const effect = key(p, "s");
    expect(effect.kind).toBe("send");
    if (effect.kind === "send") {
      expect(effect.pane).toBe(106);
      expect(effect.text).toBe("app.ts (file)\nsplit the module");
      expect(effect.notes[0].snippet).toBe("");
    }
    expect(p.noteCount(106)).toBe(0);
  } finally {
    p.hide();
  }
});

test("binary and generated files accept file comments without loading a text diff", async () => {
  const dir = folderCheckout(),
    p = new panel.Panel(local());
  try {
    writeFileSync(join(dir, "binary.dat"), Buffer.from([0, 1, 2, 0]));
    writeFileSync(join(dir, "bun.lock"), "{}\n");
    p.follow({ pane: 107, cwd: dir, name: "Agent" });
    p.show();
    await settle(p);
    for (const path of ["binary.dat", "bun.lock"]) {
      const r = p.review(107);
      Object.assign(r, { all: false, path, part: "diff", cur: 0, top: 0 });
      await settle(p);
      key(p, "C");
      expect(screen(p).join("\n")).toContain("file note · " + path);
      for (const ch of "file feedback") key(p, ch);
      key(p, "enter");
      expect(screen(p).join("\n")).toContain("file feedback");
      expect(r.loaded.has(path)).toBe(false);
      key(p, "e");
      expect(p.typingArea()?.text).toBe("file feedback");
      key(p, "escape");
      key(p, "d");
      expect(p.noteCount(107)).toBe(0);
    }
  } finally {
    p.hide();
    await settle(p);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walks hunks across files and writes a note that sends", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 7, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  key(p, "tab");
  key(p, "]");
  let body = screen(p).join("\n");
  expect(body).toContain("export const v30 = 300;");
  // ] lands on the hunk's first line, the removed one; the note goes on the added line.
  key(p, "j");
  key(p, "c");
  for (const ch of "why 300?") key(p, ch);
  key(p, "enter");
  body = screen(p).join("\n");
  expect(body).toContain("1 note");
  expect(body).toContain("why 300?");
  expect(p.noteCount(7)).toBe(1);
  const sent = key(p, "s");
  expect(sent.kind).toBe("send");
  if (sent.kind === "send") {
    expect(sent.pane).toBe(7);
    expect(sent.text).toBe("app.ts:31\n+export const v30 = 300;\nwhy 300?");
  }
  expect(p.noteCount(7)).toBe(0);
  // ] past the last hunk moves to the next file.
  key(p, "]");
  key(p, "]");
  await settle(p);
  expect(screen(p).join("\n")).toMatch(/bun\.lock|notes\.md/);
  p.hide();
});

test("a generated file waits for Enter, and scopes and commits switch", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 2, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  key(p, "j");
  key(p, "j");
  await settle(p);
  expect(screen(p).join("\n")).toContain("Its diff starts collapsed. Enter loads it.");
  key(p, "tab");
  key(p, "enter");
  await settle(p);
  expect(screen(p).join("\n")).toContain("{}");
  key(p, "u");
  await settle(p);
  let rows = screen(p);
  expect(rows[1]).toContain("topic vs HEAD");
  expect(rows.join("\n")).not.toContain("notes.md");
  key(p, "g");
  // The menu hangs from the commits tab and says what each commit touched.
  const menu = screen(p);
  expect(menu.find(row => row.includes("commit") && row.includes("files  lines  age"))).toBeDefined();
  expect(menu.find(row => row.includes("docs: more notes"))).toContain("1  +2 −0");
  key(p, "enter");
  await settle(p);
  rows = screen(p);
  expect(rows[0]).toMatch(/[0-9a-f]{7} ▾/);
  expect(rows[1]).toContain("docs: more notes");
  expect(rows.join("\n")).toContain("More.");
  p.hide();
});

test("find opens the fold its match is in", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 3, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  key(p, "tab");
  expect(screen(p).join("\n")).not.toContain("export const v18 = 18;");
  key(p, "/");
  for (const ch of "v18 ") key(p, ch);
  expect(screen(p).join("\n")).toContain("export const v18 = 18;");
  p.hide();
});

test("outside a checkout it says so", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 4, cwd: tmpdir(), name: "shell" });
  p.show();
  await settle(p);
  expect(screen(p).join("\n")).toContain("Not in a git checkout");
  expect(screen(p, 40).join("\n")).toContain("Press r to open another repo by path.");
  key(p, "r");
  expect(screen(p).join("\n")).toContain("Repo / folder");
  key(p, "escape");
  screen(p);
  p.mouse("press", 4, 5);
  expect(screen(p).join("\n")).toContain("Repo / folder");
  p.hide();
});

test("the panel fits beside the panes or not at all", () => {
  expect(panel.Panel.fit(80, 200)).toBe(80);
  expect(panel.Panel.fit(80, 100)).toBe(70);
  expect(panel.Panel.fit(80, 60)).toBe(0);
});

test("files sort by last edit, newest first, with how long ago", async () => {
  const now = Date.now() / 1000;
  utimesSync(join(root, "notes.md"), now - 2 * 86400, now - 2 * 86400);
  utimesSync(join(root, "app.ts"), now - 3 * 3600, now - 3 * 3600);
  utimesSync(join(root, "bun.lock"), now - 300, now - 300);
  const p = new panel.Panel(local());
  p.follow({ pane: 9, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  let rows = screen(p);
  expect(rows[2]).toContain("sort: name ↑ · last edit");
  expect(rows.find(row => row.includes("app.ts"))).toContain("3 h");
  key(p, "o");
  await settle(p);
  rows = screen(p);
  const at = ["bun.lock", "app.ts", "notes.md"].map(name => rows.findIndex(row => row.includes(name)));
  expect(at.every(i => i > 2)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(rows[at[0]]).toContain("5 min");
  expect(rows[at[2]]).toContain("2 d");
  expect(rows[2]).toContain("sort: name · last edit ↓");
  // Asked again, the same sort runs the other way.
  key(p, "O");
  rows = screen(p);
  const back = ["notes.md", "app.ts", "bun.lock"].map(name => rows.findIndex(row => row.includes(name)));
  expect(back).toEqual([...back].sort((a, b) => a - b));
  expect(rows[2]).toContain("last edit ↑");
  p.hide();
});

test("last-edit ages use the current language for hours and days", async () => {
  const now = Date.now() / 1000,
    original = i18n.language(),
    p = new panel.Panel(local());
  utimesSync(join(root, "notes.md"), now - 2 * 86400, now - 2 * 86400);
  utimesSync(join(root, "app.ts"), now - 3 * 3600, now - 3 * 3600);
  try {
    p.follow({ pane: 10, cwd: root, name: "Fix app" });
    p.show();
    await settle(p);
    for (const locale of i18n.locales) {
      i18n.setLanguage(locale);
      const rows = screen(p),
        hours = 3,
        days = 2;
      expect(rows[0]).toContain(i18n.t`Review` + " p " + i18n.t`pin`);
      expect(rows.find(row => row.includes("app.ts"))).toContain(i18n.t`${hours} h`);
      expect(rows.find(row => row.includes("notes.md"))).toContain(i18n.t`${days} d`);
      if (locale !== "en") {
        expect(rows.find(row => row.includes("app.ts"))).not.toContain("3 h");
        expect(rows.find(row => row.includes("notes.md"))).not.toContain("2 d");
      }
    }
  } finally {
    p.hide();
    i18n.setLanguage(original);
  }
});

test("pinned, the review stays put and its notes go to the focused pane", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 11, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  expect(screen(p)[0]).not.toContain("→");
  key(p, "p");
  p.dest = { pane: 12, cwd: "/elsewhere", name: "Reviewer" };
  const top = screen(p, 90)[0];
  expect(top).toContain("Review p pin → Reviewer");
  // Pinned, the panel's edge turns heavy.
  expect(
    screen(p)
      .slice(0, 34)
      .every(row => row.startsWith("┃")),
  ).toBe(true);
  key(p, "tab");
  key(p, "]");
  key(p, "j");
  key(p, "c");
  for (const ch of "why?") key(p, ch);
  key(p, "enter");
  expect(screen(p, 100).at(-2)).toContain("send 1 to Reviewer");
  const sent = key(p, "s");
  expect(sent).toMatchObject({ kind: "send", pane: 12, from: 11 });
  // A failed send puts the notes back on the review they came from.
  if (sent.kind === "send") p.restore(sent.from, sent.notes, "kept");
  expect(p.noteCount(11)).toBe(1);
  p.hide();
  expect(p.pinned).toBe(false);
});

test("up and down move between the file list and the diff under it, and stop past either", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 15, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  const inList = () => screen(p).at(-2)!.includes("j/k file");
  expect(inList()).toBe(true);
  expect(p.move("up")).toBe(false);
  expect(p.move("right")).toBe(false);
  expect(p.move("down")).toBe(true);
  expect(inList()).toBe(false);
  expect(p.move("down")).toBe(false);
  expect(p.move("up")).toBe(true);
  expect(inList()).toBe(true);
  // With the list hidden, the diff is all there is.
  key(p, "z");
  expect(p.move("up")).toBe(false);
  expect(p.move("down")).toBe(false);
  p.hide();
});

test("the wheel scrolls the file list under the pointer", async () => {
  const extra = Array.from({ length: 6 }, (_, i) => `z${i}.txt`);
  for (const name of extra) write(name, "new\n");
  try {
    const p = new panel.Panel(local());
    p.tree_rows = 6;
    p.follow({ pane: 13, cwd: root, name: "Fix app" });
    p.show();
    await settle(p);
    const list = () => screen(p, 70, 20).slice(3, 9).join("\n");
    expect(list()).toContain("app.ts");
    expect(list()).not.toContain("z5.txt");
    // Over a file's row, the list scrolls, and stays off the selected file.
    p.mouse("wheel_down", 5, 4);
    p.mouse("wheel_down", 5, 4);
    expect(list()).not.toContain("app.ts");
    expect(list()).toContain("z5.txt");
    // Moving the selection brings it back into view.
    key(p, "j");
    expect(list()).toContain("app.ts");
    p.hide();
  } finally {
    for (const name of extra) rmSync(join(root, name));
  }
});

test("all files reads every file in one flow, each under its heading", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 21, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  // Under the list's rule, the files in the list's order.
  const flow = () => screen(p, 70, 60).slice(8);
  let rows = flow();
  const at = (text: string) => rows.findIndex(row => row.includes(text));
  expect(rows[0]).toMatch(/M app\.ts +working copy  \+2 −2/);
  expect(rows[at("A bun.lock")]).toContain("untracked  gen +2");
  expect(rows[at("A bun.lock") + 1]).toContain("Generated file · enter loads its diff");
  expect(rows[at("M notes.md")]).toContain("committed  +2");
  expect(at("export const v30 = 300;")).toBeLessThan(at("A bun.lock"));
  expect(at("More.")).toBeGreaterThan(at("M notes.md"));
  // f walks to the next file; Enter there loads a generated diff in place.
  key(p, "tab");
  key(p, "f");
  key(p, "enter");
  await settle(p);
  rows = flow();
  expect(rows[at("A bun.lock") + 1]).toContain("{}");
  // A note goes on the file the cursor is in.
  key(p, "f");
  key(p, "c");
  for (const ch of "why?") key(p, ch);
  key(p, "enter");
  rows = flow();
  expect(rows[at("M notes.md")]).toContain("•");
  expect(rows.join("\n")).toContain("notes.md:2");
  p.hide();
});

test("a file picked in the list shows alone, and all files comes back on it", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 22, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  screen(p);
  p.mouse("press", 10, 6);
  p.mouse("release", 10, 6);
  await settle(p);
  let rows = screen(p);
  expect(rows[7]).toContain(" notes.md ");
  expect(rows.slice(8).join("\n")).not.toContain("app.ts");
  p.mouse("press", 10, 3);
  p.mouse("release", 10, 3);
  await settle(p);
  // Back on the flow, it's on the file last shown, not its top.
  rows = screen(p, 70, 20).slice(8);
  expect(rows.some(row => /M notes\.md +committed/.test(row))).toBe(true);
  expect(rows.join("\n")).toContain("More.");
  expect(rows.join("\n")).not.toContain("v5 = 50");
  p.hide();
});

test("find on all files reaches into every file", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 23, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  key(p, "tab");
  key(p, "/");
  for (const ch of "more.") key(p, ch);
  const rows = screen(p, 70, 20);
  expect(rows.join("\n")).toContain("More.");
  expect(rows.at(-2)).toContain("1/1");
  p.hide();
});

test("dragging the rule under the file list sets its height", async () => {
  const p = new panel.Panel(local());
  let saved = 0;
  p.resized = rows => (saved = rows);
  p.follow({ pane: 24, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  screen(p);
  expect(p.splitRow).toBe(7);
  p.mouse("press", 10, 7);
  expect(p.splitting).toBe(true);
  p.mouse("drag", 10, 5);
  p.mouse("release", 10, 5);
  expect(saved).toBe(2);
  const rows = screen(p);
  expect(rows[3]).toContain("All files");
  expect(rows[5]).toMatch(/^│─+$/);
  expect(rows[3]).toMatch(/▐$/);
  expect(p.splitRow).toBe(5);
  // Dragged down, the list stops short of the diff's last rows.
  p.mouse("press", 10, 5);
  p.mouse("drag", 10, 40);
  p.mouse("release", 10, 40);
  expect(saved).toBe(34 - 3 - 2 - 5);
  p.hide();
});

test("a file's heading folds it to its counts, and unfolds it", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 25, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  const flow = () => screen(p, 70, 60).slice(8).join("\n");
  expect(flow()).toMatch(/▾ M app\.ts/);
  // A click on the heading folds the file away, leaving what it held.
  p.mouse("press", 10, 8);
  p.mouse("release", 10, 8);
  let body = flow();
  expect(body).toMatch(/▸ M app\.ts +2 hunks  working copy  \+2 −2/);
  expect(body).not.toContain("v30 = 300");
  expect(body).toContain("More.");
  // Folded files are passed over by ] and unfold with Enter.
  key(p, "]");
  expect(screen(p, 70, 60).at(-2)).not.toContain("unfold");
  key(p, "[");
  expect(screen(p, 70, 60).at(-2)).not.toContain("unfold");
  key(p, "home");
  expect(screen(p, 70, 60).at(-2)).toContain("enter unfold");
  key(p, "enter");
  body = flow();
  expect(body).toMatch(/▾ M app\.ts/);
  expect(body).toContain("v30 = 300");
  // x folds the file the cursor is in.
  key(p, "x");
  expect(flow()).toMatch(/▸ M app\.ts/);
  p.hide();
});

test("test diffs fold at the ratio for the current scope, and explicit choices survive refresh", async () => {
  const p = new panel.Panel(local());
  const testLines = (n: number) =>
    write(
      "app.test.ts",
      lines(n, i => `test_only_${i}();`),
    );
  const body = () => screen(p, 70, 60).join("\n");
  testLines(25);
  try {
    p.follow({ pane: 30, cwd: root, name: "Fix app" });
    p.show();
    await settle(p);
    key(p, "t");
    await settle(p);
    // The branch has six non-test edits, excluding the generated lockfile.
    expect(body()).toContain("▾ A app.test.ts");
    testLines(24);
    await settle(p);
    expect(body()).toContain("▸ A app.test.ts");
    expect(body()).not.toContain("test_only_0();");

    // Only four of those non-test edits are uncommitted.
    p.showScope("uncommitted", null);
    await settle(p);
    expect(body()).toContain("▾ A app.test.ts");
    p.showScope("all", null);
    await settle(p);
    expect(body()).toContain("▸ A app.test.ts");

    key(p, "tab");
    key(p, "home");
    expect(screen(p).at(-2)).toContain("enter unfold");
    key(p, "enter");
    await settle(p);
    expect(body()).toContain("▾ A app.test.ts");
    expect(body()).toContain("test_only_0();");

    key(p, "x");
    testLines(25);
    await settle(p);
    expect(body()).toContain("▸ A app.test.ts");
    key(p, "enter");
    expect(body()).toContain("▾ A app.test.ts");
  } finally {
    p.hide();
    rmSync(join(root, "app.test.ts"));
  }
});

test("single-file view, find and note navigation reveal automatically folded tests", async () => {
  const p = new panel.Panel(local());
  write(
    "app.test.ts",
    lines(24, i => `test_only_${i}();`),
  );
  const body = () => screen(p, 70, 60).join("\n");
  try {
    p.follow({ pane: 31, cwd: root, name: "Fix app" });
    p.show();
    await settle(p);
    key(p, "t");
    await settle(p);
    expect(body()).toContain("▸ A app.test.ts");
    const row = screen(p).findIndex(row => row.includes("app.test.ts"));
    p.mouse("press", 10, row);
    p.mouse("release", 10, row);
    await settle(p);
    expect(body()).toContain("test_only_0();");
    p.mouse("press", 10, 3);
    p.mouse("release", 10, 3);
    await settle(p);
    expect(body()).toContain("▸ A app.test.ts");

    key(p, "tab");
    key(p, "/");
    for (const ch of "test_only_0") key(p, ch);
    key(p, "escape");
    await settle(p);
    expect(body()).toContain("▾ A app.test.ts");
    expect(body()).toContain("test_only_0();");

    key(p, "c");
    for (const ch of "check this test") key(p, ch);
    key(p, "enter");
    key(p, "x");
    expect(body()).toContain("▸ A app.test.ts");
    key(p, "n");
    await settle(p);
    expect(body()).toContain("▾ A app.test.ts");
    expect(body()).toContain("check this test");
  } finally {
    p.hide();
    rmSync(join(root, "app.test.ts"));
  }
});

test("? shows every key in one box of groups over a dimmed panel, and any key closes it", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 26, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  const before = screen(p, 80, 34);
  key(p, "?");
  expect(p.keysOpen).toBe(true);
  const rows = screen(p, 80, 34),
    at = (text: string) => rows.findIndex(row => row.includes(text));
  expect(rows[at("Keys")]).toMatch(/╭─ Keys ─+╮/);
  // Two columns of groups, each key at the end of what it does.
  expect(rows[at("Move")]).toMatch(/Move +Show/);
  expect(rows[at("Page")]).toMatch(/Page +space - +Uncommitted +u/);
  expect(rows[at("Pin review")]).toMatch(/Pin review +p/);
  expect(at("File list")).toBeGreaterThan(at("Move"));
  expect(at("Leave")).toBeGreaterThan(at("File list"));
  expect(rows[at("any key closes")]).toMatch(/╰─+ any key closes ─╯/);
  key(p, "j");
  expect(p.keysOpen).toBe(false);
  expect(screen(p, 80, 34)[4]).toBe(before[4]);
  // A click closes it too, and does nothing else.
  key(p, "?");
  p.mouse("press", 10, 4);
  expect(p.keysOpen).toBe(false);
  expect(screen(p, 80, 34)[3]).toContain("≡ All files");
  p.hide();
});

test("space pages down and - pages up, as in tig", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 27, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  key(p, "tab");
  const top = screen(p, 70, 20).slice(8).join("\n");
  key(p, " ");
  key(p, " ");
  const paged = screen(p, 70, 20).slice(8).join("\n");
  expect(paged).not.toBe(top);
  expect(paged).toContain("More.");
  key(p, "-");
  key(p, "-");
  key(p, "-");
  expect(screen(p, 70, 20).slice(8).join("\n")).toContain("v5 = 50");
  p.hide();
});

test("shift and an arrow select lines as a drag does", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 28, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  key(p, "tab");
  key(p, "select_down");
  key(p, "select_down");
  expect(screen(p).at(-2)).toContain("c comment on 3 rows");
  key(p, "select_up");
  expect(screen(p).at(-2)).toContain("c comment on 2 rows");
  // Back where it started, there's no selection.
  key(p, "select_up");
  expect(screen(p).at(-2)).not.toContain("comment on");
  // A plain move after it ends the selection and moves, as letting go of shift would.
  key(p, "select_down");
  key(p, "down");
  expect(screen(p).at(-2)).not.toContain("comment on");
  // v's selection keeps growing with plain moves.
  key(p, "v");
  key(p, "down");
  expect(screen(p).at(-2)).toContain("c comment on 2 rows");
  key(p, "escape");
  key(p, "up");
  key(p, "up");
  key(p, "select_up");
  key(p, "c");
  for (const ch of "both") key(p, ch);
  key(p, "enter");
  const body = screen(p).join("\n");
  expect(body).toMatch(/╭─ app\.ts:\d+ /);
  expect(body).toContain("both");
  p.hide();
});

test("the note box edits like a text box: words, lines, selection and paste", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 29, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  key(p, "tab");
  key(p, "c");
  expect(p.typing).toBe(true);
  for (const ch of "why is this here") key(p, ch);
  key(p, "word_backspace");
  key(p, "word_backspace");
  key(p, "newline");
  for (const ch of "50?") key(p, ch);
  // Back to the first line's start, and a word selected and typed over.
  key(p, "up");
  key(p, "line_start");
  key(p, "select_word_right");
  for (const ch of "what") key(p, ch);
  for (const byte of Buffer.from(" — pasted\r\nline")) p.pasteByte(byte);
  // The paste goes in at the caret, its line break as one.
  let rows = screen(p);
  const y = rows.findIndex(row => row.includes("│ what — pasted ")),
    x = rows[y].indexOf("what");
  expect(rows[y + 1]).toContain("│ line is ");
  expect(rows[y + 2]).toContain("│ 50? ");
  // A click in the box places the caret; a drag selects.
  p.mouse("press", x, y);
  p.mouse("drag", x + 5, y);
  p.mouse("release", x + 5, y);
  key(p, "backspace");
  key(p, "enter");
  const body = screen(p).join("\n");
  expect(body).toContain("— pasted");
  expect(body).not.toContain("what");
  expect(p.typing).toBe(false);
  p.hide();
});

/** The ghost as a terminal shows it, row by row. */
function ghostScreen(p: panel.Panel, width = 70, height = 34): string[] {
  const w = new Writer();
  p.drawGhost(w, 0, 0, width, height);
  return text(w.buffered(), width, height).split("\n");
}
test("a ghost shows another scope dimmed and leaves the followed review alone", async () => {
  const p = new panel.Panel(local());
  const hash = run("rev-parse", "--short", "HEAD");
  // Closed, a ghost still reads and draws its checkout.
  p.preview({ cwd: root, name: "w", scope: "commits", pick: hash });
  await settle(p);
  let rows = ghostScreen(p);
  expect(rows.slice(0, 34).every(row => row.startsWith("┆"))).toBe(true);
  expect(rows[1]).toContain(`${hash}  docs: more notes`);
  // The next ghost takes its place only once read, never through a blank.
  p.preview({ cwd: root, name: "w", scope: "all", pick: null });
  expect(ghostScreen(p)[1]).toContain(`${hash}  docs: more notes`);
  await settle(p);
  expect(ghostScreen(p)[1]).toContain("topic vs main");
  p.follow({ pane: 3, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  p.preview(null);
  expect(p.ghosted).toBe(false);
  rows = screen(p);
  expect(rows[0].startsWith("│")).toBe(true);
  expect(rows[1]).toContain("topic vs main");
  // Opened from elsewhere, a short hash names the full commit.
  p.showScope("commits", hash);
  await settle(p);
  expect(screen(p)[1]).toContain(`${hash}  docs: more notes`);
  expect(p.review(3).pick).toHaveLength(40);
  p.hide();
});

test("wide source wraps and scrolls in cells without writing into the pane beside it", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "corgi-review-wide-")));
  const p = new panel.Panel(local());
  try {
    runGit(dir, "init", "-q", "-b", "main");
    writeFileSync(
      join(dir, "wide.ts"),
      [
        'export const languages = ["English", "中文", "日本語", "한국어", "Русский"];',
        'export const combining = "e\u0301";',
        "界".repeat(210),
        "export const afterWideLine = true;",
      ].join("\n") + "\n",
    );
    p.follow({ pane: 88, cwd: dir, name: "Wide source" });
    p.show();
    await settle(p);
    const review = p.review(88);
    review.all = false;
    review.path = "wide.ts";
    review.free = true;
    for (const [split, width] of [
      [false, 40],
      [false, 53],
      [true, 80],
      [true, 106],
    ] as const) {
      review.split = split;
      for (const [wrap, shift] of [
        [true, 0],
        [false, 0],
        [false, 9],
      ] as const) {
        review.wrap = wrap;
        review.shift = shift;
        review.top = 0;
        const left = "L".repeat(59),
          height = 34;
        const terminal = new Terminal(left.length + width, height);
        try {
          for (let row = 0; row < height; row++) terminal.feed(`\x1b[${row + 1};1H${left}`);
          const w = new Writer();
          p.draw(w, left.length, 0, width, height, true);
          terminal.feed(w.buffered());
          const rows = terminal.text().split("\n");
          expect(rows.slice(0, height).every(row => row.startsWith(left + "│"))).toBe(true);
          const body = rows.map(row => row.slice(left.length)).join("\n");
          expect(body).toContain("界界界");
          expect(body).toContain("afterWideLine");
          expect(body).not.toContain("�");
          if (wrap) {
            expect(body).toContain("more characters");
            expect(body).toMatch(/e\u0301|é/);
          }
        } finally {
          terminal.destroy();
        }
      }
    }
  } finally {
    p.hide();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pasting a path in the diff editor replaces its current value and opens that directory", async () => {
  const p = new panel.Panel(local());
  p.follow({ pane: 501, conversation: 501, cwd: root, name: "test" });
  p.show();
  try {
    let opened = Promise.withResolvers<void>();
    p.changed = () => {
      if (!p.typing) opened.resolve();
    };
    p.key({ text: "r" });
    expect(p.typing).toBe(true);
    p.beginPathPaste();
    for (const byte of new TextEncoder().encode(root + "\n")) p.pasteByte(byte);
    p.endPathPaste();
    await opened.promise;
    expect(p.typing).toBe(false);
    expect(p.saved()?.folder).toBe(root);
    opened = Promise.withResolvers<void>();
    expect(p.pastePath(root)).toBe(true);
    await opened.promise;
    expect(p.saved()?.folder).toBe(root);
  } finally {
    p.hide();
  }
});

test("a remote review resolves its folder with the owning machine", async () => {
  const requested: string[] = [];
  let home = "";
  const p = new panel.Panel(
    {
      ...local(),
      async summary(cwd) {
        requested.push(cwd);
        return { root: "/remote/home/repo", base: null, totals: null };
      },
      async read({ cwd }) {
        requested.push(cwd);
        return { root: "/remote/home/repo", hash: "", checkout: null, same: false };
      },
    },
    {
      home: () => home,
      async list(path) {
        requested.push(path);
        home = "/remote/home";
        return [];
      },
    },
  );
  p.follow({ pane: 1, cwd: "/remote/home/repo", name: "remote" });
  expect(await p.setFolder("~/repo/src")).toBe(true);
  expect(p.saved()?.folder).toBe("/remote/home/repo/src");
  expect(requested).toContain("~/repo/src");
  expect(requested).toContain("/remote/home/repo/src");
  p.dispose();
});

test("fullscreen places a full-height file tree beside the diff and pane mode stacks it above", () => {
  const p = new panel.Panel(local());
  const patch = Array.from(
    { length: 24 },
    (_, i) =>
      `diff --git a/file${String(i).padStart(2, "0")}.ts b/file${String(i).padStart(2, "0")}.ts\n--- a/file${String(i).padStart(2, "0")}.ts\n+++ b/file${String(i).padStart(2, "0")}.ts\n@@ -1 +1 @@\n-old${i}\n+new${i}\n`,
  ).join("");
  p.showRemote(
    "https://github.com/acme/app/pull/12",
    "acme/app #12",
    "b".repeat(40),
    "a".repeat(40),
    remote.files(patch),
    null,
  );
  p.toggleFullscreen();
  try {
    const rows = screen(p, 120, 22);
    expect(p.splitRow).toBeNull();
    expect(rows.at(-2)).toContain("Z full file");
    expect(rows.at(-2)).toContain("P PR");
    const treeY = rows.findIndex(row => row.includes("file00.ts"));
    const codeY = rows.findIndex(row => row.includes("old0"));
    expect(rows[treeY].indexOf("file00.ts")).toBeLessThan(32);
    expect(rows[codeY].indexOf("old0")).toBeGreaterThan(32);
    expect(rows.join("\n")).toContain("file15.ts");
    const r = p.review(-3),
      top = r.top;
    p.mouse("wheel_down", 4, 7);
    screen(p, 120, 22);
    expect(r.tree_top).toBe(3);
    expect(r.top).toBe(top);
    p.mouse("press", 8, treeY + 1);
    expect(r.all).toBe(false);
    expect(r.path).toBe("file04.ts");
    p.toggleFullscreen();
    const pane = screen(p, 70, 22);
    expect(p.splitRow).not.toBeNull();
    expect(pane.findIndex(row => row.includes("old4"))).toBeGreaterThan(p.splitRow!);
    expect(pane.find(row => row.includes("old4"))!.indexOf("old4")).toBeLessThan(20);
    const ribbon = pane.at(-2)!;
    p.mouse("press", ribbon.indexOf("Z full file") + 1, pane.length - 2);
    expect(r.full_context).toBe(true);
    expect(screen(p, 70, 22).at(-2)).toContain("Z hunks");
  } finally {
    p.hide();
  }
});
test("remote snapshots hide tests until t shows them", () => {
  const p = new panel.Panel(local());
  const patch = ["app.test.ts", "app.ts", "tests/helper.ts"]
    .map(path => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`)
    .join("");
  p.showRemote("https://github.com/acme/app/pull/12", "PR", "b".repeat(40), "a".repeat(40), remote.files(patch), null);
  try {
    expect(p.review(-3).hide_tests).toBe(true);
    expect(p.review(-3).path).toBe("app.ts");
    expect(screen(p, 100, 50).join("\n")).not.toContain("app.test.ts");
    key(p, "t");
    expect(screen(p, 100, 50).join("\n")).toContain("app.test.ts");
    key(p, "t");
    expect(screen(p, 100, 50).join("\n")).not.toContain("app.test.ts");
  } finally {
    p.hide();
  }
});

test("syntax styles reset between runs and focused word highlights yield to selections and search", () => {
  const previous = syntax.service;
  let worker!: syntax.Port;
  const jobs: SyntaxRequest[] = [];
  const service = new syntax.Service(
    () => {},
    () =>
      (worker = {
        onmessage: null,
        onerror: null,
        terminate() {},
        postMessage(value) {
          if ("id" in value) jobs.push(value);
        },
      }),
  );
  syntax.use(service);
  codePalette.use(codePalette.defaults);
  const p = new panel.Panel(local());
  p.showRemote(
    "https://github.com/acme/app/pull/99",
    "syntax",
    "b",
    "a",
    remote.files(
      'diff --git a/greet.ts b/greet.ts\n@@ -1 +1 @@\n-function greet() { return "old"; }\n+function greet() { return "new"; }\n',
    ),
    null,
  );
  const frame = () => {
    const w = new Writer();
    p.draw(w, 0, 0, 110, 30, true);
    return w.buffered();
  };
  try {
    frame();
    for (const job of jobs)
      worker.onmessage?.({
        data: {
          id: job.id,
          spans: job.lines.map(line => [
            [0, 8, [86, 156, 214], 7],
            [8, line.length, [220, 220, 170], 0],
          ]),
        },
      } as MessageEvent<SyntaxResponse>);
    let out = frame();
    expect(out).toContain("\x1b[0m\x1b[1m\x1b[3m\x1b[4m");
    expect(out).toContain("\x1b[0m" + palette.fgRgb([220, 220, 170]));
    expect(out).toContain(palette.bgRgb(palette.mix(codePalette.background(), palette.colors.hot, 30)));
    key(p, "tab");
    key(p, "v");
    out = frame();
    expect(out).toContain(palette.fgRgb(palette.colors.strong) + palette.bgRgb(palette.colors.selected));
    key(p, "escape");
    key(p, "/");
    for (const ch of "greet") key(p, ch);
    key(p, "enter");
    out = frame();
    expect(out).toContain(
      palette.fgRgb(palette.colors.strong) + palette.bgRgb(palette.mix(palette.colors.bg, palette.colors.warm, 40)),
    );
    key(p, "S");
    expect(text(frame(), 110, 30)).toContain("greet");
  } finally {
    p.dispose();
    service.close();
    syntax.use(previous);
  }
});

test("a long file's diff arrives in slices, and a poll that finds nothing new sends no listing", async () => {
  const asked: string[] = [];
  const reader = local(),
    counted = {
      ...reader,
      read: (request: Parameters<typeof reader.read>[0]) =>
        reader.read(request).then(reply => {
          asked.push(reply.same ? "same" : "read");
          return reply;
        }),
      diffs: (request: Parameters<typeof reader.diffs>[0]) => {
        asked.push(`diffs ${request.files.map(f => `${f.path}@${f.offset}`).join(" ")}`);
        return reader.diffs(request);
      },
    };
  const p = new panel.Panel(counted);
  write(
    "long.ts",
    lines(20_000, i => `export const long_${i} = "a line that makes the file longer than one reply";`),
  );
  try {
    p.follow({ pane: 40, cwd: root, name: "Fix app" });
    p.showScope("uncommitted", null);
    p.show();
    await settle(p);
    // Its first slice comes with the other file; each next one comes alone.
    expect(asked[0]).toBe("read");
    expect(asked[1]).toBe("diffs app.ts@0 long.ts@0");
    const rest = asked.slice(2).filter(a => a.startsWith("diffs"));
    expect(rest.length).toBeGreaterThan(2);
    expect(rest.every(a => /^diffs long\.ts@[1-9]\d*$/.test(a))).toBe(true);
    // Picked alone, it shows its last line: every slice is in.
    const at = screen(p).findIndex(row => row.includes("long.ts"));
    p.mouse("press", 10, at);
    p.mouse("release", 10, at);
    key(p, "end");
    expect(screen(p).join("\n")).toContain("long_19999");
    // Nothing changed: the listing isn't sent again, and no diff is read again.
    asked.length = 0;
    await settle(p);
    expect(asked).toEqual(["same", "same"]);
  } finally {
    p.hide();
    rmSync(join(root, "long.ts"));
  }
});

test("a long diff whose file changes between its slices is read again from the start", async () => {
  const base = local();
  let release!: () => void,
    continued!: () => void,
    edited = false;
  const gate = new Promise<void>(resolve => (release = resolve)),
    asked = new Promise<void>(resolve => (continued = resolve));
  const p = new panel.Panel({
    ...base,
    // Once the panel has the edited file's listing, the slice on its way arrives.
    read: async (request: Parameters<typeof base.read>[0]) => {
      const reply = await base.read(request);
      if (edited) setTimeout(release, 0);
      return reply;
    },
    diffs: async (request: Parameters<typeof base.diffs>[0]) => {
      if (request.files.some(f => f.path === "long.ts" && f.offset > 0)) {
        continued();
        await gate;
      }
      return base.diffs(request);
    },
  });
  const long = (name: string) => lines(20_000, i => `export const ${name}_${i} = "a line longer than one reply";`);
  write("long.ts", long("old"));
  try {
    p.follow({ pane: 45, cwd: root, name: "Fix app" });
    p.showScope("uncommitted", null);
    p.show();
    const settling = settle(p);
    await asked;
    // A poll reads the edited file's listing while its slices are on the way.
    write("long.ts", long("edited") + "// longer now\n");
    edited = true;
    void Reflect.get(p, "read").call(p, Reflect.get(p, "target"));
    await settling;
    await settle(p);
    const at = screen(p).findIndex(row => row.includes("long.ts"));
    p.mouse("press", 10, at);
    p.mouse("release", 10, at);
    key(p, "end");
    const text = screen(p).join("\n");
    expect(text).toContain("longer now");
    expect(text).not.toContain("old_19999");
  } finally {
    release();
    p.hide();
    rmSync(join(root, "long.ts"));
  }
});

test("a diffs request the daemon refused while reloading is asked again at the next poll", async () => {
  const base = local();
  let refuse = true;
  const p = new panel.Panel({
    ...base,
    diffs: (request: Parameters<typeof base.diffs>[0]) => {
      if (refuse) {
        refuse = false;
        return Promise.reject(errors.fromReply({ err: "Reloading" }));
      }
      return base.diffs(request);
    },
  });
  const app = (v30: number) =>
    write(
      "app.ts",
      lines(40, i =>
        i === 5 ? "export const v5 = 50;" : i === 30 ? `export const v30 = ${v30};` : `export const v${i} = ${i};`,
      ),
    );
  try {
    p.follow({ pane: 46, cwd: root, name: "Fix app" });
    p.show();
    await settle(p);
    expect(screen(p).join("\n")).toContain("Reloading");
    await settle(p);
    let text = screen(p).join("\n");
    expect(text).not.toContain("Reloading");
    expect(text).toContain("export const v30 = 300;");
    // A file read before keeps its diff on screen while a read of its change is refused.
    app(3000);
    refuse = true;
    await p.refresh();
    text = screen(p).join("\n");
    expect(text).not.toContain("Reloading");
    expect(text).toContain("export const v30 = 300;");
    await settle(p);
    expect(screen(p).join("\n")).toContain("export const v30 = 3000;");
  } finally {
    app(300);
    p.hide();
  }
});

test("all files reads a window around what's on screen, and more as it moves", async () => {
  const read = new Set<string>();
  const reader = local(),
    counted = {
      ...reader,
      diffs: (request: Parameters<typeof reader.diffs>[0]) => {
        for (const f of request.files) read.add(f.path);
        return reader.diffs(request);
      },
    };
  const p = new panel.Panel(counted);
  const names = Array.from({ length: 40 }, (_, i) => `many/f${String(i).padStart(2, "0")}.ts`);
  mkdirSync(join(root, "many"), { recursive: true });
  for (const name of names)
    write(
      name,
      lines(30, i => `export const line_${i} = ${i};`),
    );
  try {
    p.follow({ pane: 41, cwd: root, name: "Fix app" });
    p.showScope("uncommitted", null);
    p.show();
    await settle(p);
    screen(p);
    await settle(p);
    const first = [...read].filter(path => path.startsWith("many/"));
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(20);
    expect(read.has(names[39])).toBe(false);
    // The end of the flow brings its files into the window.
    key(p, "tab");
    key(p, "end");
    screen(p);
    await settle(p);
    expect(read.has(names[39])).toBe(true);
    expect([...read].filter(path => path.startsWith("many/")).length).toBeLessThan(40);
  } finally {
    p.hide();
    rmSync(join(root, "many"), { recursive: true, force: true });
  }
});

test("a file picked in the list reads those next to it, so the next one shows without a wait", async () => {
  const read = new Set<string>();
  const reader = local(),
    counted = {
      ...reader,
      diffs: (request: Parameters<typeof reader.diffs>[0]) => {
        for (const f of request.files) read.add(f.path);
        return reader.diffs(request);
      },
    };
  const p = new panel.Panel(counted);
  // Folders of ten, so none starts folded.
  const dirs = ["wa", "wb", "wc", "wd"];
  for (const dir of dirs) {
    mkdirSync(join(root, dir), { recursive: true });
    for (let i = 0; i < 10; i++)
      write(
        `${dir}/f0${i}.ts`,
        lines(30, j => `export const ${dir}_f0${i}_${j} = ${j};`),
      );
  }
  try {
    p.follow({ pane: 43, cwd: root, name: "Fix app" });
    p.showScope("uncommitted", null);
    p.show();
    await settle(p);
    const y = screen(p).findIndex(row => row.includes("f02.ts"));
    expect(y).toBeGreaterThan(0);
    p.mouse("press", 10, y);
    p.mouse("release", 10, y);
    await settle(p);
    screen(p);
    await settle(p);
    // Those after it and before it, and those listed, but not the rest.
    for (const path of ["wa/f00.ts", "wa/f03.ts", "wa/f06.ts", "wb/f00.ts"]) expect(read.has(path)).toBe(true);
    expect(read.has("wd/f09.ts")).toBe(false);
    // The next file is already read when the list moves to it.
    key(p, "down");
    const rows = screen(p).join("\n");
    expect(rows).toContain("wa_f03_0");
    expect(rows).not.toContain(i18n.t`Reading the diff…`);
  } finally {
    p.hide();
    for (const dir of dirs) rmSync(join(root, dir), { recursive: true, force: true });
  }
});

test("find on all files reads past the window until every file is searched", async () => {
  const p = new panel.Panel(local());
  const names = Array.from({ length: 40 }, (_, i) => `many/f${String(i).padStart(2, "0")}.ts`);
  mkdirSync(join(root, "many"), { recursive: true });
  for (const [i, name] of names.entries())
    write(
      name,
      lines(30, j => (i === 39 && j === 10 ? "export const needle = 39;" : `export const line_${j} = ${j};`)),
    );
  try {
    p.follow({ pane: 42, cwd: root, name: "Fix app" });
    p.showScope("uncommitted", null);
    p.show();
    await settle(p);
    screen(p);
    await settle(p);
    key(p, "tab");
    key(p, "/");
    for (const ch of "needle") key(p, ch);
    expect(screen(p).at(-2)).toContain(i18n.t`searching…`);
    await settle(p);
    const rows = screen(p);
    expect(rows.join("\n")).toContain("export const needle = 39;");
    expect(rows.at(-2)).toContain("1/1");
    expect(rows.at(-2)).not.toContain(i18n.t`searching…`);
  } finally {
    p.hide();
    rmSync(join(root, "many"), { recursive: true, force: true });
  }
});
