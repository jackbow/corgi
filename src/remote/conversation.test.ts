import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Reader, codex, claude } from "./conversation";
import type { Conversation } from "./conversation_types";
async function ready(reader: Reader, ...args: Parameters<Reader["read"]>) {
  let page: Conversation;
  do {
    page = await reader.read(...args);
  } while (page.availability === "indexing");
  return page;
}
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
    expect(page.messages).toHaveLength(10);
    expect(page.messages[0].text).toBe("Message 85");
    const earlier = await reader.read(file, "codex", "thread", page.before!);
    expect(earlier.messages[0].text).toBe("Message 75");
    appendFileSync(file, JSON.stringify(item("Appended", "95")).slice(0, -1));
    expect((await reader.read(file, "codex", "thread", page.after!, "after")).messages.map(m => m.text)).toEqual([
      "Message 94",
    ]);
    appendFileSync(file, "}\n");
    expect((await reader.read(file, "codex", "thread", page.after!, "after")).messages.at(-1)!.text).toBe("Appended");
    const latest = await reader.read(file, "codex", "thread");
    expect(latest.messages).toHaveLength(10);
    expect(latest.messages[0].text).toBe("Message 86");
    expect(latest.messages.at(-1)!.text).toBe("Appended");
    renameSync(file, join(dir, "old"));
    write([head, item("Replacement", "r")]);
    expect((await reader.read(file, "codex", "thread", page.after!, "after")).availability).toBe("replaced");
    expect((await reader.read(file, "codex", "thread")).messages[0].text).toBe("Replacement");
    expect((await reader.read(file, "codex", "other")).availability).toBe("unavailable");
    expect((await reader.read(file, "codex", "thread", "forged:123")).availability).toBe("replaced");
    write([head, item("x".repeat(20000))]);
    expect((await reader.read(file, "codex", "thread")).messages[0].truncated).toBe(true);
    write([head, item("x".repeat(300000))]);
    const large = await ready(reader, file, "codex", "thread");
    expect(large.availability).toBe("available");
    expect(large.messages[0].text).toHaveLength(16384);
    expect(large.messages[0].truncated).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("missing and malformed files report availability explicitly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-transcripts-")),
    file = join(dir, "thread.jsonl"),
    reader = new Reader();
  try {
    expect((await reader.read(file, "claude", "s")).availability).toBe("unavailable");
    writeFileSync(file, '{"bad"}\n');
    expect((await reader.read(file, "codex", "thread")).availability).toBe("unavailable");
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
  expect(
    claude(lines(record("u", null, "Hello<system-reminder>shortened private context", "user")), "s")![0].text,
  ).toBe("Hello");
});

test("indexes beyond old file/record caps in bounded steps and lazily pages old bodies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-large-")),
    file = join(dir, "thread.jsonl"),
    reader = new Reader(1024 * 1024);
  try {
    writeFileSync(file, JSON.stringify(head) + "\n");
    for (let batch = 0; batch < 60; batch++) {
      appendFileSync(
        file,
        Array.from({ length: 1000 }, (_, i) =>
          JSON.stringify(item(`${batch * 1000 + i}: ${"x".repeat(300)}`, String(batch * 1000 + i))),
        ).join("\n") + "\n",
      );
    }
    let page = await reader.read(file, "codex", "thread"),
      offset = 0;
    expect(page.availability).toBe("indexing");
    while (page.availability === "indexing") {
      expect(page.progress!.read).toBeGreaterThan(offset);
      expect(page.progress!.read - offset).toBeLessThanOrEqual(1024 * 1024);
      offset = page.progress!.read;
      page = await reader.read(file, "codex", "thread");
    }
    expect(page.availability).toBe("available");
    expect(page.messages[0].id).toBe("message:59990");
    expect(page.messages.at(-1)!.id).toBe("message:59999");
    const old = await reader.read(file, "codex", "thread", `${page.version}:message:200`);
    expect(old.messages[0].id).toBe("message:190");
    expect(old.messages.at(-1)!.text).toBe(`199: ${"x".repeat(300)}`);
    appendFileSync(file, JSON.stringify(item("latest", "60000")) + "\n");
    const update = await reader.read(file, "codex", "thread", page.after!, "after");
    expect(update.messages.map(m => m.id)).toEqual(["message:59999", "message:60000"]);
    expect(update.version).toBe(page.version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("large Claude strings, split escapes and incomplete records preserve ancestry and identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-large-claude-")),
    file = join(dir, "s.jsonl"),
    reader = new Reader(8192);
  try {
    writeFileSync(file, JSON.stringify(record("u", null, "Hello", "user")) + "\n");
    const text = "a".repeat(65535) + '\\"\n😀' + "z".repeat(300000);
    appendFileSync(file, JSON.stringify(record("old", "u", text)) + "\n");
    appendFileSync(file, JSON.stringify(record("active", "u", text)) + "\n");
    appendFileSync(file, JSON.stringify({ ...record("side", "active", "hidden"), isSidechain: true }) + "\n");
    const initial = await ready(reader, file, "claude", "s");
    expect(initial.messages.map(m => m.id)).toEqual(["u:0", "active:0"]);
    expect(initial.messages[1].truncated).toBe(true);
    const next = JSON.stringify(record("next", "active", "Next message"));
    appendFileSync(file, next.slice(0, -1));
    expect((await ready(reader, file, "claude", "s", initial.after!, "after")).messages).toHaveLength(1);
    appendFileSync(file, "}\n");
    expect((await ready(reader, file, "claude", "s", initial.after!, "after")).messages.at(-1)!.text).toBe(
      "Next message",
    );
    appendFileSync(file, JSON.stringify(record("branch", "u", "New branch")) + "\n");
    expect((await ready(reader, file, "claude", "s", initial.after!, "after")).availability).toBe("replaced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replacement during indexing discards partial records and never mixes versions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-indexing-")),
    file = join(dir, "thread.jsonl"),
    reader = new Reader(256);
  try {
    writeFileSync(file, JSON.stringify(head) + "\n" + JSON.stringify(item("x".repeat(10000), "old")) + "\n");
    const indexing = await reader.read(file, "codex", "thread");
    expect(indexing.availability).toBe("indexing");
    renameSync(file, join(dir, "old"));
    writeFileSync(file, JSON.stringify(head) + "\n" + JSON.stringify(item("New", "new")) + "\n");
    const page = await ready(reader, file, "codex", "thread");
    expect(page.version).not.toBe(indexing.version);
    expect(page.messages.map(m => m.text)).toEqual(["New"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unusually complex record is omitted explicitly without rejecting the conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-complex-")),
    file = join(dir, "thread.jsonl"),
    reader = new Reader();
  try {
    writeFileSync(
      file,
      [
        head,
        item("Before", "b"),
        { type: "event_msg", data: Array.from({ length: 80000 }, () => "x".repeat(32)) },
        item("After", "a"),
      ]
        .map(v => JSON.stringify(v))
        .join("\n") + "\n",
    );
    const page = await ready(reader, file, "codex", "thread");
    expect(page.availability).toBe("available");
    expect(page.messages.map(m => m.text)).toEqual(["Before", "After"]);
    expect(page.omitted).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uncached giant records cannot exceed a page read budget or block adjacent messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-page-budget-")),
    file = join(dir, "thread.jsonl"),
    reader = new Reader();
  try {
    writeFileSync(
      file,
      JSON.stringify(head) + "\n" + JSON.stringify(item("x".repeat(9 * 1024 * 1024), "giant")) + "\n",
    );
    appendFileSync(
      file,
      Array.from({ length: 200 }, (_, i) => JSON.stringify(item(`Message ${i}`, String(i)))).join("\n") + "\n",
    );
    const recent = await ready(reader, file, "codex", "thread");
    const page = await reader.read(file, "codex", "thread", `${recent.version}:message:1`);
    expect(page.availability).toBe("available");
    expect(page.messages[0].id).toBe("message:giant");
    expect(page.messages[0].truncated).toBe(true);
    expect(page.messages[0].text).toContain("too large to preview");
    expect(page.messages[1].text).toBe("Message 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overview previews retain the last assistant response beyond tools and update incrementally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-preview-")),
    file = join(dir, "thread.jsonl"),
    reader = new Reader(256, 0);
  const write = (records: unknown[]) => writeFileSync(file, records.map(v => JSON.stringify(v)).join("\n") + "\n");
  const preview = async () => {
    let result: Conversation;
    do {
      result = await reader.preview(file, "codex", "thread");
    } while (result.availability === "indexing");
    return result;
  };
  try {
    write([
      head,
      item("Last\n reply " + "x".repeat(500), "reply"),
      ...Array.from({ length: 150 }, (_, i) => ({
        type: "response_item",
        payload: { type: "function_call_output", call_id: String(i), output: "tool" },
      })),
    ]);
    const result = await preview();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe(("Last reply " + "x".repeat(500)).slice(0, 320));
    appendFileSync(file, JSON.stringify(item("New reply", "new")));
    expect((await preview()).messages[0].text).toBe(result.messages[0].text);
    appendFileSync(file, "\n");
    expect((await preview()).messages[0].text).toBe("New reply");
    appendFileSync(file, JSON.stringify(item("Amended reply", "new")) + "\n");
    expect((await preview()).messages[0].text).toBe("Amended reply");
    renameSync(file, join(dir, "old"));
    write([head]);
    expect((await preview()).messages).toEqual([]);
    expect((await reader.preview(file, "codex", "other")).availability).toBe("unavailable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude previews follow active parents and join text blocks without hidden content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-preview-")),
    file = join(dir, "claude.jsonl");
  try {
    writeFileSync(
      file,
      [
        record("u", null, "Hi", "user"),
        record("old", "u", "Abandoned"),
        {
          ...record("current", "u", ""),
          message: {
            content: [
              { type: "text", text: "First" },
              { type: "thinking", thinking: "secret" },
              { type: "text", text: "Second" },
            ],
          },
        },
        { ...record("tool", "current", ""), message: { content: [{ type: "tool_use", name: "Read", input: {} }] } },
        { ...record("side", "tool", "Side"), isSidechain: true },
        record("foreign", "tool", "Wrong", "assistant", "other"),
      ]
        .map(v => JSON.stringify(v))
        .join("\n") + "\n",
    );
    const result = await new Reader().preview(file, "claude", "s");
    expect(result.messages.map(m => m.text)).toEqual(["First Second"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
