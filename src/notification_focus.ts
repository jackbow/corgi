import { isAbsolute } from "node:path";
import { field, str } from "./json";
import { Connection } from "./rpc";
import { run } from "./subprocess";

export interface Target {
  socket: string;
  server: number;
  pane: number;
  binding: string;
  conversation: string;
}
export function decode(encoded: string): Target {
  if (encoded.length > 8192) throw Error("InvalidNotificationTarget");
  const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString());
  const socket = str(value, "socket"),
    server = field(value, "server"),
    pane = field(value, "pane"),
    binding = str(value, "binding"),
    conversation = str(value, "conversation");
  if (
    !isAbsolute(socket) ||
    typeof server !== "number" ||
    !Number.isSafeInteger(server) ||
    server < 1 ||
    typeof pane !== "number" ||
    !Number.isSafeInteger(pane) ||
    pane < 1 ||
    pane > 0xffffffff ||
    !/^\d+$/.test(binding) ||
    typeof field(value, "conversation") !== "string" ||
    conversation.length > 256
  )
    throw Error("InvalidNotificationTarget");
  return { socket, server, pane, binding, conversation };
}
export function matches(target: Target, snapshot: unknown): boolean {
  const panes = field(snapshot, "panes");
  return (
    field(snapshot, "server_pid") === target.server &&
    Array.isArray(panes) &&
    panes.some(
      p =>
        field(p, "id") === target.pane &&
        String(field(p, "binding")) === target.binding &&
        field(p, "exited") !== true &&
        str(field(p, "agent"), "session") === target.conversation,
    )
  );
}
const bundles: Record<string, string> = {
  ghostty: "com.mitchellh.ghostty",
  "iTerm.app": "com.googlecode.iterm2",
  Apple_Terminal: "com.apple.Terminal",
  WezTerm: "com.github.wez.wezterm",
  kitty: "net.kovidgoyal.kitty",
};
export function terminalBundle(terminal: unknown): string | null {
  if (field(terminal, "ssh") === true) return null;
  return bundles[str(field(terminal, "env"), "TERM_PROGRAM")] ?? null;
}
export async function open(
  target: Target,
  activate: (bundle: string) => Promise<void> = async bundle => {
    await run(["/usr/bin/open", "-b", bundle], { timeout_ms: 5000, max_output: 0 });
  },
): Promise<void> {
  const connection = new Connection(target.socket);
  try {
    if (!matches(target, await connection.call("session.snapshot"))) throw Error("StaleNotification");
    const [{ viewers }, report] = await Promise.all([connection.call("viewer.list"), connection.call("bugreport")]);
    const viewer = viewers.find(v => v.pane === target.pane) ?? viewers.find(v => v.watched) ?? viewers[0];
    if (!viewer) throw Error("NoViewer");
    if (!matches(target, await connection.call("session.snapshot"))) throw Error("StaleNotification");
    await connection.call("focus", { pane: target.pane, viewer: viewer.id });
    const bundle = terminalBundle(report.viewers.find(v => v.id === viewer.id)?.terminal);
    if (bundle) await activate(bundle);
  } finally {
    connection.close();
  }
}
