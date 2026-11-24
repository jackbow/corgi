import { readFileSync, unlinkSync, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { Runtime } from "../runtime";
import { atomicWrite } from "../os";
import { getLogger } from "../log";
import * as checkpoint from "./checkpoint";
import * as json from "../json";
import * as transfer from "./transfer";
import * as cold from "./cold";
export { atomicWrite };
export function path(socket: string): string {
  const root = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "/", ".local", "state");
  const standard = `/tmp/corgi-${process.getuid?.() ?? 0}/control.sock`;
  return join(
    root,
    "corgi",
    "recovery",
    socket === standard ? "recovery.json" : `runtime-${Bun.hash.wyhash(socket, 0n).toString(16)}.json`,
  );
}
const writes = new Map<string, Promise<void>>();
export async function save(r: Runtime, socket: string): Promise<void> {
  // Capture before yielding: later mutations belong to the next save.
  const dest = path(socket),
    bytes = json.stringify(transfer.recovery(r, checkpoint.capture(r, false)));
  const pending = (writes.get(dest) ?? Promise.resolve()).catch(() => {}).then(() => write(dest, bytes));
  writes.set(dest, pending);
  const release = () => {
    if (writes.get(dest) === pending) writes.delete(dest);
  };
  void pending.then(release, release);
  return pending;
}
async function write(dest: string, bytes: string): Promise<void> {
  const parent = dirname(dest);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(parent);
  if (stat.uid !== (process.getuid?.() ?? userInfo().uid) || !stat.isDirectory() || (stat.mode & 0o077) !== 0)
    throw Error("UnsafeSocketDirectory");
  const temp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await fs.open(temp, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temp, dest);
    const directory = await fs.open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}
/** Where the daemon records a load that repaired the saved session, for the next viewer to report. */
const repairedPath = (socket: string) => `${path(socket)}.repaired.json`;
/** Records that loading `state` took `repairs`; the latest one wins. */
export async function recordRepairs(socket: string, state: unknown, repairs: string[], executable: string) {
  if (!repairs.length) return;
  try {
    const { describe } = await import("./check"),
      { release } = await import("../updates");
    atomicWrite(
      repairedPath(socket),
      json.stringify({ release: release(executable).version, report: { state: { ...describe(state), repairs } } }),
    );
  } catch (error) {
    console.warn("recording a repaired session:", error);
  }
}
/** The repaired session the daemon recorded, once: taking it removes it. */
export function takeRepairs(socket: string): { release: string; report: unknown } | null {
  const file = repairedPath(socket);
  let value: any;
  try {
    value = json.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(file);
    } catch {}
  }
  return typeof value?.release === "string" ? { release: value.release, report: value.report } : null;
}
export async function load(r: Runtime, socket: string, executable: string): Promise<boolean> {
  const source = path(socket);
  let bytes: string;
  try {
    bytes = readFileSync(source, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const decoded = await cold.read(bytes, socket, executable);
  for (const repair of decoded.repairs) getLogger("checkpoint").warn(repair);
  const repairs = [...decoded.repairs, ...(await checkpoint.restore(r, decoded.value, false, socket, executable))];
  if (decoded.discarded) repairs.push("discarded incompatible auxiliary state; restored the terminal core");
  await recordRepairs(socket, decoded.value, repairs, executable);
  if (decoded.migrated) {
    atomicWrite(`${source}.v${decoded.from}`, bytes);
    try {
      await save(r, socket);
    } catch (error) {
      console.error(`recovery snapshot ${source} could not be rewritten after migration:`, error);
    }
  }
  return true;
}
