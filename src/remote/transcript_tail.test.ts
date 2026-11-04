import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reads, Tail } from "./transcript_tail";

test("reverse reads cross byte budgets and UTF-8 boundaries, retaining only complete records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-reverse-")),
    file = join(dir, "records");
  const records = [{ text: "first😀" }, { text: "b".repeat(300000) + "😀", uuid: "last" }];
  const complete = records.map(v => JSON.stringify(v)).join("\n") + "\n";
  writeFileSync(file, complete + '{"incomplete":');
  const handle = await open(file, "r");
  try {
    const tail = new Tail((await handle.stat()).size),
      found: unknown[] = [];
    let requests = 0;
    while (true) {
      const record = await tail.next(handle, new Reads(4093));
      expect(++requests).toBeLessThan(300);
      if (record === null) break;
      if (record) found.push(record.value);
    }
    expect(found).toEqual([{ text: "b".repeat(65536), uuid: "last" }, records[0]]);
    expect(tail.lastEnd).toBe(Buffer.byteLength(complete));
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
