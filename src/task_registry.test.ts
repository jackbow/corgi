import { test, expect } from "bun:test";
import { Registry, Output, output_bytes, retained, type Identity } from "./task_registry";
import * as json from "./json";

const parent: Identity = { pane: 1, generation: 3n, provider: "codex", session: "parent" };
test("task IDs and names survive collection independently of panes and display labels", () => {
  const r = new Registry(),
    first = r.add({ kind: "command", workspace: 1, name: "tests" });
  expect(() => r.add({ kind: "command", workspace: 1, name: "tests" })).toThrow("TaskNameInUse");
  r.append(first, "ok\n");
  first.exit_code = 0;
  r.set(first, "completed", "exited");
  const second = r.add({ kind: "command", workspace: 1, name: "tests" });
  expect(r.resolve("tests", 1, null)).toBe(second);
  expect(r.resolve(`task:${first.id}`, 0, null).output).toBe("ok\n");
  expect(r.add({ kind: "command", workspace: 2, name: "tests" }).id).toBe(3n);
});
test("output strips split escapes and preserves split UTF-8 without matching control payloads", () => {
  const out = new Output(),
    bytes = Buffer.from("réady");
  expect(out.feed(Buffer.from("\x1b[3"))).toBe("");
  expect(out.feed(Buffer.from("1m"))).toBe("");
  expect(out.feed(bytes.subarray(0, 2))).toBe("r");
  expect(out.feed(bytes.subarray(2))).toBe("éady");
  expect(out.feed(Buffer.from("\x1b]0;hidden"))).toBe("");
  expect(out.feed(Buffer.from("\x1b"))).toBe("");
  expect(out.feed(Buffer.from("\\visible\n"))).toBe("visible\n");
});
test("partial UTF-8 and escape decoding survive a live handoff", () => {
  const r = new Registry(),
    task = r.add({ kind: "command", workspace: 1 }),
    out = new Output(task.decoder),
    bytes = Buffer.from("é");
  expect(out.feed(Buffer.from("\x1b]0;hidden"))).toBe("");
  const restored = new Registry();
  restored.restore(json.clone(r.save()), true);
  const next = new Output(restored.get(task.id).decoder);
  expect(next.feed(Buffer.concat([Buffer.from("\x07"), bytes.subarray(0, 1)]))).toBe("");
  const again = new Registry();
  again.restore(json.clone(restored.save()), true);
  expect(new Output(again.get(task.id).decoder).feed(bytes.subarray(1))).toBe("é");
});
test("bounded output retains valid UTF-8 and reports byte cursors and truncation", () => {
  const r = new Registry(),
    task = r.add({ kind: "command", workspace: 1 });
  r.append(task, "é".repeat(output_bytes));
  expect(Buffer.byteLength(task.output)).toBeLessThanOrEqual(output_bytes);
  expect(task.output).not.toContain("�");
  expect(task.output_end).toBe(BigInt(output_bytes * 2));
  expect(task.output_start + BigInt(Buffer.byteLength(task.output))).toBe(task.output_end);
  expect(task.truncated).toBe(true);
});
test("news is deduplicated per transition, separate from notification and UI acknowledgments", () => {
  const r = new Registry(),
    task = r.add({ kind: "agent", workspace: 1, parent, notify: false });
  r.set(task, "blocked", "needs_input");
  r.set(task, "blocked", "needs_input");
  r.set(task, "blocked", "startup_blocked");
  expect(r.notes).toHaveLength(1);
  expect(r.notes[0]).toMatchObject({ seen: false, delivery: "suppressed" });
  r.acknowledge({ ...parent, session: "replacement" }, r.sequence);
  expect(r.notes[0].seen).toBe(false);
  r.acknowledge(parent, r.sequence);
  expect(r.notes[0].seen).toBe(true);
  r.set(task, "running");
  r.set(task, "completed");
  expect(r.notes).toHaveLength(2);
});
test("retention evicts settled work but preserves queued work and the latest live helper task", () => {
  const r = new Registry(),
    helper = r.add({ kind: "agent", workspace: 1, pane: 2 });
  r.helpers.push({ pane: 2, workspace: 1, name: "review", parent, notify: true, identity: null });
  r.set(helper, "completed");
  const queued = r.add({ kind: "agent", workspace: 1, pane: 3 });
  r.set(queued, "queued");
  for (let i = 0; i < retained + 10; i++) r.set(r.add({ kind: "command", workspace: 1 }), "completed");
  expect(r.get(helper.id)).toBe(helper);
  expect(r.get(queued.id)).toBe(queued);
  expect(r.tasks).toHaveLength(retained + 2);
  expect(() => r.get(3n)).toThrow("TaskExpired");
});
test("live restore retains queued prompts and identities; cold restore never replays them", () => {
  const before = new Registry(),
    task = before.add({ kind: "agent", workspace: 1, parent, prompt: "work" });
  before.set(task, "queued");
  const live = new Registry();
  live.restore(json.clone(before.save()), true);
  expect(live.get(task.id)).toMatchObject({ state: "queued", prompt: "work", parent });
  const cold = new Registry();
  cold.restore(json.clone(before.save()), false);
  expect(cold.get(task.id)).toMatchObject({ state: "unknown", prompt: "", reason: "daemon_restarted" });
  expect(cold.notes.every(n => n.delivery === "suppressed")).toBe(true);
  task.delivered = true;
  before.set(task, "running", "delivering");
  live.restore(json.clone(before.save()), true);
  expect(live.get(task.id)).toMatchObject({ state: "unknown", reason: "DeliveryUnknown" });
});
test("queued cancellation cannot stop work already delivered", () => {
  const r = new Registry(),
    task = r.add({ kind: "agent", workspace: 1, prompt: "work" });
  r.set(task, "queued");
  r.cancel(task);
  expect(task).toMatchObject({ state: "cancelled", prompt: "" });
  const running = r.add({ kind: "agent", workspace: 1 });
  running.delivered = true;
  r.set(running, "running");
  expect(() => r.cancel(running)).toThrow("TaskNotCancellable");
});
