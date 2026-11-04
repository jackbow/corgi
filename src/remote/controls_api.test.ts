import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Remote } from "./server";
import { Auth, signed } from "./auth";
import type { Backend } from "./daemon";
const origin = "https://mac.example.ts.net:8443";
test("reader devices cannot mutate, elevate, invite, or approve; controller commands are validated and audited", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-controls-")),
    actions: unknown[] = [];
  const backend: Backend = {
    list: async () => ({ server: 42, workspaces: [], panes: [] }),
    send: async (_pane, q) => {
      actions.push(q);
    },
    read: async () => "history",
    terminal: async (pane, q) => ({ ...q, pane, cols: 80, rows: 1, lines: [] }),
    conversation: async () => ({
      availability: "available",
      messages: [],
      version: "",
      before: null,
      after: null,
      more: false,
    }),
    create: async q => {
      actions.push(q);
      return { server: 42, pane: 1, binding: "1", conversation: "thread" };
    },
    manage: async q => {
      actions.push(q);
    },
    update: async () => ({ phase: "idle", server: 42, message: "Signed releases" }),
    respond: async (_pane, _q, fingerprint) => {
      actions.push(fingerprint);
    },
  };
  const remote = new Remote(join(dir, "devices.json"), origin, backend);
  const request = (path: string, token: string, body?: unknown) =>
    remote.fetch(
      new Request(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const enroll = (offer: { url: string }) => {
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
      claim = remote.auth.claim(
        new URL(offer.url).hash.slice(6),
        "Phone",
        keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      );
    return { keys, claim };
  };
  const login = (pair: ReturnType<typeof enroll>) => {
    const id = remote.auth.outcome(pair.claim.claim).device!,
      { nonce } = remote.auth.challenge(id);
    return {
      id,
      token: remote.auth.login(
        nonce,
        sign("sha256", Buffer.from(signed(origin, nonce)), {
          key: pair.keys.privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url"),
      ).token,
    };
  };
  try {
    const primary = enroll(remote.auth.mint());
    remote.auth.approve(primary.claim.claim, primary.claim.code, true);
    const controller = login(primary),
      invite = await (await request("/api/devices/invite", controller.token, { role: "reader" })).json();
    const secondary = enroll(invite);
    expect((await (await request("/api/devices", controller.token)).json()).pending.code).toBe(secondary.claim.code);
    expect((await request("/api/devices/approve", controller.token, { ...secondary.claim, allow: true })).status).toBe(
      200,
    );
    const reader = login(secondary);
    expect(JSON.parse(await readFile(join(dir, "devices.json"), "utf8")).version).toBe(2);
    expect(new Auth(join(dir, "devices.json"), origin).role(reader.id)).toBe("reader");
    expect((await (await request("/api/me", reader.token)).json()).role).toBe("reader");
    for (const [path, body] of [
      ["/api/manage", { action: "stop-agent" }],
      ["/api/agents", { provider: "codex" }],
      ["/api/devices/invite", { role: "controller" }],
      ["/api/devices/revoke", { id: controller.id }],
      ["/api/update", { server: 42, confirm: true }],
      ["/api/panes/1/input", { key: "enter" }],
      ["/api/panes/1/respond", { choice: 1 }],
    ] as const)
      expect((await request(path, reader.token, body)).status).toBe(403);
    expect(actions).toEqual([]);
    expect((await request("/api/update", reader.token)).status).toBe(403);
    expect((await request("/api/update", controller.token, { server: 42 })).status).toBe(400);
    expect((await request("/api/update", controller.token, { server: 42, confirm: true })).status).toBe(202);
    expect((await request("/api/session", reader.token)).status).toBe(200);
    expect((await request("/api/devices", reader.token)).status).toBe(403);
    const identity = { server: 42, binding: "1", conversation: "thread" };
    expect((await request("/api/manage", controller.token, { action: "stop-agent", pane: 1, identity })).status).toBe(
      400,
    );
    expect(
      (
        await request("/api/manage", controller.token, {
          action: "rename-agent",
          pane: 1,
          identity,
          name: "Private agent title",
        })
      ).status,
    ).toBe(200);
    expect(actions).toHaveLength(1);
    const log = await readFile(join(dir, "devices.json.audit"), "utf8");
    expect(log).toContain('"result":"denied"');
    expect(log).toContain('"action":"rename-agent"');
    expect(log).not.toContain("Private agent title");
    await request("/api/devices/revoke", controller.token, { id: reader.id });
    expect((await request("/api/session", reader.token)).status).toBe(401);
    const stream = await request("/api/events", controller.token),
      body = stream.body!.getReader();
    expect(new TextDecoder().decode((await body.read()).value)).toContain("session");
    await body.cancel();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
