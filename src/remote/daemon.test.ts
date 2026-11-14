import { expect, test } from "bun:test";
import { version } from "../protocol";
import { createServer } from "../fixtures/websocket_server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, snapshot } from "./daemon";
import * as json from "../json";

test("adapter negotiates the existing daemon protocol and rejects input to a changed pane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-bridge-")),
    socket = join(dir, "daemon.sock");
  const mutations: unknown[] = [];
  const state = {
    server_pid: 42,
    workspaces: [{ id: 1, name: "Work" }],
    panes: [
      { id: 2, workspace: 1, binding: 9007199254740993n, name: "Shell", exited: false, agent: { state: "working" } },
    ],
  };
  const server = createServer(client => {
    let buffer = "";
    client.on("data", bytes => {
      buffer += bytes.toString();
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"),
          request = json.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (request.op === "hello")
          client.write(json.stringify({ request_id: request.request_id, type: "hello", protocol: version }) + "\n");
        else if (request.op === "session.snapshot")
          client.write(json.stringify({ request_id: request.request_id, ...state }) + "\n");
        else if (request.op === "session.command") {
          if (!("pane.read" in request.command)) mutations.push(request.command);
          client.write(json.stringify({ request_id: request.request_id, ok: true, result: { text: "hello" } }) + "\n");
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const daemon = new Daemon(socket),
      s = await daemon.list();
    expect(s.panes[0].binding).toBe("9007199254740993");
    expect(await daemon.read(2)).toBe("hello");
    const input = { server: 42, binding: s.panes[0].binding, text: "continue", enter: true };
    await daemon.send(2, input);
    expect(mutations).toEqual([{ "pane.send": { target: 2, text: "continue", enter: true } }]);
    state.server_pid = 43;
    await expect(daemon.send(2, input)).rejects.toThrow("PaneChanged");
    state.server_pid = 42;
    state.panes[0].binding++;
    await expect(daemon.send(2, input)).rejects.toThrow("PaneChanged");
    state.panes[0].binding--;
    state.panes[0].exited = true;
    await expect(daemon.send(2, input)).rejects.toThrow("PaneChanged");
    expect(mutations).toHaveLength(1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
test("phone projection omits transcripts, commands, accounts, and unrelated daemon state", () => {
  const s = snapshot({
    server_pid: 1,
    workspaces: [{ id: 1, name: "Work", cwd: "/private" }],
    panes: [
      {
        id: 2,
        workspace: 1,
        binding: 3n,
        name: "Pane",
        command: "secret",
        agent: { name: "Agent", transcript: "/secret", state: "working" },
      },
    ],
    accounts: ["secret"],
  });
  expect(JSON.stringify(s)).not.toContain("secret");
  expect(JSON.stringify(s)).not.toContain("/private");
  expect(s.panes[0].name).toBe("Agent");
});

test("only blocked tool requests are projected as permission prompts", () => {
  const project = (state: string, tool_active: boolean) =>
    snapshot({
      server_pid: 1,
      workspaces: [],
      panes: [{ id: 1, workspace: 1, binding: 1, agent: { state, tool_active } }],
    }).panes[0].permission;
  expect(project("blocked", true)).toBe(true);
  expect(project("working", true)).toBe(false);
  expect(project("blocked", false)).toBe(false);
});

test("surface and conversation reads are bound before and after, and launches use only daemon defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-phone-api-")),
    socket = join(dir, "daemon.sock"),
    transcript = join(dir, "thread.jsonl");
  await Bun.write(
    transcript,
    JSON.stringify({ type: "session_meta", payload: { id: "thread" } }) +
      "\n" +
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] },
      }) +
      "\n",
  );
  const pane = {
      id: 2,
      workspace: 1,
      binding: 3n,
      exited: false,
      agent: { provider: "codex", session: "thread", transcript },
    },
    state = { server_pid: 42, workspaces: [{ id: 1, name: "Work" }], panes: [pane] };
  const calls: string[] = [],
    commands: unknown[] = [];
  let changeOnSurface = false;
  const server = createServer(client => {
    let buffer = "";
    client.on("data", bytes => {
      buffer += bytes.toString();
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"),
          r = json.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        calls.push(r.op);
        let result: unknown = { ok: true };
        switch (r.op) {
          case "hello":
            result = { type: "hello", protocol: version };
            break;
          case "session.snapshot":
            result = state;
            break;
          case "pane.surface":
            result = {
              type: "surface",
              server_pid: 42,
              surface: { pane: 2, cols: 80, rows: 1, lines: ["\x1b[32mhello\x1b[0m"] },
            };
            if (changeOnSurface) pane.binding++;
            break;
          case "session.command":
            commands.push(r.command);
            result = { ok: true, result: { pane: 2, text: "history" } };
            break;
        }
        client.write(json.stringify({ request_id: r.request_id, ...(result as object) }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const daemon = new Daemon(socket),
      q = { server: 42, binding: "3", conversation: "thread" };
    let listing = await daemon.list();
    expect(listing.panes[0].lastResponse?.availability).toBe("indexing");
    for (let i = 0; i < 100 && listing.panes[0].lastResponse?.availability !== "available"; i++) {
      await Bun.sleep(10);
      listing = await daemon.list();
    }
    expect(listing.panes[0].lastResponse).toEqual({ availability: "available", text: "Hello" });
    expect(JSON.stringify(listing)).not.toContain(transcript);
    pane.agent.session = "different";
    expect((await daemon.list()).panes[0].lastResponse?.text).toBe("");
    pane.agent.session = "thread";
    expect((await daemon.terminal(2, q)).lines).toEqual(["\x1b[32mhello\x1b[0m"]);
    expect((await daemon.conversation(2, q, "", "before")).messages[0].text).toBe("Hello");
    expect(await daemon.lastResponse(2, q)).toBe("Hello");
    await expect(daemon.lastResponse(2, { ...q, conversation: "old" })).rejects.toThrow("PaneChanged");
    expect(await daemon.read(2, q)).toBe("history");
    await expect(daemon.conversation(2, { ...q, conversation: "old" }, "", "before")).rejects.toThrow("PaneChanged");
    await expect(daemon.terminal(2, { ...q, server: 99 })).rejects.toThrow("PaneChanged");
    expect(await daemon.create({ server: 42, workspace: 1, provider: "claude" })).toEqual({ pane: 2, ...q });
    expect(commands.at(-1)).toEqual({ "agent.create": { workspace: 1, provider: "claude" } });
    const mutations = commands.length;
    await expect(daemon.create({ server: 42, workspace: 99, provider: "codex" })).rejects.toThrow("PaneChanged");
    await expect(daemon.create({ server: 99, workspace: 1, provider: "codex" })).rejects.toThrow("PaneChanged");
    expect(commands).toHaveLength(mutations);
    changeOnSurface = true;
    await expect(daemon.terminal(2, q)).rejects.toThrow("PaneChanged");
    expect(calls).not.toContain("viewer.open");
    expect(calls).not.toContain("viewer.sync");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
test("phone order uses shared desktop ordering and per-checkout branches", () => {
  const s = snapshot({
    server_pid: 1,
    workspaces: [
      {
        id: 1,
        name: "Work",
        agent_order: [{ pane: 3 }, { pane: 2 }],
        git_ref: { branch: "refs/heads/main" },
        worktrees: { entries: [{ path: "/repo/work", branch: "refs/heads/feature" }] },
      },
    ],
    panes: [
      { id: 2, workspace: 1, binding: 1n, cwd: "/repo", agent: { provider: "codex", session: "a" } },
      { id: 3, workspace: 1, binding: 2n, cwd: "/repo/work/src", agent: { provider: "claude", session: "b" } },
    ],
  });
  expect([...s.panes].sort((a, b) => a.order - b.order).map(p => [p.id, p.branch])).toEqual([
    [3, "feature"],
    [2, "main"],
  ]);
  expect(s.panes[0].conversation).toBe("a");
});
test("saved dormant panes and headless sessions are excluded from the phone projection", () => {
  const s = snapshot({
    server_pid: 1,
    workspaces: [],
    panes: [{ id: 1, workspace: 1, binding: 2n, dormant: true, agent: { provider: "claude", session: "saved" } }],
    headless_sessions: [{ id: 9, provider: "codex" }],
  });
  expect(s.panes).toEqual([]);
});

test("phone activity preserves completion receipts beyond number precision and normalizes outcomes", () => {
  const raw = {
    server_pid: 1,
    workspaces: [],
    panes: [
      { id: 1, binding: 2n, workspace: 1, agent: { observation: { completed: 9007199254740993n, outcome: "failed" } } },
    ],
  };
  expect(snapshot(raw).panes[0]).toMatchObject({ completion: "9007199254740993", outcome: "failed" });
  expect(
    snapshot({ ...raw, panes: [{ ...raw.panes[0], agent: { observation: { completed: {}, outcome: "invalid" } } }] })
      .panes[0].completion,
  ).toBeUndefined();
});
