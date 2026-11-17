import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("remote helpers require explicit destinations before accessing credentials or connecting", () => {
  const bin = mkdtempSync(join(tmpdir(), "corgi-release-scripts-"));
  try {
    writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o700 });
    for (const [script, env, missing] of [
      ["../macos.sh", {}, "CORGI_PROBE_HOST"],
      ["../macos.sh", { CORGI_PROBE_HOST: "fixture" }, "CORGI_PROBE_REMOTE"],
      ["../scripts/send-release-keys.sh", {}, "CORGI_RELEASE_HOST"],
    ] as const) {
      const result = Bun.spawnSync(["/bin/bash", new URL(script, import.meta.url).pathname], {
        env: { PATH: bin, ...env },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(`Set ${missing}`);
      expect(result.stdout.toString()).toBe("");
    }
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
