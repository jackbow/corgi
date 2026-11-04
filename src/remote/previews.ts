import { Reader } from "./conversation";
import type { Conversation } from "./conversation_types";
import type { LastResponse, Pane, Provider } from "./types";

interface Job {
  reader: Reader;
  file: string;
  provider: Provider;
  session: string;
  value: LastResponse;
  version: string;
}
/** Overview reads never wait for transcript reads or retain full message bodies. */
export class Previews {
  private jobs = new Map<string, Job>();
  private running = false;
  private dirty = false;
  sync(server: number, entries: { pane: Pane; file: string }[]): Map<number, LastResponse> {
    const active = new Set<string>(),
      values = new Map<number, LastResponse>();
    for (const { pane, file } of entries) {
      if (!pane.provider || !pane.conversation || !file) {
        values.set(pane.id, { availability: "unavailable", text: "" });
        continue;
      }
      const key = JSON.stringify([server, pane.id, pane.binding, pane.conversation, pane.provider, file]);
      active.add(key);
      let job = this.jobs.get(key);
      if (!job) {
        job = {
          reader: new Reader(),
          file,
          provider: pane.provider,
          session: pane.conversation,
          value: { availability: "indexing", text: "" },
          version: "",
        };
        this.jobs.set(key, job);
      }
      values.set(pane.id, job.value);
    }
    for (const key of this.jobs.keys()) if (!active.has(key)) this.jobs.delete(key);
    this.dirty = true;
    if (!this.running) void this.refresh();
    return values;
  }
  private async refresh() {
    this.running = true;
    try {
      do {
        this.dirty = false;
        let pending = [...this.jobs];
        while (pending.length) {
          const again: typeof pending = [];
          for (const [key, job] of pending) {
            if (this.jobs.get(key) !== job) continue;
            let data: Conversation;
            try {
              data = await job.reader.preview(job.file, job.provider, job.session);
            } catch {
              data = { availability: "unavailable", version: "", messages: [], before: null, after: null, more: false };
            }
            if (this.jobs.get(key) !== job) continue;
            if (data.availability === "indexing" || data.availability === "replaced") {
              if (job.version !== data.version || job.value.availability !== "available")
                job.value = { availability: "indexing", text: "" };
              again.push([key, job]);
            } else job.value = { availability: data.availability, text: data.messages[0]?.text ?? "" };
            job.version = data.version;
          }
          pending = again;
        }
      } while (this.dirty);
    } finally {
      this.running = false;
    }
  }
}
