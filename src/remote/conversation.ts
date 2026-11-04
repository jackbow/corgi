import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { field, str } from "../json";
import { Line } from "./transcript_line";

import type { Provider } from "./types";
import type { Message, Conversation } from "./conversation_types";
interface RecordLine {
  value: unknown;
  offset: number;
}
interface Ref {
  id: string;
  role: Message["role"];
  name?: string;
  start: number;
  end: number;
  preview?: string;
}
interface Node {
  parent: string;
  refs: Ref[];
}
interface Cached {
  stamp: string;
  prefix: string;
  tail: string;
  size: number;
  mtime: number;
  offset: number;
  lineStart: number;
  line: Line;
  valid: boolean;
  first: boolean;
  nodes: Map<string, Node>;
  items: Map<string, Ref>;
  leaf: string;
  refs: Ref[];
  indices: Map<string, number>;
  bodies: Map<string, Message>;
  changed: boolean;
  omitted: number;
  version: string;
}
const MAX_TEXT = 16 * 1024,
  PAGE = 10;
const CHUNK = 256 * 1024,
  SCAN_BYTES = 8 * 1024 * 1024,
  PAGE_BYTES = 8 * 1024 * 1024;
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
function content(v: unknown): string {
  if (typeof v === "string") return v;
  return rows(v)
    .filter(b => ["text", "input_text", "output_text"].includes(str(b, "type")))
    .map(b => str(b, "text"))
    .join("\n");
}
function userText(text: string): string {
  if (
    /^\s*(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<user_instructions>)/.test(text)
  )
    return "";
  return text.replace(/<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g, "").trim();
}
function message(id: string, role: Message["role"], text: string, name?: string): Message {
  return {
    id: id.length > 160 ? digest(id) : id,
    role,
    text: text.slice(0, MAX_TEXT),
    ...(name ? { name: name.slice(0, 128) } : {}),
    ...(text.length > MAX_TEXT ? { truncated: true } : {}),
  };
}
/** Only canonical response items: event_msg copies are deliberately excluded. */
export function codex(records: RecordLine[], session: string): Message[] | null {
  const head = records[0]?.value;
  if (str(head, "type") !== "session_meta" || str(field(head, "payload"), "id") !== session) return null;
  const out = new Map<string, Message>();
  for (const { value, offset } of records) {
    if (str(value, "type") !== "response_item") continue;
    const p = field(value, "payload"),
      type = str(p, "type"),
      role = str(p, "role");
    const id = str(p, "id") || `${offset}`;
    if (type === "message" && (role === "user" || role === "assistant")) {
      const raw = content(field(p, "content")),
        text = role === "user" ? userText(raw) : raw;
      if (text) out.set(`message:${id}`, message(`message:${id}`, role, text));
    } else if (["function_call", "custom_tool_call", "local_shell_call", "web_search_call"].includes(type)) {
      const call = str(p, "call_id") || id,
        input = field(p, "input") ?? field(p, "arguments") ?? field(p, "action");
      out.set(
        `call:${call}`,
        message(
          `call:${call}`,
          "tool",
          typeof input === "string" ? input : (JSON.stringify(input) ?? ""),
          str(p, "name") || type,
        ),
      );
    } else if (["function_call_output", "custom_tool_call_output"].includes(type)) {
      const call = str(p, "call_id") || id,
        output = field(p, "output");
      out.set(
        `result:${call}`,
        message(`result:${call}`, "tool", typeof output === "string" ? output : content(output), "Result"),
      );
    }
  }
  return [...out.values()];
}
/** Follow the active main conversation leaf, excluding abandoned branches and sidechains. */
export function claude(records: RecordLine[], session: string): Message[] | null {
  const nodes = new Map<string, unknown>();
  let leaf = "";
  for (const { value } of records) {
    if (str(value, "sessionId") !== session || field(value, "isSidechain") === true) continue;
    const id = str(value, "uuid");
    if (!id) continue;
    nodes.set(id, value);
    if (["user", "assistant"].includes(str(value, "type"))) leaf = id;
  }
  if (!leaf) return null;
  const chain: unknown[] = [],
    seen = new Set<string>();
  while (leaf && !seen.has(leaf)) {
    seen.add(leaf);
    const v = nodes.get(leaf);
    if (!v) break;
    chain.push(v);
    leaf = str(v, "parentUuid");
  }
  const out = new Map<string, Message>();
  for (const v of chain.reverse()) {
    const role = str(v, "type");
    if ((role !== "user" && role !== "assistant") || field(v, "isCompactSummary") === true) continue;
    const body = field(v, "message"),
      blocks = field(body, "content"),
      uuid = str(v, "uuid");
    if (typeof blocks === "string") {
      const text = role === "user" ? userText(blocks) : blocks;
      if (text) out.set(uuid, message(uuid, role, text));
      continue;
    }
    rows(blocks).forEach((block, i) => {
      const type = str(block, "type"),
        id = `${uuid}:${i}`;
      if (type === "text") {
        const text = role === "user" ? userText(str(block, "text")) : str(block, "text");
        if (text) out.set(id, message(id, role, text));
      }
      if (type === "tool_use")
        out.set(id, message(id, "tool", JSON.stringify(field(block, "input")), str(block, "name")));
      if (type === "tool_result") out.set(id, message(id, "tool", content(field(block, "content")), "Result"));
    });
  }
  return [...out.values()];
}
const empty = (availability: Conversation["availability"], version = ""): Conversation => ({
  availability,
  version,
  messages: [],
  before: null,
  after: null,
  more: false,
});
const digest = (v: string | Buffer) => createHash("sha256").update(v).digest("hex").slice(0, 24);

/** A disposable offset/ancestry index. Message bodies are cached only for recent pages. */
export class Reader {
  constructor(
    private scanBytes = SCAN_BYTES,
    private bodyLimit = 128,
  ) {}
  private cache = new Map<string, Cached>();
  private pending = new Map<string, Promise<Conversation>>();
  private queues = new Map<string, Promise<unknown>>();
  read(
    file: string,
    provider: Provider,
    session: string,
    cursor = "",
    direction: "before" | "after" = "before",
  ): Promise<Conversation> {
    return this.request(file, provider, session, cursor, direction);
  }
  preview(file: string, provider: Provider, session: string): Promise<Conversation> {
    return this.request(file, provider, session, "", "preview");
  }
  private request(
    file: string,
    provider: Provider,
    session: string,
    cursor: string,
    direction: "before" | "after" | "preview",
  ): Promise<Conversation> {
    const key = JSON.stringify([file, provider, session, cursor, direction]);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const result = (this.queues.get(file) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.load(file, provider, session, cursor, direction))
      .finally(() => {
        this.pending.delete(key);
        if (this.queues.get(file) === result) this.queues.delete(file);
      });
    this.pending.set(key, result);
    this.queues.set(file, result);
    return result;
  }
  private remember(c: Cached, m: Message) {
    if (!this.bodyLimit) return;
    c.bodies.delete(m.id);
    c.bodies.set(m.id, m);
    while (c.bodies.size > this.bodyLimit) c.bodies.delete(c.bodies.keys().next().value!);
  }
  private index(c: Cached, value: unknown, provider: Provider, session: string, end: number, truncated: boolean) {
    if (c.first) {
      c.first = false;
      if (provider === "codex")
        c.valid = str(value, "type") === "session_meta" && str(field(value, "payload"), "id") === session;
    }
    if (provider === "codex" && !c.valid) return;
    const offset = c.lineStart;
    let messages: Message[];
    if (provider === "codex") {
      messages = codex(
        [
          { value: { type: "session_meta", payload: { id: session } }, offset: 0 },
          { value, offset },
        ],
        session,
      )!;
    } else {
      if (str(value, "sessionId") !== session || field(value, "isSidechain") === true) return;
      const uuid = str(value, "uuid");
      if (!uuid) return;
      messages = claude([{ value, offset }], session) ?? [];
      c.nodes.set(uuid, { parent: str(value, "parentUuid"), refs: [] });
      if (["user", "assistant"].includes(str(value, "type"))) {
        c.leaf = uuid;
        c.valid = true;
      }
    }
    const refs = messages.map(m => {
      this.remember(c, { ...m, ...(truncated ? { truncated: true } : {}) });
      return {
        id: m.id,
        role: m.role,
        name: m.name,
        start: offset,
        end,
        ...(m.role === "assistant" ? { preview: m.text.replace(/\s+/g, " ").trim().slice(0, 320) } : {}),
      };
    });
    if (provider === "codex") for (const ref of refs) c.items.set(ref.id, ref);
    else c.nodes.get(str(value, "uuid"))!.refs = refs;
    c.changed = true;
  }
  private order(c: Cached, provider: Provider) {
    if (!c.changed) return;
    if (provider === "codex") c.refs = [...c.items.values()];
    else {
      const chain: Node[] = [],
        seen = new Set<string>();
      let leaf = c.leaf;
      while (leaf && !seen.has(leaf)) {
        seen.add(leaf);
        const node = c.nodes.get(leaf);
        if (!node) break;
        chain.push(node);
        leaf = node.parent;
      }
      c.refs = chain.reverse().flatMap(n => n.refs);
    }
    c.indices = new Map(c.refs.map((ref, i) => [ref.id, i]));
    c.changed = false;
  }
  private async load(
    file: string,
    provider: Provider,
    session: string,
    cursor: string,
    direction: "before" | "after" | "preview",
  ): Promise<Conversation> {
    if (!file || !session) return empty("unavailable");
    const handle = await open(file, "r").catch(() => null);
    if (!handle) return empty("unavailable");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return empty("unavailable");
      const prefixBuffer = Buffer.alloc(Math.min(stat.size, 256));
      await handle.read(prefixBuffer, 0, prefixBuffer.length, 0);
      const stamp = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
        prefix = prefixBuffer.toString("hex");
      const key = JSON.stringify([file, provider, session]);
      let c = this.cache.get(key);
      const tailBuffer = Buffer.alloc(Math.min(c?.offset ?? 0, 256));
      if (tailBuffer.length) await handle.read(tailBuffer, 0, tailBuffer.length, c!.offset - tailBuffer.length);
      if (
        !c ||
        c.stamp !== stamp ||
        stat.size < c.size ||
        !prefix.startsWith(c.prefix) ||
        tailBuffer.toString("hex") !== c.tail ||
        (stat.size === c.size && stat.mtimeMs !== c.mtime)
      ) {
        c = {
          stamp,
          prefix,
          tail: "",
          size: 0,
          mtime: stat.mtimeMs,
          offset: 0,
          lineStart: 0,
          line: new Line(),
          valid: false,
          first: true,
          nodes: new Map(),
          items: new Map(),
          leaf: "",
          refs: [],
          indices: new Map(),
          bodies: new Map(),
          changed: false,
          omitted: 0,
          version: digest(stamp + prefix + stat.mtimeMs),
        };
      }
      this.cache.delete(key);
      this.cache.set(key, c);
      while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
      const bytes = Buffer.alloc(CHUNK),
        deadline = performance.now() + 150;
      let scanned = 0;
      while (c.offset < stat.size && scanned < this.scanBytes && performance.now() < deadline) {
        const { bytesRead } = await handle.read(
          bytes,
          0,
          Math.min(CHUNK, stat.size - c.offset, this.scanBytes - scanned),
          c.offset,
        );
        if (!bytesRead) break;
        for (let i = 0; i < bytesRead; i++) {
          if (bytes[i] !== 10) c.line.push(bytes[i]);
          else {
            const end = c.offset + i + 1;
            if (c.line.omitted) c.omitted++;
            else {
              let value: unknown;
              try {
                value = c.line.value();
              } catch {
                this.cache.delete(key);
                return empty("unavailable");
              }
              if (value !== null) this.index(c, value, provider, session, end, c.line.truncated);
            }
            c.line = new Line();
            c.lineStart = end;
          }
        }
        c.offset += bytesRead;
        scanned += bytesRead;
      }
      if (scanned) {
        const tail = Buffer.alloc(Math.min(c.offset, 256));
        await handle.read(tail, 0, tail.length, c.offset - tail.length);
        c.tail = tail.toString("hex");
      }
      c.size = stat.size;
      c.mtime = stat.mtimeMs;
      c.prefix = prefix;
      if (c.offset < stat.size)
        return { ...empty("indexing", c.version), progress: { read: c.offset, total: stat.size } };
      if (!c.valid) return empty("unavailable");
      this.order(c, provider);
      if (direction === "preview") {
        const final = await handle.stat();
        if (final.size < stat.size || (final.size === stat.size && final.mtimeMs !== stat.mtimeMs)) {
          this.cache.delete(key);
          return empty("replaced", c.version);
        }
        const index = c.refs.findLastIndex(ref => ref.role === "assistant"),
          last = c.refs[index];
        if (!last) return empty("available", c.version);
        let first = index;
        while (first > 0 && c.refs[first - 1].start === last.start) first--;
        const text = c.refs
          .slice(first, index + 1)
          .filter(ref => ref.role === "assistant")
          .map(ref => ref.preview)
          .join(" ")
          .slice(0, 320);
        return { ...empty("available", c.version), messages: [{ id: last.id, role: "assistant", text }] };
      }
      let index = c.refs.length;
      if (cursor) {
        const split = cursor.indexOf(":");
        if (cursor.slice(0, split) !== c.version) return empty("replaced", c.version);
        index = c.indices.get(cursor.slice(split + 1)) ?? -1;
        if (index < 0) return empty("replaced", c.version);
      }
      const from = cursor && direction === "after" ? index : Math.max(0, index - PAGE);
      const to = cursor && direction === "after" ? Math.min(c.refs.length, from + PAGE) : index;
      const refs = c.refs.slice(from, to),
        messages: Message[] = [],
        loaded = new Map<string, Message>();
      let budget = PAGE_BYTES;
      for (const ref of refs) {
        let body = loaded.get(ref.id) ?? c.bodies.get(ref.id);
        if (!body) {
          const length = ref.end - ref.start;
          if (length <= budget) {
            budget -= length;
            const line = new Line();
            let offset = ref.start;
            while (offset < ref.end) {
              const { bytesRead } = await handle.read(bytes, 0, Math.min(CHUNK, ref.end - offset), offset);
              if (!bytesRead) return empty("replaced", c.version);
              for (let i = 0; i < bytesRead; i++) if (bytes[i] !== 10) line.push(bytes[i]);
              offset += bytesRead;
            }
            const value = line.value();
            const normalized =
              provider === "codex"
                ? codex(
                    [
                      { value: { type: "session_meta", payload: { id: session } }, offset: 0 },
                      { value, offset: ref.start },
                    ],
                    session,
                  )
                : claude([{ value, offset: ref.start }], session);
            for (const m of normalized ?? []) {
              const preview = { ...m, ...(line.truncated ? { truncated: true } : {}) };
              loaded.set(m.id, preview);
              this.remember(c, preview);
            }
            body = loaded.get(ref.id);
          }
        }
        messages.push(
          body ?? {
            id: ref.id,
            role: ref.role,
            name: ref.name,
            text: "This record is too large to preview. Read its full contents on your Mac.",
            truncated: true,
          },
        );
      }
      // Detect replacement or rewriting while the page bodies were being read.
      const final = await handle.stat();
      if (final.size < stat.size || (final.size === stat.size && final.mtimeMs !== stat.mtimeMs)) {
        this.cache.delete(key);
        return empty("replaced", c.version);
      }
      return {
        availability: "available",
        version: c.version,
        messages,
        before: from > 0 && refs.length ? `${c.version}:${refs[0].id}` : null,
        after: refs.length ? `${c.version}:${refs.at(-1)!.id}` : cursor || null,
        more: to < c.refs.length,
        ...(c.omitted ? { omitted: c.omitted } : {}),
      };
    } finally {
      await handle.close();
    }
  }
}
