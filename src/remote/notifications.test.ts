import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Changes, Notifications, type Alert } from "./notifications";
import type { Pane, Snapshot } from "./types";
const pane: Pane = {
  id: 1,
  workspace: 1,
  name: "Agent",
  provider: "codex",
  conversation: "thread",
  binding: "1",
  state: "working",
  activity: "",
  exited: false,
  branch: "main",
  order: 0,
  attention: "none",
  completion: "0",
  outcome: "completed",
};
const snapshot = (changes: Partial<Pane> = {}, server = 1): Snapshot => ({
  server,
  panes: [{ ...pane, ...changes }],
  workspaces: [],
});
const subscription = {
  endpoint: "https://web.push.apple.com/one",
  keys: {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  },
};
test("agent alerts follow waiting transitions and completion receipts without unread or polling duplicates", () => {
  const tracker = new Changes();
  expect(tracker.update(snapshot({ attention: "finished", completion: "8" }))).toEqual([]);
  expect(tracker.update(snapshot({ attention: "needs_input", completion: "8" }))[0].body).toBe("Agent needs input.");
  expect(tracker.update(snapshot({ attention: "needs_input", completion: "8" }))).toEqual([]);
  expect(tracker.update(snapshot({ state: "idle", attention: "finished", completion: "9" }))[0].body).toBe(
    "Agent finished.",
  );
  expect(tracker.update(snapshot({ state: "idle", attention: "none", completion: "9" }))).toEqual([]);
  expect(tracker.update(snapshot({ state: "idle", attention: "finished", completion: "9" }))).toEqual([]);
  expect(tracker.update(snapshot({ completion: "10", outcome: "interrupted" }))).toEqual([]);
  expect(tracker.update(snapshot({ completion: "11", outcome: "failed" }))[0].body).toContain("error");
  expect(tracker.update(snapshot({ completion: "12", conversation: "new" }))).toEqual([]);
  expect(tracker.update(snapshot({ completion: "13", conversation: "new", binding: "2" }))).toEqual([]);
  expect(tracker.update(snapshot({ completion: "14" }, 2))).toEqual([]);
  expect(tracker.update(snapshot({ provider: null, completion: "15" }, 2))).toEqual([]);
  expect(tracker.update(snapshot({ exited: true, completion: "16" }, 2))).toEqual([]);
});
test("notification links bind the pane and conversation and route input prompts to Terminal", () => {
  const tracker = new Changes();
  tracker.update(snapshot());
  const alert = tracker.update(snapshot({ attention: "needs_input" }))[0];
  const url = new URL(alert.url, "https://mac.example.ts.net");
  expect(url.pathname).toBe("/agents/1");
  expect(url.searchParams.get("view")).toBe("terminal");
  expect(url.searchParams.get("notification")).toBe(JSON.stringify([1, 1, "1", "thread"]));
});
test("subscriptions persist privately, isolate devices, prune expiry/revocation, and never retry failed sends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-push-")),
    file = join(dir, "push.json");
  let devices = [{ id: "one" }, { id: "two" }],
    state = snapshot(),
    result = 201;
  const sent: { endpoint: string; alert: Alert }[] = [];
  const deliver = async (target: typeof subscription, _key: string, _origin: string, alert: unknown) => {
    sent.push({ endpoint: target.endpoint, alert: alert as Alert });
    return result;
  };
  const create = () =>
    new Notifications(
      file,
      "https://mac.example.ts.net:8443",
      () => devices,
      async () => state,
      deliver,
    );
  try {
    const service = create();
    service.subscribe("one", subscription);
    expect(() => service.subscribe("two", subscription)).toThrow("SubscriptionInUse");
    service.subscribe("two", { ...subscription, endpoint: "https://web.push.apple.com/two" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(create().status("one")).toEqual(service.status("one"));
    await service.tick();
    expect(sent).toHaveLength(0);
    state = snapshot({ completion: "1" });
    await service.tick();
    expect(sent).toHaveLength(2);
    await service.tick();
    expect(sent).toHaveLength(2);
    service.remove("two");
    result = 503;
    state = snapshot({ completion: "2" });
    await expect(service.tick()).rejects.toThrow("PushDeliveryFailed");
    await service.tick();
    expect(sent).toHaveLength(3);
    result = 410;
    await expect(service.test("one")).rejects.toThrow("SubscriptionExpired");
    expect(service.status("one").enabled).toBe(false);
    service.subscribe("one", subscription);
    devices = [];
    state = snapshot({ completion: "3" });
    await service.tick();
    expect(sent).toHaveLength(4);
    expect(create().status("one").enabled).toBe(false);
    expect(() => service.subscribe("one", subscription)).toThrow("Unauthorized");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Mac polls and delivers without browser requests, then stops monitoring", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-push-monitor-"));
  let state = snapshot(),
    observed = 0,
    sent = 0;
  const errors: unknown[] = [];
  const service = new Notifications(
    join(dir, "push.json"),
    "https://mac.example.ts.net:8443",
    () => [{ id: "phone" }],
    async () => {
      observed++;
      return state;
    },
    async () => {
      sent++;
      return 201;
    },
  );
  try {
    service.subscribe("phone", subscription);
    service.start(error => errors.push(error));
    for (let i = 0; i < 100 && !observed; i++) await Bun.sleep(10);
    state = snapshot({ attention: "needs_input" });
    for (let i = 0; i < 300 && !sent; i++) await Bun.sleep(10);
    service.stop();
    expect(sent).toBe(1);
    expect(observed).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
