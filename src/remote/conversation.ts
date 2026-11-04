import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { field, str } from "../json";

import type { Provider } from "./types";
import type { Message, Conversation } from "./conversation_types";
interface RecordLine {
  value: unknown;
  offset: number;
}
interface Cached {
  file: string;
  stamp: string;
  prefix: string;
  size: number;
  mtime: number;
  offset: number;
  records: RecordLine[];
  version: string;
}
const MAX_FILE = 16 * 1024 * 1024,
  MAX_LINE = 256 * 1024,
  MAX_TEXT = 16 * 1024,
  PAGE = 40,
  MAX_RECORDS = 50000;
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
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
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

export class Reader {
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
  private async load(
    file: string,
    provider: Provider,
    session: string,
    cursor: string,
    direction: "before" | "after",
  ): Promise<Conversation> {
    if (!file || !session) return empty("unavailable");
    const handle = await open(file, "r").catch(() => null);
    if (!handle) return empty("unavailable");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return empty("unavailable");
      if (stat.size > MAX_FILE) return empty("oversized");
      const prefixBuffer = Buffer.alloc(Math.min(stat.size, 256));
      await handle.read(prefixBuffer, 0, prefixBuffer.length, 0);
      const stamp = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
        prefix = prefixBuffer.toString("hex");
      let cached = this.cache.get(file);
      const replaced =
        !cached ||
        cached.stamp !== stamp ||
        stat.size < cached.size ||
        !prefix.startsWith(cached.prefix) ||
        (stat.size === cached.size && stat.mtimeMs !== cached.mtime);
      if (replaced)
        cached = {
          file,
          stamp,
          prefix,
          size: 0,
          mtime: stat.mtimeMs,
          offset: 0,
          records: [],
          version: digest(stamp + prefix + stat.mtimeMs),
        };
      // Cache is per file; a concurrent query may read a newer prefix, never mutate it in place.
      cached = { ...cached!, records: [...cached!.records] };
      const bytes = Buffer.alloc(stat.size - cached.offset);
      let read = 0;
      while (read < bytes.length) {
        const chunk = await handle.read(bytes, read, Math.min(256 * 1024, bytes.length - read), cached.offset + read);
        if (!chunk.bytesRead) break;
        read += chunk.bytesRead;
      }
      let start = 0;
      for (let end = bytes.indexOf(10); end >= 0 && end < read; end = bytes.indexOf(10, start)) {
        if (end - start > MAX_LINE) return empty("oversized");
        const line = bytes.subarray(start, end).toString("utf8");
        if (line.trim()) {
          try {
            if (cached.records.length >= MAX_RECORDS) return empty("oversized");
            cached.records.push({ value: JSON.parse(line), offset: cached.offset + start });
          } catch {
            return empty("unavailable");
          }
        }
        start = end + 1;
      }
      if (read - start > MAX_LINE) return empty("oversized");
      cached.offset += start;
      cached.size = stat.size;
      cached.mtime = stat.mtimeMs;
      cached.prefix = prefix;
      this.cache.delete(file);
      this.cache.set(file, cached);
      while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
      const messages = provider === "codex" ? codex(cached.records, session) : claude(cached.records, session);
      if (!messages) return empty("unavailable");
      const version = cached.version;
      let index = messages.length;
      if (cursor) {
        const split = cursor.indexOf(":");
        if (cursor.slice(0, split) !== version) return empty("replaced", version);
        const id = cursor.slice(split + 1);
        index = messages.findIndex(m => m.id === id);
        if (index < 0) return empty("replaced", version);
        // Re-send the cursor record: providers can amend a persisted message in place.
      }
      const from = cursor && direction === "after" ? index : Math.max(0, index - PAGE);
      const to = cursor && direction === "after" ? Math.min(messages.length, from + PAGE) : index;
      const page = messages.slice(from, to);
      return {
        availability: "available",
        version,
        messages: page,
        before: from > 0 && page.length ? `${version}:${page[0].id}` : null,
        after: page.length ? `${version}:${page.at(-1)!.id}` : cursor || null,
        more: to < messages.length,
      };
    } finally {
      await handle.close();
    }
  }
}
