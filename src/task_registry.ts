//! Tracked work and orchestration links, independent of provider-native subagents.
import type { Provider } from "./providers";
import type { Delivery } from "./protocol";
import type { Source } from "./observation";
import type { Wire } from "./protocol";

export type Busy = "reject" | "queue" | "steer";
export type State =
  "starting" | "queued" | "running" | "blocked" | "completed" | "failed" | "interrupted" | "unknown" | "cancelled";
export type Identity = { pane: number; generation: bigint; provider: Provider; session: string };
type Escape = "text" | "escape" | "csi" | "string" | "string_escape";
export type Decoder = { escape: Escape; pending: number[] };
export type Helper = {
  pane: number;
  workspace: number;
  name: string;
  parent: Identity | null;
  notify: boolean;
  identity: Identity | null;
};
export type Task = {
  id: bigint;
  kind: "command" | "agent";
  workspace: number;
  pane: number;
  name: string;
  parent: Identity | null;
  notify: boolean;
  identity: Identity | null;
  state: State;
  prompt: string;
  busy: Busy;
  created: number;
  updated: number;
  delivered: boolean;
  delivery: Delivery | null;
  joined: boolean;
  completed: bigint;
  turn: string;
  epoch: number;
  saw_work: boolean;
  source: Source;
  reason: string;
  exit_code: number | null;
  signal: number | null;
  output: string;
  output_start: bigint;
  output_end: bigint;
  truncated: boolean;
  decoder: Decoder;
  receipt: string;
};
export type Note = {
  seq: bigint;
  parent: Identity;
  task: bigint;
  state: State;
  seen: boolean;
  delivery: "pending" | "sending" | "sent" | "unknown" | "suppressed";
};
export type Saved = {
  next: bigint;
  sequence: bigint;
  revision: bigint;
  tasks: Task[];
  helpers: Helper[];
  notes: Note[];
};
export type Snapshot = {
  type: "tasks";
  revision: bigint;
  caller: Identity | null;
  tasks: Task[];
  helpers: Helper[];
  notes: Note[];
};
export const output_bytes = 256 * 1024;
export const retained = 256;
export function settled(state: State): boolean {
  return !["starting", "queued", "running", "blocked"].includes(state);
}
export function stopped(state: State): boolean {
  return settled(state) || state === "blocked";
}
export function same(a: Identity | null, b: Identity | null): boolean {
  return (
    !!a &&
    !!b &&
    a.pane === b.pane &&
    a.generation === b.generation &&
    a.provider === b.provider &&
    a.session === b.session
  );
}
function binding(value: Wire<Identity> | null): Identity | null {
  return value && { ...value, generation: BigInt(value.generation) };
}
export function decodeTask(t: Wire<Task>): Task {
  return {
    ...t,
    id: BigInt(t.id),
    parent: binding(t.parent),
    identity: binding(t.identity),
    completed: BigInt(t.completed),
    output_start: BigInt(t.output_start),
    output_end: BigInt(t.output_end),
  };
}
export function decode(value: Wire<Snapshot>): Snapshot {
  return {
    ...value,
    revision: BigInt(value.revision),
    caller: binding(value.caller),
    tasks: value.tasks.map(decodeTask),
    helpers: value.helpers.map(h => ({ ...h, parent: binding(h.parent), identity: binding(h.identity) })),
    notes: value.notes.map(n => ({ ...n, seq: BigInt(n.seq), task: BigInt(n.task), parent: binding(n.parent)! })),
  };
}
/** Plain PTY output, including escapes split across reads. */
export class Output {
  constructor(readonly state: Decoder = { escape: "text", pending: [] }) {}
  feed(bytes: Uint8Array, final = false): string {
    const all = Buffer.concat([Buffer.from(this.state.pending), bytes]);
    let end = all.length;
    if (!final && end) {
      let start = end - 1;
      while (start > 0 && (all[start] & 0xc0) === 0x80) start--;
      const lead = all[start],
        size =
          lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
      if (end - start < size) end = start;
    }
    this.state.pending = Array.from(all.subarray(end));
    const text = new TextDecoder().decode(all.subarray(0, end));
    let out = "";
    for (const char of text) {
      switch (this.state.escape) {
        case "text":
          if (char === "\x1b") this.state.escape = "escape";
          else if (char === "\x9b") this.state.escape = "csi";
          else if (char >= " " || char === "\n" || char === "\t" || char === "\r") out += char;
          break;
        case "escape":
          if (char === "[") this.state.escape = "csi";
          else if ("]PX^_".includes(char)) this.state.escape = "string";
          else this.state.escape = "text";
          break;
        case "csi":
          if (char >= "@" && char <= "~") this.state.escape = "text";
          break;
        case "string":
          if (char === "\x07") this.state.escape = "text";
          else if (char === "\x1b") this.state.escape = "string_escape";
          break;
        case "string_escape":
          this.state.escape = char === "\\" ? "text" : "string";
          break;
      }
    }
    return out;
  }
}
export class Registry {
  constructor(private readonly change: () => void = () => {}) {}
  next = 1n;
  sequence = 0n;
  revision = 1n;
  tasks: Task[] = [];
  helpers: Helper[] = [];
  notes: Note[] = [];
  add(
    q: Pick<Task, "kind" | "workspace"> &
      Partial<Pick<Task, "pane" | "name" | "parent" | "notify" | "prompt" | "busy" | "identity">>,
  ): Task {
    if (this.next >= 1n << 64n || this.tasks.filter(t => !settled(t.state)).length >= 1024) throw Error("TooManyTasks");
    if (
      q.name &&
      (this.helpers.some(h => h.workspace === q.workspace && h.name === q.name) ||
        this.tasks.some(t => t.workspace === q.workspace && t.name === q.name && !settled(t.state)))
    )
      throw Error("TaskNameInUse");
    const task: Task = {
      id: this.next++,
      kind: q.kind,
      workspace: q.workspace,
      pane: q.pane ?? 0,
      name: q.name ?? "",
      parent: q.parent ?? null,
      notify: q.notify ?? true,
      identity: q.identity ?? null,
      state: "starting",
      prompt: q.prompt ?? "",
      busy: q.busy ?? "reject",
      created: Date.now(),
      updated: Date.now(),
      delivered: false,
      delivery: null,
      joined: false,
      completed: 0n,
      turn: "",
      epoch: 0,
      saw_work: false,
      source: "unknown",
      reason: "",
      exit_code: null,
      signal: null,
      output: "",
      output_start: 0n,
      output_end: 0n,
      truncated: false,
      decoder: { escape: "text", pending: [] },
      receipt: "",
    };
    this.tasks.push(task);
    this.changed(task);
    this.prune();
    return task;
  }
  changed(task?: Task): void {
    if (task) task.updated = Date.now();
    this.revision++;
    this.change();
  }
  set(task: Task, state: State, reason = ""): void {
    if (task.state === state && task.reason === reason) return;
    const previous = task.state;
    task.state = state;
    task.reason = reason;
    this.changed(task);
    if (stopped(state) && previous !== state && task.parent) {
      this.notes.push({
        seq: ++this.sequence,
        parent: task.parent,
        task: task.id,
        state,
        seen: false,
        delivery: task.notify ? "pending" : "suppressed",
      });
    }
    this.prune();
  }
  append(task: Task, text: string): void {
    if (!text) return;
    const bytes = Buffer.from(task.output + text);
    task.output_end += BigInt(Buffer.byteLength(text));
    let offset = Math.max(0, bytes.length - output_bytes);
    while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
    task.output = bytes.subarray(offset).toString();
    task.output_start = task.output_end - BigInt(Buffer.byteLength(task.output));
    task.truncated ||= offset > 0;
    this.changed(task);
  }
  get(id: bigint): Task {
    const task = this.tasks.find(t => t.id === id);
    if (!task) throw Error(id > 0n && id < this.next ? "TaskExpired" : "NoTask");
    return task;
  }
  resolve(target: string, workspace: number, parent: Identity | null): Task {
    const id = /^task:([1-9][0-9]*)$/.exec(target);
    if (id) return this.get(BigInt(id[1]));
    const pane = target === "parent" ? parent?.pane : /^pane:([1-9][0-9]*)$/.exec(target)?.[1];
    const helper = this.helpers.find(h => h.workspace === workspace && h.name === target);
    const task = this.tasks.findLast(t =>
      pane ? t.pane === Number(pane) : helper ? t.pane === helper.pane : t.workspace === workspace && t.name === target,
    );
    if (!task) throw Error("NoTask");
    return task;
  }
  cancel(task: Task): void {
    if (task.kind !== "agent" || task.delivered || settled(task.state)) throw Error("TaskNotCancellable");
    task.prompt = "";
    this.set(task, "cancelled");
  }
  acknowledge(parent: Identity, through: bigint): void {
    for (const note of this.notes) if (same(note.parent, parent) && note.seq <= through) note.seen = true;
    this.changed();
  }
  snapshot(workspace: number, task: bigint | null, parent: Identity | null): Snapshot {
    return {
      type: "tasks",
      revision: this.revision,
      caller: parent,
      tasks: this.tasks
        .filter(t => (task !== null ? t.id === task : t.workspace === workspace))
        .map(t => ({ ...t, prompt: "", output: task !== null ? t.output : "" })),
      helpers: this.helpers.filter(h => h.workspace === workspace),
      notes: this.notes.filter(n => same(n.parent, parent)),
    };
  }
  prune(): void {
    const pinned = new Set(this.helpers.map(h => this.tasks.findLast(t => t.pane === h.pane)?.id));
    const evictable = this.tasks.filter(t => settled(t.state) && !pinned.has(t.id));
    const remove = new Set(evictable.slice(0, Math.max(0, evictable.length - retained)).map(t => t.id));
    this.tasks = this.tasks.filter(t => !remove.has(t.id));
    this.notes = this.notes.filter(n => !remove.has(n.task)).slice(-1024);
  }
  save(): Saved {
    return {
      next: this.next,
      sequence: this.sequence,
      revision: this.revision,
      tasks: this.tasks,
      helpers: this.helpers,
      notes: this.notes,
    };
  }
  restore(saved: Saved | undefined, live: boolean): void {
    if (!saved) return;
    this.next = BigInt(saved.next);
    this.sequence = BigInt(saved.sequence);
    this.revision = BigInt(saved.revision) + 1n;
    this.tasks = saved.tasks.map(decodeTask);
    this.helpers = live
      ? saved.helpers.map(h => ({ ...h, parent: binding(h.parent), identity: binding(h.identity) }))
      : [];
    this.notes = saved.notes.map(n => ({
      ...n,
      seq: BigInt(n.seq),
      task: BigInt(n.task),
      parent: binding(n.parent)!,
      delivery: !live ? "suppressed" : n.delivery === "sending" ? "unknown" : n.delivery,
    }));
    for (const task of this.tasks) {
      if (live && task.reason === "delivering") {
        task.state = "unknown";
        task.reason = "DeliveryUnknown";
        task.prompt = "";
      }
      if (!live && !settled(task.state)) {
        task.state = "unknown";
        task.reason = "daemon_restarted";
        task.prompt = "";
      }
    }
    this.prune();
  }
}
