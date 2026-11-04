import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Limit, Remote, listen, redirect } from "./server";
import { signed } from "./auth";
import { input, type Backend, type Input } from "./daemon";
const origin = "https://mac.example.ts.net:8443";

test("IP listener only redirects navigation to the fixed HTTPS origin", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = redirect(new Request("http://100.1.2.3:8080/api/session?token=discard", { method }), origin);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(origin + "/");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  }
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = redirect(new Request("http://100.1.2.3:8080/api/pair", { method }), origin);
    expect(response.status).toBe(405);
    expect(response.headers.get("Location")).toBe(null);
  }
});

test("private HTTP socket pairs, authenticates, restricts commands, and revokes access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-web-")),
    sent: { pane: number; input: Input }[] = [];
  const backend: Backend = {
    list: async () => ({
      server: 123,
      workspaces: [{ id: 1, name: "Work", order: 0 }],
      panes: [
        {
          id: 2,
          workspace: 1,
          name: "Codex",
          state: "working",
          activity: "Reading",
          binding: "4",
          exited: false,
          provider: "codex",
          conversation: "thread",
          branch: "main",
          order: 0,
          attention: "none",
        },
      ],
    }),
    terminal: async (_pane, q) => ({ ...q, pane: 2, cols: 80, rows: 1, lines: ["hello"] }),
    conversation: async () => ({
      availability: "available",
      version: "v",
      messages: [],
      before: null,
      after: null,
      more: false,
    }),
    create: async q => ({ pane: 3, server: q.server, binding: "5", conversation: "new" }),
    read: async () => "<script>untrusted terminal content</script>",
    send: async (pane, input) => {
      sent.push({ pane, input });
    },
  };
  const remote = new Remote(join(dir, "devices.json"), origin, backend),
    socket = join(dir, "http.sock");
  const server = listen(socket, request => remote.fetch(request));
  const request = (path: string, body?: unknown, token = "", from: string | null = origin) =>
    fetch(`http://localhost${path}`, {
      unix: socket,
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(from ? { Origin: from } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    const page = await request("/");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain("Connect your phone to Tailscale");
    const script = /src="([^"]+\.js)"/.exec(html)![1];
    const app = await request("/app.js");
    expect(app.headers.get("Content-Type")).toContain("javascript");
    expect(await app.text()).toBe(await (await request(script)).text());
    expect(await (await request("/app.css")).text()).toContain("--text:rgb(");
    expect((await request("/api/session")).status).toBe(401);
    expect((await request("/api/push")).status).toBe(401);
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
      offer = remote.auth.mint();
    const body = {
      token: new URL(offer.url).hash.slice(6),
      name: "My phone",
      key: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    };
    expect((await request("/api/pair", body, "", "https://evil.test")).status).toBe(403);
    expect((await request("/api/pair", body, "", null)).status).toBe(403);
    const claim = await (await request("/api/pair", body)).json();
    expect((await (await request("/api/pair/status", { claim: claim.claim })).json()).state).toBe("waiting");
    remote.auth.approve(claim.claim, claim.code, true);
    const { device } = await (await request("/api/pair/status", { claim: claim.claim })).json();
    const { nonce } = await (await request("/api/challenge", { device })).json();
    const signature = sign("sha256", Buffer.from(signed(origin, nonce)), {
      key: keys.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const { token } = await (await request("/api/session", { nonce, signature })).json();
    const push = {
      endpoint: "https://web.push.apple.com/token",
      keys: {
        p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
    };
    const pushStatus = await (await request("/api/push", undefined, token)).json();
    expect(pushStatus.enabled).toBe(false);
    expect(pushStatus.publicKey).toHaveLength(87);
    expect((await request("/api/push/test", {}, token)).status).toBe(400);
    expect((await request("/api/push", push, token, "https://evil.test")).status).toBe(403);
    expect((await request("/api/push", { ...push, endpoint: "https://127.0.0.1/push" }, token)).status).toBe(400);
    expect((await (await request("/api/push", push, token)).json()).enabled).toBe(true);
    expect((await (await request("/api/push", null, token)).json()).enabled).toBe(false);
    await request("/api/push", push, token);
    expect((await (await request("/api/session", undefined, token)).json()).panes[0].id).toBe(2);
    expect((await (await request("/api/panes/2/output", undefined, token)).json()).text).toContain("<script>");
    expect(
      (await request("/api/panes/2/input", { server: 123, binding: "4", text: "hi", enter: true }, token)).status,
    ).toBe(200);
    expect(sent).toEqual([{ pane: 2, input: { server: 123, binding: "4", text: "hi", enter: true } }]);
    expect((await request("/api/panes/2/input", { server: 123, binding: "4", key: "shutdown" }, token)).status).toBe(
      400,
    );
    expect((await request("/api/rpc", { op: "shutdown" }, token)).status).toBe(404);
    expect(
      (await request("/api/panes/2/input", { server: 123, binding: "4", key: "enter" }, token, "https://evil.test"))
        .status,
    ).toBe(403);
    const query = "?server=123&binding=4&conversation=thread";
    expect((await request("/agents/2")).status).toBe(200);
    expect((await request("/new")).status).toBe(200);
    expect((await request("/settings")).status).toBe(200);
    expect((await request("/arbitrary-route")).status).toBe(404);
    expect((await request("/api/panes/2/terminal" + query, undefined, token)).status).toBe(200);
    expect((await (await request("/api/panes/2/conversation" + query, undefined, token)).json()).conversation).toBe(
      "thread",
    );
    expect((await request("/api/panes/2/terminal", undefined, token)).status).toBe(400);
    expect(
      (await request("/api/panes/2/conversation" + query + "&cursor=" + "x".repeat(513), undefined, token)).status,
    ).toBe(400);
    expect((await request("/api/panes/2/conversation" + query + "&direction=unknown", undefined, token)).status).toBe(
      400,
    );
    expect((await request("/api/agents", { server: 123, workspace: 1, provider: "claude" }, token)).status).toBe(200);
    for (const body of [
      { server: 123, workspace: 1, provider: "opencode" },
      { server: 123, workspace: 1, provider: "codex", cwd: "/private" },
      { server: 123, workspace: 1, provider: "codex", command: "rm" },
      { server: 123, workspace: 1, provider: "codex", account: "other" },
    ])
      expect((await request("/api/agents", body, token)).status).toBe(400);
    remote.auth.revoke(device);
    expect((await request("/api/push", push, token)).status).toBe(401);
    expect((await request("/api/push/test", {}, token)).status).toBe(401);
    await remote.notifications.tick();
    expect(remote.notifications.status(device).enabled).toBe(false);
    expect((await request("/api/panes/2/terminal" + query, undefined, token)).status).toBe(401);
    expect((await request("/api/panes/2/conversation" + query, undefined, token)).status).toBe(401);
    expect((await request("/api/agents", { server: 123, workspace: 1, provider: "codex" }, token)).status).toBe(401);
    expect((await request("/api/session", undefined, token)).status).toBe(401);
    expect((await request("/api/panes/2/input", { server: 123, binding: "4", key: "enter" }, token)).status).toBe(401);
    expect(sent).toHaveLength(1);
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("input rejects oversized messages and arbitrary key sequences", () => {
  expect(() => input({ server: 1, binding: "2", text: "x".repeat(8193), enter: false })).toThrow("InvalidInput");
  expect(() => input({ server: 1, binding: "2", key: "enter ctrl+c" })).toThrow("InvalidInput");
  expect(() => input({ server: 1, binding: "2", key: "enter", text: "extra" })).toThrow("InvalidInput");
  expect(input({ server: 1, binding: "2", key: "ctrl+c" }).key).toBe("ctrl+c");
});
test("rate limits expire and isolate devices", () => {
  const limit = new Limit();
  limit.take("one", 1, 0);
  expect(() => limit.take("one", 1, 1)).toThrow("RateLimited");
  expect(() => limit.take("two", 1, 1)).not.toThrow();
  expect(() => limit.take("one", 1, 60_000)).not.toThrow();
});
