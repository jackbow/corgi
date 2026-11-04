import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { configure } from "./app";
import { phoneRouter } from "./router";
import { Agent, Composer, ScrollContent, useViewport } from "./agent";
import { Home } from "./ui";
import { spans } from "./terminal";
import * as fixtures from "./fixtures";
import { RequestError, type Client } from "./client";
import type { Conversation } from "./types";

const caches: QueryClient[] = [];
const client = (): Client => ({
  list: vi.fn(async () => fixtures.snapshot),
  conversation: vi.fn(async () => fixtures.conversation),
  terminal: vi.fn(async () => fixtures.terminal),
  history: vi.fn(async () => ({ text: "history" })),
  send: vi.fn(async () => {}),
  create: vi.fn(async () => ({ pane: 1, server: 42, binding: "11", conversation: "thread-1" })),
});
function app(api: Client, path = "/") {
  configure(api);
  const router = phoneRouter(createMemoryHistory({ initialEntries: [path] })),
    queries = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, retryDelay: 1 }, mutations: { retry: false } },
    });
  caches.push(queries);
  render(
    <QueryClientProvider client={queries}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queries };
}
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("localStorage", sessionStorage);
  document.documentElement.removeAttribute("data-pure-black");
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-pure-black");
  caches.splice(0).forEach(c => c.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

it("searches workspaces without reordering rows on activity changes", async () => {
  const open = vi.fn(),
    props = { data: fixtures.snapshot, open, create: vi.fn(), settings: vi.fn() };
  const { rerender } = render(<Home {...props} />);
  const names = () =>
    screen
      .getAllByRole("button")
      .filter(b => b.classList.contains("agent-row"))
      .map(b => b.textContent);
  const original = names().map(n => n?.slice(0, 20));
  rerender(
    <Home
      {...props}
      data={{ ...fixtures.snapshot, panes: fixtures.snapshot.panes.map(p => ({ ...p, state: "idle" })) }}
    />,
  );
  expect(names().map(n => n?.slice(0, 20))).toEqual(original);
  await userEvent.type(screen.getByRole("textbox", { name: "Search agents" }), "tidy-empty");
  expect(screen.getByText("Tidy up empty states")).toBeTruthy();
  expect(screen.queryByText("Update icon size")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /Tidy up empty states/ }));
  expect(open).toHaveBeenCalledWith(2);
});
it("keeps per-conversation drafts, sends Enter explicitly, and never retries uncertain sends", async () => {
  const send = vi.fn(async () => {}),
    pane = fixtures.snapshot.panes[0];
  const { rerender } = render(<Composer key="a" pane={pane} server={42} send={send} />);
  await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "hello{Enter}world");
  expect(send).not.toHaveBeenCalled();
  rerender(<Composer key="b" pane={fixtures.snapshot.panes[1]} server={42} send={send} />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  rerender(<Composer key="a" pane={pane} server={42} send={send} />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("hello\nworld");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(send).toHaveBeenCalledWith({
    server: 42,
    binding: "11",
    conversation: "thread-1",
    text: "hello\nworld",
    enter: true,
  });
  await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""));
  send.mockRejectedValueOnce(Error("timeout"));
  await userEvent.type(screen.getByRole("textbox"), "uncertain");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText(/Send not confirmed/);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("uncertain");
  expect(send).toHaveBeenCalledTimes(2);
  rerender(<Composer key="changed" pane={{ ...pane, conversation: "new" }} server={42} send={send} />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
});
it("does not clear text edited during delivery and disables duplicate sends", async () => {
  const pending = deferred<void>(),
    send = vi.fn(() => pending.promise);
  render(<Composer pane={fixtures.snapshot.panes[0]} server={42} send={send} />);
  const text = screen.getByRole("textbox");
  await userEvent.type(text, "first");
  fireEvent.submit(text.closest("form")!);
  fireEvent.submit(text.closest("form")!);
  expect(send).toHaveBeenCalledTimes(1);
  await userEvent.type(text, " changed");
  await act(async () => pending.resolve());
  expect((text as HTMLTextAreaElement).value).toBe("first changed");
  await userEvent.click(screen.getByLabelText("Message options"));
  await userEvent.click(screen.getByRole("button", { name: "Paste without Enter" }));
  expect(send.mock.calls[1]).toEqual([
    { server: 42, binding: "11", conversation: "thread-1", text: "first changed", enter: false },
  ]);
  expect(screen.getByLabelText("Message options").closest("details")!.open).toBe(false);
});
it("keeps the compact composer options out of the way and closes them without sending", async () => {
  const send = vi.fn(async () => {});
  render(<Composer pane={fixtures.snapshot.panes[0]} server={42} send={send} />);
  const text = screen.getByRole("textbox") as HTMLTextAreaElement,
    options = screen.getByLabelText("Message options"),
    details = options.closest("details")!;
  expect(text.getAttribute("rows")).toBe("1");
  expect(details.open).toBe(false);
  await userEvent.type(text, "draft\nnext line");
  await userEvent.click(options);
  expect(details.open).toBe(true);
  await userEvent.keyboard("{Escape}");
  expect(details.open).toBe(false);
  expect(document.activeElement).toBe(options);
  await userEvent.click(options);
  await userEvent.click(text);
  expect(details.open).toBe(false);
  expect(text.value).toBe("draft\nnext line");
  expect(send).not.toHaveBeenCalled();
});
it("navigates with deep links and discards delayed output when switching agents", async () => {
  const api = client(),
    pending = deferred<Conversation>();
  api.conversation = vi.fn<Client["conversation"]>((id, _q, _c, _d, signal) =>
    id === 1
      ? new Promise<Conversation>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          void pending.promise.then(resolve);
        })
      : Promise.resolve({
          ...fixtures.conversation,
          messages: [{ id: "other", role: "assistant", text: "Second agent only" }],
        }),
  );
  const { router } = app(api, "/agents/1");
  await screen.findByText(fixtures.snapshot.panes[0].name);
  await act(async () => {
    await router.navigate({ to: "/agents/$pane", params: { pane: "2" }, search: { view: "conversation" } });
  });
  await screen.findByText("Second agent only");
  await act(async () =>
    pending.resolve({ ...fixtures.conversation, messages: [{ id: "stale", role: "assistant", text: "Stale output" }] }),
  );
  expect(screen.queryByText("Stale output")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Needs input → Terminal" }));
  await screen.findByLabelText("Terminal surface");
  await userEvent.click(screen.getByRole("button", { name: "Send ctrl+c" }));
  expect(api.send).toHaveBeenCalledWith(2, { server: 42, binding: "12", conversation: "thread-2", key: "ctrl+c" });
});
it("refreshes reads on resume and does not poll while hidden", async () => {
  const api = client();
  app(api);
  await screen.findByText("Update icon size");
  const calls = vi.mocked(api.list).mock.calls.length;
  act(() => focusManager.setFocused(false));
  await new Promise(resolve => setTimeout(resolve, 2100));
  expect(api.list).toHaveBeenCalledTimes(calls);
  act(() => focusManager.setFocused(true));
  await waitFor(() => expect(vi.mocked(api.list).mock.calls.length).toBeGreaterThan(calls));
});
it("launches only the chosen provider/workspace and makes uncertain launches reviewable", async () => {
  const api = client();
  vi.mocked(api.create).mockRejectedValueOnce(Error("timeout"));
  app(api, "/new");
  await screen.findByRole("option", { name: "acme-ios" });
  await userEvent.selectOptions(screen.getByRole("combobox"), "2");
  await userEvent.click(screen.getByRole("radio", { name: "Claude" }));
  await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
  await screen.findByText(/Launch not confirmed/);
  expect(api.create).toHaveBeenCalledExactlyOnceWith({ server: 42, workspace: 2, provider: "claude" });
  expect((screen.getByRole("button", { name: "Start agent" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Check agents" }));
  await screen.findByText("Update icon size");
  expect(api.create).toHaveBeenCalledTimes(1);
});
it("navigates to the created pane without sending an initial prompt", async () => {
  const api = client();
  app(api, "/new");
  await screen.findByRole("option", { name: "corgi" });
  await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
  await screen.findByRole("tab", { name: "Conversation" });
  expect(api.send).not.toHaveBeenCalled();
});
it("renders Markdown safely and terminal SGR as selectable spans", () => {
  const props = {
    pane: fixtures.snapshot.panes[0],
    server: 42,
    back: vi.fn(),
    send: vi.fn(),
    mode: "conversation" as const,
    setMode: vi.fn(),
    terminalKey: vi.fn(),
    keyPending: false,
    keyStatus: "",
  };
  const { container } = render(
    <Agent
      {...props}
      data={{
        ...fixtures.conversation,
        messages: [
          { id: "x", role: "assistant", text: "<script>alert(1)</script>\n\n**Safe** [bad](javascript:alert(1))" },
        ],
      }}
    />,
  );
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("Safe").tagName).toBe("STRONG");
  expect(container.querySelector("a")?.getAttribute("href")).not.toContain("javascript");
  expect(spans("\x1b[1;38;2;12;34;56mHello\x1b[0m world\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\x1b[2J")).toEqual([
    { text: "Hello", style: { fontWeight: 700, color: "rgb(12,34,56)" } },
    { text: " world", style: {} },
    { text: "link", style: {} },
  ]);
});
it("preserves a reader's scroll and exposes jump to latest", () => {
  const { rerender } = render(
    <ScrollContent id="scroll-test" revision={1}>
      <div data-first="1">one</div>
    </ScrollContent>,
  );
  const el = screen.getByLabelText("Agent output");
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
  });
  el.scrollTop = 120;
  fireEvent.scroll(el);
  rerender(
    <ScrollContent id="scroll-test" revision={2}>
      <div data-first="1">one two</div>
    </ScrollContent>,
  );
  expect(el.scrollTop).toBe(120);
  fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
  expect(el.scrollTop).toBe(1000);
});

it("retains edits made after leaving and returning to a pane during a send", async () => {
  const api = client(),
    pending = deferred<void>();
  vi.mocked(api.send).mockImplementation(() => pending.promise);
  const { router } = app(api, "/agents/1");
  await screen.findByRole("textbox", { name: "Message" });
  await userEvent.type(screen.getByRole("textbox"), "submitted");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await userEvent.click(screen.getByRole("button", { name: "Back to agents" }));
  await screen.findByText("Update icon size");
  await act(async () => {
    await router.navigate({ to: "/agents/$pane", params: { pane: "1" }, search: { view: "conversation" } });
  });
  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(screen.getByRole("textbox"), " edited");
  await act(async () => pending.resolve());
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("submitted edited");
  expect(api.send).toHaveBeenCalledTimes(1);
});
it("replaces the recent window when the active conversation branch changes", async () => {
  const api = client();
  let read = 0;
  api.conversation = vi.fn<Client["conversation"]>(async () => {
    read++;
    if (read === 1)
      return {
        ...fixtures.conversation,
        messages: [{ id: "old", role: "assistant", text: "Abandoned branch" }],
        after: "fixture:old",
      };
    return {
      ...fixtures.conversation,
      messages: [{ id: "new", role: "assistant", text: "Active branch" }],
      after: "fixture:new",
    };
  });
  const { queries } = app(api, "/agents/1");
  await screen.findByText("Abandoned branch");
  await act(async () => {
    await queries.invalidateQueries({ queryKey: ["conversation"] });
  });
  await screen.findByText("Active branch");
  expect(screen.queryByText("Abandoned branch")).toBeNull();
});
it("shows only the latest window, refreshes amendments, and offers no history loading", async () => {
  const api = client();
  let reads = 0;
  const messages: Conversation["messages"] = Array.from({ length: 9 }, (_, i) => ({
    id: String(i),
    role: "user",
    text: "Prompt " + i,
  }));
  api.conversation = vi.fn<Client["conversation"]>(async () => {
    reads++;
    const current: Conversation["messages"][number] = {
      id: "current",
      role: "assistant",
      text: reads === 1 ? "Initial" : "Amended",
    };
    return {
      ...fixtures.conversation,
      messages:
        reads === 1
          ? [...messages, current]
          : [...messages.slice(1), current, { id: "new", role: "assistant", text: "Latest reply" }],
      before: "fixture:current",
      after: "fixture:current",
    };
  });
  const { queries } = app(api, "/agents/1");
  await screen.findByText("Initial");
  expect(screen.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
  await act(async () => {
    await queries.invalidateQueries({ queryKey: ["conversation"] });
  });
  await screen.findByText("Amended");
  await screen.findByText("Latest reply");
  expect(screen.queryByText("Initial")).toBeNull();
  expect(screen.getAllByText("Amended")).toHaveLength(1);
  const data = queries.getQueriesData<Conversation>({ queryKey: ["conversation"] })[0][1]!;
  expect(data.messages).toHaveLength(10);
  expect(data.messages[0].id).toBe("1");
  for (const call of vi.mocked(api.conversation).mock.calls) {
    expect(call[2]).toBe("");
    expect(call[3]).toBe("before");
  }
});

it("restores terminal attributes, indexed colors, and inverse colors", () => {
  const result = spans("\x1b[38:2::12:34:56;48;5;196;3;4mstyled\x1b[7mreverse\x1b[27;23;24mrestored\x1b[0mplain");
  expect(result[0].style).toEqual({
    color: "rgb(12,34,56)",
    backgroundColor: "rgb(255,0,0)",
    fontStyle: "italic",
    textDecoration: "underline",
  });
  expect(result[1].style.color).toBe("rgb(255,0,0)");
  expect(result[1].style.backgroundColor).toBe("rgb(12,34,56)");
  expect(result[2].style).toEqual({ color: "rgb(12,34,56)", backgroundColor: "rgb(255,0,0)" });
  expect(result[3].style).toEqual({});
  expect(
    spans("\x1b[2J\x1b[Htext\x1b[58;2;1;2;3mignored")
      .map(s => s.text)
      .join(""),
  ).toBe("textignored");
});
it("updates the viewport on keyboard resize and removes viewport listeners", () => {
  const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number };
  viewport.height = 600;
  viewport.offsetTop = 0;
  vi.stubGlobal("visualViewport", viewport);
  function Viewport() {
    useViewport();
    return null;
  }
  render(<Viewport />);
  expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("600px");
  viewport.height = 340;
  viewport.offsetTop = 24;
  act(() => {
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("340px");
  expect(document.documentElement.style.getPropertyValue("--viewport-top")).toBe("24px");
  cleanup();
  viewport.height = 200;
  viewport.dispatchEvent(new Event("resize"));
  expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("340px");
  vi.unstubAllGlobals();
});
it("returns revoked phones to enrollment without showing cached agent output", async () => {
  const { RequestError } = await import("./client");
  const api = client(),
    { queries } = app(api, "/agents/1");
  await screen.findByText("Assistant");
  vi.mocked(api.list).mockRejectedValue(new RequestError(401, "Unauthorized"));
  await act(async () => {
    await queries.invalidateQueries({ queryKey: ["session"] });
  });
  await screen.findByText("Pair this phone");
  expect(screen.queryByText("Assistant")).toBeNull();
});

it("keeps enrollment and its draft stable without retrying an unauthorized session", async () => {
  const api = client();
  vi.mocked(api.list).mockRejectedValue(new RequestError(401, "Pair this phone"));
  app(api);
  await screen.findByText("Pair this phone");
  const name = screen.getByRole("textbox", { name: "Phone name" }),
    link = screen.getByRole("textbox", { name: "Pairing link" });
  await userEvent.clear(name);
  await userEvent.type(name, "Home Screen");
  await userEvent.type(link, `${location.origin}/#pair=${"a".repeat(43)}`);
  await act(async () => {
    focusManager.setFocused(false);
    onlineManager.setOnline(false);
    focusManager.setFocused(true);
    onlineManager.setOnline(true);
    await new Promise(resolve => setTimeout(resolve, 2200));
  });
  expect(api.list).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Connecting…")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Phone name" })).toBe(name);
  expect((name as HTMLInputElement).value).toBe("Home Screen");
  expect((link as HTMLInputElement).value).toContain("#pair=");
});

it("claims a pasted pairing link and keeps approval visible while the session is unauthorized", async () => {
  const api = client(),
    token = "a".repeat(43),
    fetch = vi.fn(async (path: string, _init?: RequestInit) =>
      Response.json(path === "/api/pair" ? { claim: "claim", code: "123456" } : { state: "pending" }),
    );
  vi.mocked(api.list).mockRejectedValue(new RequestError(401, "Pair this phone"));
  vi.stubGlobal("fetch", fetch);
  const { queries } = app(api);
  await screen.findByText("Pair this phone");
  await userEvent.type(screen.getByRole("textbox", { name: "Pairing link" }), `${location.origin}/#pair=${token}`);
  await userEvent.click(screen.getByRole("button", { name: "Pair phone" }));
  await screen.findByText("123456");
  expect(JSON.parse(fetch.mock.calls.find(([path]) => path === "/api/pair")![1]!.body as string)).toMatchObject({
    token,
    name: "My phone",
  });
  await act(async () => {
    await queries.invalidateQueries({ queryKey: ["session"] });
  });
  expect(screen.getByText("Waiting for approval…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Pair phone" })).toBeNull();
  vi.mocked(api.list).mockResolvedValue(fixtures.snapshot);
  await act(async () => {
    await queries.invalidateQueries({ queryKey: ["session"] });
  });
  await screen.findByRole("textbox", { name: "Search agents" });
});

it.each([
  `https://other-mac.example/#pair=${"a".repeat(43)}`,
  `${location.origin}/#pair=too-short`,
  `${location.origin}/`,
  "not a URL",
])("rejects an invalid pairing link without claiming: %s", async link => {
  const api = client(),
    fetch = vi.fn();
  vi.mocked(api.list).mockRejectedValue(new RequestError(401, "Pair this phone"));
  vi.stubGlobal("fetch", fetch);
  app(api);
  await screen.findByText("Pair this phone");
  await userEvent.type(screen.getByRole("textbox", { name: "Pairing link" }), link);
  fireEvent.submit(screen.getByRole("button", { name: "Pair phone" }).closest("form")!);
  await screen.findByRole("alert");
  expect(fetch).not.toHaveBeenCalled();
  expect((screen.getByRole("textbox", { name: "Pairing link" }) as HTMLInputElement).value).toBe(link);
  expect((screen.getByRole("button", { name: "Pair phone" }) as HTMLButtonElement).disabled).toBe(false);
});

it("keeps existing messages visible during incremental indexing and replaces a new transcript cleanly", async () => {
  const api = client();
  let reads = 0;
  api.conversation = vi.fn<Client["conversation"]>(async () => {
    reads++;
    if (reads === 1)
      return { ...fixtures.conversation, messages: [{ id: "first", role: "assistant", text: "Existing history" }] };
    if (reads === 2)
      return { ...fixtures.conversation, availability: "indexing", messages: [], progress: { read: 10, total: 100 } };
    if (reads === 3)
      return {
        ...fixtures.conversation,
        version: "replacement",
        availability: "indexing",
        messages: [],
        progress: { read: 20, total: 100 },
      };
    return {
      ...fixtures.conversation,
      version: "replacement",
      messages: [{ id: "new", role: "assistant", text: "Replacement history" }],
    };
  });
  const { queries } = app(api, "/agents/1");
  await screen.findByText("Existing history");
  await act(async () => {
    await queries.invalidateQueries({ queryKey: ["conversation"] });
  });
  expect(screen.getByText("Existing history")).toBeTruthy();
  await screen.findByText("Updating conversation…");
  await act(async () => {
    await queries.invalidateQueries({ queryKey: ["conversation"] });
  });
  await screen.findByText(/Indexing history: 20%/);
  expect(screen.queryByText("Existing history")).toBeNull();
  await act(async () => {
    await queries.invalidateQueries({ queryKey: ["conversation"] });
  });
  await screen.findByText("Replacement history");
});

it("toggles pure black in Settings and remembers it across navigation", async () => {
  const { router } = app(client(), "/settings");
  const toggle = await screen.findByRole("switch", { name: "Pure black" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(toggle);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(window.localStorage.getItem("corgi-pure-black")).toBe("off");
  expect(document.documentElement.hasAttribute("data-pure-black")).toBe(false);
  await act(async () => {
    await router.navigate({ to: "/" });
  });
  await act(async () => {
    await router.navigate({ to: "/settings" });
  });
  const restored = await screen.findByRole("switch", { name: "Pure black" });
  expect(restored.getAttribute("aria-checked")).toBe("false");
  await userEvent.click(restored);
  expect(window.localStorage.getItem("corgi-pure-black")).toBe("on");
  expect(document.documentElement.hasAttribute("data-pure-black")).toBe(true);
});

it("opens matching notification links and rejects links to a reused pane", async () => {
  const identity = JSON.stringify([42, 1, "11", "thread-1"]);
  const { router } = app(client(), `/agents/1?view=terminal&notification=${encodeURIComponent(identity)}`);
  await screen.findByText("Allow this command?");
  await act(async () => {
    await router.navigate({
      to: "/agents/$pane",
      params: { pane: "1" },
      search: { view: "conversation", notification: JSON.stringify([42, 1, "old", "old"]) },
    });
  });
  await screen.findByText("Agent no longer available");
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
});
