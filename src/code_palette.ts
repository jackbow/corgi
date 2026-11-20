//! Code colors are independent of the surrounding application theme.
import * as palette from "./palette";
import * as terminalPalette from "./terminal_palette";
import type { ThemeRegistration } from "@shikijs/core";

export const palettes = ["dark-plus", "light-plus", "terminal"] as const;
export type Palette = (typeof palettes)[number];
export type Choice = { code_palette: Palette; code_background: boolean };
export const defaults: Choice = { code_palette: "dark-plus", code_background: true };
export const labels: Record<Palette, string> = {
  "dark-plus": "VS Code Dark+",
  "light-plus": "VS Code Light+",
  terminal: "Terminal",
};
export function parse(value: unknown): Palette {
  return palettes.includes(value as Palette) ? (value as Palette) : defaults.code_palette;
}
export let current: Choice = { ...defaults };
export let generation = 0;
/** Only grammar colors affect tokenization; background contrast is applied while drawing. */
export let syntax_key: string = defaults.code_palette;
let signature = "";
const listeners = new Set<() => void>();
export function changed(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function use(choice: Choice): void {
  const selected = { code_palette: choice.code_palette, code_background: choice.code_background };
  const key = JSON.stringify([selected, palette.colors.bg, palette.colors.text, palette.syntax, palette.code_function]);
  if (key === signature) return;
  signature = key;
  current = selected;
  adjusted.clear();
  syntax_key = choice.code_palette === "terminal" ? JSON.stringify(terminal()) : choice.code_palette;
  generation++;
  for (const fn of listeners) fn();
}
const dark_bg: palette.Rgb = [30, 30, 30],
  light_bg: palette.Rgb = [255, 255, 255],
  dark_fg: palette.Rgb = [212, 212, 212],
  light_fg: palette.Rgb = [0, 0, 0];
export const hex = (rgb: palette.Rgb) => "#" + rgb.map(v => v.toString(16).padStart(2, "0")).join("");
export function rgb(value: string): palette.Rgb {
  return [1, 3, 5].map(at => parseInt(value.slice(at, at + 2), 16)) as palette.Rgb;
}
export function background(choice = current): palette.Rgb {
  if (!choice.code_background || choice.code_palette === "terminal") return palette.colors.bg;
  return choice.code_palette === "light-plus" ? light_bg : dark_bg;
}
export function foreground(choice = current): palette.Rgb {
  if (!choice.code_background || choice.code_palette === "terminal") return palette.colors.text;
  return choice.code_palette === "light-plus" ? light_fg : dark_fg;
}
const adjusted = new Map<string, palette.Rgb>();
export function color(rgb: palette.Rgb, choice = current): palette.Rgb {
  if (choice.code_background) return rgb;
  const key = rgb.join(",");
  let out = adjusted.get(key);
  if (!out) {
    out = readable(rgb, palette.colors.bg, palette.colors.text);
    adjusted.set(key, out);
  }
  return out;
}
export function readable(color: palette.Rgb, bg: palette.Rgb, fg: palette.Rgb): palette.Rgb {
  for (let step = 0; step <= 100; step += 5) {
    const out = palette.mix(color, fg, step);
    if (terminalPalette.contrast(out, bg) >= 4.6) return out;
  }
  return fg;
}
export function terminal(): ThemeRegistration {
  const token = (scope: string[], color: palette.Rgb, fontStyle = "") => ({
    scope,
    settings: { foreground: hex(readable(color, palette.colors.bg, palette.colors.text)), fontStyle },
  });
  return {
    name: "terminal",
    type: palette.luminance(palette.colors.bg) > 0.5 ? "light" : "dark",
    colors: { "editor.background": hex(palette.colors.bg), "editor.foreground": hex(palette.colors.text) },
    tokenColors: [
      token(["keyword", "storage"], palette.syntax.keyword),
      token(["string", "markup.inline.raw"], palette.syntax.string),
      token(["constant.numeric", "constant.language"], palette.syntax.number),
      token(["entity.name.type", "support.type", "entity.name.tag"], palette.syntax.type),
      token(["variable", "support.variable"], palette.syntax.property),
      token(["entity.name.function", "support.function"], palette.code_function),
      token(["comment", "punctuation.definition.comment"], palette.colors.muted, "italic"),
      token(["punctuation.separator", "punctuation.section", "keyword.operator"], palette.syntax.punctuation),
      token(["markup.heading"], palette.syntax.keyword, "bold"),
      token(["markup.underline.link"], palette.syntax.string, "underline"),
    ],
  };
}
