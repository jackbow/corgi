import { Connection } from "../rpc";
import { field, str } from "../json";
import type { CommandInput } from "../protocol";

export interface Pane {
  id: number;
  workspace: number;
  name: string;
  state: string;
  activity: string;
  binding: string;
  exited: boolean;
}
export interface Snapshot {
  server: number;
  workspaces: { id: number; name: string }[];
  panes: Pane[];
}
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw Error("InvalidSnapshot");
  return value;
};
export function snapshot(value: unknown): Snapshot {
  return {
    server: number(field(value, "server_pid")),
    workspaces: rows(field(value, "workspaces")).map(w => ({ id: number(field(w, "id")), name: str(w, "name") })),
    panes: rows(field(value, "panes")).map(p => {
      const agent = field(p, "agent"),
        binding = field(p, "binding");
      if (typeof binding !== "bigint" && (typeof binding !== "number" || !Number.isSafeInteger(binding)))
        throw Error("InvalidSnapshot");
      return {
        id: number(field(p, "id")),
        workspace: number(field(p, "workspace")),
        name: str(agent, "name") || str(p, "name") || `Pane ${field(p, "id")}`,
        state: str(agent, "state"),
        activity: str(agent, "recent_activity"),
        binding: String(binding),
        exited: field(p, "exited") === true,
      };
    }),
  };
}
export interface Input {
  server: number;
  binding: string;
  text?: string;
  enter?: boolean;
  key?: string;
}
const keys = new Set(["enter", "escape", "up", "down", "left", "right", "ctrl+c", "tab"]);
export function input(value: unknown): Input {
  const server = number(field(value, "server")),
    binding = str(value, "binding");
  if (!/^\d+$/.test(binding)) throw Error("InvalidInput");
  const key = field(value, "key"),
    text = field(value, "text"),
    enter = field(value, "enter");
  if (typeof key === "string" && keys.has(key) && text === null && enter === null) return { server, binding, key };
  if (key === null && typeof text === "string" && Buffer.byteLength(text) <= 8192 && typeof enter === "boolean")
    return { server, binding, text, enter };
  throw Error("InvalidInput");
}
export interface Backend {
  list(): Promise<Snapshot>;
  read(pane: number): Promise<string>;
  send(pane: number, input: Input): Promise<void>;
}
export class Daemon implements Backend {
  constructor(private socket: string) {}
  private async withConnection<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    const c = new Connection(this.socket),
      timer = setTimeout(() => c.close(), 5000);
    try {
      await c.call("hello");
      return await fn(c);
    } finally {
      clearTimeout(timer);
      c.close();
    }
  }
  async list() {
    return this.withConnection(async c => snapshot(await c.call("session.snapshot")));
  }
  async read(pane: number) {
    return this.withConnection(
      async c =>
        (await c.call("session.command", { command: { "pane.read": { target: pane, lines: 300n, view: "history" } } }))
          .result.text ?? "",
    );
  }
  async send(pane: number, q: Input) {
    await this.withConnection(async c => {
      const s = snapshot(await c.call("session.snapshot")),
        p = s.panes.find(p => p.id === pane);
      if (s.server !== q.server || !p || p.binding !== q.binding || p.exited) throw Error("PaneChanged");
      const command: CommandInput = q.key
        ? { "pane.keys": { target: pane, text: q.key } }
        : { "pane.send": { target: pane, text: q.text!, enter: q.enter! } };
      await c.call("session.command", { command });
    });
  }
}
