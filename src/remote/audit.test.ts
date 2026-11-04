import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit } from "./audit";
test("audit receipts are private, bounded, and contain only action metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-audit-")),
    file = join(dir, "audit.jsonl");
  try {
    for (let i = 0; i < 1500; i++) audit(file, "phone", "rename-agent", "ok");
    const text = readFileSync(file, "utf8"),
      lines = text.trim().split("\n");
    expect(text.length).toBeLessThan(128 * 1024);
    expect(Object.keys(JSON.parse(lines[0]))).toEqual(["at", "device", "action", "result"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
