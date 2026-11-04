import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { Identity, Provider } from "./types";

import type { Prompt } from "./types";
export type { Prompt } from "./types";
/** Only complete numbered terminal menus with a visible focus and selection footer. */
export function prompt(lines: string[], provider: Provider, identity: Identity): Prompt | null {
  const text = stripVTControlCharacters(lines.join("\n")).replace(/\r/g, "");
  if (!/(?:enter|return) to (?:select|confirm|submit)|press enter/i.test(text)) return null;
  const rows = text.split("\n"),
    choices: Prompt["choices"] = [];
  let start = -1,
    selected = 0;
  for (let i = 0; i < rows.length; i++) {
    const m = /^\s*([›❯>→]?)\s*(\d{1,2})[.)]\s+(.+?)\s*$/.exec(rows[i]);
    if (!m) continue;
    if (Number(m[2]) === 1) {
      choices.length = 0;
      start = i;
      selected = 0;
    }
    if (start < 0 || Number(m[2]) !== choices.length + 1) return null;
    const focused = !!m[1];
    if (focused) selected++;
    choices.push({ index: Number(m[2]), text: m[3].slice(0, 512), selected: focused });
  }
  if (choices.length < 2 || choices.length > 9 || selected !== 1) return null;
  // Checkbox, free-text and tabbed forms stay in Terminal until their semantics are qualified.
  if (/\[[ x✓]\]|☐|☑|space to|type (?:something|your)|add notes|tab to/i.test(rows.slice(start).join("\n")))
    return null;
  const body = rows
    .slice(Math.max(0, start - 12), start)
    .join("\n")
    .trim()
    .slice(-4096);
  const id = createHash("sha256")
    .update(JSON.stringify([provider, identity, text]))
    .digest("base64url");
  return { id, text: body || "Choose a response", choices, multiple: false };
}

export function responseKeys(current: Prompt, choice: number): string {
  const index = current.choices.findIndex(c => c.index === choice),
    focus = current.choices.findIndex(c => c.selected);
  if (index < 0 || focus < 0) throw Error("InvalidInput");
  return [...Array(Math.abs(index - focus)).fill(index > focus ? "down" : "up"), "enter"].join(" ");
}
