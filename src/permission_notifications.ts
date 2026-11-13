import { run } from "./subprocess";
import type { Target } from "./notification_focus";
import { existsSync } from "node:fs";
import { getLogger } from "./log";
import { testBuild } from "./build_assets";

interface Request {
  id: string;
  name: string;
  waiting: boolean;
  permission: boolean;
  target: Target;
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export function command(notifier: string, executable: string, title: string, body: string, target: Target): string[] {
  const callback = [executable, "__notification-open", Buffer.from(JSON.stringify(target)).toString("base64url")];
  return [
    notifier,
    "-title",
    title,
    "-message",
    body.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240),
    "-group",
    `corgi-${target.server}-${target.pane}-${target.binding}`,
    "-execute",
    callback.map(quote).join(" "),
  ];
}
let warned = false;
async function notify(title: string, body: string, target: Target): Promise<void> {
  if (testBuild || process.platform !== "darwin" || process.env.CORGI_NOTIFICATIONS === "off") return;
  try {
    const notifier =
      Bun.which("terminal-notifier") ??
      ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"].find(existsSync);
    if (!notifier) throw Error("TerminalNotifierMissing");
    const result = await run(command(notifier, process.execPath, title, body, target), {
      timeout_ms: 5000,
      max_output: 0,
    });
    if (!result.ok()) throw Error("NotificationFailed");
  } catch {
    if (!warned) getLogger("notifications").warn("macOS banners require terminal-notifier and notification permission");
    warned = true;
  }
}
/** Fallback permission alerts when no local viewer can send the native banner. */
export class Requests {
  private waiting = new Set<string>();
  constructor(private deliver = notify) {}
  update(requests: Request[], deliver = true): void {
    const next = new Set<string>();
    for (const request of requests) {
      if (!request.waiting || next.has(request.id)) continue;
      next.add(request.id);
      if (deliver && !this.waiting.has(request.id))
        void this.deliver(request.permission ? "needs permission" : "needs input", request.name, request.target).catch(
          () => {},
        );
    }
    this.waiting = next;
  }
}
