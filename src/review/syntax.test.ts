import { afterEach, expect, test } from "bun:test";
import * as syntax from "./syntax";
import { highlight } from "./syntax_engine";
import * as codePalette from "../code_palette";
import * as palette from "../palette";
import * as diff from "./diff";
import type { Request, Response, Span } from "./syntax_types";

function request(lang: string, lines: string[], changes: Partial<Request> = {}): Request {
  return {
    id: 1,
    lang,
    lines,
    resets: [],
    palette: "dark-plus",
    terminal: codePalette.terminal(),
    ...changes,
  };
}
function color(spans: Span[], line: string, word: string) {
  const at = line.indexOf(word);
  return spans.find(([s, e]) => s <= at && e > at)?.[2];
}
afterEach(() => codePalette.use(codePalette.defaults));

test("proper grammars for previous language coverage, including JSX and former C aliases", () => {
  for (const [file, lang] of Object.entries({
    "a.ts": "typescript",
    "a.tsx": "tsx",
    "a.jsx": "jsx",
    "a.cpp": "cpp",
    "a.m": "objective-c",
    "a.mm": "objective-cpp",
    "a.swift": "swift",
    "a.java": "java",
    "a.kt": "kotlin",
    "a.cs": "csharp",
    "a.fish": "fish",
    "a.scss": "scss",
    "a.zig": "zig",
    "bun.lock": "json",
    Makefile: "make",
    Dockerfile: "docker",
  }))
    expect(syntax.language(file)).toBe(lang);
  expect(syntax.language("LICENSE")).toBeNull();
});

test.each([...codePalette.palettes])("%s preserves functions, comments and richer theme colors", async name => {
  const line = 'function greet(n: number) { return "hi"; } // comment';
  const [spans] = await highlight(request("typescript", [line], { palette: name }));
  expect(color(spans, line, "greet")).not.toEqual(color(spans, line, "function"));
  expect(color(spans, line, "comment")).not.toEqual(color(spans, line, '"hi"'));
  expect(new Set(spans.map(s => s[2].join(","))).size).toBeGreaterThanOrEqual(5);
  if (name === "dark-plus") expect(color(spans, line, "greet")).toEqual([220, 220, 170]);
  if (name === "light-plus") expect(color(spans, line, "greet")).toEqual([121, 94, 38]);
  if (name === "terminal") {
    expect(color(spans, line, "greet")).toEqual(palette.code_function);
    expect(spans.find(s => s[0] <= line.indexOf("comment") && s[1] > line.indexOf("comment"))![3] & 1).toBe(1);
  }
});

test.each(["tsx", "jsx"])("%s recognizes tags, attributes, expressions and functions", async lang => {
  const line = 'const view = <Button title="hi" onClick={() => greet()}>{value}</Button>;';
  const [spans] = await highlight(request(lang, [line]));
  expect(color(spans, line, "Button")).not.toEqual(color(spans, line, "title"));
  expect(color(spans, line, "greet")).toEqual([220, 220, 170]);
  expect(color(spans, line, '"hi"')).not.toEqual(color(spans, line, "title"));
});

test("Markdown embeds the bundled TypeScript grammar", async () => {
  const line = 'function greet() { return "hi"; }';
  const embedded = await highlight(request("markdown", ["```ts", line, "```"]));
  const standalone = await highlight(request("typescript", [line]));
  expect(embedded[1]).toEqual(standalone[0]);
});

test("multiline comments and strings survive chunk boundaries and folded content", async () => {
  const lines = ["/*", ...Array<string>(450).fill("inside comment"), "*/ const s = `start", "middle", "end`;"];
  const result = await highlight(request("typescript", lines));
  expect(result[300][0][2]).toEqual([106, 153, 85]);
  expect(result[451][0][2]).toEqual([106, 153, 85]);
  expect(result[452][0][2]).toEqual([206, 145, 120]);
  expect(result[453][0][2]).toEqual([206, 145, 120]);
});

test("independent requests never share grammar state, even when interleaved", async () => {
  const [old, fresh] = await Promise.all([
    highlight(request("typescript", ["/*", "comment"])),
    highlight(request("typescript", ["const x = 1;", "function greet() {}"])),
  ]);
  expect(old[1][0][2]).toEqual([106, 153, 85]);
  expect(color(fresh[1], "function greet() {}", "greet")).toEqual([220, 220, 170]);
});

test("remote hunk gaps reset each side; loading full context rebuilds state", async () => {
  const d = diff.parse("@@ -1,1 +1,1 @@\n /* open\n@@ -10,1 +10,1 @@\n const x = 1;");
  if (d === "binary") throw Error("UnexpectedBinary");
  expect(d.old_resets).toEqual([1]);
  expect(d.new_resets).toEqual([1]);
  const missing = await highlight(request("typescript", d.new, { resets: d.new_resets }));
  expect(missing[1][0][2]).toEqual([86, 156, 214]);
  const full = await highlight(request("typescript", ["/* open", "const x = 1;"]));
  expect(full[1][0][2]).toEqual([106, 153, 85]);
});

test("Unicode offsets slice the original string; long lines and unknown languages stay bounded", async () => {
  const line = 'const s = "🦊é"; greet();';
  const [spans] = await highlight(request("typescript", [line]));
  const fn = spans.find(s => line.slice(s[0], s[1]) === "greet");
  expect(fn?.[0]).toBe(line.indexOf("greet"));
  const long = "x".repeat(syntax.max_line + 100) + "/*";
  const result = await highlight(request("typescript", [long, "const x = 1;"]));
  expect(result[0].every(s => s[1] <= syntax.max_line)).toBe(true);
  expect(result[1][0][2]).toEqual([86, 156, 214]);
  expect(await highlight(request("unrecognized", ["const x = 1;"]))).toEqual([]);
});

class FakeWorker implements syntax.Port {
  requests: Array<Request | { cancel: number[] }> = [];
  onmessage: ((e: MessageEvent<Response>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  postMessage(value: Request | { cancel: number[] }) {
    this.requests.push(value);
  }
  terminate() {
    this.terminated = true;
  }
  jobs() {
    return this.requests.filter((r): r is Request => "id" in r);
  }
  reply(id: number) {
    this.onmessage?.({ data: { id, spans: [[[0, 5, [220, 220, 170], 7]]] } } as MessageEvent<Response>);
  }
}
test("drawing is asynchronous, deduplicates work, invalidates on completion and discards stale results", () => {
  const worker = new FakeWorker();
  let starts = 0,
    paints = 0;
  const service = new syntax.Service(
    () => paints++,
    () => {
      starts++;
      return worker;
    },
  );
  const lines = ["greet()"];
  expect(starts).toBe(0);
  for (let i = 0; i < 100; i++) expect(service.spans("typescript", lines, [], 0)).toEqual([]);
  expect(starts).toBe(1);
  expect(worker.jobs()).toHaveLength(1);
  const old = worker.jobs()[0].id;
  codePalette.use({ code_palette: "light-plus", code_background: true });
  worker.reply(old);
  expect(paints).toBe(0);
  service.spans("typescript", lines, [], 0);
  const fresh = worker.jobs()[1].id;
  worker.reply(fresh);
  expect(paints).toBe(1);
  expect(service.spans("typescript", lines, [], 0)[0][3]).toBe(7);
  service.release(lines);
  service.spans("typescript", lines, [], 0);
  const replaced = worker.jobs()[2].id;
  service.release(lines);
  worker.reply(replaced);
  expect(paints).toBe(1);
  service.close();
  expect(worker.terminated).toBe(true);
});
test("chat shares fences and file-size limits submit no work", () => {
  const worker = new FakeWorker(),
    service = new syntax.Service(
      () => {},
      () => worker,
    );
  expect(service.code("typescript", ["greet()"])).toBe(service.code("typescript", ["greet()"]));
  expect(service.spans("typescript", Array<string>(50_001).fill("a"), [], 0)).toEqual([]);
  expect(service.spans("typescript", ["a".repeat(2_000_001)], [], 0)).toEqual([]);
  expect(worker.jobs()).toHaveLength(0);
  service.close();
});
test("real worker highlights without runtime downloads", async () => {
  let done!: () => void;
  const ready = new Promise<void>(resolve => (done = resolve));
  const service = new syntax.Service(() => done()),
    lines = ["function greet() {}"];
  try {
    expect(service.spans("typescript", lines, [], 0)).toEqual([]);
    await ready;
    expect(color(service.spans("typescript", lines, [], 0), lines[0], "greet")).toEqual([220, 220, 170]);
  } finally {
    service.close();
  }
});

test("completed palettes are cached by content and grammar; backgrounds need no new work", () => {
  const worker = new FakeWorker(),
    service = new syntax.Service(
      () => {},
      () => worker,
    ),
    lines = ["greet()"];
  codePalette.use(codePalette.defaults);
  service.spans("typescript", lines, [], 0);
  worker.reply(worker.jobs()[0].id);
  codePalette.use({ code_palette: "dark-plus", code_background: false });
  expect(service.spans("typescript", lines, [], 0)).toHaveLength(1);
  expect(worker.jobs()).toHaveLength(1);
  codePalette.use({ code_palette: "light-plus", code_background: true });
  service.spans("typescript", lines, [], 0);
  worker.reply(worker.jobs()[1].id);
  codePalette.use(codePalette.defaults);
  expect(service.spans("typescript", lines, [], 0)).toHaveLength(1);
  expect(worker.jobs()).toHaveLength(2);
  expect(service.spans("markdown", lines, [], 0)).toEqual([]);
  expect(worker.jobs()).toHaveLength(3);
  service.close();
});
