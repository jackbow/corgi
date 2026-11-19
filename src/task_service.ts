//! Daemon orchestration over ordinary panes and the existing agent observers.
import { Runtime, Launch, type Pane, type Create } from "./runtime";
import { adapter } from "./providers";
import * as launcher from "./launcher_config";
import * as agentMessage from "./agent_message";
import * as accountLock from "./account_lock";
import * as integration from "./integration";
import * as os from "./os";
import * as errors from "./errors";
import * as tasks from "./task_registry";
import type { Terminal } from "./pane/terminal";
import type { Server } from "./server";
import type { Requests } from "./protocol";
import { readFileSync, unlinkSync } from "node:fs";

type Context = Pick<Create, "socket" | "executable" | "theme">;
const attached = new WeakMap<Terminal, Set<bigint>>();
const sending = new WeakMap<Runtime, Set<bigint>>();
const noting = new WeakSet<tasks.Note>();
const sockets = new WeakMap<Runtime, string>();
export function identity(pane: Pane | null | undefined): tasks.Identity | null {
  const agent = pane?.agent();
  return pane && agent?.provider
    ? { pane: pane.id, generation: pane.attachment.generation, provider: agent.provider, session: agent.sessionId() }
    : null;
}
function matches(r: Runtime, value: tasks.Identity | null): boolean {
  if (!value) return false;
  const pane = r.pane(value.pane),
    current = identity(pane);
  // A screen-only agent can acquire its first structured conversation later.
  if (
    pane &&
    current &&
    !value.session &&
    current.session &&
    current.provider === value.provider &&
    current.generation === value.generation + 1n &&
    pane.attachment.known.length === 1
  ) {
    Object.assign(value, current);
    r.tasks.changed();
  }
  return tasks.same(value, current);
}
export function context(r: Runtime, caller: number, workspace: number) {
  const pane = caller ? r.pane(caller) : null;
  if (caller && !pane) throw Error("NoCallerPane");
  const id = workspace || (pane && r.workspaces.owner(pane.id)?.id) || 0;
  if (!id) throw Error("MissingWorkspace");
  r.getWorkspace(id);
  const helper = pane && r.tasks.helpers.find(h => h.pane === pane.id);
  return { workspace: id, caller: identity(pane), parent: helper?.parent ?? null };
}
function target(r: Runtime, name: string, workspace: number, caller: number): Pane {
  const ctx = context(r, caller, workspace),
    helper = r.tasks.helpers.find(h => h.workspace === ctx.workspace && h.name === name),
    explicit = /^(?:pane:)?([1-9][0-9]*)$/.exec(name),
    id =
      name === "current"
        ? caller
        : name === "parent"
          ? ctx.parent?.pane
          : (helper?.pane ?? (explicit ? Number(explicit[1]) : 0)),
    pane = id ? r.pane(id) : null;
  if (!pane) throw Error("NoAgent");
  if (name === "parent" && !matches(r, ctx.parent)) throw Error("ParentChanged");
  if (helper?.identity && !matches(r, helper.identity)) throw Error("HelperChanged");
  return pane;
}
export function get(r: Runtime, q: Requests["task.get"]): tasks.Task {
  const id = /^task:([1-9][0-9]*)$/.exec(q.target);
  if (id) return r.tasks.get(BigInt(id[1]));
  const ctx = context(r, q.caller, q.workspace);
  return r.tasks.resolve(q.target === "current" ? `pane:${q.caller}` : q.target, ctx.workspace, ctx.parent);
}
function observe(r: Runtime, task: tasks.Task, terminal: Terminal): void {
  if (task.kind !== "command") return;
  let ids = attached.get(terminal);
  if (!ids) attached.set(terminal, (ids = new Set()));
  if (ids.has(task.id)) return;
  ids.add(task.id);
  const output = new tasks.Output(task.decoder);
  terminal.on("output", (bytes: Uint8Array) => {
    if (task.kind === "command" && !tasks.settled(task.state)) {
      r.tasks.append(task, output.feed(bytes));
      r.tasks.changed(task);
    }
  });
  terminal.on("exit", () => {
    if (task.kind === "command") r.tasks.append(task, output.feed(new Uint8Array(), true));
    exited(r, task, terminal);
  });
  if (terminal.exited) exited(r, task, terminal);
}
function exited(r: Runtime, task: tasks.Task, terminal: Terminal): void {
  if (tasks.settled(task.state)) return;
  if (task.kind === "command") {
    const status = terminal.exit_status;
    let receipt: number | null = null;
    if (
      task.receipt &&
      task.receipt.startsWith(`${sockets.get(r)}.task-${task.id}-`) &&
      /^[0-9a-f-]+\.exit$/.test(task.receipt.slice(`${sockets.get(r)}.task-${task.id}-`.length))
    ) {
      try {
        const text = readFileSync(task.receipt, "utf8").trim();
        if (/^[0-9]{1,3}$/.test(text) && Number(text) <= 255) receipt = Number(text);
        unlinkSync(task.receipt);
        task.receipt = "";
      } catch {}
    }
    if (receipt === null && terminal.imported) {
      r.tasks.set(task, "unknown", "exit_status_unavailable");
      return;
    }
    task.signal = status & 0x7f || null;
    task.exit_code = receipt ?? (task.signal ? 128 + task.signal : (status >>> 8) & 0xff);
    r.tasks.set(task, task.exit_code === 0 ? "completed" : "failed", "exited");
  } else r.tasks.set(task, "interrupted", "agent_exited");
}
export async function start(r: Runtime, ctx: Context, q: Requests["task.start"]): Promise<tasks.Task> {
  sockets.set(r, ctx.socket);
  if (q.no_parent && q.parent !== null) throw Error("InvalidParent");
  const parentPane = q.no_parent ? null : r.pane(q.parent ?? q.caller),
    parent = identity(parentPane);
  if (q.parent !== null && !parent) throw Error("NoAgent");
  const parentWorkspace = parentPane && r.workspaces.owner(parentPane.id)?.id,
    workspace = q.workspace || parentWorkspace || r.workspaces.owner(q.caller)?.id || 0;
  if (parent && parentWorkspace !== workspace) throw Error("ParentWorkspaceMismatch");
  if (!workspace) throw Error("MissingWorkspace");
  if (q.name && !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(q.name)) throw Error("InvalidTaskName");
  if ((!q.agent && !q.argv.length) || (q.agent && (!q.prompt.trim() || q.argv.length)) || (!q.agent && q.prompt))
    throw Error("InvalidTask");
  const ws = r.getWorkspace(workspace),
    dir = q.cwd || parentPane?.cwd || ws.cwd;
  let launch: Launch | null = null;
  if (q.agent) {
    const found = launcher
      .catalog(r)
      .filter(a => a.row === q.agent || a.agent === q.agent || a.names.includes(q.agent));
    if (!found.length) throw Error("UnknownAgent");
    if (found.length !== 1) throw Error("AmbiguousAgent");
    const chosen = found[0];
    if (r.tasks.helpers.length >= 1024) throw Error("TooManyHelpers");
    if (chosen.provider) {
      accountLock.check(chosen.provider, chosen.account);
      if (chosen.account) await integration.prepare(chosen.provider, chosen.account);
      accountLock.check(chosen.provider, chosen.account);
    } else {
      const command = r.agent_commands[Number(chosen.agent.split("/")[1]) - 1];
      if (command.semantics.provider) accountLock.check(command.semantics.provider, command.semantics.account);
    }
    launch = chosen.provider
      ? Launch.in(chosen.provider, chosen.account, chosen.yolo, chosen.options)
      : new Launch(undefined, r.agent_commands[Number(chosen.agent.split("/")[1]) - 1].command);
  }
  const task = r.tasks.add({
    kind: launch ? "agent" : "command",
    workspace,
    name: q.name,
    parent,
    notify: q.notify,
    prompt: q.prompt,
  });
  if (!launch) task.receipt = `${ctx.socket}.task-${task.id}-${crypto.randomUUID()}.exit`;
  try {
    const pane = await r.create({
      ...ctx,
      workspace,
      cwd: dir,
      cols: 100,
      rows: 30,
      title: q.name,
      ...(launch
        ? launch.run(ctx.executable)
        : {
            command: `exec ${os.shellWords(["/bin/sh", "-c", `"$@"; corgi_task_status=$?; umask 077; printf '%s\\n' "$corgi_task_status" > ${os.shellQuote(task.receipt)}; exit "$corgi_task_status"`, "corgi-task", ...q.argv])}`,
          }),
      observe: (id, terminal) => {
        task.pane = id;
        observe(r, task, terminal);
      },
    });
    if (launch) {
      r.pane(pane)!.launch = launch;
      r.tasks.helpers.push({ pane, workspace, name: q.name, parent, notify: q.notify, identity: null });
      if (launch.agent) r.rememberAgent(pane, launch.agent.provider);
    } else if (!tasks.settled(task.state)) r.tasks.set(task, "running");
    r.tasks.changed(task);
    return task;
  } catch (error) {
    task.prompt = "";
    r.tasks.set(task, "failed", errors.name(error) ?? "TaskFailed");
    throw error;
  }
}
function available(pane: Pane): boolean {
  const agent = pane.agent();
  return (
    !pane.dormant &&
    !pane.terminal.exited &&
    !pane.idleShell() &&
    !!agent.provider &&
    (agent.state === "idle" || agent.state === "done") &&
    !agent.paused &&
    !agent.compacting
  );
}
function canPrompt(r: Runtime, pane: Pane): boolean {
  const provider = pane.agent().provider;
  return (
    available(pane) &&
    !r.startup_waits.some(wait => wait.pane === pane.id) &&
    !r.renames.some(rename => rename.pane === pane.id) &&
    (!provider ||
      (adapter(provider).message?.empty?.(pane.terminal) !== false &&
        adapter(provider).message?.ready?.(pane.terminal) !== false))
  );
}
export function message(r: Runtime, q: Requests["task.message"]): tasks.Task {
  if (!q.text.trim()) throw Error("InvalidMessage");
  const pane = target(r, q.target, q.workspace, q.caller),
    agent = pane.agent(),
    binding = identity(pane);
  if (!binding || pane.dormant || pane.terminal.exited || pane.idleShell()) throw Error("NoAgent");
  const pending = r.tasks.tasks.some(t => t.pane === pane.id && !tasks.settled(t.state));
  if (q.busy === "reject" && (!canPrompt(r, pane) || pending)) throw Error("AgentBusy");
  if (
    q.busy === "steer" &&
    !available(pane) &&
    (!adapter(binding.provider).message?.steer || agent.state !== "working" || !agent.turnId())
  )
    throw Error("SteeringUnsupported");
  const helper = r.tasks.helpers.find(h => h.pane === pane.id),
    task = r.tasks.add({
      kind: "agent",
      pane: pane.id,
      workspace: r.workspaces.owner(pane.id)!.id,
      identity: binding,
      prompt: q.text,
      busy: q.busy,
      parent: helper?.parent ?? identity(r.pane(q.caller)),
      notify: helper?.notify ?? true,
    });
  task.name = helper?.name ?? "";
  r.tasks.set(task, "queued");
  return task;
}
async function deliver(r: Runtime, task: tasks.Task, pane: Pane): Promise<void> {
  let active = sending.get(r);
  if (!active) sending.set(r, (active = new Set()));
  if (active.has(task.id)) return;
  active.add(task.id);
  const binding = identity(pane)!,
    agent = pane.agent();
  task.identity = binding;
  task.completed = agent.observation.completed;
  task.epoch = agent.turn_epoch;
  task.turn = agent.turnId();
  task.saw_work = false;
  task.source = agent.observation.source;
  task.joined = task.busy === "steer" && agent.state === "working";
  task.delivered = true;
  task.reason = "delivering";
  r.tasks.set(task, "running", "delivering");
  try {
    if (task.joined) {
      const steer = adapter(binding.provider).message?.steer;
      if (!steer) throw Error("SteeringUnsupported");
      await steer(binding.session, task.turn, task.prompt, pane.account());
      task.delivery = "message";
      task.saw_work = true;
    } else {
      const sent = await agentMessage.send(r, { pane: pane.id }, task.prompt, () => {
        if (!matches(r, binding)) throw Error("AgentChanged");
        if (!canPrompt(r, pane)) throw Error("AgentBusy");
      });
      task.delivery = sent.delivery;
    }
    if (!matches(r, binding)) throw Error("DeliveryUnknown");
    task.prompt = "";
    task.reason = "";
    r.tasks.changed(task);
  } catch (error) {
    const name = errors.name(error) ?? "TaskFailed";
    if (task.busy === "queue" && (name === "AgentBusy" || name === "AgentBlocked")) {
      task.delivered = false;
      r.tasks.set(task, name === "AgentBlocked" ? "blocked" : "queued", "waiting_for_idle");
      return;
    }
    task.prompt = "";
    r.tasks.set(task, name === "DeliveryUnknown" ? "unknown" : "failed", name);
  } finally {
    active.delete(task.id);
  }
}
function advance(r: Runtime, task: tasks.Task): void {
  if (tasks.settled(task.state)) return;
  const pane = r.pane(task.pane);
  if (!pane) {
    r.tasks.set(task, "interrupted", "pane_closed");
    return;
  }
  observe(r, task, pane.terminal);
  if (pane.terminal.exited) {
    exited(r, task, pane.terminal);
    return;
  }
  if (task.kind === "command") return;
  if (pane.dormant) {
    r.tasks.set(task, "interrupted", "pane_hibernated");
    return;
  }
  const agent = pane.agent();
  if (task.identity && !matches(r, task.identity)) {
    r.tasks.set(task, "interrupted", "agent_changed");
    return;
  }
  if (!task.delivered) {
    if (task.state === "starting" && Date.now() - task.created > 60_000) {
      task.prompt = "";
      r.tasks.set(task, "failed", "startup_timeout");
      return;
    }
    if (task.state === "starting" && agent.state === "blocked") {
      r.tasks.set(task, "blocked", "startup_blocked");
      return;
    }
    const earlier = r.tasks.tasks.some(t => t.id < task.id && t.pane === task.pane && !tasks.settled(t.state));
    const uncertain = r.tasks.tasks.some(
      t => t.pane === task.pane && t.state === "unknown" && t.reason !== "daemon_restarted",
    );
    if (uncertain) {
      r.tasks.set(task, "blocked", "delivery_uncertain");
      return;
    }
    if (earlier && task.busy !== "steer") return;
    if (canPrompt(r, pane) || (task.busy === "steer" && agent.state === "working")) void deliver(r, task, pane);
    else if (agent.state === "blocked") r.tasks.set(task, "blocked", "agent_blocked");
    return;
  }
  if (sending.get(r)?.has(task.id)) return;
  if (agent.paused) return;
  if (agent.state === "working" && (task.joined || agent.turn_epoch > task.epoch || agent.turnId() !== task.turn)) {
    task.saw_work = true;
    task.turn = agent.turnId();
  }
  if (agent.observation.completed > task.completed) {
    // Receipt counters are tied to this actor; old identified turns cannot settle new work.
    const finished = agent.last_finished_turn.text();
    if (!task.joined && !task.saw_work && finished && finished === task.turn) return;
    if (task.saw_work && task.turn && finished && finished !== task.turn) return;
    task.source = agent.observation.source;
    const outcome = agent.observation.outcome;
    r.tasks.append(task, pane.terminal.liveText());
    r.tasks.set(task, outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "interrupted", outcome);
  } else if (agent.state === "blocked") r.tasks.set(task, "blocked", "needs_input");
  else if (task.state === "blocked" && agent.state === "working") r.tasks.set(task, "running");
}
async function notify(r: Runtime, note: tasks.Note): Promise<void> {
  if (noting.has(note)) return;
  noting.add(note);
  note.delivery = "sending";
  r.tasks.changed();
  try {
    const task = r.tasks.get(note.task);
    await agentMessage.send(
      r,
      { pane: note.parent.pane },
      `[Corgi helper ${task.name || `pane:${task.pane}`} task:${task.id}] ${note.state}${task.exit_code !== null ? ` (exit ${task.exit_code})` : ""}. Collect with: corgi task get task:${task.id}`,
      () => {
        const pane = r.pane(note.parent.pane);
        if (!matches(r, note.parent) || !pane || !canPrompt(r, pane)) throw Error("AgentBusy");
      },
    );
    note.delivery = "sent";
  } catch (error) {
    note.delivery = errors.is(error, "DeliveryUnknown")
      ? "unknown"
      : errors.is(error, "AgentBusy") || errors.is(error, "AgentBlocked")
        ? "pending"
        : "suppressed";
  } finally {
    noting.delete(note);
    r.tasks.changed();
  }
}
export function tick(r: Runtime, socket?: string): void {
  if (socket) sockets.set(r, socket);
  for (const helper of r.tasks.helpers) {
    if (!helper.identity) {
      const pane = r.pane(helper.pane);
      if (pane && available(pane)) {
        helper.identity = identity(pane);
        r.tasks.changed();
      }
    }
  }
  for (const task of r.tasks.tasks) advance(r, task);
  const helpers = r.tasks.helpers.filter(h => !!r.pane(h.pane));
  if (helpers.length !== r.tasks.helpers.length) {
    r.tasks.helpers = helpers;
    r.tasks.prune();
    r.tasks.changed();
  }
  for (const note of r.tasks.notes) {
    if (note.delivery !== "pending") continue;
    const pane = r.pane(note.parent.pane);
    if (!matches(r, note.parent) || !pane || pane.terminal.exited) {
      note.delivery = "suppressed";
      r.tasks.changed();
    } else if (
      canPrompt(r, pane) &&
      !r.tasks.notes.some(
        other =>
          other.seq < note.seq &&
          tasks.same(other.parent, note.parent) &&
          (other.delivery === "pending" || other.delivery === "sending"),
      )
    )
      void notify(r, note);
  }
}
/** Install listeners before live handoff activates PTYs and consumes buffered output. */
export function bind(r: Runtime, socket: string): void {
  sockets.set(r, socket);
  for (const task of r.tasks.tasks) {
    const pane = r.pane(task.pane);
    if (pane && !tasks.settled(task.state)) observe(r, task, pane.terminal);
  }
}
export function flush(server: Server): void {
  for (const client of server.clients) {
    const sub = client.tasks;
    if (client.dead || !sub || sub.revision === server.runtime.tasks.revision) continue;
    sub.revision = server.runtime.tasks.revision;
    client.queue(server.runtime.tasks.snapshot(sub.workspace, sub.task, sub.parent));
  }
}
