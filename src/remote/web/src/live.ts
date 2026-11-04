import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Client } from "./client";
import type { Snapshot } from "./types";

/** Fetch streaming keeps bearer credentials out of URLs and stops when the app is hidden. */
export function useLive(client: Client, enabled = true) {
  const cache = useQueryClient();
  useEffect(() => {
    if (!client.events || !enabled) return;
    let disposed = false,
      active: AbortController | undefined,
      retry: ReturnType<typeof setTimeout>;
    const start = () => {
      clearTimeout(retry);
      active?.abort();
      if (disposed || document.visibilityState === "hidden") return;
      const controller = new AbortController();
      active = controller;
      void client.events!(controller.signal, (type, data) => {
        if (data)
          cache.setQueryData<Snapshot>(["session"], prior =>
            prior?.observed && data.observed && prior.observed > data.observed
              ? prior
              : {
                  ...data,
                  panes: data.panes.map(pane => {
                    const old =
                      prior?.server === data.server
                        ? prior.panes.find(
                            p => p.id === pane.id && p.binding === pane.binding && p.conversation === pane.conversation,
                          )
                        : undefined;
                    return { ...pane, lastResponse: old?.lastResponse };
                  }),
                },
          );
        for (const key of type === "session" ? ["session", "prompt"] : ["conversation", "terminal", "prompt"])
          void cache.invalidateQueries({
            queryKey: [key],
            predicate: query => Date.now() - query.state.dataUpdatedAt >= (key === "session" ? 2000 : 1000),
            refetchType: "active",
          });
      })
        .catch(() => {})
        .finally(() => {
          if (!disposed && !controller.signal.aborted) retry = setTimeout(start, 2000);
        });
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        clearTimeout(retry);
        active?.abort();
      } else start();
    };
    start();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", start);
    return () => {
      disposed = true;
      clearTimeout(retry);
      active?.abort();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", start);
    };
  }, [client, cache, enabled]);
}
