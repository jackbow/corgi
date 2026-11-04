import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as json from "../json";
import { Daemon } from "./daemon";
import type { Snapshot } from "./types";
test("live subscriptions sanitize snapshots and close on background cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-controls-live-")),
    socket = join(dir, "daemon.sock"),
    received: Snapshot[] = [],
    state = {
      type: "session",
      server_pid: 42,
      workspaces: [{ id: 1, name: "Work", cwd: "/private/work" }],
      panes: [
        {
          id: 1,
          workspace: 1,
          binding: 3n,
          agent: { provider: "codex", session: "thread", transcript: "/private/transcript", account: "secret" },
        },
      ],
    };
  const abort = new AbortController();
  let subscribed = false;
  const server = createServer(client => {
    let buffer = "";
    client.on("data", bytes => {
      buffer += bytes.toString();
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"),
          r = json.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (r.op === "session.subscribe") subscribed = true;
        client.write(
          json.stringify({ request_id: r.request_id, ...(r.op === "hello" ? { type: "hello", protocol: 4 } : state) }) +
            "\n",
        );
        if (r.op === "session.subscribe") client.write(json.stringify({ ...state, panes: [] }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    await new Daemon(socket).watch(abort.signal, data => {
      if (data) received.push(data);
      if (received.length === 2) abort.abort();
    });
    expect(subscribed).toBe(true);
    expect(received).toHaveLength(2);
    expect(received.map(s => s.panes.length).sort()).toEqual([0, 1]);
    expect(received.every(s => typeof s.observed === "number")).toBe(true);
    expect(JSON.stringify(received)).not.toMatch(/private|secret|transcript|account/);
  } finally {
    abort.abort();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
test("management rechecks pane bindings and questions reject stale or duplicate responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-controls-daemon-")),
    socket = join(dir, "daemon.sock"),
    commands: unknown[] = [];
  const pane = {
      id: 1,
      workspace: 1,
      binding: 3n,
      exited: false,
      agent: { state: "blocked", provider: "codex", session: "thread" },
    },
    state = {
      server_pid: 42,
      workspaces: [
        { id: 1, name: "Work" },
        { id: 2, name: "Other" },
      ],
      panes: [pane],
    };
  let lines = ["Approve this operation?", "› 1. Yes", "  2. No", "Enter to select · Esc to cancel"];
  const server = createServer(client => {
    let buffer = "";
    client.on("data", bytes => {
      buffer += bytes.toString();
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"),
          r = json.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        let result: object = { ok: true };
        switch (r.op) {
          case "hello":
            result = { type: "hello", protocol: 4 };
            break;
          case "session.snapshot":
            result = state;
            break;
          case "pane.surface":
            result = { surface: { pane: 1, cols: 80, rows: lines.length, lines } };
            break;
          case "session.command":
            commands.push(r.command);
            result = { ok: true, result: {} };
            break;
        }
        client.write(json.stringify({ request_id: r.request_id, ...result }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const daemon = new Daemon(socket),
      identity = { server: 42, binding: "3", conversation: "thread" },
      p = await daemon.prompt(1, identity);
    expect(p?.choices).toHaveLength(2);
    await daemon.respond(1, identity, p!.id, 2);
    expect(commands).toEqual([{ "pane.keys": { target: 1, text: "down enter" } }]);
    await expect(daemon.respond(1, identity, p!.id, 2)).rejects.toThrow("PromptChanged");
    pane.agent.state = "working";
    await daemon.activity();
    pane.agent.state = "blocked";
    const repeated = await daemon.prompt(1, identity);
    expect(repeated!.id).not.toBe(p!.id);
    await expect(daemon.respond(1, identity, p!.id, 1)).rejects.toThrow("PromptChanged");
    lines = ["Approve another operation?", ...lines.slice(1)];
    await expect(daemon.respond(1, identity, p!.id, 1)).rejects.toThrow("PromptChanged");
    await daemon.manage({ action: "rename-agent", pane: 1, identity, name: "Renamed" });
    pane.binding++;
    await expect(daemon.manage({ action: "stop-agent", pane: 1, identity, confirm: true })).rejects.toThrow(
      "PaneChanged",
    );
    pane.binding--;
    await expect(daemon.manage({ action: "clear-agent", pane: 1, identity, confirm: true })).rejects.toThrow(
      "AgentBusy",
    );
    pane.agent.state = "idle";
    await daemon.manage({ action: "clear-agent", pane: 1, identity, confirm: true });
    expect(commands.at(-1)).toEqual({ "pane.send": { target: 1, text: "/new", enter: true } });
    await expect(
      daemon.manage({ action: "close-workspace", server: 42, workspace: 99, confirm: true }),
    ).rejects.toThrow("PaneChanged");
    await daemon.manage({ action: "move-workspace", server: 42, workspace: 2, before: 1 });
    expect(commands.at(-1)).toEqual({ "workspace.move": { target: 2, before: 1 } });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
