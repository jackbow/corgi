import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, appendFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "./archive";

test("history pages backwards with opaque scoped replayable cursors and skips partial records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-archive-")),
    file = join(dir, "codex.jsonl");
  const records = [
    { type: "session_meta", payload: { id: "thread" } },
    ...Array.from({ length: 55 }, (_, i) => ({
      type: "response_item",
      payload: {
        type: "message",
        id: String(i),
        role: "assistant",
        content: [{ type: "output_text", text: `Reply ${i}` }],
      },
    })),
  ];
  try {
    await writeFile(file, records.map(r => JSON.stringify(r)).join("\n") + "\n{partial");
    const reader = new Archive(),
      first = await reader.read(file, "codex", "thread", "");
    expect(first.messages).toHaveLength(20);
    expect(first.messages[0].text).toBe("Reply 35");
    expect(first.messages.at(-1)?.text).toBe("Reply 54");
    expect(first.before).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const next = await reader.read(file, "codex", "thread", first.before!);
    expect(next.messages[0].text).toBe("Reply 15");
    expect(next.messages.at(-1)?.text).toBe("Reply 34");
    expect(await reader.read(file, "codex", "thread", first.before!)).toEqual(next);
    expect((await reader.read(file, "codex", "different", first.before!)).availability).toBe("replaced");
    await appendFile(file, " record}\n");
    const end = await reader.read(file, "codex", "thread", next.before!);
    expect(end.messages).toHaveLength(15);
    expect(end.before).toBeNull();
    await writeFile(join(dir, "replacement"), records.map(r => JSON.stringify(r)).join("\n") + "\n");
    await rename(join(dir, "replacement"), file);
    expect((await reader.read(file, "codex", "thread", first.before!)).availability).toBe("replaced");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Claude history follows active parents across pages and excludes abandoned and side branches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-archive-")),
    file = join(dir, "claude.jsonl");
  const records = Array.from({ length: 42 }, (_, i) => ({
    type: "assistant",
    sessionId: "thread",
    uuid: `m${i}`,
    parentUuid: i ? `m${i - 1}` : null,
    message: { content: [{ type: "text", text: `Reply ${i}` }] },
  }));
  records.splice(35, 0, {
    ...records[34],
    uuid: "abandoned",
    message: { content: [{ type: "text", text: "Wrong branch" }] },
  });
  try {
    await writeFile(
      file,
      [...records, { ...records[0], uuid: "side", isSidechain: true }].map(r => JSON.stringify(r)).join("\n") + "\n",
    );
    const reader = new Archive(),
      first = await reader.read(file, "claude", "thread", ""),
      next = await reader.read(file, "claude", "thread", first.before!);
    expect(first.messages[0].text).toBe("Reply 22");
    expect(next.messages[0].text).toBe("Reply 2");
    expect([...first.messages, ...next.messages].some(m => m.text === "Wrong branch")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
