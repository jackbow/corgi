//! Theme-colored sidebar mark and the host's Kitty capability probe.
export const reply_prefix = "\x1b_G";
export const query = "\x1b_Ga=q,i=730031,t=d,f=24,s=1,v=1;AAAA\x1b\\";
export const mark = ">_";
export type Mode = "none" | "mark";
export function hit(mode: Mode, sidebar_width: number, x: number, y: number): boolean {
  return sidebar_width > 0 && mode === "mark" && x >= 2 && x < 4 && y === 0;
}
export class State {
  status: "probing" | "supported" | "unavailable" = "probing";
  supports_kitty_graphics = false;
  mode(): Mode {
    return "mark";
  }
  accept(sequence: string): boolean {
    if (!sequence.startsWith(reply_prefix) || !sequence.endsWith("\x1b\\")) return false;
    const rest = sequence.slice(reply_prefix.length, -2),
      separator = rest.indexOf(";");
    if (separator < 0) return false;
    let id: number | null = null,
      placement: number | null = null;
    for (const field of rest.slice(0, separator).split(",")) {
      const equals = field.indexOf("=");
      if (equals < 0) return false;
      const key = field.slice(0, equals),
        value = field.slice(equals + 1);
      if (key === "i" || key === "p") {
        if (!/^\d+$/.test(value) || Number(value) > 0xffffffff) return false;
        if (key === "i") {
          if (id !== null) return false;
          id = Number(value);
        } else {
          if (placement !== null) return false;
          placement = Number(value);
        }
      }
    }
    if (id !== 730031 || (placement !== null && placement !== 1)) return false;
    this.status = rest.slice(separator + 1) === "OK" ? "supported" : "unavailable";
    this.supports_kitty_graphics = this.status === "supported";
    return true;
  }
}
