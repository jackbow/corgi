import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function paths(socket: string) {
  const id = createHash("sha256").update(resolve(socket)).digest("hex").slice(0, 16);
  const runtime = `/tmp/corgi-${process.getuid?.() ?? 0}/remote-${id}`;
  const state = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "corgi/remote", id);
  return {
    runtime,
    state,
    http: join(runtime, "http.sock"),
    control: join(runtime, "control.sock"),
    lock: join(runtime, "lock"),
    devices: join(state, "devices.json"),
    log: join(runtime, "server.log"),
  };
}
export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw Error("UnsafeRemoteDirectory");
}
