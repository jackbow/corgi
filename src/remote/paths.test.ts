import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, privateDirectory } from "./paths";

test("runtime endpoints are stable, isolated, and fit macOS Unix socket limits", () => {
  const one = paths("/tmp/one.sock"),
    two = paths("/tmp/two.sock");
  expect(paths("/tmp/one.sock")).toEqual(one);
  expect(one.runtime).not.toBe(two.runtime);
  expect(one.devices).not.toBe(two.devices);
  expect(Buffer.byteLength(one.control)).toBeLessThan(104);
  expect(Buffer.byteLength(one.http)).toBeLessThan(104);
});
test("service directories are private and reject shared directories and symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-paths-")),
    dir = join(root, "private");
  try {
    privateDirectory(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    chmodSync(dir, 0o755);
    expect(() => privateDirectory(dir)).toThrow("UnsafeRemoteDirectory");
    const link = join(root, "link");
    symlinkSync(dir, link);
    expect(() => privateDirectory(link)).toThrow("UnsafeRemoteDirectory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
