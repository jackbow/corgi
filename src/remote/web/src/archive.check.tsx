import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArchiveBrowser } from "./archive";
import type { Client } from "./client";
import type { Conversation } from "./types";
const caches: QueryClient[] = [];
let sequence = 0;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
});
afterEach(() => {
  cleanup();
  caches.splice(0).forEach(c => c.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(archive: NonNullable<Client["archive"]>) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  caches.push(cache);
  render(
    <QueryClientProvider client={cache}>
      <ArchiveBrowser
        client={{ archive } as Client}
        pane={2}
        identity={{ server: 42, binding: "3", conversation: "thread" }}
        id={`history-test-${sequence++}`}
        close={vi.fn()}
      />
    </QueryClientProvider>,
  );
}
const page = (start: number, next: string | null): Conversation => ({
  availability: "available",
  version: "v",
  messages: Array.from({ length: 20 }, (_, i) => ({
    id: `m${start + i}`,
    role: "assistant",
    text: `Response ${start + i}`,
  })),
  before: next,
  after: null,
  more: !!next,
});
it("loads earlier pages on upward scroll without a load-earlier button", async () => {
  const archive = vi.fn(async (_pane, _identity, cursor) => (cursor ? page(0, null) : page(20, "older")));
  mount(archive);
  await screen.findByText("Response 39");
  expect(screen.queryByRole("button", { name: /Load earlier/i })).toBeNull();
  const output = screen.getByLabelText("Agent output");
  output.scrollTop = 0;
  fireEvent.scroll(output);
  await waitFor(() => expect(archive).toHaveBeenCalledTimes(2));
  expect(archive.mock.calls[1][2]).toBe("older");
  await screen.findByText("Beginning of available history.");
});
it("searches older pages only when requested and stops after another match", async () => {
  const archive = vi.fn(async (_pane, _identity, cursor) =>
    cursor === "last" ? page(0, null) : cursor === "older" ? page(20, "last") : page(40, "older"),
  );
  mount(archive);
  await screen.findByText("Response 59");
  await userEvent.type(screen.getByRole("searchbox"), "Response 2");
  expect(archive).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Search older" }));
  await waitFor(() => expect(archive).toHaveBeenCalledTimes(2));
  await screen.findByRole("button", { name: "Search older" });
  expect(archive).toHaveBeenCalledTimes(2);
});
