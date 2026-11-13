import { expect, test } from "bun:test";
import { command, Requests } from "./permission_notifications";
const target = { socket: "/tmp/corgi.sock", server: 1, pane: 2, binding: "1", conversation: "thread" };

test("desktop requests notify once per waiting transition, independent of viewers", () => {
  const sent: string[][] = [];
  const requests = new Requests(async (title, body) => {
    sent.push([title, body]);
  });
  const agent = { id: "pane:conversation", name: "Migration", waiting: false, permission: true, target };
  requests.update([agent]);
  requests.update([{ ...agent, waiting: true }]);
  requests.update([{ ...agent, waiting: true }]);
  expect(sent).toEqual([["needs permission", "Migration"]]);
  requests.update([agent]);
  requests.update([{ ...agent, waiting: true, permission: false }]);
  expect(sent[1]).toEqual(["needs input", "Migration"]);
  requests.update([]);
  requests.update([{ ...agent, waiting: true }]);
  expect(sent).toHaveLength(3);
});

test("notification click commands quote executable paths and keep names outside shell code", () => {
  const text = '\" & do shell script \"touch /tmp/unsafe\"';
  const executable = "/Applications/User's Corgi/corgi";
  const argv = command("terminal-notifier", executable, "needs permission", text + "\n" + "x".repeat(300), target);
  expect(argv[4]).toStartWith(text + " ");
  expect(argv[4]).toHaveLength(240);
  const callback = argv[argv.indexOf("-execute") + 1];
  expect(callback).not.toContain(text);
  expect(callback).toContain("__notification-open");
  expect(callback).toStartWith("'/Applications/User'\\''s Corgi/corgi'");
  expect(argv[argv.indexOf("-group") + 1]).toBe("corgi-1-2-1");
});

test("notification failure does not retry or affect agent tracking", async () => {
  let calls = 0;
  const requests = new Requests(async () => {
    calls++;
    throw Error("Unavailable");
  });
  const agent = { id: "1", name: "Agent", waiting: true, permission: true, target };
  requests.update([agent, agent]);
  await Promise.resolve();
  requests.update([agent]);
  expect(calls).toBe(1);
});

test("a desktop viewer owns permission banners, while new requests without a viewer still notify", () => {
  const sent: string[] = [];
  const requests = new Requests(async title => {
    sent.push(title);
  });
  const agent = { id: "one", name: "Migration", waiting: false, permission: true, target };
  requests.update([agent], false);
  requests.update([{ ...agent, waiting: true }], false);
  expect(sent).toEqual([]);
  requests.update([{ ...agent, waiting: true }], true);
  expect(sent).toEqual([]);
  requests.update([agent], true);
  requests.update([{ ...agent, waiting: true }], true);
  expect(sent).toEqual(["needs permission"]);
});
