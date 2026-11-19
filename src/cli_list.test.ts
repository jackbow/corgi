import { expect, test } from "bun:test";
import { compact, select, type Reply } from "./cli_list";
import { displayWidth } from "./text";

function snapshot() {
  return {
    ok: true,
    result: {
      revision: 12,
      workspaces: [
        {
          id: 2,
          name: "api",
          cwd: "/src/api",
          model: {
            nodes: [{ split: { first: 1, second: 2 } }, { pane: 9 }, { pane: 10 }, { pane: 11 }, { pane: 12 }],
            tabs: [
              { id: 20, root: 0, title: "Build" },
              { id: 21, root: 3 },
              { id: 22, root: 4 },
            ],
          },
        },
        { id: 3, name: "web", archived: true, model: { nodes: [{ pane: 13 }], tabs: [{ id: 23, root: 0 }] } },
      ],
      panes: [
        { id: 10, name: "manual name", agent: { provider: "codex", state: "working", name: "agent name" } },
        { id: 9, agent: { provider: "claude", state: "blocked", attention: "needs_input" } },
        { id: 11, dormant: true, agent: { provider: "codex", state: "working" } },
        { id: 12, exited: true, command: "bun test" },
        { id: 13, cwd: "/src/web" },
      ],
      headless_sessions: [
        {
          id: 4,
          workspace: 2,
          provider: "codex",
          state: "blocked",
          attention: "none",
          agent: { state: "idle", name: "Triage" },
        },
        { id: 5, workspace: 2, corgi: true, provider: "claude" },
        { id: 6, workspace: 2, exited: true, provider: "claude" },
      ],
    },
    viewers: [
      { id: 1, workspace: 2 },
      { id: 2, workspace: 3 },
    ],
  };
}

test("compact sessions follow visual order, prefer names and use aggregate headless state", () => {
  const output = compact(snapshot());
  expect(
    output
      .trimEnd()
      .split("\n")
      .map(line => line.trim().split(/\s{2,}/)),
  ).toEqual([
    ["PANE", "TAB", "WS", "AGENT", "WORKSPACE", "SESSION", "STATUS"],
    ["9", "20", "2", "claude", "api", "Build", "needs input"],
    ["10", "20", "2", "codex", "api", "manual name", "working"],
    ["headless:4", "-", "2", "codex", "api", "Triage", "blocked"],
    ["4 inactive hidden (--all)"],
  ]);
  expect(output).not.toContain("headless:5");
  expect(output).not.toContain("agent name");
});

test("--all includes dormant, exited and archived sessions without hiding their lifecycle", () => {
  const output = compact(snapshot(), { all: true });
  expect(output).toMatch(/11\s+21\s+2\s+codex\s+api\s+api\s+hibernated/);
  expect(output).toMatch(/12\s+22\s+2\s+-\s+api\s+bun test\s+exited/);
  expect(output).toMatch(/13\s+23\s+3\s+-\s+web\s+web\s+archived/);
  expect(output).toMatch(/headless:6\s+-\s+2\s+claude\s+api\s+api\s+exited/);
  expect(output).not.toContain("hidden");
});

test("workspace filtering narrows JSON collections and retains snapshot metadata without mutation", () => {
  const reply = snapshot(),
    filtered = select(reply, 3);
  expect(filtered).toEqual({
    ...reply,
    result: {
      ...reply.result,
      workspaces: [reply.result.workspaces[1]],
      panes: [reply.result.panes[4]],
      headless_sessions: [],
    },
    viewers: [reply.viewers[1]],
  });
  expect(select(reply)).toBe(reply);
  expect(reply.result.panes).toHaveLength(5);
  expect(() => select(reply, 999)).toThrow("NoWorkspace");
});

test("empty and entirely inactive snapshots give explicit feedback", () => {
  expect(compact({})).toBe("no sessions\n");
  expect(compact(select(snapshot(), 3))).toBe("no sessions\n1 inactive hidden (--all)\n");
});

test("compact rows sanitize controls and clip Unicode names to terminal cells while keeping IDs and status", () => {
  const reply = snapshot();
  reply.result.workspaces[0].name = "项目".repeat(60);
  reply.result.panes[1].agent!.name = "bad\n\x1b[31mname";
  for (const width of [60, 80, 120]) {
    const output = compact(reply, { width });
    for (const line of output.trimEnd().split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(width);
    expect(output).toContain("…");
    expect(output).toContain("headless:4");
    expect(output).toContain("needs input");
  }
  reply.result.workspaces[0].name = "api";
  expect(compact(reply)).toContain("bad  [31mname");
  expect(compact(reply)).not.toContain("\x1b");
});

test("untracked programs show their command or directory and running status", () => {
  const reply: Reply = {
    result: {
      workspaces: [{ id: 1, name: "api", model: { nodes: [{ pane: 7 }], tabs: [{ id: 8, root: 0 }] } }],
      panes: [{ id: 7, cwd: "/src/app", command: "tail -f log" }],
    },
  };
  expect(compact(reply)).toMatch(/7\s+8\s+1\s+-\s+api\s+tail -f log\s+running/);
  reply.result!.panes![0].command = "";
  expect(compact(reply)).toMatch(/api\s+app\s+running/);
});

test("nonterminal output keeps full names for AI callers", () => {
  const reply = snapshot();
  reply.result.workspaces[0].name = "long workspace name ".repeat(12);
  expect(compact(reply)).toContain(reply.result.workspaces[0].name);
});
