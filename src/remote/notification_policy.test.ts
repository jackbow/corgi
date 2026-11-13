import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notifications, defaults, preferences } from "./notifications";
import type { Pane } from "./types";
const subscription = {
  endpoint: "https://web.push.apple.com/one",
  keys: {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  },
};
const pane: Pane = {
  id: 1,
  workspace: 1,
  binding: "1",
  conversation: "thread",
  name: "Agent",
  provider: "codex",
  state: "working",
  activity: "",
  exited: false,
  branch: "",
  order: 0,
  attention: "none",
  completion: "0",
};
test("notification retries survive restarts and wait for backoff without replaying agent input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-push-policy-")),
    file = join(dir, "push.json");
  let now = Date.now(),
    state = { ...pane },
    status = 500,
    attempts = 0;
  const create = () =>
    new Notifications(
      file,
      "https://mac.example.ts.net",
      () => [{ id: "phone" }],
      async () => ({ server: 1, workspaces: [], panes: [state] }),
      async () => {
        attempts++;
        return status;
      },
      async () => "Latest response",
      () => now,
    );
  try {
    const first = create();
    first.subscribe("phone", subscription);
    await first.tick();
    state = { ...state, state: "idle", completion: "1", attention: "finished" };
    await expect(first.tick()).rejects.toThrow("PushDeliveryFailed");
    expect(attempts).toBe(1);
    await first.tick();
    expect(attempts).toBe(1);
    const recovered = create();
    await recovered.tick();
    expect(attempts).toBe(1);
    now += 5000;
    status = 201;
    await recovered.tick();
    expect(attempts).toBe(2);
    now += 5000;
    await recovered.tick();
    expect(attempts).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("categories, snooze, cooldown and settle delay control per-device delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-push-policy-"));
  let now = Date.now(),
    state = { ...pane },
    sent = 0;
  const push = new Notifications(
    join(dir, "push.json"),
    "https://mac.example.ts.net",
    () => [{ id: "phone" }],
    async () => ({ server: 1, workspaces: [], panes: [state] }),
    async () => {
      sent++;
      return 201;
    },
    async () => "",
    () => now,
  );
  try {
    push.subscribe("phone", subscription);
    push.configure("phone", { ...defaults, finished: false, settle: 2, cooldown: 30 });
    await push.tick();
    state = { ...state, state: "idle", completion: "1", attention: "finished" };
    await push.tick();
    now += 3000;
    await push.tick();
    expect(sent).toBe(0);
    state = { ...state, state: "blocked", permission: true, attention: "needs_input" };
    await push.tick();
    expect(sent).toBe(0);
    state = { ...state, state: "working", attention: "none" };
    now += 3000;
    await push.tick();
    expect(sent).toBe(0);
    state = { ...state, state: "blocked", attention: "needs_input" };
    await push.tick();
    now += 3000;
    await push.tick();
    expect(sent).toBe(1);
    state = { ...state, state: "working", attention: "none" };
    await push.tick();
    state = { ...state, state: "blocked", attention: "needs_input" };
    await push.tick();
    now += 3000;
    await push.tick();
    expect(sent).toBe(1);
    push.configure("phone", { ...defaults, snoozeUntil: now + 60_000 });
    now += 35_000;
    await push.tick();
    expect(sent).toBe(1);
    expect(push.status("phone").preferences.snoozeUntil).toBeGreaterThan(now);
    for (const value of [{ cooldown: -1 }, { settle: 31 }, { input: "yes" }, { unknown: true }])
      expect(() => preferences(value)).toThrow("InvalidInput");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("permission requests use the input preference rather than the completion preference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-push-permission-"));
  let state = { ...pane },
    sent = 0;
  const push = new Notifications(
    join(dir, "push.json"),
    "https://mac.example.ts.net",
    () => [{ id: "phone" }],
    async () => ({ server: 1, workspaces: [], panes: [state] }),
    async () => {
      sent++;
      return 201;
    },
  );
  try {
    push.subscribe("phone", subscription);
    push.configure("phone", { ...defaults, input: false });
    await push.tick();
    state = { ...state, state: "blocked", permission: true };
    await push.tick();
    expect(sent).toBe(0);
    state = { ...pane };
    await push.tick();
    push.configure("phone", { ...defaults, finished: false });
    state = { ...state, state: "blocked", permission: true };
    await push.tick();
    expect(sent).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
