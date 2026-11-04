import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";

/** Metadata only: never record prompts, terminal text, tokens or paths. */
export function audit(file: string, device: string, action: string, result: "ok" | "failed" | "denied") {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), device, action, result }) + "\n";
    appendFileSync(file, line, { mode: 0o600 });
    chmodSync(file, 0o600);
    const text = readFileSync(file, "utf8");
    if (text.length > 128 * 1024) writeFileSync(file, text.split("\n").slice(-512).join("\n"), { mode: 0o600 });
  } catch {
    /* Audit failures must not replay a completed mutation. */
  }
}
