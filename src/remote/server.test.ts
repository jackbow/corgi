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
      workspaces: [{ id: 1, name: "Work" }],
      panes: [
        { id: 2, workspace: 1, name: "Codex", state: "working", activity: "Reading", binding: "4", exited: false },
      ],
    }),
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
    expect(await page.text()).toContain("Connect your phone to Tailscale");
    expect((await request("/app.js")).headers.get("Content-Type")).toContain("javascript");
    expect(await (await request("/app.css")).text()).toContain("--text:rgb(");
    expect((await request("/api/session")).status).toBe(401);
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
    remote.auth.revoke(device);
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
