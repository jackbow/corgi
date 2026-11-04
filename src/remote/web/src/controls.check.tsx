import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PromptCard } from "./prompt";
import { WorkspaceControls, AgentActions } from "./management";
import { Composer } from "./agent";
import { clearSubmitted, readDraft } from "./drafts";
import { useLive } from "./live";
import type { Client } from "./client";
import * as fixtures from "./fixtures";
import type { Snapshot } from "./types";
const caches: QueryClient[] = [];
function wrap(children: ReactNode) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  caches.push(cache);
  return { cache, ...render(<QueryClientProvider client={cache}>{children}</QueryClientProvider>) };
}
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("localStorage", sessionStorage);
});
afterEach(() => {
  cleanup();
  caches.splice(0).forEach(c => c.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("never answers a prompt on mount and disables an uncertain response instead of retrying", async () => {
  const respond = vi.fn(async () => {
    throw Error("timeout");
  });
  render(
    <PromptCard
      prompt={{
        id: "p",
        text: "Approve operation?",
        multiple: false,
        choices: [
          { index: 1, text: "Approve once", selected: true },
          { index: 2, text: "Deny", selected: false },
        ],
      }}
      respond={respond}
      terminal={vi.fn()}
    />,
  );
  expect(respond).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Approve once" }));
  await screen.findByText(/Response not confirmed/);
  await userEvent.click(screen.getByRole("button", { name: "Approve once" }));
  expect(respond).toHaveBeenCalledTimes(1);
});
it("confirms workspace closure and sends stable IDs without arbitrary daemon commands", async () => {
  const manage = vi.fn(async () => {}),
    client = { manage } as unknown as Client,
    data = fixtures.snapshot;
  wrap(<WorkspaceControls client={client} data={data} />);
  await userEvent.click(screen.getAllByRole("button", { name: "Close workspace" })[0]);
  expect(manage).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Confirm close" }));
  expect(manage).toHaveBeenCalledWith({
    action: "close-workspace",
    workspace: data.workspaces[0].id,
    server: data.server,
    confirm: true,
  });
});
it("binds an agent stop to its current conversation and requires confirmation", async () => {
  const manage = vi.fn(async () => {}),
    pane = fixtures.snapshot.panes[0];
  wrap(<AgentActions client={{ manage } as unknown as Client} pane={pane} server={42} />);
  fireEvent.click(screen.getByText("Agent actions"));
  await userEvent.click(screen.getByRole("button", { name: "Stop agent" }));
  expect(manage).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(manage).toHaveBeenCalledWith({
    action: "stop-agent",
    pane: pane.id,
    identity: { server: 42, binding: pane.binding, conversation: pane.conversation },
    confirm: true,
  });
});
it("inserts command suggestions into the draft without sending", async () => {
  const send = vi.fn(async () => {});
  render(
    <Composer
      pane={fixtures.snapshot.panes[0]}
      server={42}
      send={send}
      commands={[{ text: "/compact", description: "Compact context" }]}
    />,
  );
  await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "/co");
  await userEvent.click(screen.getByRole("button", { name: /\/compact/ }));
  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("/compact ");
  expect(send).not.toHaveBeenCalled();
});
it("keeps sensitive terminal input out of persisted drafts", async () => {
  const send = vi.fn(async () => {}),
    pane = fixtures.snapshot.panes[0];
  render(<Composer pane={pane} server={42} send={send} />);
  fireEvent.click(screen.getByLabelText("Message options"));
  await userEvent.click(screen.getByRole("button", { name: "Sensitive input (not saved)" }));
  await userEvent.type(screen.getByLabelText("Message"), "private-example");
  expect(JSON.stringify({ ...localStorage })).not.toContain("private-example");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(send).toHaveBeenCalledWith({
    server: 42,
    binding: pane.binding,
    conversation: pane.conversation,
    text: "private-example",
    enter: true,
  });
});
it("retains durable drafts for 48 hours and clears only the exact submitted draft", () => {
  localStorage.setItem("corgi-draft:test", JSON.stringify({ text: "newer edit", expires: Date.now() + 1000 }));
  clearSubmitted("corgi-draft:test", "older submission");
  expect(readDraft("corgi-draft:test")).toBe("newer edit");
  localStorage.setItem("corgi-draft:test", JSON.stringify({ text: "expired", expires: Date.now() - 1 }));
  expect(readDraft("corgi-draft:test")).toBe("");
});
it("aborts live reads in the background and opens a fresh subscription on return", async () => {
  const calls: { signal: AbortSignal; changed: (type: string, data?: Snapshot) => void }[] = [];
  const client = {
    events: vi.fn(async (signal, changed) => {
      calls.push({ signal, changed });
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }),
  } as unknown as Client;
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  function Live() {
    useLive(client);
    return null;
  }
  const { cache } = wrap(<Live />);
  await waitFor(() => expect(calls).toHaveLength(1));
  cache.setQueryData(["session"], { ...fixtures.snapshot, observed: 20 });
  calls[0].changed("session", {
    ...fixtures.snapshot,
    observed: 21,
    panes: fixtures.snapshot.panes.map(p => ({ ...p, activity: "New activity", lastResponse: undefined })),
  });
  expect(cache.getQueryData<Snapshot>(["session"])?.panes[0].lastResponse).toEqual(
    fixtures.snapshot.panes[0].lastResponse,
  );
  calls[0].changed("session", { ...fixtures.snapshot, observed: 19 });
  expect(cache.getQueryData<Snapshot>(["session"])?.observed).toBe(21);
  visibility.mockReturnValue("hidden");
  fireEvent(document, new Event("visibilitychange"));
  expect(calls[0].signal.aborted).toBe(true);
  visibility.mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1].signal.aborted).toBe(false);
});
