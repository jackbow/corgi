import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { runInNewContext } from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Remote } from "./server";
import type { Input } from "./daemon";
import script from "./web/app.js" with { type: "text" };
import shell from "./web/index.html" with { type: "text" };

const origin = "https://mac.example.ts.net:8443";
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw Error("Browser did not reach expected state");
}
/** Minimal storage boundary; cryptography, UI, HTTP routes, and daemon projection are real. */
function storage(initial: unknown) {
  let value = initial;
  const database = {
    transaction: () => {
      const tx = {
        oncomplete: null as (() => void) | null,
        objectStore: () => ({
          get: () => complete(value),
          put: (next: unknown) => {
            value = next;
            return complete(undefined);
          },
          delete: () => {
            value = undefined;
            return complete(undefined);
          },
        }),
      };
      const complete = (result: unknown) => {
        queueMicrotask(() => tx.oncomplete?.());
        return { result };
      };
      return tx;
    },
  };
  return {
    open: () => {
      const request = { result: database, onsuccess: null as (() => void) | null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
}
test("phone UI signs in, treats output as text, and never retries uncertain input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-phone-"));
  const sent: Input[] = [];
  let rejectInput = false;
  const remote = new Remote(join(dir, "devices.json"), origin, {
    list: async () => ({
      server: 42,
      workspaces: [{ id: 1, name: "Work" }],
      panes: [
        { id: 2, workspace: 1, name: "Agent", state: "working", activity: "Reading", binding: "3", exited: false },
      ],
    }),
    read: async () => '<script>window.compromised=true</script><img src=x onerror="window.compromised=true">',
    send: async (_pane, input) => {
      sent.push(input);
      if (rejectInput) throw Error("Unavailable");
    },
  });
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const key = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  const offer = remote.auth.mint(),
    claim = remote.auth.claim(new URL(offer.url).hash.slice(6), "Phone", key);
  remote.auth.approve(claim.claim, claim.code, true);
  const identity = { keys, device: remote.auth.outcome(claim.claim).device };
  const window = new Window({
    url: origin,
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  window.document.write(String(shell));
  const element = (id: string) => window.document.getElementById(id)!;
  const interval: (() => void)[] = [];
  try {
    runInNewContext(script, {
      document: window.document,
      window,
      location: window.location,
      history: window.history,
      crypto,
      TextEncoder,
      AbortSignal,
      URLSearchParams,
      btoa,
      atob,
      indexedDB: storage(identity),
      setInterval: (callback: () => void) => {
        interval.push(callback);
      },
      setTimeout,
      fetch: (path: string, init: RequestInit) =>
        remote.fetch(new Request(origin + path, { ...init, headers: { ...init.headers, Origin: origin } })),
    });
    await until(() => element("status").textContent === "Connected through Tailscale");
    expect(element("main").hasAttribute("hidden")).toBe(false);
    expect(element("output").querySelector("script")).toBeNull();
    expect(element("output").querySelector("img")).toBeNull();
    expect(element("output").textContent).toContain("<script>");
    const message = element("message") as unknown as { value: string };
    message.value = "continue";
    element("send").dispatchEvent(new window.Event("submit", { cancelable: true }));
    await until(() => sent.length === 1 && message.value === "");
    expect(sent[0]).toEqual({ server: 42, binding: "3", text: "continue", enter: true });
    rejectInput = true;
    message.value = "uncertain";
    element("send").dispatchEvent(new window.Event("submit", { cancelable: true }));
    await until(() => element("delivery").textContent?.includes("not confirmed") === true);
    expect(message.value).toBe("uncertain");
    element("status").textContent = "Refreshing";
    interval.forEach(callback => callback());
    await until(() => element("status").textContent === "Connected through Tailscale");
    expect(sent).toHaveLength(2);
    expect(element("delivery").textContent).toContain("not confirmed");
  } finally {
    await window.happyDOM.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
