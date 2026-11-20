//! Asynchronous code colors. Drawing only reads caches or submits work; it never tokenizes.
import * as codePalette from "../code_palette";
import { startWorker } from "./syntax_worker_port";
import { max_line, type Request, type Response, type Span } from "./syntax_types";
export { max_line, type Span } from "./syntax_types";

const extensions: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  zig: "zig",
  zon: "zig",
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  m: "objective-c",
  mm: "objective-cpp",
  swift: "swift",
  java: "java",
  kt: "kotlin",
  cs: "csharp",
  py: "python",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "fish",
  json: "json",
  jsonc: "jsonc",
  lock: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  css: "css",
  scss: "scss",
  md: "markdown",
  markdown: "markdown",
};
export function language(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "Makefile") return "make";
  if (name === "Dockerfile") return "docker";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (extensions[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}
export interface Port {
  postMessage(value: Request | { cancel: number[] }): void;
  onmessage: ((event: MessageEvent<Response>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
  unref?(): void;
}
type Entry = { id: number; spans: Span[][] | null };
/** One lazily started worker per viewer. Weak file keys don't retain closed views. */
export class Service {
  private worker: Port | null = null;
  private files = new WeakMap<string[], Map<string, Entry>>();
  private pending = new Map<number, Entry>();
  private sequence = 0;
  private stamp = -1;
  private palette_key = "";
  private failed = false;
  private chat = new Map<string, Highlighter>();
  private chat_bytes = 0;
  generation = 0;
  constructor(
    readonly changed = () => {},
    private start = startWorker,
  ) {}
  private refresh(): void {
    if (this.stamp === codePalette.generation) return;
    this.stamp = codePalette.generation;
    if (this.palette_key !== codePalette.syntax_key) {
      this.worker?.postMessage({ cancel: [...this.pending.keys()] });
      this.pending.clear();
      this.palette_key = codePalette.syntax_key;
    }
    this.generation++;
  }
  spans(lang: string | null, lines: string[], resets: number[], index: number): Span[] {
    this.refresh();
    if (!lang || index < 0 || index >= lines.length || lines.length > 50_000 || this.failed) return [];
    const key = `${codePalette.syntax_key}:${lang}:${resets.join(",")}`;
    let file = this.files.get(lines);
    let entry = file?.get(key);
    if (!entry) {
      // The same file side owns its content, language and reset boundaries for its lifetime.
      if (lines.reduce((n, line) => n + line.length, 0) > 2_000_000) return [];
      entry = { id: 0, spans: null };
      if (!file) {
        file = new Map();
        this.files.set(lines, file);
      }
      file.set(key, entry);
      // Bound changes to terminal themes as well as the three selectable palettes.
      while (file.size > 4) {
        const oldest = file.keys().next().value!;
        const removed = file.get(oldest)!;
        if (this.pending.delete(removed.id)) this.worker?.postMessage({ cancel: [removed.id] });
        file.delete(oldest);
      }
    }
    if (entry.spans === null && !this.pending.has(entry.id)) {
      entry.id = ++this.sequence;
      this.pending.set(entry.id, entry);
      try {
        if (!this.worker) {
          this.worker = this.start();
          this.worker.unref?.();
          this.worker.onmessage = event => this.receive(event.data);
          this.worker.onerror = () => {
            this.failed = true;
            this.pending.clear();
            this.worker?.terminate();
            this.worker = null;
          };
        }
        this.worker.postMessage({
          id: entry.id,
          lang,
          lines,
          resets,
          palette: codePalette.current.code_palette,
          terminal: codePalette.terminal(),
        });
      } catch {
        this.failed = true;
        this.pending.clear();
      }
    }
    return entry.spans?.[index] ?? [];
  }
  receive(response: Response): void {
    // A palette may change before the next frame has submitted anything.
    this.refresh();
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    entry.spans = response.spans;
    this.generation++;
    this.changed();
  }
  /** Chat layouts are disposable; share identical fences in a bounded LRU. */
  code(lang: string | null, lines: string[]): Highlighter {
    const key = JSON.stringify([lang, lines]);
    let lit = this.chat.get(key);
    if (lit) this.chat.delete(key);
    else {
      lit = new Highlighter(lang, lines);
      this.chat_bytes += key.length * 2;
    }
    this.chat.set(key, lit);
    while (this.chat.size > 64 || this.chat_bytes > 2_000_000) {
      const oldest = this.chat.keys().next().value!;
      this.chat.get(oldest)!.dispose(this);
      this.chat.delete(oldest);
      this.chat_bytes -= oldest.length * 2;
    }
    return lit;
  }
  release(lines: string[]): void {
    const entries = this.files.get(lines);
    if (entries)
      for (const entry of entries.values()) {
        if (this.pending.delete(entry.id)) this.worker?.postMessage({ cancel: [entry.id] });
      }
    this.files.delete(lines);
  }
  close(): void {
    this.worker?.terminate();
    this.worker = null;
    this.files = new WeakMap();
    this.pending.clear();
    this.chat.clear();
    this.chat_bytes = 0;
  }
}
export let service = new Service();
export function use(viewer: Service): void {
  service = viewer;
}
export class Highlighter {
  private owner: Service | null = null;
  constructor(
    private lang: string | null,
    private lines: string[],
    private resets: number[] = [],
  ) {}
  spans(index: number): Span[] {
    this.owner = service;
    return service.spans(this.lang, this.lines, this.resets, index);
  }
  dispose(viewer = this.owner ?? service): void {
    viewer.release(this.lines);
  }
}
