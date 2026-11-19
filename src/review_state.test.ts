import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type State } from "./review_state";
const state = (): State => ({
  prs_open: true,
  active: "pr",
  diff: null,
  pr: {
    url: "https://github.com/acme/app/pull/12",
    tab: "discussion",
    top: 7,
    checksOpen: true,
    unresolvedOnly: true,
    openThreads: ["one"],
    foldedThreads: ["two"],
  },
});
test("review state survives recreation and concurrent viewers retain each other's conversations", () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-review-state-")),
    file = join(dir, "state.json");
  try {
    const a = new Store(file),
      b = new Store(file);
    a.put("codex:first", state());
    b.put("codex:second", { ...state(), active: null });
    a.flush();
    b.flush();
    const restored = new Store(file);
    expect(restored.get("codex:first")).toEqual(state());
    expect(restored.get("codex:second")?.active).toBeNull();
    const copy = restored.get("codex:first")!;
    copy.pr!.openThreads.push("changed");
    expect(restored.get("codex:first")?.pr?.openThreads).toEqual(["one"]);
    writeFileSync(
      file,
      JSON.stringify({ bad: { ...state(), pr: { ...state().pr, url: "https://evil.org/" } }, good: state() }),
    );
    expect(new Store(file).get("bad")).toBeNull();
    expect(new Store(file).get("good")).toEqual(state());
    writeFileSync(file, "broken");
    expect(new Store(file).get("good")).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
