import { Connection } from "../rpc";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { field, str } from "../json";
import type { CommandInput } from "../protocol";
import { Reader } from "./conversation";
import { Previews } from "./previews";
import type { Conversation } from "./conversation_types";
import type { Provider, Pane, Snapshot, Identity, Launch, Terminal } from "./types";
export type { Pane, Snapshot, Identity, Launch, Terminal } from "./types";
import { rank, type Target } from "../agent_order";
import { terminalKeys, terminalCommand, type Management } from "./controls";
import { prompt, responseKeys, type Prompt } from "./prompts";
import * as profiles from "../agent_profiles";
import type { Profile } from "./types";
import { Archive } from "./archive";
import { catalog, type Command as SlashCommand } from "./catalog";
import { Updates } from "./updates";
import type { UpdateState } from "./types";

const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw Error("InvalidSnapshot");
  return value;
};
export function snapshot(value: unknown): Snapshot {
  return {
    server: number(field(value, "server_pid")),
    workspaces: rows(field(value, "workspaces")).map((w, order) => ({
      id: number(field(w, "id")),
      name: str(w, "name"),
      order,
    })),
    panes: rows(field(value, "panes"))
      .filter(p => field(p, "dormant") !== true)
      .map(p => {
        const agent = field(p, "agent"),
          binding = field(p, "binding"),
          observation = field(agent, "observation"),
          completion = field(observation, "completed"),
          outcome = str(observation, "outcome");
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
          provider: provider(str(agent, "provider")),
          conversation: str(agent, "session"),
          attention: str(agent, "attention"),
          completion:
            typeof completion === "bigint" || (typeof completion === "number" && Number.isSafeInteger(completion))
              ? String(completion)
              : undefined,
          outcome: outcome === "completed" || outcome === "interrupted" || outcome === "failed" ? outcome : undefined,
          branch: branch(value, p),
          order: displayOrder(value, p),
        };
      }),
  };
}
function provider(value: string): Provider | null {
  return value === "codex" || value === "claude" ? value : null;
}
function branch(value: unknown, pane: unknown): string {
  const w = rows(field(value, "workspaces")).find(w => field(w, "id") === field(pane, "workspace"));
  const cwd = str(field(pane, "agent"), "cwd") || str(pane, "cwd");
  const tree = rows(field(field(w, "worktrees"), "entries"))
    .filter(t => str(t, "path") === cwd || cwd.startsWith(str(t, "path") + "/"))
    .sort((a, b) => str(b, "path").length - str(a, "path").length)[0];
  const root = str(w, "cwd");
  return (
    tree
      ? str(tree, "branch")
      : !root || cwd === root || cwd.startsWith(root + "/")
        ? str(field(w, "git_ref"), "branch")
        : ""
  ).replace(/^refs\/heads\//, "");
}
function displayOrder(value: unknown, pane: unknown): number {
  const w = rows(field(value, "workspaces")).find(w => field(w, "id") === field(pane, "workspace"));
  const targets = (key: string) => rows(field(w, key)) as Target[];
  return rank(targets("agent_order"), { pane: number(field(pane, "id")) });
}
export function identity(value: unknown): Identity {
  const q = {
    server: number(field(value, "server")),
    binding: str(value, "binding"),
    conversation: str(value, "conversation"),
  };
  if (!/^\d+$/.test(q.binding) || q.conversation.length > 256) throw Error("InvalidInput");
  return q;
}
export function launch(value: unknown): Launch {
  const selected = provider(str(value, "provider"));
  if (!selected || !value || Object.keys(value).some(k => !["server", "workspace", "provider", "profile"].includes(k)))
    throw Error("InvalidInput");
  const profile = field(value, "profile");
  if (profile !== null && (typeof profile !== "string" || !/^[a-z0-9-]{1,64}$/.test(profile)))
    throw Error("InvalidInput");
  return {
    server: number(field(value, "server")),
    workspace: number(field(value, "workspace")),
    provider: selected,
    ...(profile ? { profile } : {}),
  };
}
export interface Input {
  server: number;
  binding: string;
  text?: string;
  enter?: boolean;
  key?: string;
  conversation?: string;
}
const keys = new Set(terminalKeys);
export function input(value: unknown): Input {
  const server = number(field(value, "server")),
    binding = str(value, "binding");
  if (!/^\d+$/.test(binding)) throw Error("InvalidInput");
  const key = field(value, "key"),
    text = field(value, "text"),
    enter = field(value, "enter");
  const conversation = field(value, "conversation");
  if (conversation !== null && (typeof conversation !== "string" || conversation.length > 256))
    throw Error("InvalidInput");
  const current = conversation === null ? {} : { conversation };
  if (typeof key === "string" && keys.has(key) && text === null && enter === null)
    return { server, binding, ...current, key };
  if (key === null && typeof text === "string" && Buffer.byteLength(text) <= 8192 && typeof enter === "boolean")
    return { server, binding, ...current, text, enter };
  throw Error("InvalidInput");
}
export interface Backend {
  list(): Promise<Snapshot>;
  activity?(): Promise<Snapshot>;
  lastResponse?(pane: number, identity: Identity): Promise<string>;
  read(pane: number, identity?: Identity, lines?: number): Promise<string>;
  send(pane: number, input: Input): Promise<void>;
  terminal(pane: number, identity: Identity): Promise<Terminal>;
  conversation(pane: number, identity: Identity, cursor: string, direction: "before" | "after"): Promise<Conversation>;
  create(launch: Launch): Promise<{ pane: number } & Identity>;
  manage?(action: Management): Promise<void>;
  profiles?(): Promise<Profile[]>;
  prompt?(pane: number, identity: Identity): Promise<Prompt | null>;
  respond?(pane: number, identity: Identity, prompt: string, choice: number): Promise<void>;
  watch?(signal: AbortSignal, changed: (snapshot?: Snapshot) => void): Promise<void>;
  archive?(pane: number, identity: Identity, cursor: string): Promise<Conversation>;
  commands?(pane: number, identity: Identity): Promise<SlashCommand[]>;
  update?(server?: number): Promise<UpdateState>;
}
export class Daemon implements Backend {
  private reader = new Reader();
  private responseReader = new Reader();
  private previews = new Previews();
  private archiveReader = new Archive();
  private responding = new Set<number>();
  private prompts = new Map<number, { digest: string; fingerprint: string; consumed: boolean }>();
  private updater: Updates;
  constructor(private socket: string) {
    this.updater = new Updates(
      () =>
        this.withConnection(async c => {
          const h = await c.call("hello");
          return { server: number(field(h, "server_pid")), executable: str(h, "executable") };
        }),
      socket,
    );
  }
  update(server?: number) {
    return server === undefined ? this.updater.status() : this.updater.start(server);
  }
  private observe(s: Snapshot, observed = Date.now()) {
    for (const pane of this.prompts.keys()) {
      const p = s.panes.find(p => p.id === pane);
      if (!p || p.exited || (p.attention !== "needs_input" && p.state !== "blocked")) this.prompts.delete(pane);
    }
    return { ...s, observed };
  }
  async commands(pane: number, q: Identity) {
    return this.withConnection(async c => {
      const { raw, p } = await this.checked(c, pane, q),
        record = raw.panes.find(p => p.id === pane);
      if (!p.provider) return [];
      const result = await catalog(p.provider, record?.agent.cwd || record?.cwd || "", str(record?.agent, "account"));
      await this.checked(c, pane, q);
      return result;
    });
  }
  async archive(pane: number, q: Identity, cursor: string) {
    return this.withConnection(async c => {
      const { raw, p } = await this.checked(c, pane, q),
        record = raw.panes.find(p => p.id === pane);
      if (!p.provider) throw Error("Unsupported");
      const result = await this.archiveReader.read(record?.agent.transcript ?? "", p.provider, q.conversation, cursor);
      await this.checked(c, pane, q);
      return result;
    });
  }
  async profiles(): Promise<Profile[]> {
    return profiles
      .list()
      .flatMap(p =>
        p.provider === "codex" || p.provider === "claude" ? [{ id: p.id, name: p.name, provider: p.provider }] : [],
      );
  }
  async watch(signal: AbortSignal, changed: (snapshot?: Snapshot) => void) {
    const c = new Connection(this.socket);
    const close = () => c.close();
    signal.addEventListener("abort", close, { once: true });
    try {
      if (signal.aborted) return;
      await c.call("hello");
      c.onEvent(e => {
        if (e.type === "session") changed(this.observe(snapshot(e)));
      });
      const observed = Date.now();
      changed(this.observe(snapshot(await c.call("session.subscribe")), observed));
      await new Promise<void>(resolve => {
        c.socket.once("close", resolve);
        if (c.socket.destroyed) resolve();
      });
    } finally {
      signal.removeEventListener("abort", close);
      c.close();
    }
  }
  async prompt(pane: number, q: Identity) {
    return this.withConnection(async c => {
      const { p } = await this.checked(c, pane, q);
      if (!p.provider || (p.attention !== "needs_input" && p.state !== "blocked")) {
        this.prompts.delete(pane);
        return null;
      }
      const result = await c.call("pane.surface", { pane });
      await this.checked(c, pane, q);
      const current = prompt(result.surface.lines, p.provider, q);
      if (!current) {
        this.prompts.delete(pane);
        return null;
      }
      let issued = this.prompts.get(pane);
      if (!issued || issued.digest !== current.id) {
        issued = { digest: current.id, fingerprint: randomBytes(32).toString("base64url"), consumed: false };
        this.prompts.delete(pane);
        this.prompts.set(pane, issued);
        while (this.prompts.size > 128) this.prompts.delete(this.prompts.keys().next().value!);
      }
      return { ...current, id: issued.fingerprint };
    });
  }
  async respond(pane: number, q: Identity, fingerprint: string, choice: number) {
    if (this.responding.has(pane)) throw Error("PromptChanged");
    this.responding.add(pane);
    try {
      await this.withConnection(async c => {
        const { p } = await this.checked(c, pane, q);
        if (!p.provider || (p.attention !== "needs_input" && p.state !== "blocked")) throw Error("PromptChanged");
        const result = await c.call("pane.surface", { pane });
        const current = prompt(result.surface.lines, p.provider, q);
        const issued = this.prompts.get(pane);
        if (
          !current ||
          !issued ||
          issued.fingerprint !== fingerprint ||
          issued.digest !== current.id ||
          issued.consumed
        )
          throw Error("PromptChanged");
        const text = responseKeys(current, choice);
        await this.checked(c, pane, q);
        issued.consumed = true;
        await c.call("session.command", { command: { "pane.keys": { target: pane, text } } });
      });
    } finally {
      this.responding.delete(pane);
    }
  }
  async manage(q: Management) {
    return this.withConnection(async c => {
      let command: CommandInput;
      if ("pane" in q) {
        const { p } = await this.checked(c, q.pane, q.identity);
        switch (q.action) {
          case "rename-agent":
            command = { "agent.rename": { target: q.pane, name: q.name } };
            break;
          case "stop-agent":
            command = { "pane.close": { target: q.pane } };
            break;
          case "clear-agent":
            if (p.state !== "idle" || p.attention === "needs_input" || !p.provider) throw Error("AgentBusy");
            command = {
              "pane.send": { target: q.pane, text: p.provider === "codex" ? "/new" : "/clear", enter: true },
            };
            break;
        }
      } else {
        const s = snapshot(await c.call("session.snapshot"));
        if (s.server !== q.server || ("workspace" in q && !s.workspaces.some(w => w.id === q.workspace)))
          throw Error("PaneChanged");
        switch (q.action) {
          case "create-workspace":
            if (!(await stat(q.cwd).catch(() => null))?.isDirectory()) throw Error("InvalidInput");
            command = { "workspace.create": { name: q.name, cwd: q.cwd } };
            break;
          case "rename-workspace":
            command = { "workspace.edit": { target: q.workspace, name: q.name } };
            break;
          case "close-workspace":
            command = { "workspace.close": { target: q.workspace, close_contents: true } };
            break;
          case "move-workspace":
            if (!s.workspaces.some(w => w.id === q.before) || q.before === q.workspace) throw Error("InvalidInput");
            command = { "workspace.move": { target: q.workspace, before: q.before } };
            break;
        }
      }
      await c.call("session.command", { command });
    });
  }
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
    const observed = Date.now();
    const raw = await this.withConnection(c => c.call("session.snapshot")),
      data = this.observe(snapshot(raw), observed);
    const files = new Map(rows(field(raw, "panes")).map(p => [field(p, "id"), str(field(p, "agent"), "transcript")]));
    const values = this.previews.sync(
      data.server,
      data.panes.map(pane => ({ pane, file: files.get(pane.id) ?? "" })),
    );
    return { ...data, panes: data.panes.map(pane => ({ ...pane, lastResponse: values.get(pane.id) })) };
  }
  async activity() {
    return this.withConnection(async c => this.observe(snapshot(await c.call("session.snapshot"))));
  }
  async read(pane: number, q?: Identity, lines = 300) {
    return this.withConnection(async c => {
      if (q) await this.checked(c, pane, q);
      const text =
        (
          await c.call("session.command", {
            command: { "pane.read": { target: pane, lines: BigInt(lines), view: "history" } },
          })
        ).result.text ?? "";
      if (q) await this.checked(c, pane, q);
      return text.slice(-512 * 1024);
    });
  }
  private async checked(c: Connection, pane: number, q: Identity) {
    const raw = await c.call("session.snapshot"),
      s = snapshot(raw),
      p = s.panes.find(p => p.id === pane);
    if (s.server !== q.server || !p || p.binding !== q.binding || p.conversation !== q.conversation || p.exited)
      throw Error("PaneChanged");
    return { raw, p };
  }
  async terminal(pane: number, q: Identity): Promise<Terminal> {
    return this.withConnection(async c => {
      await this.checked(c, pane, q);
      const result = await c.call("pane.surface", { pane });
      await this.checked(c, pane, q);
      const s = result.surface;
      if (
        s.cols > 1000 ||
        s.rows > 1000 ||
        s.lines.length > 1000 ||
        s.lines.reduce((n, l) => n + l.length, 0) > 2 * 1024 * 1024
      )
        throw Error("SurfaceTooLarge");
      return { ...q, pane, cols: s.cols, rows: s.rows, lines: s.lines };
    });
  }
  async conversation(pane: number, q: Identity, cursor: string, direction: "before" | "after"): Promise<Conversation> {
    return this.withConnection(async c => {
      const { raw, p } = await this.checked(c, pane, q);
      const record = raw.panes.find(p => p.id === pane);
      const result = p.provider
        ? await this.reader.read(record?.agent.transcript ?? "", p.provider, q.conversation, cursor, direction)
        : { availability: "unavailable" as const, version: "", messages: [], before: null, after: null, more: false };
      await this.checked(c, pane, q);
      return result;
    });
  }
  async lastResponse(pane: number, q: Identity): Promise<string> {
    return this.withConnection(async c => {
      const { raw, p } = await this.checked(c, pane, q),
        record = raw.panes.find(p => p.id === pane);
      const result = p.provider
        ? await this.responseReader.preview(record?.agent.transcript ?? "", p.provider, q.conversation)
        : null;
      await this.checked(c, pane, q);
      return result?.availability === "available" ? (result.messages[0]?.text ?? "") : "";
    });
  }
  async create(q: Launch): Promise<{ pane: number } & Identity> {
    return this.withConnection(async c => {
      const s = snapshot(await c.call("session.snapshot"));
      if (s.server !== q.server || !s.workspaces.some(w => w.id === q.workspace)) throw Error("PaneChanged");
      if (q.profile && !(await this.profiles()).some(p => p.id === q.profile && p.provider === q.provider))
        throw Error("InvalidInput");
      const result = await c.call("session.command", {
        command: q.profile
          ? { "agent.profile.create": { workspace: q.workspace, id: q.profile } }
          : { "agent.create": { workspace: q.workspace, provider: q.provider } },
      });
      const pane = result.result.pane;
      const next = snapshot(await c.call("session.snapshot")),
        p = next.panes.find(p => p.id === pane);
      if (!p || next.server !== q.server) throw Error("PaneChanged");
      return { pane: p.id, server: next.server, binding: p.binding, conversation: p.conversation };
    });
  }
  async send(pane: number, q: Input) {
    await this.withConnection(async c => {
      const s = snapshot(await c.call("session.snapshot")),
        p = s.panes.find(p => p.id === pane);
      if (
        s.server !== q.server ||
        !p ||
        p.binding !== q.binding ||
        p.exited ||
        (q.conversation !== undefined && p.conversation !== q.conversation)
      )
        throw Error("PaneChanged");
      const command: CommandInput = q.key
        ? terminalCommand(pane, q.key)
        : { "pane.send": { target: pane, text: q.text!, enter: q.enter! } };
      await c.call("session.command", { command });
    });
  }
}
