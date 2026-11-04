import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Messages } from "./messages";
import type { Conversation } from "./types";

let heights: Map<string, number>;
const observers = new Map<Element, () => void>();
beforeEach(() => {
  heights = new Map();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      private el?: Element;
      observe(el: Element) {
        this.el = el;
        observers.set(el, this.callback);
      }
      disconnect() {
        if (this.el) observers.delete(this.el);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return heights.get(this.dataset.messageId ?? "") ?? 80;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
});
afterEach(() => {
  cleanup();
  observers.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const conversation = (count: number): Conversation => ({
  availability: "available",
  version: "v",
  before: "v:m0",
  after: `v:m${count - 1}`,
  more: false,
  messages: Array.from({ length: count }, (_, i) => ({ id: `m${i}`, role: "assistant", text: `Message ${i}` })),
});

it("mounts a bounded viewport of a long conversation and navigates back to latest", () => {
  const { container } = render(<Messages id="large" data={conversation(10000)} />);
  expect(container.querySelectorAll("article").length).toBeLessThan(40);
  expect(screen.getByText("Message 9999")).toBeTruthy();
  expect(screen.queryByText("Message 0")).toBeNull();
  const el = screen.getByLabelText("Agent output");
  el.scrollTop = 0;
  fireEvent.scroll(el);
  expect(screen.getByText("Message 0")).toBeTruthy();
  expect(screen.queryByText("Message 9999")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
  expect(screen.getByText("Message 9999")).toBeTruthy();
  expect(container.querySelectorAll("article").length).toBeLessThan(40);
});
it("anchors a reader across appends, prepends, row resizing, and navigation", () => {
  let data = conversation(500);
  const { rerender, unmount } = render(<Messages id="anchoring" data={data} />);
  let el = screen.getByLabelText("Agent output");
  el.scrollTop = 16000;
  fireEvent.scroll(el);
  expect(screen.getByText("Message 100")).toBeTruthy();
  const top = el.scrollTop;
  data = { ...data, messages: [...data.messages, { id: "new", role: "assistant", text: "New message" }] };
  rerender(<Messages id="anchoring" data={data} />);
  expect(el.scrollTop).toBe(top);
  const row = document.querySelector('[data-message-id="m99"]')!;
  heights.set("m99", 400);
  act(() => observers.get(row)!());
  expect(el.scrollTop).toBe(top + 320);
  data = { ...data, messages: [{ id: "earlier", role: "user", text: "Earlier prompt" }, ...data.messages] };
  rerender(<Messages id="anchoring" data={data} />);
  expect(el.scrollTop).toBe(top + 320 + 160);
  expect(screen.getByText("Message 100")).toBeTruthy();
  unmount();
  render(<Messages id="anchoring" data={data} />);
  el = screen.getByLabelText("Agent output");
  expect(screen.getByText("Message 100")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();
});
it("retains expanded tool state when a row leaves and returns to the viewport", () => {
  const data = conversation(500);
  data.messages[0] = { id: "m0", role: "tool", name: "Read", text: "Tool result body" };
  render(<Messages id="tool-state" data={data} />);
  const el = screen.getByLabelText("Agent output");
  el.scrollTop = 0;
  fireEvent.scroll(el);
  const details = screen.getByText("Read").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(screen.getByText("Tool result body")).toBeTruthy();
  el.scrollTop = 16000;
  fireEvent.scroll(el);
  expect(screen.queryByText("Tool result body")).toBeNull();
  el.scrollTop = 0;
  fireEvent.scroll(el);
  expect(screen.getByText("Tool result body")).toBeTruthy();
});
