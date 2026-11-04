import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Reader, codex, claude } from "./conversation";
const lines = (...values: unknown[]) => values.map((value, offset) => ({ value, offset }));
const head = { type: "session_meta", payload: { id: "thread" } };
const item = (text: string, id?: string) => ({
  type: "response_item",
  payload: { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] },
});
const record = (uuid: string, parentUuid: string | null, text: string, type = "assistant", sessionId = "s") => ({
  type,
  uuid,
  parentUuid,
  sessionId,
  message: { content: [{ type: "text", text }] },
});
test("Codex uses canonical messages/tools and excludes event copies, system and reasoning", () => {
  const result = codex(
    lines(
      head,
      item("Hello", "m"),
      item("Hello", "m"),
      { type: "event_msg", payload: { type: "agent_message", message: "Hello" } },
      {
        type: "response_item",
        payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "secret" }] },
      },
      { type: "response_item", payload: { type: "reasoning", summary: [{ text: "secret" }] } },
      {
        type: "response_item",
        payload: { type: "function_call", name: "exec", call_id: "c", arguments: '{"cmd":"ls"}' },
      },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c", output: "files" } },
    ),
    "thread",
  )!;
  expect(result.map(m => m.role)).toEqual(["assistant", "tool", "tool"]);
  expect(result[1].name).toBe("exec");
  expect(result[2].text).toBe("files");
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(codex(lines(head), "wrong")).toBeNull();
});
test("Claude follows the current ancestry, filters other sessions/sidechains and hides thinking", () => {
  const result = claude(
    lines(
      record("u", null, "Hi", "user"),
      record("old", "u", "Abandoned"),
      record("new", "u", "Current"),
      {
        ...record("tools", "new", ""),
        message: {
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "tool_use", name: "Read", input: { file: "a" } },
            { type: "tool_result", content: [{ type: "text", text: "output" }] },
          ],
        },
      },
      { ...record("side", "tools", "Side"), isSidechain: true },
      record("foreign", "tools", "Wrong", "assistant", "other"),
    ),
    "s",
  )!;
  expect(result.map(m => m.text)).toEqual(["Hi", "Current", '{"file":"a"}', "output"]);
  expect(JSON.stringify(result)).not.toMatch(/hidden|Abandoned|Wrong|Side/);
});
test("bounded pagination, incremental complete records, replacement and invalid cursors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-transcripts-")),
    file = join(dir, "thread.jsonl"),
    reader = new Reader();
  const write = (records: unknown[]) => writeFileSync(file, records.map(v => JSON.stringify(v)).join("\n") + "\n");
  try {
    write([head, ...Array.from({ length: 95 }, (_, i) => item(`Message ${i}`, String(i)))]);
    const page = await reader.read(file, "codex", "thread");
    expect(page.messages).toHaveLength(40);
    expect(page.messages[0].text).toBe("Message 55");
    const earlier = await reader.read(file, "codex", "thread", page.before!);
    expect(earlier.messages[0].text).toBe("Message 15");
    appendFileSync(file, JSON.stringify(item("Appended", "95")).slice(0, -1));
    expect((await reader.read(file, "codex", "thread", page.after!, "after")).messages.map(m => m.text)).toEqual([
      "Message 94",
    ]);
    appendFileSync(file, "}\n");
    expect((await reader.read(file, "codex", "thread", page.after!, "after")).messages.at(-1)!.text).toBe("Appended");
    renameSync(file, join(dir, "old"));
    write([head, item("Replacement", "r")]);
    expect((await reader.read(file, "codex", "thread", page.after!, "after")).availability).toBe("replaced");
    expect((await reader.read(file, "codex", "thread")).messages[0].text).toBe("Replacement");
    expect((await reader.read(file, "codex", "other")).availability).toBe("unavailable");
    expect((await reader.read(file, "codex", "thread", "forged:123")).availability).toBe("replaced");
    write([head, item("x".repeat(20000))]);
    expect((await reader.read(file, "codex", "thread")).messages[0].truncated).toBe(true);
    write([head, item("x".repeat(300000))]);
    expect((await reader.read(file, "codex", "thread")).availability).toBe("oversized");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("missing, malformed and oversized files report availability explicitly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-transcripts-")),
    file = join(dir, "thread.jsonl"),
    reader = new Reader();
  try {
    expect((await reader.read(file, "claude", "s")).availability).toBe("unavailable");
    writeFileSync(file, '{"bad"}\n');
    expect((await reader.read(file, "codex", "thread")).availability).toBe("unavailable");
    writeFileSync(file, "x".repeat(17 * 1024 * 1024));
    expect((await reader.read(file, "codex", "thread")).availability).toBe("oversized");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incremental Claude reads update a stable message and reset abandoned ancestry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-claude-")),
    file = join(dir, "s.jsonl"),
    reader = new Reader();
  const append = (v: unknown) => appendFileSync(file, JSON.stringify(v) + "\n");
  try {
    append(record("u", null, "Hi", "user"));
    append(record("a", "u", "Initial"));
    const page = await reader.read(file, "claude", "s");
    append(record("a", "u", "Amended"));
    expect((await reader.read(file, "claude", "s", page.after!, "after")).messages[0].text).toBe("Amended");
    append(record("b", "u", "New branch"));
    expect((await reader.read(file, "claude", "s", page.after!, "after")).availability).toBe("replaced");
    expect((await reader.read(file, "claude", "s")).messages.map(m => m.text)).toEqual(["Hi", "New branch"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("provider context and system reminders do not become user messages", () => {
  const v = {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "# AGENTS.md instructions\nprivate setup" }],
    },
  };
  expect(codex(lines(head, v), "thread")).toEqual([]);
  expect(claude(lines(record("u", null, "Hello<system-reminder>hidden</system-reminder>", "user")), "s")![0].text).toBe(
    "Hello",
  );
});
