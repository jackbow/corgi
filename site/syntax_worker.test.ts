import { expect, test } from "bun:test";
import { join } from "node:path";
import * as codePalette from "../src/code_palette";
import type { Request, Response } from "../src/review/syntax_types";

test("browser worker bundle highlights offline with all network APIs blocked", async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/review/syntax_worker.ts")],
    target: "browser",
    minify: true,
  });
  expect(result.success).toBe(true);
  expect(result.outputs).toHaveLength(1);
  const source =
    'globalThis.fetch = globalThis.importScripts = () => { throw Error("NetworkForbidden"); };\n' +
    (await result.outputs[0].text());
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module" });
  try {
    const done = new Promise<Response>((resolve, reject) => {
      worker.onmessage = event => resolve(event.data);
      worker.onerror = reject;
    });
    worker.postMessage({
      id: 1,
      lang: "tsx",
      lines: ['function greet() { return <Button title="hi" />; }'],
      resets: [],
      palette: "dark-plus",
      terminal: codePalette.terminal(),
    } satisfies Request);
    const response = await done;
    expect(response.error).toBeUndefined();
    expect(
      response.spans[0].some(([start, end, rgb]) => start === 9 && end === 14 && rgb.join(",") === "220,220,170"),
    ).toBe(true);
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
});
