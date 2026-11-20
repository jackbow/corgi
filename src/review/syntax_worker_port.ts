import { nativeFiles } from "../build_assets";
import type { Port } from "./syntax";

export function startWorker(): Port {
  // Compiled entrypoints resolve relative to main.js, like the existing viewer workers.
  const entry = nativeFiles ? "./review/syntax_worker.js" : "./syntax_worker.ts";
  return new Worker(new URL(entry, import.meta.url)) as Port;
}
