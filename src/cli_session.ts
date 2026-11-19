import { basename } from "node:path";
import * as text from "./text";
import * as tasks from "./task_registry";
import type { Daemon } from "./rpc_http";

type Agent = {
  provider?: string | null;
  state?: string;
  attention?: string;
  name?: string;
  activity?: string;
  recent_activity?: string;
};
type Pane = {
  id: number;
  name?: string;
  cwd?: string;
  command?: string;
  dormant?: boolean;
  exited?: boolean;
  agent?: Agent;
};
type Node = { pane: number } | { split: { first: number; second: number } } | null;
type Workspace = {
  id: number;
  name: string;
  cwd?: string;
  archived?: boolean;
  model?: { tabs: { id: number; root: number; title?: string }[]; nodes: Node[] };
};
type Headless = Pane & { workspace: number; corgi?: boolean; provider?: string; state?: string; attention?: string };
export type Reply = {
  result?: { workspaces?: Workspace[]; panes?: Pane[]; headless_sessions?: Headless[] };
  viewers?: { workspace: number }[];
};
export type Session = {
  target: string;
  pane: number | null;
  tab: number | null;
  workspace: number;
  workspace_name: string;
  name: string;
  provider: string | null;
  state: string;
  attention: string;
  cwd: string;
  command: string;
  activity: string;
  inactive: boolean;
  aliases: string[];
};
export type Context = { workspace?: number; caller?: number };

/** Pane IDs in visual split order. */
export function panes(nodes: Node[], index: number): number[] {
  const node = nodes[index];
  if (!node) return [];
  return "pane" in node ? [node.pane] : [...panes(nodes, node.split.first), ...panes(nodes, node.split.second)];
}
export function select(reply: Reply, workspace = 0): Reply {
  if (!workspace) return reply;
  const workspaces = (reply.result?.workspaces ?? []).filter(w => w.id === workspace);
  if (!workspaces.length) throw Error("NoWorkspace");
  const ids = new Set(workspaces.flatMap(w => (w.model?.tabs ?? []).flatMap(t => panes(w.model!.nodes, t.root))));
  return {
    ...reply,
    result: {
      ...reply.result,
      workspaces,
      panes: (reply.result?.panes ?? []).filter(p => ids.has(p.id)),
      headless_sessions: (reply.result?.headless_sessions ?? []).filter(s => s.workspace === workspace),
    },
    viewers: (reply.viewers ?? []).filter(v => v.workspace === workspace),
  };
}
/** Normalize the snapshot once for discovery, lookup and inspection. */
export function sessions(reply: Reply): Session[] {
  const out: Session[] = [],
    byId = new Map((reply.result?.panes ?? []).map(p => [p.id, p]));
  const add = (target: string, pane: number | null, tab: number | null, w: Workspace, p: Pane, title = "") => {
    const a = p.agent,
      names = [p.name, a?.name, title].filter((n): n is string => !!n),
      name = names[0] || p.command || basename(p.cwd || w.cwd || "") || "shell";
    out.push({
      target,
      pane,
      tab,
      workspace: w.id,
      workspace_name: w.name,
      name,
      provider: a?.provider || null,
      state: w.archived
        ? "archived"
        : p.dormant
          ? "hibernated"
          : p.exited
            ? "exited"
            : a?.provider
              ? a.state || "unknown"
              : "running",
      attention: a?.attention || "none",
      cwd: p.cwd || w.cwd || "",
      command: p.command || "",
      activity: a?.activity || a?.recent_activity || "",
      inactive: !!(w.archived || p.dormant || p.exited),
      aliases: [...new Set([...names, name])],
    });
  };
  for (const w of reply.result?.workspaces ?? []) {
    for (const t of w.model?.tabs ?? [])
      for (const id of panes(w.model!.nodes, t.root)) {
        const p = byId.get(id);
        if (p) add(`pane:${id}`, id, t.id, w, p, t.title);
      }
    for (const s of reply.result?.headless_sessions ?? [])
      if (s.workspace === w.id && !s.corgi)
        add(`headless:${s.id}`, null, null, w, {
          ...s,
          agent: {
            ...s.agent,
            provider: s.provider ?? s.agent?.provider,
            state: s.state ?? s.agent?.state,
            attention: s.attention ?? s.agent?.attention,
          },
        });
  }
  return out;
}
export function status(s: Session): string {
  return !s.inactive && s.attention !== "none" ? s.attention.replaceAll("_", " ") : s.state;
}
export class Catalog {
  readonly sessions: Session[];
  constructor(
    reply: Reply,
    readonly tasks: tasks.Snapshot,
  ) {
    this.sessions = sessions(reply);
    for (const s of this.sessions)
      if (s.pane !== null) {
        const helper = tasks.helpers.find(h => h.pane === s.pane),
          latest = tasks.tasks.findLast(t => t.pane === s.pane);
        for (const name of [helper?.name, latest?.name]) if (name && !s.aliases.includes(name)) s.aliases.push(name);
      }
  }
  scope({ workspace = 0, caller = 0 }: Context): number {
    return workspace || this.sessions.find(s => s.pane === caller)?.workspace || 0;
  }
  resolve(target: string, context: Context = {}): Session {
    if (target === "current") {
      const session = this.sessions.find(s => s.pane === context.caller);
      if (!session) throw Error("NoCallerPane");
      return session;
    }
    const key = /^\+?[1-9][0-9]*$/.test(target) ? `pane:${Number(target)}` : target;
    let matches: Session[];
    if (/^(pane|headless):[1-9][0-9]*$/.test(key))
      matches = this.sessions.filter(
        s => s.target === key && (!context.workspace || s.workspace === context.workspace),
      );
    else {
      const scope = this.scope(context);
      matches = this.sessions.filter(s => (!scope || s.workspace === scope) && s.aliases.includes(target));
    }
    if (matches.length > 1) throw Error("AmbiguousTarget");
    if (!matches.length) throw Error("NoSession");
    return matches[0];
  }
  detail(session: Session) {
    const task = session.pane === null ? null : (this.tasks.tasks.findLast(t => t.pane === session.pane) ?? null),
      helper = this.tasks.helpers.find(h => h.pane === session.pane),
      parent = helper?.parent ?? task?.parent ?? null,
      helpers = this.tasks.helpers
        .filter(h => h.parent?.pane === session.pane)
        .map(h => ({ target: `pane:${h.pane}`, name: h.name })),
      { aliases, ...fields } = session;
    return {
      ...fields,
      task: task
        ? { id: `task:${task.id}`, name: task.name, state: task.state, reason: task.reason, exit_code: task.exit_code }
        : null,
      parent: parent ? `pane:${parent.pane}` : null,
      helpers,
    };
  }
}
export async function load(daemon: Pick<Daemon, "call">): Promise<Catalog> {
  const [reply, tracked] = await Promise.all([daemon.call("session.list"), daemon.call("task.list", {})]);
  return new Catalog(reply, tasks.decode(tracked.snapshot));
}
export function details(value: ReturnType<Catalog["detail"]>): string {
  const clean = (value: string) => text.spacedControls(value),
    out = [
      `${value.target} ${value.provider || "-"} ${status({ ...value, aliases: [] })}`,
      `  workspace: ${value.workspace} ${value.workspace_name}`,
      `  tab: ${value.tab ?? "-"}`,
      `  session: ${value.name}`,
      `  cwd: ${value.cwd}`,
    ];
  if (value.command) out.push(`  command: ${value.command}`);
  if (value.activity) out.push(`  activity: ${value.activity}`);
  out.push(
    `  task: ${value.task ? `${value.task.id} ${value.task.state}${value.task.exit_code === null ? "" : ` exit=${value.task.exit_code}`}` : "-"}`,
    `  parent: ${value.parent || "-"}`,
    `  helpers: ${value.helpers.map(h => `${h.target}${h.name ? ` (${h.name})` : ""}`).join(", ") || "-"}`,
  );
  return out.map(clean).join("\n") + "\n";
}
