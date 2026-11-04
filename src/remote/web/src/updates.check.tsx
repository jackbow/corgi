import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MacUpdates } from "./updates";
const caches: QueryClient[] = [];
afterEach(() => {
  cleanup();
  caches.splice(0).forEach(c => c.clear());
});
it("requires confirmation and never retries an uncertain Mac update", async () => {
  const request = vi.fn(async (_path: string, body?: unknown) => {
    if (body) throw Error("timeout");
    return { phase: "idle", server: 42, message: "Signed releases" };
  });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  caches.push(cache);
  render(
    <QueryClientProvider client={cache}>
      <MacUpdates request={request as never} />
    </QueryClientProvider>,
  );
  await screen.findByText("Signed releases");
  await userEvent.click(screen.getByRole("button", { name: "Update Mac Corgi" }));
  expect(request.mock.calls.filter(c => c[1])).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Confirm update" }));
  await screen.findByRole("alert");
  expect(request.mock.calls.filter(c => c[1])).toEqual([["/api/update", { server: 42, confirm: true }]]);
  expect((screen.getByRole("button", { name: "Update Mac Corgi" }) as HTMLButtonElement).disabled).toBe(true);
});
