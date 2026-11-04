import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { phoneRouter } from "./router";
import { configure, Pairing } from "./app";
import { client, type Client } from "./client";
import * as fixtures from "./fixtures";
import "@fontsource-variable/geist";
import "@fontsource-variable/fira-code";
import "./style.css";

const fixture = import.meta.env.DEV ? new URLSearchParams(location.search).get("fixture") : null;
const preview: Client = {
  list: async () => {
    if (fixture === "error") throw Error("Disconnected");
    return fixture === "empty" ? { ...fixtures.snapshot, panes: [] } : fixtures.snapshot;
  },
  conversation: async () => fixtures.conversation,
  terminal: async () => fixtures.terminal,
  history: async () => ({ text: "$ bun test\n✓ Handles long queries\n✓ Keeps short queries unchanged" }),
  send: async () => {
    await new Promise(resolve => setTimeout(resolve, 400));
  },
  create: async () => ({ pane: 1, server: 42, binding: "11", conversation: "thread-1" }),
};
configure(fixture ? preview : client);
if (fixture && ["agent", "waiting"].includes(fixture) && location.pathname === "/")
  history.replaceState(
    null,
    "",
    `/agents/${fixture === "waiting" ? 2 : 1}?view=${fixture === "waiting" ? "terminal" : "conversation"}&fixture=${fixture}`,
  );
if (fixture && ["new", "settings"].includes(fixture) && location.pathname === "/")
  history.replaceState(null, "", `/${fixture}?fixture=${fixture}`);
const router = phoneRouter();
const queries = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      retry: 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchIntervalInBackground: false,
    },
    mutations: { retry: false },
  },
});
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      {fixture === "pairing" ? <Pairing /> : <RouterProvider router={router} />}
    </QueryClientProvider>
  </StrictMode>,
);
