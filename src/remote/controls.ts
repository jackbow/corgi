import { field, str } from "../json";
import { isAbsolute } from "node:path";
import type { Identity } from "./types";
import type { CommandInput } from "../protocol";

import type { Management } from "./types";
export type { Management } from "./types";
export function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 0xffffffff)
    throw Error("InvalidInput");
  return value;
}
export function label(value: unknown, max = 160): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || /\p{Cc}/u.test(value))
    throw Error("InvalidInput");
  return value.trim();
}
export function management(value: unknown, parseIdentity: (v: unknown) => Identity): Management {
  const action = str(value, "action");
  const exact = (...keys: string[]) => {
    if (!value || typeof value !== "object" || Object.keys(value).some(k => !["action", ...keys].includes(k)))
      throw Error("InvalidInput");
  };
  switch (action) {
    case "rename-agent":
      exact("pane", "identity", "name");
      return {
        action,
        pane: positive(field(value, "pane")),
        identity: parseIdentity(field(value, "identity")),
        name: label(field(value, "name")),
      };
    case "clear-agent":
    case "stop-agent":
      exact("pane", "identity", "confirm");
      if (field(value, "confirm") !== true) throw Error("InvalidInput");
      return {
        action,
        pane: positive(field(value, "pane")),
        identity: parseIdentity(field(value, "identity")),
        confirm: true,
      };
    case "create-workspace": {
      exact("server", "name", "cwd");
      const cwd = label(field(value, "cwd"), 4096);
      if (!isAbsolute(cwd)) throw Error("InvalidInput");
      return { action, server: positive(field(value, "server")), name: label(field(value, "name")), cwd };
    }
    case "rename-workspace":
      exact("server", "workspace", "name");
      return {
        action,
        server: positive(field(value, "server")),
        workspace: positive(field(value, "workspace")),
        name: label(field(value, "name")),
      };
    case "close-workspace":
      exact("server", "workspace", "confirm");
      if (field(value, "confirm") !== true) throw Error("InvalidInput");
      return {
        action,
        server: positive(field(value, "server")),
        workspace: positive(field(value, "workspace")),
        confirm: true,
      };
    case "move-workspace":
      exact("server", "workspace", "before");
      return {
        action,
        server: positive(field(value, "server")),
        workspace: positive(field(value, "workspace")),
        before: positive(field(value, "before")),
      };
    default:
      throw Error("InvalidInput");
  }
}

export const terminalKeys = [
  "enter",
  "escape",
  "tab",
  "shift+tab",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "backspace",
  "delete",
  ...Array.from({ length: 26 }, (_, i) => `ctrl+${String.fromCharCode(97 + i)}`),
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
];
const functionSequences = [
  "\x1bOP",
  "\x1bOQ",
  "\x1bOR",
  "\x1bOS",
  "\x1b[15~",
  "\x1b[17~",
  "\x1b[18~",
  "\x1b[19~",
  "\x1b[20~",
  "\x1b[21~",
  "\x1b[23~",
  "\x1b[24~",
];
/** Older running daemons accept function keys through their existing raw-input command. */
export function terminalCommand(pane: number, key: string): CommandInput {
  if (!terminalKeys.includes(key)) throw Error("InvalidInput");
  const index = /^f(\d+)$/.exec(key);
  return index
    ? { "pane.input": { target: pane, data: functionSequences[Number(index[1]) - 1] } }
    : { "pane.keys": { target: pane, text: key === "escape" ? "esc" : key } };
}
