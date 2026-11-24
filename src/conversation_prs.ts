//! PRs explicitly linked in a conversation, ordered by their latest mention.
import { open, stat } from "node:fs/promises";
import * as pr from "./pull_request";
import { adapter } from "./providers";
import type { Provider } from "./providers";
import type { Message, Search } from "./providers/search";
import type { Runtime } from "./runtime";
import { head } from "./transcript";

export interface Mention extends pr.Ref {
  mentioned: number;
}
export type Sort = "recent" | "number";
export function sorted(items: Mention[], sort: Sort = "recent"): Mention[] {
  return [...items].sort((a, b) =>
    sort === "number"
      ? a.number - b.number || a.repo.localeCompare(b.repo)
      : b.mentioned - a.mentioned || a.url.localeCompare(b.url),
  );
}
export class Index {
  last_message_at = 0;
  private refs = new Map<string, Mention>();
  private sequence = 0;
  observe(messages: (Pick<Message, "role" | "text"> & Partial<Pick<Message, "timestamp">>)[]) {
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      if (message.timestamp && Number.isFinite(message.timestamp))
        this.last_message_at = Math.max(this.last_message_at, message.timestamp);
      const mentioned = ++this.sequence;
      for (const match of message.text.matchAll(
        /https:\/\/github\.com\/[^\s<>"'\])]+|(?<![\w/.])#?[1-9]\d*(?![\w/.])/gi,
      )) {
        const token = match[0];
        if (/^https:/i.test(token)) {
          const ref = pr.parse(token.replace(/[.,;:!?}`*]+$/g, ""));
          if (ref) this.refs.set(ref.url.toLowerCase(), { ...ref, mentioned });
        } else {
          const candidates = [...this.refs.values()].filter(ref => ref.number === Number(token.replace(/^#/, "")));
          if (candidates.length === 1) candidates[0].mentioned = mentioned;
        }
      }
    }
  }
  items(): Mention[] {
    return sorted([...this.refs.values()]);
  }
}

interface Reading {
  identity: string;
  stamp: string;
  offset: number;
  partial: Buffer;
  discard: boolean;
  index: Index;
  search: Search;
}
/** Reuses provider decoding, reads appended JSONL in bounded chunks, and rebuilds
 * from transcripts after a restart rather than persisting derived references. */
export class Tracker {
  private readings = new Map<number, Reading>();
  private running = false;
  private next = 0;
  stopped = false;
  async refresh(runtime: Runtime, changed: () => void, now = Date.now()) {
    if (this.running || this.stopped || now < this.next) return;
    this.running = true;
    this.next = now + 2000;
    try {
      const followed = runtime.followed();
      const ids = new Set<number>([...followed].map(actor => actor.id));
      for (const id of this.readings.keys()) if (!ids.has(id)) this.readings.delete(id);
      for (const actor of followed) {
        if (this.stopped) break;
        const a = actor.state,
          provider = a.provider,
          transcript = a.transcriptPath(),
          session = a.sessionId();
        if (!provider || !session || actor.parent !== null) continue;
        try {
          const search = this.readings.get(actor.id)?.search ?? (await adapter(provider).search?.());
          const file = transcript || search?.source?.(session);
          if (!search || !file) continue;
          const identity = JSON.stringify([provider, file, session]);
          const store = search.jsonl ? file : file.slice(0, file.lastIndexOf("#"));
          const info = await stat(store);
          const wal = search.jsonl ? null : await stat(store + "-wal").catch(() => null);
          const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${wal?.size}:${wal?.mtimeMs}`;
          let reading = this.readings.get(actor.id);
          if (
            !reading ||
            reading.identity !== identity ||
            info.size < reading.offset ||
            !reading.stamp.startsWith(`${info.ino}:`) ||
            (search.jsonl && reading.offset === info.size && reading.stamp !== stamp)
          ) {
            reading = {
              identity,
              stamp: "",
              offset: 0,
              partial: Buffer.alloc(0),
              discard: false,
              index: new Index(),
              search,
            };
            this.readings.set(actor.id, reading);
          }
          if (reading.stamp === stamp) continue;
          await this.read(reading, file, provider, session, info.size, stamp);
          if (this.stopped || a.sessionId() !== session || a.transcriptPath() !== transcript) continue;
          // A history rebuild must not replace the current list with earlier mentions.
          if (reading.stamp !== stamp) continue;
          const items = reading.index.items();
          if (
            actor.last_message_at !== reading.index.last_message_at ||
            JSON.stringify(actor.pull_requests) !== JSON.stringify(items)
          ) {
            actor.last_message_at = reading.index.last_message_at;
            actor.pull_requests = items;
            changed();
          }
        } catch {
          // A missing or temporarily unreadable transcript keeps its last references.
        }
      }
    } finally {
      this.running = false;
    }
  }
  private async read(r: Reading, file: string, provider: Provider, session: string, size: number, stamp: string) {
    if (!r.search.jsonl) {
      const normalized = await r.search.read(
        { session, source: file, cwd: "", stamp, bytes: size, updated_at: 0 },
        false,
      );
      r.index = new Index();
      r.index.observe(normalized.messages);
      r.stamp = stamp;
      return;
    }
    const handle = await open(file, "r");
    try {
      if (r.offset === 0) adapter(provider).transcript?.verify?.(await head(handle), session);
      const buffer = Buffer.alloc(Math.min(1024 * 1024, size - r.offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, r.offset);
      let chunk = buffer.subarray(0, bytesRead);
      if (r.discard) {
        const end = chunk.indexOf(10);
        chunk = end < 0 ? Buffer.alloc(0) : chunk.subarray(end + 1);
        if (end >= 0) r.discard = false;
      }
      const input = Buffer.concat([r.partial, chunk]),
        end = input.lastIndexOf(10) + 1;
      r.index.observe(r.search.jsonl(input.subarray(0, end).toString()).messages);
      r.partial = Buffer.from(input.subarray(end));
      if (r.partial.length > 1024 * 1024) {
        r.partial = Buffer.alloc(0);
        r.discard = true;
      }
      r.offset += bytesRead;
      // Leave an unfinished initial scan eligible for the next pass.
      if (r.offset === size) r.stamp = stamp;
      else r.stamp = `${stamp.split(":")[0]}:scanning`;
    } finally {
      await handle.close();
    }
  }
}
