import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { Client } from "./client";
import type { Identity, Conversation } from "./types";
import { Messages } from "./messages";
import { Button } from "./ui";

export function ArchiveBrowser({
  client,
  pane,
  identity,
  id,
  close,
}: {
  client: Client;
  pane: number;
  identity: Identity;
  id: string;
  close: () => void;
}) {
  const [search, setSearch] = useState(""),
    [scanning, setScanning] = useState(false);
  const cache = useQueryClient(),
    scanFrom = useRef<unknown>("");
  const query = useInfiniteQuery({
    queryKey: ["archive", id],
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) => {
      let page = await client.archive!(pane, identity, pageParam, signal);
      while (page.availability === "indexing") {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 500);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        page = await client.archive!(pane, identity, pageParam, signal);
      }
      return page;
    },
    getNextPageParam: page => (page.availability === "available" ? (page.before ?? undefined) : undefined),
    maxPages: 50,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const pages = query.data?.pages ?? [],
    all = [...pages].reverse().flatMap(page => page.messages),
    seen = new Set<string>();
  const messages = all.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return !search || m.text.toLowerCase().includes(search.toLowerCase());
  });
  const unavailable = pages.some(p => p.availability !== "available");
  const foundOlder =
    query.data?.pageParams.at(-1) !== scanFrom.current &&
    !!pages.at(-1)?.messages.some(m => m.text.toLowerCase().includes(search.toLowerCase()));
  useEffect(() => {
    if (!scanning || !search || foundOlder || !query.hasNextPage || query.isError || unavailable) {
      if (scanning) setScanning(false);
      return;
    }
    if (!query.isFetching) void query.fetchNextPage();
  }, [scanning, search, foundOlder, query.hasNextPage, query.isFetching, query.isError, unavailable]);
  const data: Conversation = {
    availability: "available",
    version: id,
    messages,
    before: null,
    after: null,
    more: !!query.hasNextPage,
  };
  return (
    <div className="archive-browser">
      <div className="archive-controls">
        <label className="sr-only" htmlFor="archive-search">
          Search conversation history
        </label>
        <input
          id="archive-search"
          type="search"
          placeholder="Search conversation history"
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            setScanning(false);
          }}
        />
        <Button
          onClick={() => {
            if (scanning) {
              setScanning(false);
              void cache.cancelQueries({ queryKey: ["archive", id] });
            } else {
              scanFrom.current = query.data?.pageParams.at(-1) ?? "";
              setScanning(true);
            }
          }}
          disabled={!search || !query.hasNextPage}
        >
          {scanning ? "Stop search" : "Search older"}
        </Button>
        <Button onClick={close}>Return to live</Button>
      </div>
      <p className="muted" role="status">
        {unavailable
          ? "History changed or unavailable. Return to live and reopen history."
          : query.isError
            ? "History request failed. Return to live and reopen history."
            : query.isFetching
              ? "Reading earlier messages…"
              : query.hasNextPage
                ? "Scroll up for earlier messages. Search reads older pages only when requested."
                : "Beginning of available history."}
      </p>
      <Messages
        id={`archive:${id}`}
        data={data}
        earlier={() => {
          if (!query.isFetching && query.hasNextPage && !search) void query.fetchNextPage();
        }}
      />
    </div>
  );
}
