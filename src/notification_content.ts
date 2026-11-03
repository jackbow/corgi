import { open } from "node:fs/promises";
import type { Agent } from "./mirror";
import { clip, records } from "./launch/history";
import { field, str } from "./providers/common";
import { messageText } from "./providers/pi/headless";

/** Only assistant text belongs in previews, never reasoning or tool output. */
export function latest(bytes: string, provider: Agent["provider"], mid = false): string {
  let last = "";
  for (const record of records(bytes, mid)) {
    let message: unknown = null;
    switch (provider) {
      case "codex":
        if (str(record, "type") === "response_item") {
          const payload = field(record, "payload");
          if (str(payload, "type") === "message" && str(payload, "role") === "assistant") message = payload;
        }
        break;
      case "claude":
        if (str(record, "type") === "assistant" && !field(record, "isSidechain")) message = field(record, "message");
        break;
      case "pi":
      case "omp":
        if (str(record, "type") === "message" && str(field(record, "message"), "role") === "assistant")
          message = field(record, "message");
        break;
    }
    const content = field(message, "content"),
      text =
        provider === "codex" && Array.isArray(content)
          ? content
              .filter(p => str(p, "type") === "output_text")
              .map(p => str(p, "text"))
              .join("\n")
          : messageText(message);
    if (text.trim()) last = text;
  }
  return clip(last, 240);
}

export async function content(agent: Agent | undefined): Promise<{ title: string; body: string }> {
  const title = clip(agent?.name ?? "", 160) || "Corgi";
  if (!agent?.transcript || !agent.provider) return { title, body: "" };
  try {
    const file = await open(agent.transcript, "r");
    try {
      const { size } = await file.stat(),
        start = Math.max(0, size - 256 * 1024),
        bytes = Buffer.alloc(size - start),
        { bytesRead } = await file.read(bytes, 0, bytes.length, start);
      return { title, body: latest(bytes.subarray(0, bytesRead).toString("utf8"), agent.provider, start > 0) };
    } finally {
      await file.close();
    }
  } catch {
    return { title, body: "" };
  }
}
