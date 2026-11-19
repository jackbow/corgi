import { test, expect, spyOn } from "bun:test";
import { Runtime, Pane } from "./runtime";
import { Terminal } from "./pane/terminal";
import { Workspace } from "./workspace";
import { adapter, Text } from "./providers";
import * as service from "./task_service";
import * as protocol from "./protocol";
import * as checkpoint from "./persist/checkpoint";
import * as accountLock from "./account_lock";
import { validateCheckpoint } from "./persist/schema";
import * as json from "./json";

const ctx = { socket: "/tmp/corgi-task-unit", executable: "/bin/corgi", theme: {} };
function fixture() {
  const r = new Runtime(),
    w = new Workspace(1, "/tmp");
  r.workspaces.items.push(w);
  r.workspaces.next_id = 2;
  const pane = (session: string) => {
    w.model.next_id = r.workspaces.next_pane_id;
    const id = w.model.newTab("");
    r.workspaces.next_pane_id = w.model.next_id;
    const p = new Pane(id, Terminal.create(80, 24), "/tmp");
    const actor = r.conversations.get("claude", session);
    actor.state.state = "idle";
    p.attachment.select(actor);
    r.panes.push(p);
    return p;
  };
  return { r, pane };
}
async function until(check: () => boolean, tick = () => {}) {
  const end = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > end) throw Error("TestTimedOut");
    tick();
    await Bun.sleep(5);
  }
}
const message = (target: number, text: string, busy = "reject", caller = 0) =>
  protocol.decode("task.message", { target: `pane:${target}`, workspace: 1, caller, text, busy });

test("helper launches respect provider account locks", async () => {
  const { r } = fixture(),
    release = accountLock.take("codex", "");
  try {
    await expect(
      service.start(r, ctx, protocol.decode("task.start", { workspace: 1, agent: "codex", prompt: "work" })),
    ).rejects.toThrow("AccountInUse");
    expect(r.tasks.tasks).toHaveLength(0);
  } finally {
    release();
    r.destroy();
  }
});
test("custom helper commands respect their detected provider account lock", async () => {
  const { r } = fixture(),
    release = accountLock.take("claude", "");
  r.agent_commands[0].set("claude");
  r.agent_commands[0].semantics.provider = "claude";
  try {
    await expect(
      service.start(r, ctx, protocol.decode("task.start", { workspace: 1, agent: "command/1", prompt: "work" })),
    ).rejects.toThrow("AccountInUse");
  } finally {
    release();
    r.destroy();
  }
});
test("repeated agent assignments do not accumulate terminal listeners", () => {
  const { r, pane } = fixture(),
    child = pane("child"),
    before = child.terminal.listenerCount("output");
  try {
    for (let i = 0; i < 20; i++) {
      const task = service.message(r, message(child.id, "work", "queue"));
      service.bind(r, ctx.socket);
      r.tasks.cancel(task);
    }
    expect(child.terminal.listenerCount("output")).toBe(before);
  } finally {
    r.destroy();
  }
});
test("first structured binding can adopt a provisional agent but a replacement cannot", () => {
  const { r, pane } = fixture(),
    child = pane("unused");
  try {
    child.attachment.detach();
    child.attachment.provisional.provider = "claude";
    child.attachment.provisional.state = "idle";
    const task = service.message(r, message(child.id, "work", "queue"));
    child.attachment.select(r.conversations.get("claude", "first"));
    child.agent().state = "working";
    service.tick(r);
    expect(task.identity?.session).toBe("first");
    expect(task.state).toBe("queued");
    child.attachment.select(r.conversations.get("claude", "replacement"));
    service.tick(r);
    expect(task).toMatchObject({ state: "interrupted", reason: "agent_changed" });
  } finally {
    r.destroy();
  }
});

test("commands retain complete output and nonzero status after ordinary pane teardown", async () => {
  const { r } = fixture();
  try {
    const task = await service.start(
      r,
      ctx,
      protocol.decode("task.start", {
        workspace: 1,
        name: "tests",
        argv: ["/bin/sh", "-c", "printf 'ready\\n'; exit 7"],
      }),
    );
    await until(
      () => task.state === "failed",
      () => service.tick(r),
    );
    expect(task).toMatchObject({ exit_code: 7, reason: "exited" });
    expect(task.output).toContain("ready");
    r.close(task.pane);
    expect(service.get(r, protocol.decode("task.get", { target: `task:${task.id}` })).output).toContain("ready");
  } finally {
    r.destroy();
  }
});
test("typed tracked prompts finish only after their work, without clearing UI receipts", async () => {
  const { r, pane } = fixture(),
    child = pane("child"),
    channel = spyOn(adapter("claude").message!, "channel").mockResolvedValue(null);
  try {
    const task = service.message(r, message(child.id, "review"));
    service.tick(r);
    await until(() => task.delivery !== null);
    service.tick(r);
    expect(task.state).toBe("running");
    const a = child.agent();
    a.beginTurn("new-turn");
    service.tick(r);
    a.endTurn("new-turn", "completed", "hook", Date.now() * 1000);
    service.tick(r);
    expect(task).toMatchObject({ state: "completed", source: "hook" });
    expect(a.observation.unread()).toBe(true);
  } finally {
    channel.mockRestore();
    r.destroy();
  }
});
test("queued prompts are FIFO and cannot be advanced by startup idle or an old-turn receipt", async () => {
  const { r, pane } = fixture(),
    child = pane("child"),
    sent: string[] = [],
    channel = spyOn(adapter("claude").message!, "channel").mockImplementation(async () => async text => {
      sent.push(text);
    });
  try {
    child.agent().turn = new Text("old");
    const first = service.message(r, message(child.id, "first", "queue")),
      second = service.message(r, message(child.id, "second", "queue"));
    service.tick(r);
    await until(() => first.delivery !== null);
    expect(sent).toEqual(["first"]);
    child.agent().recordCompletion("old", "completed", "hook", false);
    service.tick(r);
    expect(first.state).toBe("running");
    expect(second.state).toBe("queued");
    child.agent().beginTurn("first");
    service.tick(r);
    child.agent().endTurn("first", "completed", "hook", Date.now() * 1000);
    service.tick(r);
    service.tick(r);
    await until(() => second.delivery !== null);
    expect(sent).toEqual(["first", "second"]);
  } finally {
    channel.mockRestore();
    r.destroy();
  }
});
test("busy rejection and unsupported steering never submit a prompt", () => {
  const { r, pane } = fixture(),
    child = pane("child");
  try {
    child.agent().beginTurn("turn");
    expect(() => service.message(r, message(child.id, "x"))).toThrow("AgentBusy");
    expect(() => service.message(r, message(child.id, "x", "steer"))).toThrow("SteeringUnsupported");
    expect(r.tasks.tasks).toHaveLength(0);
  } finally {
    r.destroy();
  }
});
test("steering joins exactly the active turn, and queued work waits for it", async () => {
  const { r, pane } = fixture(),
    child = pane("child"),
    a = child.agent();
  a.provider = "codex";
  a.session = new Text("thread");
  a.beginTurn("turn");
  const steer = spyOn(adapter("codex").message!, "steer").mockResolvedValue(undefined);
  try {
    const task = service.message(r, message(child.id, "steer me", "steer"));
    service.tick(r);
    await until(() => task.delivery !== null);
    expect(steer).toHaveBeenCalledWith("thread", "turn", "steer me", "");
    expect(task.joined).toBe(true);
    a.endTurn("turn", "completed", "hook", Date.now() * 1000);
    service.tick(r);
    expect(task.state).toBe("completed");
  } finally {
    steer.mockRestore();
    r.destroy();
  }
});
test("uncertain delivery is never retried and blocks later queued prompts", async () => {
  const { r, pane } = fixture(),
    child = pane("child"),
    channel = spyOn(adapter("claude").message!, "channel").mockImplementation(async () => async () => {
      throw Error("DeliveryUnknown");
    });
  try {
    const first = service.message(r, message(child.id, "first", "queue")),
      second = service.message(r, message(child.id, "second", "queue"));
    service.tick(r);
    await until(() => first.state === "unknown");
    service.tick(r);
    service.tick(r);
    expect(channel).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ state: "blocked", reason: "delivery_uncertain", delivered: false });
  } finally {
    channel.mockRestore();
    r.destroy();
  }
});
test("parent notes defer while busy, send once when idle, and never target a replacement", async () => {
  const { r, pane } = fixture(),
    parent = pane("parent"),
    child = pane("child"),
    sent: string[] = [],
    channel = spyOn(adapter("claude").message!, "channel").mockImplementation(async () => async text => {
      sent.push(text);
    });
  try {
    const task = r.tasks.add({ kind: "agent", workspace: 1, pane: child.id, parent: service.identity(parent) });
    parent.agent().beginTurn("busy");
    r.tasks.set(task, "completed");
    service.tick(r);
    expect(sent).toEqual([]);
    parent.agent().state = "idle";
    service.tick(r);
    await until(() => r.tasks.notes[0].delivery === "sent");
    service.tick(r);
    expect(sent).toHaveLength(1);
    expect(r.tasks.tasks).toHaveLength(1);
    const another = r.tasks.add({ kind: "agent", workspace: 1, pane: child.id, parent: service.identity(parent) });
    parent.attachment.select(r.conversations.get("claude", "replacement"));
    r.tasks.set(another, "failed");
    service.tick(r);
    expect(r.tasks.notes[1].delivery).toBe("suppressed");
    expect(sent).toHaveLength(1);
    expect(r.pane(child.id)).not.toBeNull();
  } finally {
    channel.mockRestore();
    r.destroy();
  }
});
test("automated notes and queued work wait for a recognized draft to clear", async () => {
  const { r, pane } = fixture(),
    parent = pane("p"),
    child = pane("c"),
    sent: string[] = [],
    channel = spyOn(adapter("claude").message!, "channel").mockImplementation(async () => async text => {
      sent.push(text);
    });
  try {
    parent.terminal.feed("─".repeat(30) + "\r\n❯ unfinished draft\r\n" + "─".repeat(30));
    const done = r.tasks.add({ kind: "agent", workspace: 1, pane: child.id, parent: service.identity(parent) });
    r.tasks.set(done, "completed");
    service.tick(r);
    await Bun.sleep(0);
    expect(sent).toEqual([]);
    parent.terminal.feed("\x1b[2J\x1b[H" + "─".repeat(30) + "\r\n❯ \r\n" + "─".repeat(30));
    service.tick(r);
    await until(() => r.tasks.notes[0].delivery === "sent");
    expect(sent).toHaveLength(1);
  } finally {
    channel.mockRestore();
    r.destroy();
  }
});
test("paused background work cannot settle a tracked agent task", async () => {
  const { r, pane } = fixture(),
    child = pane("child"),
    channel = spyOn(adapter("claude").message!, "channel").mockResolvedValue(null);
  try {
    const task = service.message(r, message(child.id, "work"));
    service.tick(r);
    await until(() => task.delivery !== null);
    child.agent().beginTurn("turn");
    service.tick(r);
    child.agent().endTurn("turn", "completed", "hook", Date.now() * 1000);
    child.agent().paused = true;
    service.tick(r);
    expect(task.state).toBe("running");
    child.agent().paused = false;
    service.tick(r);
    expect(task.state).toBe("completed");
  } finally {
    channel.mockRestore();
    r.destroy();
  }
});
test("a replaced child cannot complete or receive a tracked task after channel discovery", async () => {
  const { r, pane } = fixture(),
    child = pane("child"),
    release = Promise.withResolvers<null>(),
    channel = spyOn(adapter("claude").message!, "channel").mockImplementation(() => release.promise);
  try {
    const task = service.message(r, message(child.id, "work"));
    service.tick(r);
    child.attachment.select(r.conversations.get("claude", "replacement"));
    release.resolve(null);
    await until(() => task.state === "failed");
    expect(task.reason).toBe("AgentChanged");
    expect(child.terminal.native({ op: "takePending" })).toBe("");
  } finally {
    channel.mockRestore();
    r.destroy();
  }
});
test("a queued prompt stays unsent when its target becomes busy during channel discovery", async () => {
  const { r, pane } = fixture(),
    child = pane("child"),
    release = Promise.withResolvers<null>(),
    channel = spyOn(adapter("claude").message!, "channel").mockImplementation(() => release.promise);
  try {
    const task = service.message(r, message(child.id, "work", "queue"));
    service.tick(r);
    child.agent().beginTurn("manual");
    release.resolve(null);
    await until(() => task.state === "queued");
    expect(task).toMatchObject({ delivered: false, prompt: "work" });
    expect(child.terminal.native({ op: "takePending" })).toBe("");
    child.agent().state = "idle";
    service.tick(r);
    await until(() => task.delivery !== null);
    expect(channel).toHaveBeenCalledTimes(2);
  } finally {
    channel.mockRestore();
    r.destroy();
  }
});
test("checkpoints preserve orchestration without changing native subagent links", async () => {
  const { r, pane } = fixture(),
    parent = pane("parent"),
    child = pane("child"),
    restored = new Runtime();
  try {
    const task = service.message(r, message(child.id, "work", "queue", parent.id));
    const state = checkpoint.capture(r, true);
    await checkpoint.restore(restored, state, true, ctx.socket, ctx.executable, false);
    expect(restored.tasks.get(task.id)).toMatchObject({
      state: "queued",
      prompt: "work",
      parent: service.identity(parent),
    });
    expect(restored.conversations.items.every(a => a.parent === null)).toBe(true);
  } finally {
    r.destroy();
    restored.destroy();
  }
});
test("saved task records reject duplicate IDs, broken output cursors, and unbounded decoder state", () => {
  const { r } = fixture();
  try {
    r.tasks.add({ kind: "command", workspace: 1 });
    const state = checkpoint.capture(r, true);
    expect(() => validateCheckpoint(state)).not.toThrow();
    const duplicate = json.clone(state);
    duplicate.tasks.tasks.push(duplicate.tasks.tasks[0]);
    expect(() => validateCheckpoint(duplicate)).toThrow();
    const cursor = json.clone(state);
    cursor.tasks.tasks[0].output = "inconsistent";
    expect(() => validateCheckpoint(cursor)).toThrow();
    const decoder = json.clone(state);
    decoder.tasks.tasks[0].decoder.pending = [0, 1, 2, 3];
    expect(() => validateCheckpoint(decoder)).toThrow("Overflow");
  } finally {
    r.destroy();
  }
});
