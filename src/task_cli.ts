import { Args } from "./cli";
import * as rpc from "./rpc";
import type { Daemon } from "./rpc_http";
import type { RequestInput } from "./protocol";
import * as tasks from "./task_registry";
import * as json from "./json";
import * as errors from "./errors";

type Common = { json: boolean; timeout: number; workspace: number; caller: number };
type Invocation = Common &
  (
    | { op: "start"; request: RequestInput<"task.start">; bg: boolean }
    | { op: "message"; request: RequestInput<"task.message">; wait: boolean }
    | { op: "wait"; target: string; children: "any" | "all" | null; output: string | null }
    | { op: "get" | "cancel"; target: string }
    | { op: "list" }
  );
export type Result = { ok: boolean; reason: string; tasks: tasks.Task[]; exit_code: number; note?: tasks.Note };
export function handles(words: string[]): boolean {
  if (["run", "wait", "task"].includes(words[0])) return true;
  if (words[0] !== "message") return false;
  const args = new Args(words.slice(1));
  return (
    args.options.has("busy") ||
    args.options.has("wait") ||
    !/^(current|[1-9][0-9]*|(?:pane|headless):[1-9][0-9]*)$/.test(args.positional[0] ?? "")
  );
}
function number(value: string | null, fallback = 0): number {
  if (value === null) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 0xffffffff)
    throw Error("Usage");
  return Number(value);
}
export async function parse(words: string[], caller = 0, input = () => Bun.stdin.text()): Promise<Invocation> {
  const group = words[0],
    end = words.indexOf("--"),
    split = group === "run" && end >= 0 ? end : words.length,
    args = new Args(words.slice(group === "task" ? 2 : 1, split)),
    timeout = Number(args.option("timeout") ?? 180),
    common: Common = { json: args.flag("json"), timeout, workspace: number(args.option("workspace")), caller };
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 2_147_483) throw Error("Usage");
  let result: Invocation;
  switch (group) {
    case "run": {
      const agent = args.option("agent") ?? "",
        stdin = args.flag("stdin"),
        request: RequestInput<"task.start"> = {
          workspace: common.workspace,
          caller,
          agent,
          name: args.option("name") ?? "",
          cwd: args.option("cwd") ?? "",
          parent: number(args.option("parent")) || null,
          no_parent: args.flag("no-parent"),
          notify: !args.flag("no-notify"),
          argv: end < 0 ? [] : words.slice(end + 1),
          prompt: agent ? (stdin ? await input() : args.positional.join(" ")) : "",
        };
      if (agent) args.positional = [];
      if ((!agent && (!request.argv?.length || stdin)) || (agent && (!request.prompt?.trim() || request.argv?.length)))
        throw Error("Usage");
      result = { ...common, op: "start", request, bg: args.flag("bg") };
      break;
    }
    case "message": {
      const target = args.next(),
        stdin = args.flag("stdin"),
        text = stdin ? await input() : args.positional.join(" "),
        busy = args.option("busy") ?? "reject";
      if (!["reject", "queue", "steer"].includes(busy) || !text.trim()) throw Error("Usage");
      args.positional = [];
      result = {
        ...common,
        op: "message",
        request: { target, text, busy: busy as tasks.Busy, caller, workspace: common.workspace },
        wait: args.flag("wait"),
      };
      break;
    }
    case "wait": {
      const children = args.option("children"),
        output = args.option("output"),
        target = args.positional.shift() ?? "";
      if (children !== null && children !== "any" && children !== "all") throw Error("Usage");
      if ((!target && !children) || (children && (target || output !== null || !caller)) || output === "")
        throw Error("Usage");
      result = { ...common, op: "wait", children, output, target };
      break;
    }
    case "task": {
      const op = words[1];
      if (op === "list") result = { ...common, op };
      else if (op === "get" || op === "cancel") result = { ...common, op, target: args.next() };
      else throw Error("Usage");
      break;
    }
    default:
      throw Error("Usage");
  }
  args.end();
  return result;
}
function status(items: tasks.Task[], reason: string): Result {
  const task = items[0],
    exit =
      reason === "timeout"
        ? 124
        : reason === "output"
          ? 0
          : items.length === 1 && task.kind === "command" && task.exit_code !== null
            ? task.exit_code
            : items.every(t => t.state === "completed")
              ? 0
              : 1;
  return { ok: exit === 0, reason, tasks: items, exit_code: exit };
}
/** Chooses tasks once; subsequent work cannot extend an all-children wait. */
export class Waiter {
  private ids: Set<bigint> | null = null;
  private parent: tasks.Identity | null | undefined;
  private offsets = new Map<bigint, bigint>();
  private match = "";
  latest: tasks.Task[] = [];
  constructor(
    readonly children: "any" | "all" | null,
    readonly output: string | null,
    readonly stream: ((text: string) => void) | null = null,
    initial: tasks.Task | null = null,
  ) {
    if (initial) this.latest = [initial];
  }
  target(fallback: string): string {
    return !this.children && this.ids?.size === 1 ? `task:${[...this.ids][0]}` : fallback;
  }
  update(snapshot: tasks.Snapshot): Result | null {
    if (this.children) {
      if (this.parent === undefined) this.parent = snapshot.caller;
      if (!this.parent) throw Error("NoAgent");
      if (!tasks.same(this.parent, snapshot.caller)) throw Error("ParentChanged");
    }
    if (this.children === "any") {
      this.latest = snapshot.tasks.filter(t => tasks.same(t.parent, snapshot.caller));
      const note = snapshot.notes.find(n => !n.seen);
      if (!note) return null;
      const task = snapshot.tasks.find(t => t.id === note.task);
      if (!task) return null;
      const result = status([task], note.state);
      if (note.state !== "completed") {
        result.ok = false;
        result.exit_code = task.exit_code || 1;
      }
      return { ...result, note };
    }
    if (this.ids === null) {
      let selected = snapshot.tasks;
      if (this.children === "all") {
        const own = selected.filter(t => tasks.same(t.parent, snapshot.caller));
        selected = own.filter(
          t => !tasks.settled(t.state) || !own.some(other => other.pane === t.pane && other.id > t.id),
        );
      }
      this.ids = new Set(selected.map(t => t.id));
      if (!this.children && !selected.length) throw Error("NoTask");
    }
    this.latest = snapshot.tasks.filter(t => this.ids!.has(t.id));
    if (this.latest.length !== this.ids.size) throw Error("TaskExpired");
    for (const task of this.latest) {
      if (this.output !== null && task.kind !== "command") throw Error("OutputWaitRequiresCommand");
      const previous = this.offsets.get(task.id);
      let offset = previous ?? (this.output !== null ? task.output_end : 0n);
      if (this.output !== null && offset < task.output_start)
        return { ok: false, reason: "output_truncated", tasks: [task], exit_code: 1 };
      if (offset < task.output_start) offset = task.output_start;
      const chunk = Buffer.from(task.output)
        .subarray(Number(offset - task.output_start))
        .toString();
      this.offsets.set(task.id, task.output_end);
      if (this.stream && task.kind === "command") this.stream(chunk);
      if (this.output !== null) {
        const text = this.match + chunk;
        if (text.includes(this.output)) return status([task], "output");
        this.match = this.output.length > 1 ? text.slice(-(this.output.length - 1)) : "";
      }
    }
    if (!this.latest.every(t => tasks.stopped(t.state))) return null;
    if (this.output !== null)
      return { ok: false, reason: "output_not_found", tasks: this.latest, exit_code: this.latest[0].exit_code || 1 };
    return status(this.latest, this.children ? "children" : this.latest[0].reason || this.latest[0].state);
  }
  timeout(): Result {
    return status(this.latest, "timeout");
  }
}
async function wait(
  daemon: Daemon,
  inv: Common,
  target: string,
  children: "any" | "all" | null,
  output: string | null,
  stream = false,
  initial: tasks.Task | null = null,
): Promise<Result> {
  const waiter = new Waiter(children, output, stream && !inv.json ? text => process.stdout.write(text) : null, initial),
    until = Date.now() + inv.timeout * 1000;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.on("SIGINT", interrupt);
  try {
    for (;;) {
      const connection = new rpc.Connection(daemon.socket);
      try {
        const result = await new Promise<Result | "reconnect">((resolve, reject) => {
          const update = (snapshot: tasks.Snapshot) => {
            try {
              const result = waiter.update(snapshot);
              if (result) resolve(result);
            } catch (error) {
              reject(error);
            }
          };
          const timer = setInterval(() => {
            if (interrupted) resolve({ ...waiter.timeout(), ok: false, reason: "interrupted", exit_code: 130 });
            else if (Date.now() >= until) resolve(waiter.timeout());
          }, 50);
          connection.onEvent(event => {
            if (event.type === "tasks") update(tasks.decode(event));
          });
          connection.onClose(() => {
            clearInterval(timer);
            resolve("reconnect");
          });
          void (async () => {
            await connection.call("hello");
            const reply = await connection.call("task.subscribe", {
              target: waiter.target(target),
              caller: inv.caller,
              workspace: inv.workspace,
            });
            update(tasks.decode(reply.snapshot));
          })().catch(reject);
        });
        if (result !== "reconnect") {
          if (result.note) await daemon.call("task.ack", { caller: inv.caller, through: result.note.seq });
          return result;
        }
      } catch (error) {
        if (
          !connection.disconnected ||
          !["ConnectionClosed", "ConnectFailed", "ENOENT", "ECONNREFUSED"].includes(errors.name(error) ?? "")
        )
          throw error;
      } finally {
        connection.close();
      }
      if (interrupted) return { ...waiter.timeout(), ok: false, reason: "interrupted", exit_code: 130 };
      if (Date.now() >= until) return waiter.timeout();
      await Bun.sleep(50);
    }
  } finally {
    process.off("SIGINT", interrupt);
  }
}
function label(task: tasks.Task): string {
  return `task:${task.id} ${task.name || `pane:${task.pane}`} ${task.state}${task.exit_code !== null ? ` exit=${task.exit_code}` : ""}${task.reason ? ` ${task.reason}` : ""}${task.truncated ? " output_truncated" : ""}`;
}
export async function run(daemon: Daemon, words: string[]): Promise<void> {
  const inv = await parse(words, Number(process.env.CORGI_PANE) || 0),
    query = { caller: inv.caller, workspace: inv.workspace };
  if (inv.op === "get" || inv.op === "cancel") {
    const reply = await daemon.call(inv.op === "get" ? "task.get" : "task.cancel", { ...query, target: inv.target }),
      task = tasks.decodeTask(reply.task);
    process.stdout.write(inv.json ? json.stringify(reply) + "\n" : label(task) + "\n" + task.output);
    return;
  }
  if (inv.op === "list") {
    const reply = await daemon.call("task.list", query);
    process.stdout.write(
      inv.json ? json.stringify(reply) + "\n" : tasks.decode(reply.snapshot).tasks.map(label).join("\n") + "\n",
    );
    return;
  }
  let target = inv.op === "wait" ? inv.target : "",
    stream = false,
    initial: tasks.Task | null = null;
  if (inv.op === "start" || inv.op === "message") {
    const reply =
        inv.op === "start"
          ? await daemon.call("task.start", inv.request)
          : await daemon.call("task.message", inv.request),
      task = tasks.decodeTask(reply.task);
    initial = task;
    if (inv.op === "start" ? inv.bg : !inv.wait) {
      process.stdout.write(inv.json ? json.stringify({ ok: true, task }) + "\n" : label(task) + "\n");
      return;
    }
    target = `task:${task.id}`;
    stream = inv.op === "start" && task.kind === "command";
    if (!inv.json) process.stderr.write(label(task) + "\n");
  }
  const result = await wait(
    daemon,
    inv,
    target,
    inv.op === "wait" ? inv.children : null,
    inv.op === "wait" ? inv.output : null,
    stream,
    initial,
  );
  for (let i = 0; inv.op === "wait" && inv.children && i < result.tasks.length; i++) {
    const reply = await daemon.call("task.get", { target: `task:${result.tasks[i].id}` });
    result.tasks[i] = tasks.decodeTask(reply.task);
  }
  if (inv.json) process.stdout.write(json.stringify(result) + "\n");
  else {
    if (!stream && result.tasks.length === 1) process.stdout.write(result.tasks[0].output);
    process.stderr.write(`${result.reason}${result.tasks.length ? ": " + result.tasks.map(label).join("; ") : ""}\n`);
  }
  process.exitCode = result.exit_code;
}
