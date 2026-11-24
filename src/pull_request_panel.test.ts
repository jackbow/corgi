import { expect, test } from "bun:test";
import { Panel } from "./pull_request_panel";
import { Cache, Client, stale_ms } from "./pull_request";
import { snapshot } from "./fixtures/pull_request";
import { Terminal } from "./pane/terminal";
import { Writer } from "./text";
import * as palette from "./palette";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
test("opening renders stale cached content before refreshing and keeps it on network failure", async () => {
  const s = snapshot(),
    pending = deferred<typeof s>(),
    cache = new Cache();
  s.fetched -= stale_ms;
  cache.cached = async () => s;
  cache.refresh = () => {
    expect(p.snapshot).toEqual(s);
    return pending.promise;
  };
  const p = new Panel(cache),
    opening = p.show(s.ref);
  await Promise.resolve();
  expect(p.snapshot).toEqual(s);
  expect(p.refreshing).toBe(true);
  pending.reject(new Error("offline"));
  await opening;
  expect(p.snapshot).toEqual(s);
  expect(p.error).toBe("offline");
  expect(p.refreshing).toBe(false);
  let fetches = 0;
  cache.refresh = async () => {
    fetches++;
    return { ...s, title: "Updated", fetched: Date.now() };
  };
  await p.show(s.ref);
  cache.cached = async () => p.snapshot;
  await p.show(s.ref);
  expect(p.snapshot?.title).toBe("Updated");
  expect(fetches).toBe(1);
  await p.show(s.ref, true);
  expect(fetches).toBe(2);
});
test("stale content retains navigation, and late reads cannot replace another PR", async () => {
  const a = snapshot(),
    b = snapshot(13),
    pending = deferred<typeof a>(),
    cache = new Cache();
  cache.cached = async () => null;
  cache.refresh = ref => (ref.number === 12 ? pending.promise : Promise.resolve(b));
  const p = new Panel(cache);
  p.ref = a.ref;
  p.snapshot = { ...a, fetched: Date.now() - stale_ms };
  p.tab = "discussion";
  p.top = 7;
  const first = p.show(a.ref);
  expect(p.snapshot?.ref.url).toBe(a.ref.url);
  expect(p.tab).toBe("discussion");
  expect(p.top).toBe(7);
  await Promise.resolve();
  await p.show(b.ref);
  pending.resolve(a);
  await first;
  expect(p.snapshot?.ref.number).toBe(13);
  expect(p.refreshing).toBe(false);
});
test("fresh and merged cached PRs skip automatic refresh while manual refresh still works", async () => {
  const cache = new Cache(),
    p = new Panel(cache);
  let fetches = 0;
  for (const s of [snapshot(), { ...snapshot(13), state: "MERGED" as const, fetched: Date.now() - stale_ms * 10 }]) {
    cache.cached = async () => s;
    cache.refresh = async () => {
      fetches++;
      return s;
    };
    await p.show(s.ref);
    expect(p.snapshot).toEqual(s);
    expect(p.refreshing).toBe(false);
    expect(fetches).toBe(0);
  }
  await p.show(snapshot(13).ref, true);
  expect(fetches).toBe(1);
  cache.cached = async () => null;
  await p.show(snapshot(13).ref);
  expect(fetches).toBe(2);
});

function screen(p: Panel, width = 70, height = 30) {
  const writer = new Writer(),
    terminal = new Terminal(width + 4, height + 2);
  try {
    p.draw(writer, 2, 1, width, height, true);
    terminal.feed(writer.buffered());
    return terminal.text().split("\n");
  } finally {
    terminal.destroy();
  }
}
function click(p: Panel, rows: string[], label: string) {
  const y = rows.findIndex(row => row.includes(label));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = rows[y].indexOf(label) + 1;
  expect(p.mouse(0, x, y)).toBeNull();
  return p.mouse(0, x, y, true);
}
test("framed tabs, checks and discussion use mouse and keyboard actions", () => {
  const p = new Panel(),
    s = snapshot();
  s.checks = [
    { title: "lint", state: "passed" },
    { title: "unit tests", state: "failed", id: "123" },
    { title: "deploy", state: "pending" },
  ];
  s.comments = [{ author: "reviewer", body: "**hello**\x1b[2Jworld", at: "today", path: "app.ts" }];
  s.stack = [
    {
      ...snapshot(13).ref,
      title: "Child PR title",
      headBranch: "child",
      baseBranch: s.headBranch,
      state: "OPEN",
      draft: false,
    },
  ];
  p.snapshot = s;
  p.ref = s.ref;
  let rows = screen(p);
  expect(rows.join("\n")).toContain("╭");
  expect(rows.join("\n")).toContain("Approval pending");
  expect(rows.join("\n")).toContain("No merge conflicts");
  expect(click(p, rows, "Checks:")).toEqual({ name: "pull-request-checks" });
  p.checksOpen = true;
  rows = screen(p, 70, 45);
  expect(rows.join("\n")).not.toContain("lint");
  expect(rows.join("\n")).toContain("deploy");
  expect(click(p, rows, "unit tests")).toEqual({ name: "pull-request-retry", value: "123" });
  expect(p.key({ text: "R" })).toEqual({ name: "pull-request-retry", value: "" });
  p.selectTab("discussion");
  rows = screen(p);
  expect(rows.join("\n")).toContain("hello [2Jworld");
  expect(rows.join("\n")).not.toContain("**hello**");
  expect(rows.join("\n")).toContain("@reviewer");
  p.selectTab("stack");
  rows = screen(p);
  expect(click(p, rows, "Child PR title")).toEqual({ name: "pull-request", value: s.stack[0].url });
  expect(p.key({ text: "2" })).toEqual({ name: "pull-request-tab", value: "discussion" });
  p.key({ named: "tab" });
  expect(p.key({ named: "enter" })).toEqual({ name: "zoom" });
});
test("narrow panels retain fixed actions while scrolling and cancel dragged clicks", () => {
  const p = new Panel(),
    s = snapshot();
  s.title = "A very long PR title with 界 and more text";
  s.body = Array.from({ length: 60 }, (_, i) => "paragraph " + i).join("\n\n");
  p.ref = s.ref;
  p.snapshot = s;
  const rows = screen(p, 40, 24);
  expect(click(p, rows, "Diff · d")).toEqual({ name: "pull-request-diff" });
  expect(click(p, rows, "Merge · m")).toEqual({ name: "pull-request-merge" });
  p.mouse(65, 10, 12);
  expect(p.top).toBe(3);
  const scrolled = screen(p, 40, 24);
  expect(scrolled.findIndex(row => row.includes("Diff · d"))).toBe(rows.findIndex(row => row.includes("Diff · d")));
  const y = scrolled.findIndex(row => row.includes("Diff · d"));
  p.mouse(0, 8, y);
  expect(p.mouse(0, 0, 0, true)).toBeNull();
  p.mouse(0, 8, y);
  p.mouse(32, 12, y - 3);
  expect(p.mouse(0, 8, y, true)).toBeNull();
  p.key({ named: "end" });
  screen(p, 40, 24);
  expect(p.top).toBeGreaterThan(3);
  p.key({ named: "home" });
  expect(p.top).toBe(0);
});
test("loading, draft and closed views disable mutations and hover does not change keyboard focus", () => {
  const p = new Panel(),
    s = snapshot();
  p.ref = s.ref;
  p.snapshot = s;
  let rows = screen(p);
  const first = p.key({ named: "enter" });
  const y = rows.findIndex(row => row.includes("Diff · d"));
  p.mouse(35, 8, y);
  expect(p.key({ named: "enter" })).toEqual(first);
  for (const state of ["refreshing", "draft", "closed"] as const) {
    p.refreshing = state === "refreshing";
    s.draft = state === "draft";
    s.state = state === "closed" ? "CLOSED" : "OPEN";
    rows = screen(p);
    if (state === "draft") expect(rows.join("\n")).toContain("Mark ready");
    else {
      expect(rows.join("\n")).not.toContain("Merge · m");
    }
  }
});
test("merge requires method confirmation on the displayed snapshot and is blocked during refresh/errors", async () => {
  const client = new Client(),
    s = snapshot(),
    cache = new Cache(client),
    p = new Panel(cache);
  p.snapshot = s;
  p.ref = s.ref;
  p.refreshing = true;
  p.requestMerge("merge");
  expect(p.confirmation).toBeNull();
  p.refreshing = false;
  p.error = "offline";
  p.requestMerge("merge");
  expect(p.confirmation).toBeNull();
  p.error = "";
  p.requestMerge("merge");
  expect(p.confirmation?.snapshot.head).toBe(s.head);
  screen(p);
  expect(p.key({ named: "enter" })).toEqual({ name: "pull-request-confirm", value: "squash" });
  expect(p.rows(66).find(row => row.text.trim() === "Squash and merge")?.action).toEqual({
    name: "pull-request-confirm",
    value: "squash",
  });
  let changed = false;
  client.mutate = async (current, mutation) => {
    expect(current).toBe(s);
    expect(mutation).toEqual({ kind: "merge", method: "squash" });
    changed = true;
  };
  cache.refresh = async () => ({ ...s, state: "MERGED" });
  await p.mutate({ kind: "merge", method: "squash" }, p.confirmation!.snapshot);
  expect(changed).toBe(true);
  expect(p.snapshot?.state).toBe("MERGED");
  expect(p.confirmation).toBeNull();
  expect(p.busy).toBe(false);
});

test("resolved threads start folded, unresolved threads stay readable, and discussion is newest first", () => {
  const p = new Panel(),
    s = snapshot();
  p.snapshot = s;
  p.ref = s.ref;
  p.selectTab("discussion");
  const comment = (body: string, at: string) => ({ author: "reviewer", body, at, path: "app.ts" });
  s.comments = [comment("old discussion", "2026-01-01"), comment("new discussion", "2026-01-05")];
  s.threads = [
    { id: "done", resolved: true, path: "done.ts", comments: [comment("resolved hidden body", "2026-01-04")] },
    {
      id: "open",
      resolved: false,
      path: "open.ts",
      comments: [comment("old reply", "2026-01-02"), comment("new reply", "2026-01-03")],
    },
  ];
  let rows = screen(p, 90, 55),
    text = rows.join("\n");
  expect(text).toContain("1 unresolved · 1 resolved");
  expect(text).not.toContain("resolved hidden body");
  expect(text.indexOf("new discussion")).toBeLessThan(text.indexOf("Resolved"));
  expect(text.indexOf("Resolved")).toBeLessThan(text.indexOf("Unresolved"));
  expect(text.indexOf("new reply")).toBeLessThan(text.indexOf("old reply"));
  expect(text.indexOf("old reply")).toBeLessThan(text.indexOf("old discussion"));
  expect(click(p, rows, "Resolved")).toEqual({ name: "pull-request-thread", value: "done" });
  p.openThreads.add("done");
  rows = screen(p, 90, 55);
  expect(rows.join("\n")).toContain("resolved hidden body");
  p.foldedThreads.add("open");
  rows = screen(p, 90, 55);
  expect(rows.join("\n")).not.toContain("new reply");
});

test("drafts show the inline ready action and unavailable mergeability without a raw Unknown status", () => {
  const p = new Panel(),
    s = snapshot();
  p.snapshot = s;
  p.ref = s.ref;
  s.draft = true;
  s.mergeable = s.mergeState = "UNKNOWN";
  s.decision = "";
  let text = screen(p, 90, 40).join("\n");
  expect(text).toContain("Draft [ Mark ready - v ]");
  expect(text).not.toContain("mark ready for review to merge");
  expect(text).not.toContain("merge unavailable until marked ready");
  expect(text).toContain("Conflict status not available for this draft");
  expect(text).not.toContain("Unknown");
  expect(text).not.toContain("Checking for conflicts");
  s.draft = false;
  text = screen(p, 90, 40).join("\n");
  expect(text).toContain("GitHub has not calculated mergeability");
  expect(text).toContain("╭─ Description");
  expect(text).toContain("│ Description");
});

test("stack titles read base first with dependents nested and siblings kept on separate branches", () => {
  const p = new Panel(),
    s = snapshot();
  p.ref = s.ref;
  p.snapshot = s;
  const node = (number: number, title: string, headBranch: string, baseBranch: string) => ({
    ...snapshot(number).ref,
    title,
    headBranch,
    baseBranch,
    state: "OPEN" as const,
    draft: false,
  });
  s.baseBranch = "parent";
  s.stack = [
    node(14, "Second child", "sibling", "topic"),
    node(10, "Stack foundation", "foundation", "main"),
    node(15, "Grandchild", "leaf", "child"),
    node(13, "First child", "child", "topic"),
    node(11, "Stack parent", "parent", "foundation"),
  ];
  p.selectTab("stack");
  const rows = screen(p, 90, 60),
    text = rows.slice(8).join("\n");
  const titles = ["Stack foundation", "Stack parent", s.title, "First child", "Grandchild", "Second child"];
  const positions = titles.map(title => text.indexOf(title));
  expect(positions.every(at => at >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(text).toContain("#12 · This PR");
  const first = rows.find(row => row.includes("#13"))!,
    second = rows.find(row => row.includes("#14"))!;
  expect(first.indexOf("├─")).toBe(second.indexOf("└─"));
  expect(click(p, rows, "Stack parent")).toEqual({ name: "pull-request", value: snapshot(11).ref.url });
});

test("draft ready and browser controls have mouse and keyboard parity", () => {
  const p = new Panel(),
    s = snapshot();
  p.ref = s.ref;
  p.snapshot = s;
  s.draft = true;
  const rows = screen(p);
  expect(click(p, rows, "Mark ready")).toEqual({ name: "pull-request-ready" });
  const draftRow = rows.findIndex(row => row.includes("Draft [ Mark ready - v ]"));
  expect(draftRow).toBeGreaterThanOrEqual(0);
  expect(p.mouse(0, rows[draftRow].indexOf("Draft") + 1, draftRow, true)).toBeNull();
  expect(click(p, screen(p, 42, 30), "Mark ready - v")).toEqual({ name: "pull-request-ready" });
  expect(p.key({ text: "v" })).toEqual({ name: "pull-request-ready" });
  expect(click(p, rows, "Open · o")).toEqual({ name: "pull-request-browser" });
  expect(click(p, rows, "acme/app #12")).toEqual({ name: "pull-request-browser" });
  expect(rows.join("\n")).not.toContain("Open in browser");
  expect(rows.findIndex(row => row.includes("Overview"))).toBe(5);
  expect(p.key({ text: "o" })).toEqual({ name: "pull-request-browser" });
  p.refreshing = true;
  expect(click(p, screen(p), "Mark ready")).toBeNull();
});

test("unresolved-only discussion excludes general comments and resolved threads without losing folds", () => {
  const p = new Panel(),
    s = snapshot();
  p.ref = s.ref;
  p.snapshot = s;
  p.selectTab("discussion");
  const comment = { author: "reviewer", body: "Keep this unresolved", at: "2026-11-13", path: "app.ts" };
  s.comments = [{ ...comment, body: "General discussion" }];
  s.threads = [
    { id: "done", resolved: true, path: "done.ts", comments: [{ ...comment, body: "Resolved content" }] },
    { id: "open", resolved: false, path: "open.ts", comments: [comment] },
  ];
  p.openThreads.add("done");
  expect(click(p, screen(p, 90, 55), "All discussion")).toEqual({ name: "pull-request-filter" });
  expect(p.key({ text: "u" })).toEqual({ name: "pull-request-filter" });
  p.unresolvedOnly = true;
  let text = screen(p, 90, 55).join("\n");
  expect(text).toContain("Keep this unresolved");
  expect(text).not.toContain("Resolved content");
  expect(text).not.toContain("General discussion");
  p.unresolvedOnly = false;
  text = screen(p, 90, 55).join("\n");
  expect(text).toContain("Resolved content");
  expect(text).toContain("General discussion");
});

test("draft status uses warning orange while inline code uses the syntax string color", () => {
  const p = new Panel(),
    s = snapshot();
  p.ref = s.ref;
  p.snapshot = s;
  s.draft = true;
  s.body = "Use `example()` here";
  const writer = new Writer();
  p.draw(writer, 0, 0, 90, 45, true);
  const output = writer.buffered().toString();
  expect(output).toContain(new palette.Style({ fg: "warm", bg: "surface", bold: false }).sgr() + " ● Draft");
  expect(output).toContain(palette.fgRgb(palette.syntax.string) + "example()");
});

test("PullApprove summaries are visible even when checks are folded", () => {
  const p = new Panel(),
    s = snapshot();
  p.ref = s.ref;
  p.snapshot = s;
  s.checks = [{ title: "pullapprove5", state: "pending", summary: "One approval required" }];
  expect(screen(p, 90, 45).join("\n")).toContain("PullApprove · One approval required");
});

test("overview sections and discussion entries use matching closed cards at narrow and normal widths", () => {
  const p = new Panel(),
    s = snapshot();
  p.ref = s.ref;
  p.snapshot = s;
  s.body = "Long description with `code` and 界 ".repeat(12);
  for (const width of [38, 88]) {
    const rows = screen(p, width + 2, 85);
    const text = rows.join("\n");
    for (const label of ["Merge readiness", "Checks", "Reviewers", "Labels", "Description"])
      expect(text).toContain("╭─ " + label);
    expect(rows.filter(row => row.includes("╰")).length).toBe(6);
    // The card border is not part of a button's hit target.
    const y = rows.findIndex(row => row.includes("Checks:"));
    expect(p.mouse(0, 3, y)).toBeNull();
    expect(p.mouse(0, 3, y, true)).toBeNull();
    expect(click(p, rows, "Checks:")).toEqual({ name: "pull-request-checks" });
  }
  s.comments = [{ author: "reviewer", body: "hello", at: "2026-11-13", path: "" }];
  s.threads = [
    {
      id: "done",
      resolved: true,
      path: "done.ts",
      comments: [{ author: "reviewer", body: "hidden", at: "2026-11-12", path: "done.ts" }],
    },
  ];
  p.selectTab("discussion");
  const rows = screen(p, 70, 45),
    text = rows.join("\n");
  expect(text).toContain("╭─ Comments and reviews");
  expect(text).toContain("╭─ @reviewer");
  expect(text).toContain("╭─ done.ts");
  expect(text).not.toContain("hidden");
  expect(click(p, rows, "Resolved")).toEqual({ name: "pull-request-thread", value: "done" });
});

test("Discussion tab counts only unresolved threads and uses the refreshed readiness count", () => {
  const p = new Panel(),
    s = snapshot();
  p.snapshot = s;
  p.ref = s.ref;
  s.threads = [false, true, false].map((resolved, index) => ({
    id: String(index),
    resolved,
    path: "app.ts",
    comments: [],
  }));
  for (const width of [42, 90]) {
    const rows = screen(p, width, 35);
    expect(click(p, rows, "Discussion (2)")).toEqual({ name: "pull-request-tab", value: "discussion" });
    s.stack = [
      {
        ...snapshot(13).ref,
        title: "Child",
        headBranch: "child",
        baseBranch: s.headBranch,
        state: "OPEN",
        draft: false,
      },
    ];
    expect(click(p, screen(p, width, 35), "Discussion (2)")).toEqual({ name: "pull-request-tab", value: "discussion" });
    s.stack = [];
  }
  s.unresolved = 5;
  expect(screen(p).join("\n")).toContain("Discussion (5)");
  s.unresolved = 0;
  const rows = screen(p);
  expect(rows.join("\n")).not.toContain("Discussion (");
  expect(click(p, rows, "Discussion")).toEqual({ name: "pull-request-tab", value: "discussion" });
});

test("readiness has compact actions, unresolved count and independent refresh while noise is hidden", () => {
  const p = new Panel(),
    s = snapshot();
  p.snapshot = s;
  p.ref = s.ref;
  s.mergeable = "CONFLICTING";
  s.unresolved = 2;
  s.decision = "";
  const rows = screen(p, 90, 55),
    text = rows.join("\n");
  expect(click(p, rows, "Resolve conflicts with Codex")).toEqual({ name: "pull-request-conflicts" });
  expect(click(p, rows, "Merge · m")).toEqual({ name: "pull-request-merge" });
  expect(click(p, rows, "Refresh readiness / checks")).toEqual({ name: "pull-request-status" });
  expect(click(p, rows, "2 unresolved comments")).toEqual({ name: "pull-request-tab", value: "discussion" });
  expect(text).not.toContain("not reported");
  expect(text).not.toContain("Auto-merge:");
  expect(text).toContain("Stack");
  s.draft = true;
  expect(click(p, screen(p, 90, 55), "Mark ready - v")).toEqual({ name: "pull-request-ready" });
  s.autoMerge = true;
  expect(screen(p, 90, 55).join("\n")).toContain("Auto-merge enabled");
});

test("stack tab reports base-first position and stack merge confirmation warns about dependents", () => {
  const p = new Panel(),
    s = snapshot();
  p.snapshot = s;
  p.ref = s.ref;
  s.baseBranch = "parent";
  const node = (n: number, headBranch: string, baseBranch: string) => ({
    ...snapshot(n).ref,
    title: "PR " + n,
    headBranch,
    baseBranch,
    state: "OPEN" as const,
    draft: false,
  });
  s.stack = [node(13, "child", s.headBranch), node(11, "parent", "main")];
  const rows = screen(p, 90, 50);
  expect(click(p, rows, "Stack (2/3)")).toEqual({ name: "pull-request-tab", value: "stack" });
  p.requestMerge("merge");
  const text = screen(p, 90, 50).join("\n");
  expect(text).toContain("part of a stack of 3 PRs");
  expect(text).toContain("dependents may need updating");
  expect(p.key({ named: "enter" })).toEqual({ name: "pull-request-confirm", value: "squash" });
});

test("status refresh preserves discussion navigation and ignores late updates after changing PR", async () => {
  const p = new Panel(),
    s = snapshot(),
    pending = deferred<typeof s>();
  p.ref = s.ref;
  p.snapshot = s;
  p.tab = "discussion";
  p.top = 7;
  p.unresolvedOnly = true;
  p.cache.status = () => pending.promise;
  const work = p.refreshStatus();
  expect(p.statusRefreshing).toBe(true);
  pending.resolve({ ...s, unresolved: 4 });
  await work;
  expect(p.snapshot?.unresolved).toBe(4);
  expect(p.top).toBe(7);
  expect(p.tab).toBe("discussion");
  expect(p.unresolvedOnly).toBe(true);
  const late = deferred<typeof s>(),
    next = snapshot(13);
  p.cache.status = () => late.promise;
  const old = p.refreshStatus();
  p.cache.cached = async () => next;
  p.cache.refresh = async () => next;
  await p.show(next.ref);
  expect(p.statusRefreshing).toBe(false);
  late.resolve({ ...s, unresolved: 99 });
  await old;
  expect(p.snapshot?.ref.url).toBe(next.ref.url);
  expect(p.snapshot?.unresolved).not.toBe(99);
});

test("discussion renders saved file context and exposes send, reply and new comment controls", () => {
  const p = new Panel(),
    s = snapshot();
  s.threads = [
    {
      id: "t",
      path: "app.ts",
      line: 3,
      resolved: false,
      comments: [
        {
          author: "alice",
          body: "Fix this",
          path: "app.ts",
          at: "2026-01-01",
          diffHunk: "@@ -2 +2,2 @@\n same\n+added",
        },
      ],
    },
  ];
  s.comments = [{ author: "bob", body: "Looks good", path: "", at: "2026-01-02" }];
  p.snapshot = s;
  p.ref = s.ref;
  p.tab = "discussion";
  const rows = p.rows(70),
    text = rows.map(r => r.text).join("\n");
  for (const label of ["app.ts:3", "+added", "New comment", "Send to agent", "Reply to thread"])
    expect(text).toContain(label);
  const send = rows.find(
    r => r.action?.name === "pull-request-comment-send" && p.commentTarget(String(r.action.value))?.thread,
  );
  expect(p.commentTarget(String(send?.action?.value))?.comment.author).toBe("alice");
  p.snapshot = snapshot(13);
  expect(p.commentTarget(String(send?.action?.value))).toBeNull();
  expect(p.commentTarget("invalid")).toBeNull();
});
test("comment composer edits shortcut letters, multiline UTF-8 paste and explicit posting", () => {
  const p = new Panel();
  p.snapshot = snapshot();
  p.ref = p.snapshot.ref;
  p.beginComment();
  for (const text of "rqumadf123") expect(p.key({ text })).toBeNull();
  p.key({ named: "enter" });
  for (const byte of Buffer.from("héllo\r\nworld")) p.pasteByte(byte);
  expect(p.compose?.area.text).toBe("rqumadf123\nhéllo\nworld");
  p.key({ named: "left" });
  p.key({ text: "!" });
  expect(p.compose?.area.text).toEndWith("worl!d");
  screen(p, 70, 30);
  p.key({ named: "tab" });
  expect(p.key({ named: "enter" })).toEqual({ name: "pull-request-comment-post" });
  p.key({ named: "tab" });
  expect(p.key({ named: "enter" })).toEqual({ name: "pull-request-comment-cancel" });
  p.key({ named: "shift_tab" });
  p.key({ text: "z" });
  expect(p.key({ named: "enter" })).toBeNull();
  expect(p.compose?.area.text).toContain("z\n");
  expect(p.key({ named: "escape" })).toEqual({ name: "pull-request-comment-cancel" });
});
test("failed comments retain drafts; accepted comments clear even when refresh fails", async () => {
  const p = new Panel(),
    s = snapshot(),
    calls: unknown[] = [];
  p.snapshot = s;
  p.ref = s.ref;
  s.threads = [{ id: "t", path: "x.ts", comments: [], resolved: true }];
  p.beginComment("not-in-pr");
  expect(p.compose).toBeNull();
  p.beginComment("t");
  p.compose!.area.insert("Reply");
  p.cache.client.mutate = async () => {
    throw new Error("offline");
  };
  await p.postComment();
  expect(p.compose?.area.text).toBe("Reply");
  expect(p.error).toBe("offline");
  p.cache.client.mutate = async (snapshot, mutation) => {
    calls.push([snapshot.ref.url, mutation]);
  };
  p.cache.refresh = async () => {
    throw new Error("offline");
  };
  await p.postComment();
  expect(calls).toEqual([[s.ref.url, { kind: "comment", body: "Reply", thread: "t" }]]);
  expect(p.compose).toBeNull();
  expect(p.error).toContain("Comment posted; refresh failed");
  await p.postComment();
  expect(calls).toHaveLength(1);
});
test("in-flight comment stays bound to its original PR when the viewer navigates", async () => {
  const p = new Panel(),
    a = snapshot(),
    b = snapshot(13),
    write = deferred<void>();
  p.snapshot = a;
  p.ref = a.ref;
  p.beginComment();
  p.compose!.area.insert("Hello");
  p.cache.client.mutate = () => write.promise;
  p.cache.refresh = async ref => {
    expect(ref.url).toBe(a.ref.url);
    return a;
  };
  const posting = p.postComment();
  p.ref = b.ref;
  p.snapshot = b;
  p.compose = null;
  write.resolve();
  await posting;
  expect(p.snapshot).toBe(b);
  expect(p.busy).toBe(false);
});

test("legacy cached discussion loads file context on demand even for merged PRs", async () => {
  const p = new Panel(),
    old = snapshot(),
    fresh = snapshot();
  old.state = fresh.state = "MERGED";
  delete old.discussionVersion;
  let reads = 0;
  p.cache.cached = async () => old;
  p.cache.section = async (_, section) => {
    expect(section).toBe("discussion");
    reads++;
    return fresh;
  };
  await p.show(old.ref);
  expect(reads).toBe(0);
  p.selectTab("discussion");
  await Bun.sleep(0);
  expect(reads).toBe(1);
  expect(p.snapshot?.discussionVersion).toBe(1);
});
test("send targets retain comment identity when refreshed comments change order", () => {
  const p = new Panel(),
    s = snapshot();
  const first = { author: "alice", body: "First", at: "2026-01-01", path: "" },
    second = { ...first, body: "Second" };
  p.snapshot = s;
  p.ref = s.ref;
  p.tab = "discussion";
  s.comments = [first, second];
  const value = String(p.rows(70).find(r => r.action?.name === "pull-request-comment-send")!.action!.value);
  s.comments.reverse();
  expect(p.commentTarget(value)?.comment.body).toBe("First");
  first.body = "Edited";
  expect(p.commentTarget(value)).toBeNull();
});
test("long pasted drafts scroll to the caret while keeping the posting controls visible", () => {
  const p = new Panel();
  p.snapshot = snapshot();
  p.ref = p.snapshot.ref;
  p.beginComment();
  screen(p, 40, 20);
  for (const byte of Buffer.from(Array.from({ length: 30 }, (_, i) => `Line ${i}`).join("\n"))) p.pasteByte(byte);
  const rows = screen(p, 40, 20);
  expect(rows.join("\n")).toContain("Line 29");
  expect(rows.join("\n")).toContain("Post to GitHub");
  expect(p.top).toBeGreaterThan(0);
  p.key({ named: "home" });
  p.key({ named: "up" });
  expect(p.compose?.area.position().row).toBe(28);
});

test("overview renders before readiness and loads only opened sections", async () => {
  const basic = { ...snapshot(), loaded: [] as ("discussion" | "checks" | "stack")[], statusFetched: undefined },
    cache = new Cache(),
    p = new Panel(cache),
    readiness = deferred<typeof basic>();
  const calls: string[] = [],
    details = new Map<string, ReturnType<typeof deferred<typeof basic>>>();
  cache.cached = async () => basic;
  cache.status = () => readiness.promise;
  cache.section = (_, section) => {
    calls.push(section);
    const pending = deferred<typeof basic>();
    details.set(section, pending);
    return pending.promise;
  };
  await p.show(basic.ref);
  expect(p.snapshot?.title).toBe(basic.title);
  expect(p.statusRefreshing).toBe(true);
  expect(calls).toEqual([]);
  let text = screen(p, 90, 45).join("\n");
  expect(text).toContain("Approval pending");
  expect(text).not.toContain("0 passed");
  readiness.resolve({ ...basic, checkSummary: "failed", unresolved: 2 });
  await Bun.sleep(0);
  text = screen(p, 90, 45).join("\n");
  expect(text).toContain("Failed");
  expect(text).toContain("2 unresolved comments");
  p.toggleChecks();
  expect(calls).toEqual(["checks"]);
  expect(screen(p).join("\n")).not.toContain("All checks passed");
  details.get("checks")!.resolve({ ...basic, loaded: ["checks"], checks: [{ title: "lint", state: "failed" }] });
  await Bun.sleep(0);
  p.selectTab("discussion");
  expect(calls).toEqual(["checks", "discussion"]);
  expect(screen(p).join("\n")).not.toContain("No comments");
  details.get("discussion")!.reject(Error("discussion offline"));
  await Bun.sleep(0);
  expect(screen(p).join("\n")).toContain("discussion offline");
  expect(p.error).toBe("");
  expect(p.key({ text: "d" })).toEqual({ name: "pull-request-diff" });
  p.selectTab("stack");
  expect(calls).toEqual(["checks", "discussion", "stack"]);
  expect(screen(p).join("\n")).not.toContain("No related PRs");
  const next = snapshot(13);
  cache.cached = async () => ({ ...next, loaded: [] });
  await p.show(next.ref);
  details.get("stack")!.resolve({ ...basic, loaded: ["stack"] });
  await Bun.sleep(0);
  expect(p.snapshot?.ref.url).toBe(next.ref.url);
});

test("a refresh reloads the open section after an older section request finishes", async () => {
  const old = { ...snapshot(), loaded: [] as ("discussion" | "checks" | "stack")[] },
    fresh = { ...old, fetched: old.fetched + 1 },
    p = new Panel(),
    pending = deferred<typeof old>();
  let reads = 0;
  p.ref = old.ref;
  p.snapshot = old;
  p.cache.section = async (snapshot, section) => {
    expect(section).toBe("discussion");
    reads++;
    return reads === 1
      ? pending.promise
      : {
          ...snapshot,
          loaded: ["discussion"],
          comments: [{ author: "alice", at: "now", path: "", body: "fresh comment" }],
        };
  };
  p.cache.status = async () => fresh;
  p.selectTab("discussion");
  await p.refreshStatus();
  pending.resolve({ ...old, loaded: ["discussion"] });
  await Bun.sleep(0);
  expect(reads).toBe(2);
  expect(p.snapshot?.comments[0].body).toBe("fresh comment");
});
