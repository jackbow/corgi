import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function worker() {
  const handlers = new Map<string, (event: any) => void>(),
    shown: { title: string; options: any }[] = [],
    opened: string[] = [],
    navigated: string[] = [];
  let windows: unknown[] = [];
  runInNewContext(readFileSync(new URL("./web/public/sw.js", import.meta.url), "utf8"), {
    URL,
    self: {
      location: { origin: "https://mac.example.ts.net:8443" },
      addEventListener: (type: string, handler: (event: any) => void) => handlers.set(type, handler),
      registration: {
        showNotification: async (title: string, options: unknown) => {
          shown.push({ title, options });
        },
      },
      skipWaiting: async () => {},
      clients: {
        claim: async () => {},
        matchAll: async () => windows,
        openWindow: async (url: string) => {
          opened.push(url);
        },
      },
    },
  });
  const event = async (type: string, data: object) => {
    let pending: Promise<unknown> | undefined;
    handlers.get(type)!({
      ...data,
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
  };
  return {
    event,
    handlers,
    shown,
    opened,
    navigated,
    setWindows: (next: unknown[]) => {
      windows = next;
    },
  };
}
test("the push worker displays payloads without fetching or caching conversation content", async () => {
  const w = worker();
  expect(w.handlers.has("fetch")).toBe(false);
  await w.event("push", {
    data: {
      json: () => ({ title: "ignored", body: "Agent needs input.", tag: "one", url: "/agents/2?view=terminal" }),
    },
  });
  expect(w.shown[0].title).toBe("Corgi");
  expect(w.shown[0].options.body).toBe("Agent needs input.");
  expect(w.shown[0].options.data.url).toBe("https://mac.example.ts.net:8443/agents/2?view=terminal");
  for (const json of [
    () => null,
    () => {
      throw Error("broken");
    },
  ])
    await w.event("push", { data: { json } });
  expect(w.shown.at(-1)!.options.body).toContain("An agent has an update");
});
test("notification clicks only navigate to local agent routes and reuse an existing app window", async () => {
  const w = worker();
  let closed = 0,
    focused = 0;
  const click = (url: string) =>
    w.event("notificationclick", { notification: { close: () => closed++, data: { url } } });
  await click("https://evil.test/phishing");
  expect(w.opened).toEqual(["https://mac.example.ts.net:8443/"]);
  w.setWindows([
    {
      url: "https://mac.example.ts.net:8443/",
      navigate: async (url: string) => {
        w.navigated.push(url);
        return { focus: async () => focused++ };
      },
    },
  ]);
  await click("/agents/2?view=terminal");
  expect(w.navigated).toEqual(["https://mac.example.ts.net:8443/agents/2?view=terminal"]);
  expect(focused).toBe(1);
  expect(closed).toBe(2);
});
