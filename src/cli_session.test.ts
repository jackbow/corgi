import { test, expect, spyOn } from "bun:test";
import { Catalog, details, type Reply } from "./cli_session";
import { Registry, type Identity } from "./task_registry";
import * as cli from "./cli";
import * as task_cli from "./task_cli";

function fixture() {
  const reply: Reply = {
    result: {
      workspaces: [
        {
          id: 1,
          name: "api",
          cwd: "/src/api",
          model: {
            nodes: [{ pane: 3 }, { pane: 4 }],
            tabs: [
              { id: 30, root: 0, title: "Review" },
              { id: 40, root: 1, title: "Writer" },
            ],
          },
        },
        { id: 2, name: "web", model: { nodes: [{ pane: 5 }], tabs: [{ id: 50, root: 0 }] } },
      ],
      panes: [
        {
          id: 3,
          name: "reviewer",
          cwd: "/src/api/lib",
          agent: { provider: "codex", name: "Audit changes", state: "working", activity: "Checking errors\nnow" },
        },
        { id: 4, name: "writer", agent: { provider: "claude", state: "idle" } },
        { id: 5, name: "reviewer", agent: { provider: "claude", state: "idle" } },
      ],
      headless_sessions: [{ id: 7, workspace: 1, provider: "claude", agent: { name: "triage", state: "idle" } }],
    },
  };
  const registry = new Registry(),
    parent: Identity = { pane: 4, provider: "claude", generation: 1n, session: "parent" },
    child: Identity = { pane: 3, provider: "codex", generation: 1n, session: "child" };
  const task = registry.add({ kind: "agent", pane: 3, workspace: 1, name: "helper", parent });
  registry.set(task, "running");
  registry.helpers.push({ pane: 3, workspace: 1, name: "helper", parent, notify: true, identity: child });
  const catalog = new Catalog(reply, registry.snapshot(null, null, null));
  return { reply, registry, catalog, task };
}

test("session IDs, caller, names and launcher aliases resolve within a workspace", () => {
  const { catalog } = fixture();
  for (const target of ["3", "pane:3", "reviewer", "Review", "Audit changes", "helper"])
    expect(catalog.resolve(target, { workspace: 1 }).pane).toBe(3);
  expect(catalog.resolve("current", { caller: 4 }).tab).toBe(40);
  expect(catalog.resolve("reviewer", { caller: 4 }).pane).toBe(3);
  expect(catalog.resolve("reviewer", { workspace: 2 }).pane).toBe(5);
  expect(catalog.resolve("writer").pane).toBe(4);
  expect(() => catalog.resolve("reviewer")).toThrow("AmbiguousTarget");
  expect(() => catalog.resolve("current")).toThrow("NoCallerPane");
  expect(() => catalog.resolve("missing")).toThrow("NoSession");
  expect(() => catalog.resolve("pane:3", { workspace: 2 })).toThrow("NoSession");
  expect(catalog.resolve("triage")).toMatchObject({ target: "headless:7", pane: null, tab: null });
  expect(catalog.resolve("headless:7").name).toBe("triage");
});

test("duplicate names in a workspace require IDs rather than silently choosing a session", () => {
  const { reply, registry } = fixture();
  reply.result!.panes![1].name = "reviewer";
  expect(() => new Catalog(reply, registry.snapshot(null, null, null)).resolve("reviewer", { workspace: 1 })).toThrow(
    "AmbiguousTarget",
  );
});

test("get includes the latest assignment and parent/helper links without dumping output", () => {
  const { catalog, task } = fixture();
  const detail = catalog.detail(catalog.resolve("helper"));
  expect(detail).toMatchObject({
    target: "pane:3",
    pane: 3,
    tab: 30,
    workspace: 1,
    cwd: "/src/api/lib",
    task: { id: `task:${task.id}`, state: "running" },
    parent: "pane:4",
    helpers: [],
  });
  expect(detail).not.toHaveProperty("aliases");
  expect(detail.task).not.toHaveProperty("output");
  expect(catalog.detail(catalog.resolve("writer")).helpers).toEqual([{ target: "pane:3", name: "helper" }]);
  expect(details(detail)).toContain("activity: Checking errors now");
  expect(details(detail)).toContain("parent: pane:4");
  expect(details(catalog.detail(catalog.resolve("triage")))).toContain("task: -");
});

test("names resolve before pane commands are sent and bad arguments never trigger discovery", async () => {
  const { reply, registry } = fixture(),
    calls: [string, unknown][] = [];
  const daemon = {
    socket: "/unused",
    call: async (op: string, query: unknown) => {
      calls.push([op, query]);
      if (op === "session.list") return reply;
      if (op === "task.list") return { snapshot: registry.snapshot(null, null, null) };
      return { result: {} };
    },
  } as never;
  const written = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await cli.run(daemon, ["pane", "swap", "helper", "writer", "--workspace", "1", "--json"]);
    expect(calls.at(-1)).toEqual(["session.command", { command: { "pane.swap": { target: 3, other: 4 } } }]);
    calls.length = 0;
    await expect(cli.run(daemon, ["pane", "keys", "helper", "bad-key"])).rejects.toThrow("InvalidKey");
    expect(calls).toEqual([]);
    await cli.run(daemon, ["get", "helper", "--json"]);
    expect(JSON.parse(String(written.mock.calls.at(-1)![0])).session).toMatchObject({ pane: 3, tab: 30, workspace: 1 });
  } finally {
    written.mockRestore();
  }
});

test("task commands resolve session names and collect retained tasks after a pane disappears", async () => {
  const { reply, registry, task } = fixture(),
    calls: [string, unknown][] = [];
  const daemon = {
    socket: "/unused",
    call: async (op: string, query: unknown) => {
      calls.push([op, query]);
      if (op === "session.list") return reply;
      if (op === "task.list") return { snapshot: registry.snapshot(null, null, null) };
      return { task };
    },
  } as never;
  const saved = process.env.CORGI_PANE,
    written = spyOn(process.stdout, "write").mockReturnValue(true);
  delete process.env.CORGI_PANE;
  try {
    await task_cli.run(daemon, ["task", "get", "Audit changes", "--json"]);
    expect(calls.at(-1)).toEqual(["task.get", { target: "pane:3", workspace: 1, caller: 0 }]);
    await task_cli.run(daemon, ["message", "helper", "Check errors", "--workspace", "1", "--json"]);
    expect(calls.at(-1)?.[1]).toMatchObject({ target: "helper", workspace: 1 });
    reply.result!.panes = reply.result!.panes!.filter(p => p.id !== 3);
    await task_cli.run(daemon, ["task", "get", "pane:3", "--json"]);
    expect(calls.at(-1)).toEqual(["task.get", { target: `task:${task.id}`, workspace: 1, caller: 0 }]);
  } finally {
    if (saved === undefined) delete process.env.CORGI_PANE;
    else process.env.CORGI_PANE = saved;
    written.mockRestore();
  }
});

test("named headless messages use the native channel and reject task-only delivery options", async () => {
  const { reply, registry } = fixture(),
    calls: [string, unknown][] = [];
  const daemon = {
    socket: "/unused",
    call: async (op: string, query: unknown) => {
      calls.push([op, query]);
      if (op === "session.list") return reply;
      if (op === "task.list") return { snapshot: registry.snapshot(null, null, null) };
      return { ok: true, result: {} };
    },
  } as never;
  const written = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await cli.run(daemon, ["message", "triage", "--", "--busy"]);
    expect(calls.at(-1)).toEqual([
      "session.command",
      { command: { "agent.message": { target: { headless: 7 }, text: "--busy" } } },
    ]);
    for (const option of [["--busy", "queue"], ["--wait"]]) {
      calls.length = 0;
      await expect(cli.run(daemon, ["message", "triage", "hello", ...option])).rejects.toThrow("PaneRequired");
      expect(calls.some(([op]) => op === "session.command" || op === "task.message")).toBe(false);
    }
  } finally {
    written.mockRestore();
  }
});
