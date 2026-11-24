import { expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { conversations as opencode } from "./providers/opencode2/search";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Index, sorted, Tracker } from "./conversation_prs";
import { Runtime, Pane } from "./runtime";
import { Workspace } from "./workspace";
import { Terminal } from "./pane/terminal";
import { Path } from "./agents";
import { agent } from "./mirror";
import { snapshot } from "./session";
import { Runtime as Mirror } from "./mirror";
import { rows } from "./agent_rows";
import { transport } from "./fixtures/transport";

const url = (n: number, repo = "acme/app") => `https://github.com/${repo}/pull/${n}`;
test("user and assistant links introduce PRs and later short references raise them", () => {
  const index = new Index();
  index.observe([{ role: "user", text: `12 before any link. [#12](${url(12)}/files) and ${url(7)}.` }]);
  expect(
    index
      .items()
      .map(p => p.number)
      .sort(),
  ).toEqual([12, 7]);
  index.observe([{ role: "assistant", text: `Here's ${url(9)}?diff=split` }]);
  expect(index.items()[0].number).toBe(9);
  index.observe([{ role: "user", text: "please fix 12" }]);
  expect(index.items()[0].number).toBe(12);
  index.observe([{ role: "assistant", text: "then #7" }]);
  expect(index.items()[0].number).toBe(7);
  expect(sorted(index.items(), "number").map(p => p.number)).toEqual([7, 9, 12]);
});
test("tool output, unknown numbers, URL digits, and ambiguous short references do not raise PRs", () => {
  const index = new Index();
  index.observe([{ role: "user", text: `${url(12)} ${url(12, "other/repo")}` }]);
  index.observe([{ role: "assistant", text: url(9) }]);
  index.observe([
    { role: "tool", text: url(99) },
    { role: "user", text: "#12 99 112 version12 12.4 path/12" },
  ]);
  expect(index.items().map(p => p.number)).toEqual([9, 12, 12]);
  index.observe([{ role: "assistant", text: `${url(12, "other/repo")}#discussion` }]);
  expect(index.items()[0].repo).toBe("other/repo");
});
test("code, emphasis, punctuation and host casing preserve canonical PR links", () => {
  const index = new Index();
  index.observe([
    { role: "user", text: "`https://GitHub.com/acme/app/pull/12` **https://github.com/acme/app/pull/9**." },
  ]);
  expect(sorted(index.items(), "number").map(p => p.number)).toEqual([9, 12]);
});
test("wire normalization accepts older snapshots and rejects malformed PR references", () => {
  expect(agent().last_message_at).toBe(0);
  expect(agent({ last_message_at: 1234 }).last_message_at).toBe(1234);
  for (const value of [-1, NaN, Infinity, "1234", null])
    expect(agent({ last_message_at: value }).last_message_at).toBe(0);
  expect(agent().pull_requests).toEqual([]);
  expect(
    agent({ pull_requests: [{ url: url(12), mentioned: 2 }, null, { url: "https://evil.test/12", mentioned: 3 }] })
      .pull_requests,
  ).toHaveLength(1);
});

test("message age tracks user and assistant timestamps without tools or missing stamps resetting it", () => {
  const index = new Index();
  index.observe([{ role: "user", text: "hello", timestamp: 1000 }]);
  index.observe([{ role: "assistant", text: "hi", timestamp: 2000 }]);
  index.observe([
    { role: "tool", text: "result", timestamp: 9000 },
    { role: "user", text: "no stamp" },
  ]);
  index.observe([{ role: "assistant", text: "older", timestamp: 1500 }]);
  expect(index.last_message_at).toBe(2000);
});
test("provider decoders include user input while excluding tool output and injected instructions", async () => {
  const providers = [
    [
      await import("./providers/codex/search"),
      (text: string, role: string) => ({
        type: "response_item",
        payload: { type: "message", role, content: [{ type: "input_text", text }] },
      }),
    ],
    [
      await import("./providers/claude/search"),
      (text: string, role: string) => ({ type: role, message: { role, content: text } }),
    ],
    [
      await import("./providers/pi/search"),
      (text: string, role: string) => ({ type: "message", message: { role, content: text } }),
    ],
    [
      await import("./providers/omp/search"),
      (text: string, role: string) => ({ type: "message", message: { role, content: text } }),
    ],
  ] as const;
  for (const [provider, record] of providers) {
    const index = new Index();
    const text = [
      record(url(12), "user"),
      record(url(9), "assistant"),
      record("fix 12", "user"),
      record(url(99), "tool"),
      record(`# AGENTS.md\n${url(77)}`, "user"),
    ]
      .map(v => JSON.stringify(v) + "\n")
      .join("");
    index.observe(provider.conversations.jsonl(text).messages);
    expect(index.items().map(p => p.number)).toEqual([12, 9]);
  }
});
test("transcript tracking rebuilds history, reads appended user input, and isolates sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-prs-")),
    file = join(dir, "session.jsonl");
  const runtime = new Runtime(),
    terminal = Terminal.create(20, 4),
    pane = new Pane(1, terminal, dir);
  const actor = runtime.conversations.get("codex", "session");
  runtime.workspaces.items = [new Workspace(1, dir)];
  runtime.workspaces.items[0].model.newTab("chat");
  runtime.panes.push(pane);
  pane.attachment.select(actor);
  actor.state.transcript = new Path(file);
  const tracker = new Tracker();
  let changes = 0;
  const message = (text: string, role = "user", timestamp = "2026-11-24T12:00:00.000Z") =>
    JSON.stringify({
      type: "response_item",
      timestamp,
      payload: { type: "message", role, content: [{ type: "input_text", text }] },
    }) + "\n";
  try {
    await writeFile(
      file,
      JSON.stringify({ type: "session_meta", payload: { id: "session", cwd: dir } }) +
        "\n" +
        message(url(12)) +
        message(url(9), "assistant"),
    );
    await tracker.refresh(runtime, () => changes++, 0);
    expect(actor.pull_requests.map(p => p.number)).toEqual([9, 12]);
    expect(actor.last_message_at).toBe(Date.parse("2026-11-24T12:00:00.000Z"));
    expect(snapshot(runtime).panes[0].agent.last_message_at).toBe(actor.last_message_at);
    const mirror = new Mirror();
    try {
      mirror.receive(
        transport(async () => {}),
        {
          ...snapshot(runtime),
          headless_sessions: [
            { id: 2, workspace: 1, provider: "codex", state: "idle", agent: { last_message_at: 1234 } },
          ],
        },
      );
      const entries = rows(mirror, mirror.workspaces.items[0], Date.now()).map(row => row.entry);
      expect(entries.map(e => e.last_message_at)).toEqual([actor.last_message_at, 1234]);
    } finally {
      mirror.destroy();
    }
    const next = message("please update 12"),
      split = next.length - 5;
    await appendFile(file, next.slice(0, split));
    await tracker.refresh(runtime, () => changes++, 2000);
    expect(actor.pull_requests[0].number).toBe(9);
    await appendFile(file, next.slice(split));
    await tracker.refresh(runtime, () => changes++, 4000);
    expect(actor.pull_requests[0].number).toBe(12);
    await tracker.refresh(runtime, () => changes++, 6000);
    expect(changes).toBe(2);
    await appendFile(file, message("A new message without a PR", "assistant", "2026-11-24T12:05:00.000Z"));
    await tracker.refresh(runtime, () => changes++, 8000);
    expect(actor.last_message_at).toBe(Date.parse("2026-11-24T12:05:00.000Z"));
    expect(changes).toBe(3);
    await appendFile(file, message("tool output", "tool", "2026-11-24T12:10:00.000Z"));
    await tracker.refresh(runtime, () => changes++, 10000);
    expect(changes).toBe(3);
    const other = runtime.conversations.get("codex", "other");
    pane.attachment.select(other);
    expect(other.pull_requests).toEqual([]);
    expect(other.last_message_at).toBe(0);
  } finally {
    tracker.stopped = true;
    runtime.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});
test("OpenCode user mentions are read from its store, including WAL updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-pr-db-")),
    file = join(dir, "opencode.db");
  const db = new Database(file, { create: true });
  db.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)",
  );
  const insert = db.query("INSERT INTO session_message VALUES (?, 'session', ?, ?, 1, ?)");
  insert.run("one", "user", 1, JSON.stringify({ text: url(12) }));
  insert.run("two", "assistant", 2, JSON.stringify({ content: [{ type: "text", text: url(9) }] }));
  const runtime = new Runtime(),
    pane = new Pane(1, Terminal.create(20, 4), dir);
  const actor = runtime.conversations.get("opencode2", "session"),
    tracker = new Tracker();
  runtime.workspaces.items = [new Workspace(1, dir)];
  runtime.panes.push(pane);
  pane.attachment.select(actor);
  const previous = opencode.source;
  opencode.source = session => `${file}#${session}`;
  try {
    await tracker.refresh(runtime, () => {}, 0);
    expect(actor.pull_requests.map(p => p.number)).toEqual([9, 12]);
    insert.run("three", "user", 3, JSON.stringify({ text: "fix #12" }));
    await tracker.refresh(runtime, () => {}, 2000);
    expect(actor.pull_requests[0].number).toBe(12);
  } finally {
    opencode.source = previous;
    tracker.stopped = true;
    runtime.destroy();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("bounded transcript rebuilds preserve the complete list until history is fully scanned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-pr-rebuild-")),
    file = join(dir, "session.jsonl");
  const runtime = new Runtime(),
    pane = new Pane(1, Terminal.create(20, 4), dir);
  const actor = runtime.conversations.get("codex", "session");
  runtime.workspaces.items = [new Workspace(1, dir)];
  runtime.panes.push(pane);
  pane.attachment.select(actor);
  actor.state.transcript = new Path(file);
  const tracker = new Tracker();
  actor.pull_requests = [{ ...refForTest(7), mentioned: 1 }];
  const previous = actor.pull_requests;
  const message = (text: string, role = "user") =>
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role, content: [{ type: "input_text", text }] },
    }) + "\n";
  const header = JSON.stringify({ type: "session_meta", payload: { id: "session", cwd: dir } }) + "\n";
  const padding = message("x".repeat(100000), "tool").repeat(24);
  let changes = 0;
  try {
    await writeFile(file, header + message(url(12)) + padding + message(url(9)));
    await tracker.refresh(runtime, () => changes++, 0);
    expect(actor.pull_requests).toBe(previous);
    await tracker.refresh(runtime, () => changes++, 2000);
    expect(actor.pull_requests).toBe(previous);
    await tracker.refresh(runtime, () => changes++, 4000);
    expect(actor.pull_requests.map(p => p.number)).toEqual([9, 12]);
    expect(changes).toBe(1);
    const complete = actor.pull_requests;
    await tracker.refresh(runtime, () => changes++, 6000);
    expect(actor.pull_requests).toBe(complete);
    await writeFile(file, header + message(url(9)) + padding + message(url(12)));
    await tracker.refresh(runtime, () => changes++, 8000);
    expect(actor.pull_requests).toBe(complete);
    await tracker.refresh(runtime, () => changes++, 10000);
    expect(actor.pull_requests).toBe(complete);
    await tracker.refresh(runtime, () => changes++, 12000);
    expect(actor.pull_requests.map(p => p.number)).toEqual([12, 9]);
    expect(changes).toBe(2);
  } finally {
    tracker.stopped = true;
    runtime.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});
function refForTest(number: number) {
  return { url: url(number), repo: "acme/app", number };
}
