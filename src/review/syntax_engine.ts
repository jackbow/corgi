//! Imported only by the highlighting worker (and its focused tests).
import { createHighlighterCore, type GrammarState } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import dark from "@shikijs/themes/dark-plus";
import light from "@shikijs/themes/light-plus";
import typescript from "@shikijs/langs/typescript";
import javascript from "@shikijs/langs/javascript";
import tsx from "@shikijs/langs/tsx";
import jsx from "@shikijs/langs/jsx";
import zig from "@shikijs/langs/zig";
import rust from "@shikijs/langs/rust";
import go from "@shikijs/langs/go";
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import objc from "@shikijs/langs/objective-c";
import objcpp from "@shikijs/langs/objective-cpp";
import swift from "@shikijs/langs/swift";
import java from "@shikijs/langs/java";
import kotlin from "@shikijs/langs/kotlin";
import csharp from "@shikijs/langs/csharp";
import python from "@shikijs/langs/python";
import shell from "@shikijs/langs/shellscript";
import fish from "@shikijs/langs/fish";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import yaml from "@shikijs/langs/yaml";
import toml from "@shikijs/langs/toml";
import css from "@shikijs/langs/css";
import scss from "@shikijs/langs/scss";
import markdown from "@shikijs/langs/markdown";
import make from "@shikijs/langs/make";
import docker from "@shikijs/langs/docker";
import { rgb } from "../code_palette";
import { chunk_lines, max_line, type Request, type Span } from "./syntax_types";

const engine = createHighlighterCore({
  engine: createJavaScriptRegexEngine(),
  themes: [dark, light],
  langs: [
    typescript,
    javascript,
    tsx,
    jsx,
    zig,
    rust,
    go,
    c,
    cpp,
    objc,
    objcpp,
    swift,
    java,
    kotlin,
    csharp,
    python,
    shell,
    fish,
    json,
    jsonc,
    yaml,
    toml,
    css,
    scss,
    markdown,
    make,
    docker,
  ],
});
/** State belongs to this request alone, including while another file is running. */
export async function highlight(request: Request, cancelled = () => false): Promise<Span[][]> {
  const h = await engine;
  if (cancelled() || !h.getLoadedLanguages().includes(request.lang)) return [];
  if (request.palette === "terminal") await h.loadTheme(request.terminal);
  const resets = new Set(request.resets),
    result: Span[][] = [];
  let state: GrammarState | undefined;
  const colors = new Map<string, ReturnType<typeof rgb>>();
  for (let at = 0; at < request.lines.length; at++) {
    if (at % chunk_lines === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (cancelled()) return [];
    }
    if (resets.has(at)) state = undefined;
    const full = request.lines[at],
      line = full.slice(0, max_line);
    const out = h.codeToTokensBase(line, { lang: request.lang, theme: request.palette, grammarState: state });
    result.push(
      (out[0] ?? [])
        .filter(t => t.content.length)
        .map(t => {
          const color = t.color ?? "#d4d4d4";
          let fg = colors.get(color);
          if (!fg) {
            fg = rgb(color);
            colors.set(color, fg);
          }
          return [t.offset, t.offset + t.content.length, fg, t.fontStyle ?? 0];
        }),
    );
    // Truncated lines have unknown trailing state; don't carry a false string/comment.
    state = full.length > max_line ? undefined : h.getLastGrammarState(out);
  }
  return result;
}
