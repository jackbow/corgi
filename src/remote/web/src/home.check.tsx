import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Home } from "./ui";
import * as fixtures from "./fixtures";

const props = () => ({ data: fixtures.snapshot, open: vi.fn(), create: vi.fn(), settings: vi.fn() });
beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps workspace toggles independent when several groups change together", () => {
  render(<Home {...props()} />);
  act(() => {
    screen.getByRole("button", { name: "Collapse corgi" }).click();
    screen.getByRole("button", { name: "Collapse acme-ios" }).click();
  });
  expect(screen.getByRole("button", { name: "Expand corgi" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Expand acme-ios" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Collapse Experiments" })).toBeTruthy();
});

it("keeps workspace overview visible when collapsed and remembers the choice across refresh and navigation", async () => {
  const p = props(),
    { rerender, unmount } = render(<Home {...p} />);
  await userEvent.click(screen.getByRole("button", { name: "Collapse corgi" }));
  const workspace = screen.getByRole("region", { name: "corgi" });
  expect(screen.getByRole("button", { name: "Expand corgi" }).getAttribute("aria-expanded")).toBe("false");
  expect(within(workspace).queryByRole("button", { name: /Tidy up/ })).toBeNull();
  for (const text of ["3 agents", "1 needs input", "1 working", "1 ready"])
    expect(within(workspace).getByText(text)).toBeTruthy();
  const toggle = within(workspace).getByRole("button");
  expect(within(toggle).queryByRole("img", { name: "Claude" })).toBeNull();
  expect(within(toggle).queryByRole("img", { name: "Codex" })).toBeNull();
  const updated = {
    ...fixtures.snapshot,
    panes: fixtures.snapshot.panes.map(pane => (pane.id === 1 ? { ...pane, exited: true } : pane)),
  };
  rerender(<Home {...p} data={updated} />);
  expect(within(workspace).getByText("1 ended")).toBeTruthy();
  expect(within(workspace).queryByText("1 working")).toBeNull();
  expect(screen.getByRole("button", { name: "Expand corgi" })).toBeTruthy();
  unmount();
  render(<Home {...p} />);
  expect(screen.getByRole("button", { name: "Expand corgi" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Expand corgi" }));
  expect(screen.getByRole("button", { name: /Tidy up empty states/ })).toBeTruthy();
});

it("reveals matching agents while searching and restores collapsed groups when cleared", async () => {
  render(<Home {...props()} />);
  await userEvent.click(screen.getByRole("button", { name: "Collapse corgi" }));
  const search = screen.getByRole("textbox", { name: "Search agents" });
  await userEvent.type(search, "tidy-empty");
  expect(screen.getByRole("button", { name: /Tidy up empty states/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Collapse corgi" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Collapse corgi" }));
  expect(screen.queryByRole("button", { name: /Tidy up empty states/ })).toBeNull();
  await userEvent.clear(search);
  expect(screen.getByRole("button", { name: "Expand corgi" })).toBeTruthy();
  await userEvent.type(search, "Experiments");
  expect(screen.getByRole("region", { name: "Experiments" })).toBeTruthy();
  expect(screen.getByText("No agents in this workspace.")).toBeTruthy();
  expect(screen.queryByText("No matching agents")).toBeNull();
});

it("uses accessible provider artwork instead of provider text in agent rows", async () => {
  const p = props();
  render(<Home {...p} />);
  for (const [name, provider] of [
    [/Fix input overflow/, "Codex"],
    [/Tidy up empty states/, "Claude"],
  ] as const) {
    const row = screen.getByRole("button", { name });
    const icon = within(row).getByRole("img", { name: provider });
    expect(icon.querySelector("path")!.getAttribute("d")!.length).toBeGreaterThan(100);
    expect(icon.querySelector("path")!.getAttribute("fill")).toBe("currentColor");
    expect(icon.closest(".metadata")).toBeTruthy();
    expect(icon.getAttribute("width")).toBe("12");
  }
  await userEvent.click(screen.getByRole("button", { name: /Tidy up empty states/ }));
  expect(p.open).toHaveBeenCalledWith(2);
});

it("leads each agent with its current status and keeps provider identity in metadata", () => {
  const p = props(),
    { rerender } = render(<Home {...p} />);
  const working = screen.getByRole("button", { name: /Fix input overflow/ });
  const waiting = screen.getByRole("button", { name: /Tidy up empty states/ });
  const ready = screen.getByRole("button", { name: /Update icon size/ });
  expect(working.firstElementChild).toBe(within(working).getByRole("img", { name: "Working" }));
  expect(waiting.firstElementChild).toBe(within(waiting).getByRole("img", { name: "Needs input" }));
  expect(ready.firstElementChild).toBe(within(ready).getByRole("img", { name: "Ready" }));
  expect(within(working).getByRole("img", { name: "Codex" }).closest(".metadata")).toBeTruthy();
  rerender(
    <Home
      {...p}
      data={{
        ...p.data,
        panes: p.data.panes.map(pane => (pane.id === 1 ? { ...pane, exited: true, attention: "needs_input" } : pane)),
      }}
    />,
  );
  expect(working.firstElementChild).toBe(within(working).getByRole("img", { name: "Ended" }));
});

it("collapses groups even when stored preferences are malformed or unavailable", async () => {
  sessionStorage.setItem("corgi-collapsed-workspaces", "not json");
  render(<Home {...props()} />);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("Unavailable");
  });
  await userEvent.click(screen.getByRole("button", { name: "Collapse corgi" }));
  expect(screen.getByRole("button", { name: "Expand corgi" })).toBeTruthy();
});
