import { test, expect } from "bun:test";
import { parse, handles, Waiter, list } from "./task_cli";
import { Registry, type Identity } from "./task_registry";

const parent: Identity = { pane: 1, generation: 1n, provider: "claude", session: "p" };
test("task listings identify each workspace and make an empty result explicit", () => {
  const r = new Registry(),
    a = r.add({ kind: "command", workspace: 1, name: "tests" }),
    b = r.add({ kind: "command", workspace: 2, name: "tests" });
  expect(list([])).toBe("no tasks\n");
  expect(list([a, b])).toBe("task:1 tests starting workspace:1\ntask:2 tests starting workspace:2\n");
});
test("run preserves program argv and parses launcher prompts without guessing executable names", async () => {
  expect(
    await parse(["run", "--bg", "--name", "tests", "--workspace", "2", "--", "bun", "test", "--timeout", "9000"]),
  ).toMatchObject({
    op: "start",
    bg: true,
    request: { argv: ["bun", "test", "--timeout", "9000"], workspace: 2, name: "tests" },
  });
  expect(await parse(["run", "--agent", "codex", "--stdin"], 1, async () => "Review branch")).toMatchObject({
    request: { agent: "codex", caller: 1, prompt: "Review branch" },
  });
  for (const words of [
    ["run", "bun", "test"],
    ["run", "--agent", "codex"],
    ["wait"],
    ["wait", "x", "--timeout", "NaN"],
    ["wait", "x", "--children", "all"],
    ["message", "x", "hi", "--busy", "guess"],
  ])
    await expect(parse(words)).rejects.toThrow("Usage");
});
test("legacy messaging stays on its existing path unless orchestration is requested", () => {
  expect(handles(["message", "3", "hi"])).toBe(false);
  expect(handles(["message", "headless:3", "hi"])).toBe(false);
  expect(handles(["message", "--json", "3", "hi"])).toBe(false);
  expect(handles(["message", "--busy", "queue", "3", "hi"])).toBe(true);
  expect(handles(["message", "reviewer", "hi"])).toBe(true);
  expect(handles(["message", "3", "hi", "--busy", "queue"])).toBe(true);
  expect(handles(["message", "3", "--", "--wait"])).toBe(false);
});
test("wait ignores startup idle, returns timeout without mutation, and collects nonzero exits", () => {
  const r = new Registry(),
    task = r.add({ kind: "command", workspace: 1 }),
    waiter = new Waiter(null, null);
  expect(waiter.update(r.snapshot(1, task.id, null))).toBeNull();
  expect(waiter.timeout().exit_code).toBe(124);
  expect(task.state).toBe("starting");
  task.exit_code = 7;
  r.set(task, "failed", "exited");
  expect(waiter.update(r.snapshot(1, task.id, null))).toMatchObject({ exit_code: 7, reason: "exited" });
});
test("wait pins an alias to the accepted task across reconnects and timeout retains the launch ID", () => {
  const r = new Registry(),
    task = r.add({ kind: "command", workspace: 1, name: "tests" }),
    waiter = new Waiter(null, null, null, task);
  expect(waiter.timeout().tasks.map(t => t.id)).toEqual([task.id]);
  waiter.update(r.snapshot(1, task.id, null));
  expect(waiter.target("tests")).toBe(`task:${task.id}`);
  r.add({ kind: "command", workspace: 1, name: "other" });
  expect(waiter.target("tests")).toBe(`task:${task.id}`);
});
test("output waits match only new output, spanning events and reconnect snapshots", () => {
  const r = new Registry(),
    task = r.add({ kind: "command", workspace: 1 }),
    waiter = new Waiter(null, "ready");
  r.append(task, "ready\n");
  expect(waiter.update(r.snapshot(1, task.id, null))).toBeNull();
  r.append(task, "rea");
  expect(waiter.update(r.snapshot(1, task.id, null))).toBeNull();
  expect(waiter.update(r.snapshot(1, task.id, null))).toBeNull();
  r.append(task, "dy");
  expect(waiter.update(r.snapshot(1, task.id, null))).toMatchObject({ reason: "output", exit_code: 0 });
});
test("all children snapshots accepted work, includes queued prompts, and ignores later assignments", () => {
  const r = new Registry(),
    a = r.add({ kind: "agent", pane: 2, workspace: 1, parent }),
    b = r.add({ kind: "agent", pane: 2, workspace: 1, parent }),
    waiter = new Waiter("all", null);
  r.set(a, "running");
  r.set(b, "queued");
  expect(waiter.update(r.snapshot(1, null, parent))).toBeNull();
  r.set(a, "completed");
  expect(waiter.update(r.snapshot(1, null, parent))).toBeNull();
  r.add({ kind: "agent", pane: 3, workspace: 1, parent });
  r.set(b, "completed");
  expect(waiter.update(r.snapshot(1, null, parent))).toMatchObject({ exit_code: 0, reason: "children" });
});
test("output waits fail when a successful command exits without fresh matching output", () => {
  const r = new Registry(),
    task = r.add({ kind: "command", workspace: 1 }),
    waiter = new Waiter(null, "ready");
  waiter.update(r.snapshot(1, task.id, null));
  task.exit_code = 0;
  r.set(task, "completed", "exited");
  expect(waiter.update(r.snapshot(1, task.id, null))).toMatchObject({
    reason: "output_not_found",
    ok: false,
    exit_code: 1,
  });
});
test("any children returns unseen news once acknowledged, including attention events", () => {
  const r = new Registry(),
    task = r.add({ kind: "agent", workspace: 1, parent }),
    waiter = new Waiter("any", null);
  r.set(task, "blocked", "needs_input");
  const result = waiter.update(r.snapshot(1, null, parent));
  expect(result).toMatchObject({ reason: "blocked", exit_code: 1 });
  r.acknowledge(parent, result!.note!.seq);
  expect(new Waiter("any", null).update(r.snapshot(1, null, parent))).toBeNull();
});
test("child waits cannot collect a replacement parent's work after reconnecting", () => {
  const r = new Registry(),
    waiter = new Waiter("any", null);
  waiter.update(r.snapshot(1, null, parent));
  expect(() =>
    waiter.update(r.snapshot(1, null, { ...parent, generation: parent.generation + 1n, session: "replacement" })),
  ).toThrow("ParentChanged");
});
