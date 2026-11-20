import type { ThemeRegistration } from "@shikijs/core";
import type { Rgb } from "../palette";
import type { Palette } from "../code_palette";

/** UTF-16 `[start, end)`, matching JavaScript slicing and word diffs. */
export type Span = [start: number, end: number, foreground: Rgb, style: number];
export const max_line = 2000;
export const chunk_lines = 200;
export type Request = {
  id: number;
  lang: string;
  lines: string[];
  resets: number[];
  palette: Palette;
  terminal: ThemeRegistration;
};
export type Response = { id: number; spans: Span[][]; error?: boolean };
