import source from "../../src/review/syntax_worker_source";
import type { Port } from "../../src/review/syntax";

export function startWorker(): Port {
  if (!source) throw Error("SyntaxWorkerUnavailable");
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    return new Worker(url, { type: "module" }) as Port;
  } finally {
    URL.revokeObjectURL(url);
  }
}
