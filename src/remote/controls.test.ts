import { expect, test } from "bun:test";
import { management, terminalCommand } from "./controls";
import { identity, input, launch } from "./daemon";
const q = { server: 42, binding: "3", conversation: "thread" };
test("management accepts only scoped actions with explicit destructive confirmation", () => {
  expect(management({ action: "rename-agent", pane: 1, identity: q, name: " New name " }, identity)).toMatchObject({
    name: "New name",
    identity: q,
  });
  expect(
    management({ action: "create-workspace", server: 42, name: "Project", cwd: "/projects/app" }, identity),
  ).toMatchObject({ cwd: "/projects/app" });
  for (const value of [
    { action: "stop-agent", pane: 1, identity: q },
    { action: "close-workspace", server: 42, workspace: 1 },
    { action: "rename-workspace", server: 42, workspace: 1, name: "bad\nname" },
    { action: "create-workspace", server: 42, name: "Project", cwd: "../private" },
    { action: "rename-agent", pane: 1, identity: q, name: "Name", command: "shell" },
    { action: "worktree.create", server: 42 },
  ])
    expect(() => management(value, identity)).toThrow("InvalidInput");
});
test("terminal keys and profile IDs are allowlisted", () => {
  expect(terminalCommand(1, "escape")).toEqual({ "pane.keys": { target: 1, text: "esc" } });
  expect(terminalCommand(1, "f12")).toEqual({ "pane.input": { target: 1, data: "\x1b[24~" } });
  for (const key of ["ctrl+z", "ctrl+u", "f12", "shift+tab", "pageup"]) expect(input({ ...q, key }).key).toBe(key);
  for (const key of ["ctrl+c enter", "shell", "f13"]) expect(() => input({ ...q, key })).toThrow("InvalidInput");
  expect(launch({ server: 42, workspace: 1, provider: "codex", profile: "review-agent" }).profile).toBe("review-agent");
  expect(() => launch({ server: 42, workspace: 1, provider: "codex", profile: "../private" })).toThrow("InvalidInput");
});
