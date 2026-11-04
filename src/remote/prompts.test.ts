import { expect, test } from "bun:test";
import { prompt, responseKeys } from "./prompts";
const q = { server: 42, binding: "3", conversation: "thread" };
const lines = ["Run this command?", "  ❯ 1. Yes, this time", "    2. No", "Enter to confirm · Esc to cancel"];
test("numbered prompts preserve choices and bind responses to screen and conversation", () => {
  const p = prompt(lines, "claude", q)!;
  expect(p.choices).toEqual([
    { index: 1, text: "Yes, this time", selected: true },
    { index: 2, text: "No", selected: false },
  ]);
  expect(responseKeys(p, 2)).toBe("down enter");
  expect(responseKeys(p, 1)).toBe("enter");
  expect(() => responseKeys(p, 3)).toThrow("InvalidInput");
  expect(prompt(lines, "claude", { ...q, conversation: "other" })!.id).not.toBe(p.id);
  expect(prompt(["Different command?", ...lines.slice(1)], "claude", q)!.id).not.toBe(p.id);
});
test("incomplete, ambiguous and unsupported forms fall back to Terminal", () => {
  for (const rows of [
    lines.slice(0, -1),
    lines.map(l => l.replace("❯", " ")),
    [...lines, "Space to toggle"],
    [...lines, "Tab to add notes"],
    ["❯ 1. Yes", "3. No", "Enter to select"],
  ])
    expect(prompt(rows, "codex", q)).toBeNull();
});
