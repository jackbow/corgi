import { test, expect } from "bun:test";
import { parse, needsPane, title } from "./action";
test("wire names used by the CLI and the test suites parse", () => {
  expect(parse("split", "down")).toEqual({ name: "split", value: "down" });
  expect(parse("split")).toEqual({ name: "split", value: "right" });
  expect(parse("move-tab", "left")).toEqual({
    name: "move-tab",
    value: "left",
  });
  expect(parse("detach")).toEqual({ name: "detach" });
  expect(parse("copy", "copied").value).toBe("copied");
  expect(parse("move-tab")).toEqual({ name: "move-tab", value: "right" });
  expect(parse("join", "1")).toEqual({ name: "join", value: 1 });
  expect(parse("focus", "up")).toEqual({ name: "focus", value: "up" });
  expect(parse("undo-close")).toEqual({ name: "undo-close" });
  expect(parse("last-tab")).toEqual({ name: "last-tab" });
  expect(parse("last-workspace")).toEqual({ name: "last-workspace" });
  expect(parse("prompt")).toEqual({ name: "prompt" });
  expect(parse("goto-workspace", "2")).toEqual({
    name: "goto-workspace",
    value: 2,
  });
  expect(parse("rename", "Renamed").value).toBe("Renamed");
  for (const [name, value, error] of [
    ["close_tab", "", "UnknownAction"],
    ["focus", "north", "BadValue"],
    ["resize", "", "BadValue"],
    ["tab", "two", "BadValue"],
  ])
    expect(() => parse(name, value)).toThrow(error);
});

test("agent scope can be toggled without a pane", () => {
  const action = parse("toggle-agent-scope");
  expect(action).toEqual({ name: "toggle-agent-scope" });
  expect(needsPane(action)).toBe(false);
  expect(title(action)).toBe("Toggle workspace / all agents");
});
