import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Previews } from "./previews";
import type { Pane } from "./types";

const pane: Pane = {
  id: 1,
  workspace: 1,
  name: "Agent",
  provider: "codex",
  conversation: "thread",
  binding: "1",
  state: "working",
  activity: "",
  exited: false,
  branch: "main",
  order: 0,
  attention: "",
};
const head = JSON.stringify({ type: "session_meta", payload: { id: "thread" } }) + "\n";
const reply = (text: string) =>
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  }) + "\n";

test("overview returns immediately, isolates identities, refreshes replies and handles unavailable files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-previews-")),
    file = join(dir, "thread.jsonl"),
    previews = new Previews();
  const entries = [{ pane, file }];
  const waitFor = async (text: string) => {
    for (let i = 0; i < 100; i++) {
      const value = previews.sync(1, entries).get(1)!;
      if (value.availability === "available" && value.text === text) return value;
      await Bun.sleep(10);
    }
    throw Error("Preview did not refresh");
  };
  try {
    writeFileSync(file, head + reply("First"));
    expect(previews.sync(1, entries).get(1)).toEqual({ availability: "indexing", text: "" });
    await waitFor("First");
    appendFileSync(file, reply("Latest"));
    await waitFor("Latest");
    for (const replacement of [
      { ...pane, binding: "2" },
      { ...pane, conversation: "different" },
    ])
      expect(previews.sync(1, [{ pane: replacement, file }]).get(1)).toEqual({ availability: "indexing", text: "" });
    expect(previews.sync(2, entries).get(1)?.text).toBe("");
    expect(previews.sync(2, [{ pane, file: "" }]).get(1)).toEqual({ availability: "unavailable", text: "" });
    expect(previews.sync(2, [{ pane: { ...pane, provider: null }, file }]).get(1)?.availability).toBe("unavailable");
    // Prune in-flight jobs before deleting fixtures.
    previews.sync(2, []);
    await Bun.sleep(30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
