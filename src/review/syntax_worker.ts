import { highlight } from "./syntax_engine";
import type { Request, Response } from "./syntax_types";

const active = new Set<number>(),
  cancelled = new Set<number>();
self.onmessage = async (event: MessageEvent<Request | { cancel: number[] }>) => {
  const request = event.data;
  if ("cancel" in request) {
    for (const id of request.cancel) if (active.has(id)) cancelled.add(id);
    return;
  }
  active.add(request.id);
  try {
    const spans = await highlight(request, () => cancelled.has(request.id));
    if (!cancelled.has(request.id)) self.postMessage({ id: request.id, spans } satisfies Response);
  } catch {
    if (!cancelled.has(request.id)) self.postMessage({ id: request.id, spans: [], error: true } satisfies Response);
  } finally {
    cancelled.delete(request.id);
    active.delete(request.id);
  }
};
