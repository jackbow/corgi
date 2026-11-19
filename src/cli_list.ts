import * as text from "./text";
import * as session from "./cli_session";
export { panes, select } from "./cli_session";
export type { Reply } from "./cli_session";
export type Options = { all?: boolean; tree?: boolean; workspace?: number; width?: number };

/** IDs stay intact; only workspace and session names shrink to fit a terminal. */
export function compact(reply: session.Reply, { all = false, width = Infinity }: Options = {}): string {
  const entries = session.sessions(reply),
    shown = entries.filter(s => all || !s.inactive),
    hidden = entries.length - shown.length;
  const rows = shown.map(s =>
    [
      s.pane === null ? s.target : String(s.pane),
      String(s.tab ?? "-"),
      String(s.workspace),
      s.provider || "-",
      s.workspace_name,
      s.name,
      session.status(s),
    ].map(text.spacedControls),
  );
  const out: string[] = [];
  if (!rows.length) out.push("no sessions");
  else {
    const headers = ["PANE", "TAB", "WS", "AGENT", "WORKSPACE", "SESSION", "STATUS"],
      widths = headers.map((h, i) => Math.max(text.displayWidth(h), ...rows.map(r => text.displayWidth(r[i]))));
    const room = Math.max(2, width - widths[0] - widths[1] - widths[2] - widths[3] - widths[6] - 12);
    if (widths[4] + widths[5] > room) {
      widths[4] = Math.min(widths[4], Math.max(1, Math.floor(room * 0.4)));
      widths[5] = Math.max(1, Math.min(widths[5], room - widths[4]));
    }
    for (const row of [headers, ...rows])
      out.push(
        row
          .map((value, i) => {
            const clipped = text.ellipsis(value, widths[i]);
            return i === 6 ? clipped : clipped + " ".repeat(widths[i] - text.displayWidth(clipped));
          })
          .join("  ")
          .trimEnd(),
      );
  }
  if (hidden) out.push(`${hidden} inactive hidden (--all)`);
  return out.join("\n") + "\n";
}
