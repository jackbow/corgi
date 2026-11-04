import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, ArrowUp, ChevronDown, TerminalSquare } from "lucide-react";
import { Back, Button, Empty, Status } from "./ui";
import { spans } from "./terminal";
import type { Conversation, Identity, Pane, Terminal } from "./types";
import { clearSubmitted, useDraft } from "./drafts";

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
function Messages({ data, older, pending }: { data: Conversation; older?: () => void; pending?: boolean }) {
  return (
    <div className="messages" data-first={data.messages[0]?.id}>
      {data.before && (
        <Button className="older" onClick={older} disabled={pending}>
          Load earlier messages
        </Button>
      )}
      {data.messages.map(m =>
        m.role === "tool" ? (
          <details className="tool" key={m.id}>
            <summary>
              <TerminalSquare size={14} />
              {m.name || "Tool activity"}
              <ChevronDown size={14} />
            </summary>
            <pre>{m.text}</pre>
            {m.truncated && <p className="muted">Output shortened. Full output is available on your Mac.</p>}
          </details>
        ) : (
          <article className={`message ${m.role}`} key={m.id}>
            <span className="message-label">{m.role === "user" ? "You" : "Assistant"}</span>
            <Markdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                a: ({ children, ...props }) => (
                  <a {...props} target="_blank" rel="noreferrer noopener">
                    {children}
                  </a>
                ),
              }}
            >
              {m.text}
            </Markdown>
            {m.truncated && <p className="muted">Message shortened. Continue in Terminal.</p>}
          </article>
        ),
      )}
    </div>
  );
}
export function Composer({
  pane,
  server,
  send,
  disabled = false,
}: {
  pane: Pane;
  server: number;
  send: (body: Identity & { text?: string; enter?: boolean; key?: string }) => Promise<void>;
  disabled?: boolean;
}) {
  const key = `corgi-draft:${identityKey(pane, server)}`;
  const [draft, save] = useDraft(key),
    [pending, setPending] = useState(false),
    [delivery, setDelivery] = useState("");
  const busy = useRef(false),
    textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = textarea.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [draft]);
  async function submit(body: { text?: string; enter?: boolean; key?: string }) {
    if (busy.current || disabled || pane.exited || body.text === "") return;
    busy.current = true;
    setPending(true);
    setDelivery("");
    try {
      await send({ server, binding: pane.binding, conversation: pane.conversation, ...body });
      if (body.text !== undefined) clearSubmitted(key, body.text);
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
        <textarea
          id="message"
          ref={textarea}
          placeholder={pane.exited ? "This agent has ended" : "Message this agent…"}
          value={draft}
          onChange={e => save(e.target.value)}
          rows={2}
          maxLength={8192}
          disabled={pane.exited}
        />
        <div className="composer-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={pending || disabled || pane.exited || !draft}
            onClick={() => void submit({ text: draft, enter: false })}
          >
            Paste without Enter
          </Button>
          <Button
            variant="primary"
            aria-label="Send message"
            disabled={pending || disabled || pane.exited || !draft.trim()}
          >
            <ArrowUp size={18} />
            {pending ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>
      <p className="delivery" role="status">
        {delivery || "Return adds a new line · Send presses Enter"}
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
  older,
  olderPending,
  terminalKey,
  keyPending,
  keyStatus,
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
  older?: () => void;
  olderPending?: boolean;
  terminalKey: (key: string) => void;
  keyPending: boolean;
  keyStatus: string;
}) {
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
          <div className="activity-strip">
            <span className="truncate">{pane.activity || "Waiting for the next instruction"}</span>
            {needsInput && mode !== "terminal" && (
              <Button variant="ghost" onClick={() => setMode("terminal")}>
                Needs input → Terminal
              </Button>
            )}
          </div>
          {error && (
            <p className="notice" role="status">
              {error}
            </p>
          )}
          <Tabs.Content value="conversation" className="tab-panel">
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
                  <h2>
                    {data.availability === "oversized" ? "Conversation is too large" : "Conversation unavailable"}
                  </h2>
                  <p>Read and interact with this agent in Terminal.</p>
                  <Button onClick={() => setMode("terminal")}>Open Terminal</Button>
                </div>
              ) : data.messages.length ? (
                <Messages data={data} older={older} pending={olderPending} />
              ) : (
                <Empty title="No messages yet" text="Send the first instruction below." />
              )}
            </ScrollContent>
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
                  <pre>{history}</pre>
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
                  disabled={keyPending || pane.exited}
                  onClick={() => terminalKey(key)}
                >
                  {label}
                </Button>
              ))}
            </nav>
            <p className="delivery" role="status">
              {keyStatus}
            </p>
          </Tabs.Content>
        </main>
      </Tabs.Root>
      <Composer key={key} pane={pane} server={server} send={send} disabled={keyPending} />
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
