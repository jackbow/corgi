import { isAbsolute } from "node:path";
import type { UpdateState } from "./types";

type Target = { server: number; executable: string };
type Result = { code: number; text: string };
type Run = (executable: string, args: string[]) => Promise<Result>;
function runner(socket: string): Run {
  return async (exe, args) => {
    const child = Bun.spawn([exe, "update", ...args], {
      env: { ...process.env, CORGI_SOCKET: socket, CORGI_APP_EXE: exe },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(600_000),
    });
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      let text = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return text;
          text += new TextDecoder().decode(chunk.value);
          if (text.length > 65536) {
            child.kill();
            throw Error("UpdateOutputTooLarge");
          }
        }
      } finally {
        reader.releaseLock();
      }
    };
    const [out, err, code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
    return { code, text: out + err };
  };
}
/** Uses the running Mac executable's signed updater, never a browser-supplied command or path. */
export class Updates {
  private value: UpdateState | undefined;
  private pending = false;
  private run: Run;
  constructor(
    private target: () => Promise<Target>,
    socket: string,
    run?: Run,
  ) {
    this.run = run ?? runner(socket);
  }
  async status(): Promise<UpdateState> {
    const target = await this.target();
    if (this.value && (this.pending || this.value.server === target.server)) return this.value;
    if (!isAbsolute(target.executable)) throw Error("Unsupported");
    const result = await this.run(target.executable, ["status"]);
    return (this.value = {
      phase: result.code === 0 ? "idle" : "unsupported",
      server: target.server,
      current: /^current: ([\w.-]+)$/m.exec(result.text)?.[1],
      staged: /^staged: ([\w.-]+)$/m.exec(result.text)?.[1],
      message:
        result.code === 0
          ? "Updates use the Mac's signed release channel."
          : "The running Mac uses an unmanaged build. Install a managed release on the Mac to enable updates.",
    });
  }
  async start(server: number): Promise<UpdateState> {
    if (this.pending) throw Error("RateLimited");
    this.pending = true;
    try {
      const state = await this.status(),
        target = await this.target();
      if (target.server !== server || state.server !== server) throw Error("PaneChanged");
      if (state.phase === "unsupported") throw Error("Unsupported");
      if (!isAbsolute(target.executable)) throw Error("Unsupported");
      this.value = { ...state, phase: "running", message: "Checking, downloading and applying the signed Mac update…" };
      void this.run(target.executable, [])
        .then(
          result => {
            const deferred =
              result.text.includes("UpdateDeferred") || result.text.includes("Update remains downloaded");
            this.value = {
              ...state,
              phase: result.code === 0 ? "complete" : deferred ? "deferred" : "failed",
              message:
                result.code === 0
                  ? "Mac update finished. The phone feature service remains running separately."
                  : deferred
                    ? "Update downloaded. A restart needs approval from an outside terminal: run corgi update on the Mac."
                    : "Update not confirmed. Check corgi update status on the Mac before trying again.",
            };
          },
          () => {
            this.value = {
              ...state,
              phase: "failed",
              message: "Update not confirmed. Check corgi update status on the Mac before trying again.",
            };
          },
        )
        .finally(() => {
          this.pending = false;
        });
      return this.value;
    } catch (error) {
      this.pending = false;
      throw error;
    }
  }
}
