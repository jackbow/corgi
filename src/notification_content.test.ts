import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latest, content } from "./notification_content";
import { agent } from "./mirror";

const lines = (...values: unknown[]) => values.map(v => JSON.stringify(v) + "\n").join("");
test("notification previews use the latest assistant text, excluding tools and reasoning", () => {
  expect(
    latest(
      lines(
        {
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Earlier" }] },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done!\nChanges ready 🐕" }],
          },
        },
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "User prompt" }] },
        },
        {
          type: "response_item",
          payload: { type: "reasoning", content: [{ type: "text", text: "Private reasoning" }] },
        },
      ),
      "codex",
    ),
  ).toBe("Done! Changes ready 🐕");
  for (const provider of ["claude", "pi", "omp"] as const) {
    expect(
      latest(
        lines(
          {
            type: provider === "claude" ? "assistant" : "message",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Ready" },
                { type: "thinking", thinking: "Private" },
              ],
            },
          },
          { type: provider === "claude" ? "user" : "message", message: { role: "toolResult", content: "Tool result" } },
        ),
        provider,
      ),
    ).toBe("Ready");
  }
  expect(latest(lines({ type: "assistant", isSidechain: true, message: { content: "Child reply" } }), "claude")).toBe(
    "",
  );
});
test("notification previews ignore incomplete records and clip long Unicode messages", () => {
  const row = { type: "assistant", message: { content: "🐕".repeat(100) } };
  const preview = latest("partial record\n" + lines(row) + '{"unfinished":', "claude", true);
  expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(240);
  expect(preview).not.toContain("�");
  expect(preview.length).toBeGreaterThan(0);
});
test("notification content reads a bounded transcript tail and falls back when unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-preview-")),
    path = join(root, "transcript");
  try {
    writeFileSync(
      path,
      "x".repeat(300000) + "\n" + lines({ type: "assistant", message: { content: "Latest answer" } }),
    );
    const a = agent({ name: "Fix notifications", provider: "claude", transcript: path });
    expect(await content(a)).toEqual({ title: "Fix notifications", body: "Latest answer" });
    a.transcript += ".missing";
    expect(await content(a)).toEqual({ title: "Fix notifications", body: "" });
    expect(await content(undefined)).toEqual({ title: "Corgi", body: "" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
