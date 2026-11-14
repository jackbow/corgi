import { expect, test } from "bun:test";
import { decode, matches, terminalBundle, open, type Target } from "./notification_focus";
import { createServer } from "./fixtures/websocket_server";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as json from "./json";
const target: Target = {
  socket: "/tmp/corgi.sock",
  server: 1,
  pane: 2,
  binding: "9007199254740993",
  conversation: "abc",
};
const snapshot = {
  server_pid: 1,
  panes: [{ id: 2, binding: 9007199254740993n, exited: false, agent: { session: "abc" } }],
};
test("notification callbacks retain exact identity and reject reused panes and daemons", () => {
  expect(decode(Buffer.from(JSON.stringify(target)).toString("base64url"))).toEqual(target);
  expect(matches(target, snapshot)).toBe(true);
  for (const change of [{ server: 2 }, { pane: 3 }, { binding: "1" }, { conversation: "new" }])
    expect(matches({ ...target, ...change }, snapshot)).toBe(false);
  expect(matches(target, { ...snapshot, panes: [{ ...snapshot.panes[0], exited: true }] })).toBe(false);
  expect(() => decode(Buffer.from(JSON.stringify({ ...target, socket: "relative" })).toString("base64url"))).toThrow(
    "InvalidNotificationTarget",
  );
});
test("activation uses the selected viewer's terminal and never raises a remote viewer's app", () => {
  expect(terminalBundle({ env: { TERM_PROGRAM: "ghostty" } })).toBe("com.mitchellh.ghostty");
  expect(terminalBundle({ env: { TERM_PROGRAM: "iTerm.app" } })).toBe("com.googlecode.iterm2");
  expect(terminalBundle({ ssh: true, env: { TERM_PROGRAM: "ghostty" } })).toBeNull();
  expect(terminalBundle({ env: { TERM_PROGRAM: "unknown" } })).toBeNull();
});

test("clicking focuses the requesting pane's viewer and rejects a conversation switched during lookup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-notification-focus-")),
    socket = join(dir, "daemon.sock");
  let binding = 9007199254740993n,
    changed = false;
  const focused: unknown[] = [],
    activated: string[] = [];
  const server = createServer(client => {
    let buffer = "";
    client.on("data", bytes => {
      buffer += bytes.toString();
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"),
          request = json.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        let reply: object;
        switch (request.op) {
          case "session.snapshot":
            reply = { ...snapshot, panes: [{ ...snapshot.panes[0], binding }] };
            break;
          case "viewer.list":
            reply = {
              ok: true,
              viewers: [
                { id: 1, pane: 9, workspace: 1, watched: true },
                { id: 2, pane: 2, workspace: 1, watched: false },
              ],
            };
            if (changed) binding++;
            break;
          case "bugreport":
            reply = { ok: true, viewers: [{ id: 2, terminal: { env: { TERM_PROGRAM: "ghostty" } } }] };
            break;
          case "focus":
            focused.push({ pane: request.pane, viewer: request.viewer });
            reply = { ok: true, viewer: request.viewer, queued: true };
            break;
          default:
            throw Error("UnexpectedRequest");
        }
        client.write(json.stringify({ ...reply, request_id: request.request_id }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    await open({ ...target, socket }, async bundle => {
      activated.push(bundle);
    });
    expect(focused).toEqual([{ pane: 2, viewer: 2 }]);
    expect(activated).toEqual(["com.mitchellh.ghostty"]);
    changed = true;
    await expect(
      open({ ...target, socket }, async bundle => {
        activated.push(bundle);
      }),
    ).rejects.toThrow("StaleNotification");
    expect(focused).toHaveLength(1);
    expect(activated).toHaveLength(1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
