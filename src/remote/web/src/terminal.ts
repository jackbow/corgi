export interface Span {
  text: string;
  style: {
    color?: string;
    backgroundColor?: string;
    fontWeight?: number;
    fontStyle?: string;
    textDecoration?: string;
    opacity?: number;
  };
}
const basic = [
  "var(--bg)",
  "var(--hot)",
  "var(--accent)",
  "var(--warm)",
  "var(--syntax-keyword)",
  "var(--syntax-type)",
  "var(--syntax-string)",
  "var(--text)",
  "var(--faint)",
  "var(--hot)",
  "var(--accent)",
  "var(--warm)",
  "var(--syntax-keyword)",
  "var(--syntax-type)",
  "var(--syntax-string)",
  "var(--strong)",
];
function color(n: number) {
  if (n < 16) return basic[n];
  if (n >= 232)
    return `rgb(${Array(3)
      .fill(8 + (n - 232) * 10)
      .join(",")})`;
  const v = n - 16;
  return `rgb(${[Math.floor(v / 36), Math.floor(v / 6) % 6, v % 6].map(i => (i ? 55 + i * 40 : 0)).join(",")})`;
}
/** Surface text is data. Only SGR color/attributes become styles; other controls are discarded. */
export function spans(line: string): Span[] {
  const out: Span[] = [];
  let style: Span["style"] = {},
    at = 0,
    inverse = false;
  const current = (): Span["style"] =>
    inverse
      ? { ...style, color: style.backgroundColor ?? "var(--bg)", backgroundColor: style.color ?? "var(--text)" }
      : { ...style };
  const controls =
    /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_X][\s\S]*?\x1b\\|\x1b[ -/]*[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
  for (const match of line.matchAll(controls)) {
    if (match.index! > at) out.push({ text: line.slice(at, match.index), style: current() });
    if (/^\x1b\[[\d;:]*m$/.test(match[0])) {
      const values = match[0]
        .slice(2, -1)
        .replace(/(38|48|58):2:(?:0|):(\d+):(\d+):(\d+)/g, "$1;2;$2;$3;$4")
        .replace(/4:0(?=;|$)/g, "24")
        .replace(/4:[1-5]/g, "4")
        .split(/[;:]/)
        .map(Number);
      for (let i = 0; i < values.length; i++) {
        const n = values[i];
        if (n === 0) {
          style = {};
          inverse = false;
        } else if (n === 1) style.fontWeight = 700;
        else if (n === 2) style.opacity = 0.7;
        else if (n === 3) style.fontStyle = "italic";
        else if (n === 4) style.textDecoration = "underline";
        else if (n === 7) inverse = true;
        else if (n === 9) style.textDecoration = "line-through";
        else if (n === 22) {
          delete style.fontWeight;
          delete style.opacity;
        } else if (n === 23) delete style.fontStyle;
        else if (n === 24 || n === 29) delete style.textDecoration;
        else if (n === 27) inverse = false;
        else if (n === 39) delete style.color;
        else if (n === 49) delete style.backgroundColor;
        else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) style.color = basic[n >= 90 ? n - 82 : n - 30];
        else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107))
          style.backgroundColor = basic[n >= 100 ? n - 92 : n - 40];
        else if (n === 38 || n === 48 || n === 58) {
          let c: string | undefined;
          if (values[i + 1] === 5) {
            const v = values[i + 2];
            if (v >= 0 && v <= 255) c = color(v);
            i += 2;
          } else if (values[i + 1] === 2) {
            const rgb = values.slice(i + 2, i + 5);
            if (rgb.length === 3 && rgb.every(v => v >= 0 && v <= 255)) c = `rgb(${rgb.join(",")})`;
            i += 4;
          }
          if (c && n !== 58) style[n === 38 ? "color" : "backgroundColor"] = c;
        }
      }
    }
    at = match.index! + match[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at), style: current() });
  return out;
}
