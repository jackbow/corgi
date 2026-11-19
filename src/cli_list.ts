import { basename } from "node:path";
import * as text from "./text";

export type Options = { all?: boolean; tree?: boolean; workspace?: number; width?: number };
type Agent = { provider?: string | null; state?: string; attention?: string; name?: string };
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

/** Pane IDs in visual split order. */
export function panes(nodes: Node[], index: number): number[] {
  const node = nodes[index];
  if (!node) return [];
  return "pane" in node ? [node.pane] : [...panes(nodes, node.split.first), ...panes(nodes, node.split.second)];
}

/** Keep the full snapshot shape when narrowing to one workspace. */
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

/** One row per terminal or headless agent, in workspace and visual tab order. */
export function compact(reply: Reply, { all = false, width = 100 }: Options = {}): string {
  const rows: string[][] = [],
    byId = new Map((reply.result?.panes ?? []).map(p => [p.id, p]));
  let hidden = 0;
  const add = (id: string, w: Workspace, p: Pane, title = "") => {
    if (!all && (w.archived || p.dormant || p.exited)) {
      hidden++;
      return;
    }
    const a = p.agent,
      attention = a?.attention && a.attention !== "none" ? a.attention.replaceAll("_", " ") : "",
      status = w.archived
        ? "archived"
        : p.dormant
          ? "hibernated"
          : p.exited
            ? "exited"
            : attention || (a?.provider ? a.state || "unknown" : "running"),
      name = p.name || a?.name || title || p.command || basename(p.cwd || w.cwd || "") || "shell";
    rows.push([id, a?.provider || "-", `${w.name || `workspace ${w.id}`} / ${name}`, status].map(text.spacedControls));
  };
  for (const w of reply.result?.workspaces ?? []) {
    for (const t of w.model?.tabs ?? [])
      for (const id of panes(w.model!.nodes, t.root)) {
        const p = byId.get(id);
        if (p) add(String(id), w, p, t.title);
      }
    for (const s of reply.result?.headless_sessions ?? [])
      if (s.workspace === w.id && !s.corgi)
        add(`headless:${s.id}`, w, {
          ...s,
          agent: {
            ...s.agent,
            provider: s.provider ?? s.agent?.provider,
            state: s.state ?? s.agent?.state,
            attention: s.attention ?? s.agent?.attention,
          },
        });
  }
  const out: string[] = [];
  if (!rows.length) out.push("no sessions");
  else {
    const headers = ["ID", "AGENT", "WORKSPACE / SESSION", "STATUS"],
      widths = headers.map((h, i) => Math.max(text.displayWidth(h), ...rows.map(r => text.displayWidth(r[i]))));
    widths[2] = Math.max(1, Math.min(widths[2], width - widths[0] - widths[1] - widths[3] - 6));
    for (const row of [headers, ...rows])
      out.push(
        row
          .map((value, i) => {
            const clipped = text.ellipsis(value, widths[i]);
            return i === 3 ? clipped : clipped + " ".repeat(widths[i] - text.displayWidth(clipped));
          })
          .join("  ")
          .trimEnd(),
      );
  }
  if (hidden) out.push(`${hidden} inactive hidden (--all)`);
  return out.join("\n") + "\n";
}
