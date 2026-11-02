import { expect, test } from "bun:test";
import { createServer } from "node:net";
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
          client.write(json.stringify({ request_id: request.request_id, type: "hello", protocol: 4 }) + "\n");
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
