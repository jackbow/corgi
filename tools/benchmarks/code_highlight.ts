//! bun tools/benchmarks/code_highlight.ts [line count]
//! Exercises the actual worker, cached scrolling and palette changes without drawing.
import * as syntax from "../../src/review/syntax";
import * as codePalette from "../../src/code_palette";

const count = Number(process.argv[2] ?? 10_000);
const lines = Array.from(
  { length: count },
  (_, i) => `export function item${i}(n: number) { return n + ${i}; } // item`,
);
let complete = () => {},
  submissions = 0;
const service = new syntax.Service(
  () => complete(),
  () => {
    const worker = new Worker(new URL("../../src/review/syntax_worker.ts", import.meta.url)) as syntax.Port;
    const post = worker.postMessage.bind(worker);
    worker.postMessage = value => {
      if ("id" in value) submissions++;
      post(value);
    };
    return worker;
  },
);
const baseline = process.memoryUsage().rss;
const highlights: { palette: string; background: boolean; ms: number }[] = [];
try {
  for (const name of codePalette.palettes)
    for (const background of [true, false]) {
      codePalette.use({ code_palette: name, code_background: background });
      const done = new Promise<void>(resolve => (complete = resolve)),
        start = performance.now();
      const cached = service.spans("typescript", lines, [], count - 1);
      if (!cached.length) await done;
      if (!service.spans("typescript", lines, [], count - 1).length) throw Error("HighlightFailed");
      highlights.push({ palette: name, background, ms: +(performance.now() - start).toFixed(2) });
    }
  const before = submissions,
    start = performance.now();
  for (let i = 0; i < 100_000; i++) service.spans("typescript", lines, [], i % count);
  const cached_ms = +(performance.now() - start).toFixed(2);
  codePalette.use({ code_palette: "dark-plus", code_background: true });
  const switch_start = performance.now();
  if (!service.spans("typescript", lines, [], count - 1).length) throw Error("MissingCachedPalette");
  const cached_palette_ms = +(performance.now() - switch_start).toFixed(2);
  const rss_cached = process.memoryUsage().rss;
  service.release(lines);
  service.close();
  await Bun.sleep(100);
  Bun.gc(true);
  console.log(
    JSON.stringify(
      {
        lines: count,
        highlights,
        cached_reads: 100_000,
        cached_ms,
        cached_submissions: submissions - before,
        cached_palette_ms,
        rss_before: baseline,
        rss_cached,
        rss_after_close_gc: process.memoryUsage().rss,
      },
      null,
      2,
    ),
  );
} finally {
  service.close();
}
