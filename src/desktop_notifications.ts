import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { nativeRoot } from "./native_paths";
import { n } from "./native_bridge";
import { privateDirectory } from "./os";
import type { AttentionTarget } from "./protocol";
import * as i18n from "./i18n";

function install(): string {
  const source = join(nativeRoot, "bin", "Corgi Notifications.app"),
    root = join(homedir(), "Library", "Application Support", "Corgi"),
    app = join(root, "Notifications.app"),
    binary = "Contents/MacOS/corgi-notify";
  privateDirectory(root);
  if (
    !existsSync(join(app, binary)) ||
    ![binary, "Contents/Info.plist"].every(
      file => existsSync(join(app, file)) && readFileSync(join(source, file)).equals(readFileSync(join(app, file))),
    )
  ) {
    const staged = `${app}.${process.pid}.tmp`,
      backup = `${app}.${process.pid}.old`;
    cpSync(source, staged, { recursive: true });
    const previous = existsSync(app);
    if (previous) renameSync(app, backup);
    try {
      renameSync(staged, app);
    } catch (error) {
      if (previous) renameSync(backup, app);
      throw error;
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
    if (previous) rmSync(backup, { recursive: true, force: true });
  }
  return join(app, binary);
}
export class Notifications {
  private child: ChildProcess | null = null;
  private ready: Promise<ChildProcess | null> | null = null;
  private closed = false;
  private targets = new Map<string, AttentionTarget>();
  constructor(
    private clicked: (target: AttentionTarget) => void,
    private helper?: string,
  ) {}
  private start(): Promise<ChildProcess | null> {
    return (this.ready ??= new Promise(resolve => {
      try {
        // Keep the tty source away from the descriptors spawn replaces with pipes.
        const terminal = process.stdin.isTTY ? n.probe_dup_above(0, 64) : -1;
        let child: ChildProcess;
        try {
          child = this.child = spawn(this.helper ?? install(), [], {
            stdio: ["pipe", "pipe", "ignore", terminal >= 0 ? terminal : "ignore"],
          });
        } finally {
          if (terminal >= 0) n.probe_close(terminal);
        }
        let buffer = "";
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (data: string) => {
          buffer += data;
          if (buffer.length > 65536) {
            child.kill();
            return;
          }
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
              const message = JSON.parse(line);
              if (message.ready !== undefined) resolve(message.ready ? child : null);
              if (typeof message.clicked === "string") {
                const target = this.targets.get(message.clicked);
                if (target) {
                  this.targets.delete(message.clicked);
                  this.clicked(target);
                }
              }
            } catch {}
          }
        });
        child.on("error", () => resolve(null));
        child.on("exit", () => {
          this.child = null;
          this.targets.clear();
          resolve(null);
        });
        child.stdin!.on("error", () => child.kill());
      } catch {
        resolve(null);
      }
    }));
  }
  async show(kind: string, target: AttentionTarget | null, subtitle = ""): Promise<void> {
    if (this.closed || process.env.CORGI_BELL === "off") return;
    const body = kind === "needs_input" ? i18n.t`Needs input` : i18n.t`Finished`;
    const child =
      (this.helper || (process.platform === "darwin" && !process.env.SSH_CONNECTION && !process.env.SSH_TTY)) && target
        ? await this.start()
        : null;
    if (this.closed) return;
    if (child?.stdin?.writable && child.exitCode === null) {
      const id = crypto.randomUUID();
      this.targets.set(id, target!);
      if (this.targets.size > 128) this.targets.delete(this.targets.keys().next().value!);
      child.stdin.write(JSON.stringify({ id, title: "Corgi", subtitle, body }) + "\n");
    } else {
      process.stdout.write(`\x1b]777;notify;Corgi;${body}\x1b\\`);
    }
  }
  close(): void {
    this.closed = true;
    this.targets.clear();
    const child = this.child;
    child?.stdin?.end();
    if (child) {
      const timer = setTimeout(() => child.kill(), 1000);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    }
  }
}
