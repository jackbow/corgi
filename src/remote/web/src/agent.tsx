import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowDown, ArrowUp, Ellipsis } from "lucide-react";
import { Back, Button, Empty, Status } from "./ui";
import { spans } from "./terminal";
import { Messages } from "./messages";
import type { Conversation, Identity, Pane, Terminal } from "./types";
import { clearSubmitted, useDraft } from "./drafts";
import type { Command } from "../../types";
import { useWakeLock } from "./playback";

export const identityKey = (pane: Pane, server: number) => `${server}:${pane.id}:${pane.binding}:${pane.conversation}`;
const positions = new Map<string, { top: number; left: number; follow: boolean }>();
export function ScrollContent({ id, children, revision }: { id: string; children: ReactNode; revision: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(positions.get(id)?.follow ?? true);
  const prior = useRef({ height: 0, first: "" });
  useLayoutEffect(() => {
    const el = ref.current!,
      p = positions.get(id);
    if (p && !p.follow) {
      el.scrollTop = p.top;
      el.scrollLeft = p.left;
    } else el.scrollTop = el.scrollHeight;
    setFollow(p?.follow ?? true);
    return () => {
      positions.set(id, {
        top: el.scrollTop,
        left: el.scrollLeft,
        follow: el.scrollHeight - el.scrollTop - el.clientHeight < 40,
      });
    };
  }, [id]);
  useLayoutEffect(() => {
    const el = ref.current!,
      p = positions.get(id);
    if (p?.follow !== false) el.scrollTop = el.scrollHeight;
    // When older messages are prepended, retain the first visible message.
    else if (el.firstElementChild?.getAttribute("data-first") !== prior.current.first && prior.current.height)
      el.scrollTop += el.scrollHeight - prior.current.height;
    prior.current = { height: el.scrollHeight, first: el.firstElementChild?.getAttribute("data-first") ?? "" };
  }, [revision]);
  return (
    <div className="content-wrap">
      <div
        className="scroll agent-content"
        ref={ref}
        tabIndex={0}
        aria-label="Agent output"
        onScroll={() => {
          const el = ref.current!,
            next = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          positions.set(id, { top: el.scrollTop, left: el.scrollLeft, follow: next });
          setFollow(next);
        }}
      >
        {children}
      </div>
      {!follow && (
        <Button
          className="jump"
          onClick={() => {
            const el = ref.current!;
            el.scrollTop = el.scrollHeight;
            positions.set(id, { top: el.scrollTop, left: el.scrollLeft, follow: true });
            setFollow(true);
          }}
        >
          <ArrowDown size={16} />
          Jump to latest
        </Button>
      )}
    </div>
  );
}
export function Composer({
  pane,
  server,
  send,
  disabled = false,
  readOnly = false,
  commands = [],
}: {
  pane: Pane;
  server: number;
  send: (body: Identity & { text?: string; enter?: boolean; key?: string }) => Promise<void>;
  disabled?: boolean;
  readOnly?: boolean;
  commands?: Command[];
}) {
  const key = `corgi-draft:${identityKey(pane, server)}`;
  const [savedDraft, saveDraft] = useDraft(key),
    [pending, setPending] = useState(false),
    [delivery, setDelivery] = useState("");
  const [sensitive, setSensitive] = useState(false),
    [secret, setSecret] = useState("");
  const draft = sensitive ? secret : savedDraft,
    save = sensitive ? setSecret : saveDraft;
  const busy = useRef(false),
    textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = textarea.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [draft, sensitive]);
  async function submit(body: { text?: string; enter?: boolean; key?: string }) {
    if (busy.current || disabled || readOnly || pane.exited || body.text === "") return;
    busy.current = true;
    setPending(true);
    setDelivery("");
    try {
      await send({ server, binding: pane.binding, conversation: pane.conversation, ...body });
      if (body.text !== undefined) {
        if (sensitive) setSecret(prior => (prior === body.text ? "" : prior));
        else clearSubmitted(key, body.text);
      }
      setDelivery(body.key ? "Key sent" : body.enter ? "Sent" : "Pasted without Enter");
    } catch {
      setDelivery("Send not confirmed. Check the output before retrying.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <footer className="composer">
      <form
        onSubmit={e => {
          e.preventDefault();
          void submit({ text: draft, enter: true });
        }}
      >
        <label className="sr-only" htmlFor="message">
          Message
        </label>
        {sensitive ? (
          <input
            id="message"
            className="sensitive-input"
            type="password"
            value={secret}
            onChange={e => setSecret(e.target.value)}
            placeholder="Sensitive input · not saved"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={8192}
            disabled={pane.exited || readOnly}
          />
        ) : (
          <textarea
            id="message"
            aria-describedby="message-hint"
            ref={textarea}
            placeholder={readOnly ? "Read-only device" : pane.exited ? "This agent has ended" : "Message this agent…"}
            value={draft}
            onChange={e => save(e.target.value)}
            rows={1}
            maxLength={8192}
            disabled={pane.exited || readOnly}
          />
        )}
        <div className="composer-actions">
          <details
            className="composer-options"
            onBlur={e => {
              if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false;
            }}
            onKeyDown={e => {
              if (e.key === "Escape") {
                e.currentTarget.open = false;
                e.currentTarget.querySelector("summary")?.focus();
              }
            }}
          >
            <summary aria-label="Message options" title="Message options" tabIndex={0}>
              <Ellipsis size={18} />
            </summary>
            <div className="composer-menu">
              <Button
                type="button"
                variant="ghost"
                disabled={pending || readOnly || pane.exited}
                onClick={e => {
                  e.currentTarget.closest("details")!.open = false;
                  setSensitive(!sensitive);
                  setSecret("");
                }}
              >
                {sensitive ? "Use normal message input" : "Sensitive input (not saved)"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={pending || disabled || readOnly || pane.exited || !draft}
                onClick={e => {
                  e.currentTarget.closest("details")!.open = false;
                  void submit({ text: draft, enter: false });
                }}
              >
                Paste without Enter
              </Button>
            </div>
          </details>
          <Button
            variant="primary"
            aria-label="Send message"
            title={pending ? "Sending…" : "Send message"}
            aria-busy={pending}
            disabled={pending || disabled || readOnly || pane.exited || !draft.trim()}
          >
            <ArrowUp size={18} />
          </Button>
        </div>
      </form>
      {!readOnly &&
        !sensitive &&
        (draft.startsWith("/") || draft.startsWith("$")) &&
        !draft.includes(" ") &&
        commands.length > 0 && (
          <div className="command-suggestions" aria-label="Commands and skills">
            {commands
              .filter(c => c.text.startsWith(draft))
              .slice(0, 8)
              .map(c => (
                <Button
                  type="button"
                  key={c.text}
                  onClick={() => {
                    save(c.text + " ");
                    textarea.current?.focus();
                  }}
                >
                  <strong>{c.text}</strong>
                  <span className="truncate muted">{c.description}</span>
                </Button>
              ))}
          </div>
        )}
      <p id="message-hint" className="sr-only">
        Return adds a new line · Send presses Enter
      </p>
      <p className={delivery ? "delivery" : "sr-only"} role="status">
        {delivery}
      </p>
    </footer>
  );
}
export function Agent({
  pane,
  server,
  data,
  surface,
  history,
  back,
  send,
  mode,
  setMode,
  error,
  terminalKey,
  keyPending,
  keyStatus,
  readOnly = false,
  controls,
  commands,
  historyLines = 300,
  setHistoryLines,
}: {
  pane: Pane;
  server: number;
  data?: Conversation;
  surface?: Terminal;
  history?: string;
  back: () => void;
  send: Parameters<typeof Composer>[0]["send"];
  mode: "conversation" | "terminal";
  setMode: (mode: "conversation" | "terminal") => void;
  error?: string;
  terminalKey: (key: string) => void;
  keyPending: boolean;
  keyStatus: string;
  readOnly?: boolean;
  controls?: ReactNode;
  commands?: Command[];
  historyLines?: number;
  setHistoryLines?: (value: number) => void;
}) {
  const [historySearch, setHistorySearch] = useState("");
  useWakeLock(mode === "terminal");
  const key = identityKey(pane, server),
    needsInput = pane.attention === "needs_input" || pane.state === "blocked";
  return (
    <>
      <header className="header agent-header">
        <Back go={back} />
        <div className="title">
          <h1>{pane.name}</h1>
          <p className="metadata">
            {pane.provider === "claude" ? "Claude" : "Codex"}
            {pane.branch && ` · ${pane.branch}`}
          </p>
        </div>
        <Status pane={pane} />
      </header>
      <Tabs.Root value={mode} onValueChange={v => setMode(v as typeof mode)} className="agent-tabs" asChild>
        <main>
          <Tabs.List aria-label="Agent view" className="tabs">
            <Tabs.Trigger value="conversation">Conversation</Tabs.Trigger>
            <Tabs.Trigger value="terminal">Terminal</Tabs.Trigger>
          </Tabs.List>
          {needsInput && mode !== "terminal" && (
            <div className="activity-strip">
              <Button variant="ghost" onClick={() => setMode("terminal")}>
                Needs input → Terminal
              </Button>
            </div>
          )}
          {error && (
            <p className="notice" role="status">
              {error}
            </p>
          )}
          {controls}
          <Tabs.Content value="conversation" className="tab-panel">
            {data?.availability === "available" && data.messages.length && !pane.exited ? (
              <Messages key={`${key}:${data.version}`} id={`${key}:${data.version}`} data={data} />
            ) : (
              <ScrollContent id={`${key}:conversation`} revision={data}>
                {pane.exited ? (
                  <Empty title="This agent has ended" text="Return to your workspaces to choose another agent." />
                ) : !data && error ? (
                  <div className="empty">
                    <h2>Conversation unavailable</h2>
                    <p>Reconnect or try the terminal view.</p>
                    <Button onClick={() => setMode("terminal")}>Open Terminal</Button>
                  </div>
                ) : !data ? (
                  <Empty title="Reading conversation…" text="Checking the current transcript on your Mac." />
                ) : data.availability !== "available" ? (
                  <div className="empty">
                    <h2>{data.availability === "indexing" ? "Reading conversation…" : "Conversation unavailable"}</h2>
                    <p>
                      {data.availability === "indexing"
                        ? "Reading recent messages on your Mac. You can use Terminal while it loads."
                        : "Read and interact with this agent in Terminal."}
                    </p>
                    <Button onClick={() => setMode("terminal")}>Open Terminal</Button>
                  </div>
                ) : (
                  <Empty title="No messages yet" text="Send the first instruction below." />
                )}
              </ScrollContent>
            )}
          </Tabs.Content>
          <Tabs.Content value="terminal" className="tab-panel">
            <ScrollContent id={`${key}:terminal`} revision={surface}>
              <div className="terminal-region">
                {surface ? (
                  <pre aria-label="Terminal surface">
                    {surface.lines.map((line, i) => (
                      <div key={i}>
                        {spans(line).map((s, j) => (
                          <span style={s.style} key={j}>
                            {s.text}
                          </span>
                        ))}
                        {"\n"}
                      </div>
                    ))}
                  </pre>
                ) : (
                  <p className="muted">
                    {pane.exited
                      ? "This agent has ended."
                      : error
                        ? "Terminal unavailable. Reconnect or return to agents."
                        : "Reading terminal…"}
                  </p>
                )}
              </div>
              {history !== undefined && (
                <details className="history">
                  <summary>Recent plain-text history</summary>
                  {setHistoryLines && (
                    <label>
                      History lines
                      <select value={historyLines} onChange={e => setHistoryLines(Number(e.target.value))}>
                        {[100, 300, 500, 1000, 10000].map(n => (
                          <option key={n} value={n}>
                            {n.toLocaleString()}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Find in terminal history
                    <input type="search" value={historySearch} onChange={e => setHistorySearch(e.target.value)} />
                  </label>
                  <pre>
                    {historySearch
                      ? history
                          .split("\n")
                          .filter(line => line.toLowerCase().includes(historySearch.toLowerCase()))
                          .join("\n") || "No matching lines"
                      : history}
                  </pre>
                </details>
              )}
            </ScrollContent>
            <nav className="key-toolbar" aria-label="Terminal keys">
              {[
                ["enter", "Enter"],
                ["escape", "Esc"],
                ["tab", "Tab"],
                ["up", "↑"],
                ["down", "↓"],
                ["left", "←"],
                ["right", "→"],
                ["ctrl+c", "Ctrl+C"],
              ].map(([key, label]) => (
                <Button
                  key={key}
                  aria-label={`Send ${key}`}
                  disabled={keyPending || pane.exited || readOnly}
                  onClick={() => terminalKey(key)}
                >
                  {label}
                </Button>
              ))}
            </nav>
            <label className="extra-keys">
              More keys
              <select
                aria-label="Additional terminal key"
                defaultValue=""
                disabled={keyPending || pane.exited || readOnly}
                onChange={e => {
                  if (e.target.value) terminalKey(e.target.value);
                  e.target.value = "";
                }}
              >
                <option value="">Choose a key…</option>
                {[
                  "shift+tab",
                  "home",
                  "end",
                  "pageup",
                  "pagedown",
                  "backspace",
                  "delete",
                  ...Array.from({ length: 26 }, (_, i) => `ctrl+${String.fromCharCode(97 + i)}`),
                  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
                ].map(k => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <p className="delivery" role="status">
              {keyStatus}
            </p>
          </Tabs.Content>
        </main>
      </Tabs.Root>
      <Composer
        key={key}
        pane={pane}
        server={server}
        send={send}
        disabled={keyPending}
        readOnly={readOnly}
        commands={commands}
      />
    </>
  );
}
export function useViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      document.documentElement.style.setProperty("--viewport-height", `${viewport?.height ?? window.innerHeight}px`);
      document.documentElement.style.setProperty("--viewport-top", `${viewport?.offsetTop ?? 0}px`);
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
}
