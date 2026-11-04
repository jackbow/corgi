import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { phoneRouter } from "./router";
import { configure, Pairing } from "./app";
import { client, type Client } from "./client";
import { applyAppearance, pureBlack } from "./appearance";
import * as fixtures from "./fixtures";
import "@fontsource-variable/geist";
import "@fontsource-variable/fira-code";
import "./style.css";
import { pushSupported, registerPushWorker } from "./notifications";

applyAppearance(pureBlack());
if (pushSupported()) void registerPushWorker().catch(() => {});
const fixture = import.meta.env.DEV ? new URLSearchParams(location.search).get("fixture") : null;
let answered = false;
const preview: Client = {
  manage: async () => {},
  profiles: async () => [
    { id: "review", name: "Review", provider: "codex" },
    { id: "planning", name: "Planning", provider: "claude" },
  ],
  prompt: async id =>
    id === 2 && !answered
      ? {
          id: "fixture-question",
          text: "Run the browser checks for this change?",
          multiple: false,
          choices: [
            { index: 1, text: "Yes, this time", selected: true },
            { index: 2, text: "No", selected: false },
          ],
        }
      : null,
  respond: async () => {
    answered = true;
  },
  commands: async () => [
    { text: "/compact", description: "Compact the conversation" },
    { text: "/help", description: "Show provider help" },
  ],
  archive: async (_pane, _identity, cursor) => {
    const end = cursor ? Number(cursor) : 100;
    return {
      availability: "available",
      version: "fixture",
      messages: Array.from({ length: 20 }, (_, i) => ({
        id: `archive-${end - 20 + i}`,
        role: "assistant",
        text: `Previous response ${end - 20 + i}`,
      })),
      before: end > 20 ? String(end - 20) : null,
      after: null,
      more: end > 20,
    };
  },
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
