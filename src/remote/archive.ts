import { open } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { str, field } from "../json";
import { codex, claude } from "./conversation";
import { Reads, Tail } from "./transcript_tail";
import { Line } from "./transcript_line";
import type { Conversation, Message } from "./conversation_types";
import type { Provider } from "./types";

interface State {
  source: string;
  stamp: string;
  prefix: string;
  size: number;
  edge: string;
  mtime: number;
  tail: Tail;
  leaf: string;
  started: boolean;
  rest: Message[];
  collected: Message[];
  seen: Set<string>;
  expires: number;
  pages: Map<string, Conversation>;
  current: string;
  busy?: Promise<Conversation>;
}
const digest = (v: Buffer) => createHash("sha256").update(v).digest("hex");
const empty = (availability: Conversation["availability"]): Conversation => ({
  availability,
  version: "",
  messages: [],
  before: null,
  after: null,
  more: false,
});
/** Opt-in backwards browsing. Cursors reference bounded, expiring memory; no transcript index. */
export class Archive {
  private states = new Map<string, State>();
  async read(file: string, provider: Provider, session: string, cursor: string): Promise<Conversation> {
    const now = Date.now(),
      source = JSON.stringify([file, provider, session]);
    for (const [id, state] of this.states) if (state.expires < now) this.states.delete(id);
    let state = [...this.states.values()].find(
      s => s.source === source && (s.current === cursor || s.pages.has(cursor)),
    );
    if (cursor && !state) return empty("replaced");
    if (!cursor && !state) {
      const handle = await open(file, "r").catch(() => null);
      if (!handle) return empty("unavailable");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return empty("unavailable");
        const bytes = Buffer.alloc(Math.min(stat.size, 4096));
        await handle.read(bytes, 0, bytes.length, 0);
        if (provider === "codex") {
          const line = new Line(),
            budget = new Reads(4 * 1024 * 1024);
          let offset = 0,
            complete = false;
          while (offset < stat.size && !complete) {
            const bytes = await budget.read(handle, offset, stat.size - offset);
            if (!bytes) return empty("unavailable");
            for (const byte of bytes) {
              if (byte === 10) {
                complete = true;
                break;
              }
              line.push(byte);
            }
            offset += bytes.length;
          }
          if (!complete) return empty("unavailable");
          const header = line.value();
          if (str(header, "type") !== "session_meta" || str(field(header, "payload"), "id") !== session)
            return empty("unavailable");
        }
        const edge = Buffer.alloc(Math.min(256, stat.size));
        await handle.read(edge, 0, edge.length, stat.size - edge.length);
        state = {
          source,
          stamp: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
          prefix: digest(bytes.subarray(0, Math.min(256, bytes.length))),
          size: stat.size,
          edge: digest(edge),
          mtime: stat.mtimeMs,
          tail: new Tail(stat.size),
          leaf: "",
          started: false,
          rest: [],
          collected: [],
          seen: new Set(),
          expires: now + 600_000,
          pages: new Map(),
          current: "",
        };
        this.states.set(randomBytes(18).toString("base64url"), state);
        while (this.states.size > 4) this.states.delete(this.states.keys().next().value!);
      } finally {
        await handle.close();
      }
    }
    if (!state) return empty("replaced");
    if (state.busy) return state.busy;
    state.expires = now + 600_000;
    const current = state;
    current.busy = this.page(current, file, provider, session, cursor)
      .then(result => {
        if (result.availability === "replaced")
          for (const [id, value] of this.states) if (value === current) this.states.delete(id);
        return result;
      })
      .finally(() => {
        current.busy = undefined;
      });
    return current.busy;
  }
  private async page(
    s: State,
    file: string,
    provider: Provider,
    session: string,
    cursor: string,
  ): Promise<Conversation> {
    const handle = await open(file, "r").catch(() => null);
    if (!handle) return empty("unavailable");
    try {
      const stat = await handle.stat(),
        prefix = Buffer.alloc(Math.min(256, s.size)),
        edge = Buffer.alloc(Math.min(256, s.size));
      await handle.read(prefix, 0, prefix.length, 0);
      await handle.read(edge, 0, edge.length, s.size - edge.length);
      if (
        `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== s.stamp ||
        stat.size < s.size ||
        digest(prefix) !== s.prefix ||
        digest(edge) !== s.edge ||
        (stat.size === s.size && stat.mtimeMs !== s.mtime)
      )
        return empty("replaced");
      if (s.pages.has(cursor)) return s.pages.get(cursor)!;
      const budget = new Reads(4 * 1024 * 1024);
      let exhausted = false;
      while (s.collected.length < 20) {
        if (s.rest.length) {
          s.collected.push(s.rest.pop()!);
          continue;
        }
        if (provider === "claude" && s.started && !s.leaf) {
          exhausted = true;
          break;
        }
        const record = await s.tail.next(handle, budget);
        if (record === undefined) return { ...empty("indexing"), before: cursor || null };
        if (record === null) {
          exhausted = true;
          break;
        }
        if (record.line.omitted) continue;
        const v = record.value;
        if (provider === "claude") {
          if (str(v, "sessionId") !== session || field(v, "isSidechain") === true) continue;
          const id = str(v, "uuid");
          if (!id || (s.started ? id !== s.leaf : !["user", "assistant"].includes(str(v, "type")))) continue;
          s.started = true;
          s.leaf = str(v, "parentUuid");
          s.rest = claude([record], session) ?? [];
        } else {
          s.rest = (
            codex([{ value: { type: "session_meta", payload: { id: session } }, offset: 0 }, record], session) ?? []
          ).filter(m => !s.seen.has(m.id));
        }
        for (const message of s.rest) {
          s.seen.add(message.id);
          if (record.line.truncated) message.truncated = true;
        }
        // Deduplication memory stays bounded even for indefinitely long histories.
        while (s.seen.size > 10000) s.seen.delete(s.seen.values().next().value!);
      }
      const next = exhausted ? null : randomBytes(24).toString("base64url");
      const result: Conversation = {
        availability: "available",
        version: s.stamp,
        messages: s.collected.reverse(),
        before: next,
        after: null,
        more: !!next,
      };
      s.collected = [];
      s.pages.set(cursor, result);
      s.current = next ?? "done";
      while (s.pages.size > 8) s.pages.delete(s.pages.keys().next().value!);
      return result;
    } catch {
      return empty("unavailable");
    } finally {
      await handle.close();
    }
  }
}
