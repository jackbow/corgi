/** Each page carries only its own recorded screens. */
import { join } from "node:path";
import type { Locale } from "../src/locale";

// Bundle before the page build: nesting Bun.build inside onLoad can deadlock.
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "../src/review/syntax_worker.ts")],
  target: "browser",
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, "Syntax worker bundle failed");
const worker = await result.outputs[0].text();
export function frames(language: Locale): Bun.BunPlugin {
  return {
    name: "site-frames",
    setup(build) {
      build.onLoad({ filter: /\/syntax_worker_source\.ts$/ }, () => ({
        contents: `export default ${JSON.stringify(worker)};`,
        loader: "js",
      }));
      build.onLoad({ filter: /\/site\/frames\.json$/ }, async () => ({
        contents: await Bun.file(
          join(import.meta.dir, language === "en" ? "frames.json" : `frames/${language}.json`),
        ).text(),
        loader: "json",
      }));
    },
  };
}
