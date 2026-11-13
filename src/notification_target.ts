import type { AttentionTarget } from "./protocol";
import type { Runtime } from "./mirror";
import type { Target } from "./agent_order";
import * as json from "./json";

/** Resolve the conversation again on click; a pane may have switched agents. */
export function resolve(target: AttentionTarget, runtime: Pick<Runtime, "panes" | "sessions">): Target | null {
  if ("conversation" in target) {
    const pane = runtime.panes.find(p => p.agent.conversation === target.conversation);
    if (pane) return { pane: pane.id };
    const session = runtime.sessions.find(s => s.agent?.conversation === target.conversation);
    return session ? { headless: session.id } : null;
  }
  if ("pane" in target) {
    const pane = runtime.panes.find(p => p.id === target.pane);
    return pane && pane.binding === BigInt(target.binding) ? { pane: pane.id } : null;
  }
  return runtime.sessions.some(s => s.id === target.headless) ? { headless: target.headless } : null;
}
export function parse(bytes: string): AttentionTarget | null {
  try {
    const value = json.object(json.parse(bytes)),
      id = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
    if (id(value.conversation)) return { conversation: value.conversation };
    if (id(value.headless)) return { headless: value.headless };
    if (id(value.pane) && (typeof value.binding === "number" || typeof value.binding === "bigint"))
      return { pane: value.pane, binding: BigInt(value.binding) };
  } catch {}
  return null;
}
