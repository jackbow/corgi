import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Input } from "./folders";
import { displayWidth } from "../text";

async function type(input: Input, value: string) {
  input.apply("select_all");
  input.insert(value);
  await input.refresh();
}
test("folder input starts unselected at the end and fuzzy matches sibling names", async () => {
  let reads = 0;
  const input = new Input(
    "/work",
    () => {},
    async () => {
      reads++;
      return ["widget_backend", "web", "wbackend", ".hidden", "other"];
    },
  );
  expect(input.text).toBe("/work/");
  expect(input.caret).toBe(input.text.length);
  expect(input.selection()).toBeNull();
  await input.refresh();
  expect(input.matches).not.toContain("/work/.hidden/");
  await type(input, "/work/WBK");
  expect(input.matches).toEqual(["/work/wbackend/", "/work/widget_backend/"]);
  expect(input.chosen()).toBe("/work/WBK");
  input.moveSuggestion(1);
  input.moveSuggestion(1);
  expect(input.chosen()).toBe("/work/widget_backend/");
  input.moveSuggestion(-1);
  expect(input.chosen()).toBe("/work/wbackend/");
  expect(input.text).toBe("/work/WBK");
  expect(reads).toBe(1);
  expect(input.complete()).toBe(true);
  await input.refresh();
  expect(input.text).toBe("/work/wbackend/");
  expect(input.selection()).toBeNull();
  expect(reads).toBe(2);
});
test("home, relative paths, dot folders and no matches keep literal paths usable", async () => {
  const parents: string[] = [];
  const input = new Input(
    "/work/project",
    () => {},
    async path => {
      parents.push(path);
      return [".cache", "source", "tests"];
    },
    "/users/me",
  );
  await type(input, "~/sr");
  expect(parents.at(-1)).toBe("/users/me");
  expect(input.matches).toEqual(["~/source/"]);
  await type(input, "../sr");
  expect(parents.at(-1)).toBe("/work");
  expect(input.matches).toEqual(["../source/"]);
  await type(input, ".ca");
  expect(input.matches).toEqual([".cache/"]);
  await type(input, "missing");
  expect(input.matches).toEqual([]);
  input.moveSuggestion(1);
  expect(input.complete()).toBe(false);
  expect(input.chosen()).toBe("missing");
  await type(input, "");
  expect(input.chosen()).toBe("");
  input.moveSuggestion(-1);
  expect(input.chosen()).toBe("source/");
});
test("directory discovery includes folder symlinks and excludes files and broken links", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-folder-completion-"));
  try {
    mkdirSync(join(root, "folder with spaces"));
    writeFileSync(join(root, "file"), "");
    symlinkSync(join(root, "folder with spaces"), join(root, "linked"));
    symlinkSync(join(root, "file"), join(root, "linked-file"));
    symlinkSync(join(root, "missing"), join(root, "broken"));
    const input = new Input(root);
    await input.refresh();
    expect(input.matches).toEqual([join(root, "linked") + "/", join(root, "folder with spaces") + "/"]);
    await type(input, root + "/fws");
    expect(input.matches).toEqual([join(root, "folder with spaces") + "/"]);
    input.complete();
    await input.refresh();
    expect(input.text).toBe(join(root, "folder with spaces") + "/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("late directory reads cannot replace a newer query or its error", async () => {
  const pending = new Map<string, (names: string[]) => void>();
  let changes = 0;
  const input = new Input(
    "/work",
    () => changes++,
    path => new Promise(resolve => pending.set(path, resolve)),
  );
  const first = input.refresh();
  input.insert("next/");
  const second = input.refresh();
  pending.get("/work/next")!(["current"]);
  await second;
  pending.get("/work")!(["stale"]);
  await first;
  expect(input.matches).toEqual(["/work/next/current/"]);
  expect(changes).toBe(1);
  expect(input.loading).toBe(false);
});
test("unreadable folders show a recoverable error and retry on editing", async () => {
  let fail = true;
  const input = new Input(
    "/work",
    () => {},
    async () => {
      if (fail) throw Error("EACCES");
      return ["okay"];
    },
  );
  await input.refresh();
  expect(input.problem).toContain("Cannot read folders");
  expect(input.matches).toEqual([]);
  expect(input.chosen()).toBe("/work/");
  fail = false;
  await input.refresh();
  expect(input.problem).toBeNull();
  expect(input.matches).toEqual(["/work/okay/"]);
});
test("the path viewport keeps wide characters and the end caret inside the field", () => {
  const input = new Input("/very/long/目录/🦊/path");
  const view = input.viewport(12),
    shown = input.text.slice(view.line.start, view.line.end);
  expect(displayWidth(shown)).toBeLessThanOrEqual(12);
  expect(view.caret).toBeLessThan(12);
  expect(shown).toEndWith("path/");
  expect(shown).not.toContain("�");
  input.apply("line_start");
  const start = input.viewport(12);
  expect(start.line.start).toBe(0);
  expect(start.caret).toBe(0);
});
