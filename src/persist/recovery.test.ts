import { test, expect, spyOn } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  statSync,
  promises as fs,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { atomicWrite } from "../os";
import { save as saveInference } from "../inference/setup";
import * as claude from "../providers/claude";
import { Runtime, Pane } from "../runtime";
import { Terminal } from "../pane/terminal";
import { Workspace } from "../workspace";
import { failure } from "../state_report";
import * as json from "../json";
import * as checkpoint from "./checkpoint";
import * as recovery from "./recovery";

test("recovery saves yield during disk IO and commit captured snapshots in order", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-recovery-async-")),
    prior = process.env.XDG_STATE_HOME,
    socket = join(root, "control.sock"),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    rename = fs.rename,
    open = fs.open;
  process.env.XDG_STATE_HOME = root;
  using r = new Runtime();
  const observed: number[] = [],
    renamed = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      observed.push(json.parse(readFileSync(from, "utf8")).revision);
      return rename(from, to);
    }),
    held = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      const file = await open(path, flags, mode);
      if (path === dirname(recovery.path(socket))) {
        const sync = file.sync.bind(file);
        spyOn(file, "sync").mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          return sync();
        });
      }
      return file;
    });
  let first: Promise<void> | undefined, second: Promise<void> | undefined;
  try {
    r.revision = 1n;
    first = recovery.save(r, socket);
    await entered.promise;
    r.revision = 2n;
    let saved = false;
    second = recovery.save(r, socket).then(() => {
      saved = true;
    });
    r.revision = 3n;
    // The event loop stays available while the first write is held.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(saved).toBe(false);
    expect(observed).toEqual([1]);
    release.resolve();
    await Promise.all([first, second]);
    expect(observed).toEqual([1, 2]);
    expect(json.parse(readFileSync(recovery.path(socket), "utf8")).revision).toBe(2);
    expect(statSync(recovery.path(socket)).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(recovery.path(socket))).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(recovery.path(socket)))).toEqual([recovery.path(socket).split("/").at(-1)!]);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    held.mockRestore();
    renamed.mockRestore();
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
test("a failed recovery save cleans its temp file and does not poison later saves", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-recovery-async-")),
    prior = process.env.XDG_STATE_HOME,
    socket = join(root, "control.sock");
  process.env.XDG_STATE_HOME = root;
  using r = new Runtime();
  const rename = spyOn(fs, "rename").mockRejectedValueOnce(Error("DiskFailure"));
  try {
    await expect(recovery.save(r, socket)).rejects.toThrow("DiskFailure");
    expect(readdirSync(dirname(recovery.path(socket)))).toEqual([]);
    rename.mockRestore();
    await recovery.save(r, socket);
    expect(json.parse(readFileSync(recovery.path(socket), "utf8")).version).toBe(checkpoint.version);
  } finally {
    rename.mockRestore();
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
test("recovery saves reject an unsafe parent directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-recovery-async-")),
    prior = process.env.XDG_STATE_HOME,
    socket = join(root, "control.sock");
  process.env.XDG_STATE_HOME = root;
  using r = new Runtime();
  try {
    const parent = dirname(recovery.path(socket));
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    await expect(recovery.save(r, socket)).rejects.toThrow("UnsafeSocketDirectory");
    expect(readdirSync(parent)).toEqual([]);
  } finally {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomic writes avoid stale temp collisions and preserve private permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-atomic-review-")),
    dest = join(root, "saved.json"),
    other = join(root, "unrelated");
  try {
    writeFileSync(other, "untouched");
    symlinkSync(other, `${dest}.tmp-${process.pid}`);
    atomicWrite(dest, "new state");
    expect(readFileSync(dest, "utf8")).toBe("new state");
    expect(readFileSync(other, "utf8")).toBe("untouched");
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).sort()).toEqual(["saved.json", "saved.json.tmp-" + process.pid, "unrelated"].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("failed atomic replacement removes only its own temporary file", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-atomic-review-")),
    dest = join(root, "directory");
  try {
    mkdirSync(dest, { mode: 0o700 });
    expect(() => atomicWrite(dest, "state")).toThrow();
    expect(readdirSync(root)).toEqual(["directory"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("atomic writes reject an unsafe parent directory", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-atomic-review-")),
    parent = join(root, "public");
  try {
    mkdirSync(parent, { mode: 0o755 });
    expect(() => atomicWrite(join(parent, "saved"), "state")).toThrow("UnsafeSocketDirectory");
    expect(readdirSync(parent)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("successful migrated recovery keeps its backup when the final rewrite fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-recovery-review-")),
    prior = process.env.XDG_STATE_HOME,
    r = new Runtime();
  process.env.XDG_STATE_HOME = root;
  const source = recovery.path(join(root, "control.sock")),
    bytes = readFileSync(new URL("../fixtures/steps/checkpoint-4.in.json", import.meta.url), "utf8");
  mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
  writeFileSync(source, bytes, { mode: 0o600 });
  const restore = spyOn(checkpoint, "restore").mockImplementationOnce(async () => {
      rmSync(source);
      mkdirSync(source, { mode: 0o700 });
      return [];
    }),
    error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await recovery.load(r, join(root, "control.sock"), process.execPath)).toBe(true);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(readFileSync(source + ".v4", "utf8")).toBe(bytes);
    expect(error).toHaveBeenCalledTimes(1);
  } finally {
    restore.mockRestore();
    error.mockRestore();
    r.destroy();
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("inference settings preserve ordinary config directory permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-config-review-")),
    parent = join(root, "config");
  try {
    mkdirSync(parent, { mode: 0o755 });
    saveInference(join(parent, "choice.json"), "off");
    expect(JSON.parse(readFileSync(join(parent, "choice.json"), "utf8")).inference).toBe("off");
    expect(statSync(parent).mode & 0o777).toBe(0o755);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("hook settings preserve ordinary config directory and file permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-config-review-")),
    parent = join(root, "claude"),
    prior = process.env.CLAUDE_CONFIG_DIR;
  try {
    mkdirSync(parent, { mode: 0o755 });
    process.env.CLAUDE_CONFIG_DIR = parent;
    const file = join(parent, "settings.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    await claude.adapter.integration.install("");
    expect(JSON.parse(readFileSync(file, "utf8")).hooks).toBeDefined();
    expect(readFileSync(file + ".corgi-backup", "utf8")).toBe("{}");
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(statSync(parent).mode & 0o777).toBe(0o755);
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
test("a load that repairs the saved session leaves a report for the next viewer, once", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-recovery-repair-")),
    prior = process.env.XDG_STATE_HOME,
    socket = join(root, "control.sock");
  process.env.XDG_STATE_HOME = root;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  using before = new Runtime();
  using after = new Runtime();
  try {
    const ws = new Workspace(1, "/tmp");
    before.workspaces.items.push(ws);
    before.workspaces.next_id = 2;
    const pane = new Pane(ws.model.newTab(""), Terminal.create(20, 4), "/tmp");
    pane.terminal.exited = true;
    pane.attachment.select(before.conversations.get("claude", "forgotten"));
    before.panes.push(pane);
    before.workspaces.next_pane_id = ws.model.next_id;
    const state = json.parse(json.stringify(checkpoint.capture(before, false)));
    state.conversations = [];
    mkdirSync(dirname(recovery.path(socket)), { recursive: true, mode: 0o700 });
    writeFileSync(recovery.path(socket), json.stringify(state), { mode: 0o600 });
    expect(await recovery.load(after, socket, "/tmp/corgi")).toBe(true);
    const taken = recovery.takeRepairs(socket);
    expect(taken?.release).toBeString();
    expect(failure(taken?.report).state.repairs).toEqual([
      `pane ${pane.id} pointed at conversation 1, which isn't saved; dropped`,
    ]);
    expect(recovery.takeRepairs(socket)).toBeNull();
  } finally {
    warn.mockRestore();
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
