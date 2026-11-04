import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, ChevronDown, TerminalSquare } from "lucide-react";
import { Button } from "./ui";
import type { Conversation, Message } from "./types";

type Anchor = { id: string; delta: number; follow: boolean };
const positions = new Map<string, Anchor>();
const estimate = (m: Message) => (m.role === "tool" ? 64 : 160);
function locate(offsets: number[], top: number) {
  let lo = 0,
    hi = offsets.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (offsets[mid] <= top) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
const Body = memo(function Body({
  message: m,
  open,
  toggle,
}: {
  message: Message;
  open: boolean;
  toggle: (id: string, open: boolean) => void;
}) {
  return m.role === "tool" ? (
    <details className="tool" open={open} onToggle={e => toggle(m.id, e.currentTarget.open)}>
      <summary>
        <TerminalSquare size={14} />
        {m.name || "Tool activity"}
        <ChevronDown size={14} />
      </summary>
      {open && <pre>{m.text}</pre>}
      {open && m.truncated && <p className="muted">Output shortened. Full output is available on your Mac.</p>}
    </details>
  ) : (
    <article className={`message ${m.role}`}>
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
  );
});
function Row({
  id,
  measure,
  children,
}: {
  id: string;
  measure: (id: string, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const update = () => {
      if (el.offsetHeight) measure(id, el.offsetHeight);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [id, measure]);
  return (
    <div ref={ref} data-message-id={id} style={{ display: "flow-root" }}>
      {children}
    </div>
  );
}
/** Measured variable-height rows; only the viewport and a small overscan are mounted. */
export function Messages({ id, data, earlier }: { id: string; data: Conversation; earlier?: () => void }) {
  const ref = useRef<HTMLDivElement>(null),
    heights = useRef(new Map<string, number>()),
    anchor = useRef<Anchor>(positions.get(id) ?? { id: "", delta: 0, follow: true });
  const [revision, setRevision] = useState(0),
    [viewport, setViewport] = useState({ top: 0, height: 600 }),
    [follow, setFollow] = useState(anchor.current.follow),
    [opened, setOpened] = useState(new Set<string>());
  const measure = useCallback((key: string, height: number) => {
    if (heights.current.get(key) === height) return;
    heights.current.set(key, height);
    setRevision(v => v + 1);
  }, []);
  const toggle = useCallback(
    (key: string, open: boolean) =>
      setOpened(prior => {
        if (prior.has(key) === open) return prior;
        const next = new Set(prior);
        if (open) next.add(key);
        else next.delete(key);
        return next;
      }),
    [],
  );
  const offsets = useMemo(() => {
    const out = [0];
    for (const m of data.messages) out.push(out.at(-1)! + (heights.current.get(m.id) ?? estimate(m)));
    return out;
  }, [data.messages, revision]);
  const total = offsets.at(-1)!,
    top = follow ? Math.max(0, total - viewport.height) : viewport.top,
    from = Math.max(0, locate(offsets, Math.max(0, top - 600)) - 1),
    to = Math.min(data.messages.length, locate(offsets, top + viewport.height + 600) + 2);
  useLayoutEffect(() => {
    const el = ref.current!;
    const index = data.messages.findIndex(m => m.id === anchor.current.id);
    if (anchor.current.follow) el.scrollTop = Math.max(0, total - el.clientHeight);
    else if (index >= 0) el.scrollTop = offsets[index] + anchor.current.delta;
    setViewport(p => (p.top === el.scrollTop ? p : { ...p, top: el.scrollTop }));
  }, [offsets, total, data.messages]);
  useLayoutEffect(() => {
    const el = ref.current!;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width !== el.clientWidth) {
        width = el.clientWidth;
        heights.current.clear();
        for (const row of el.querySelectorAll<HTMLElement>("[data-message-id]"))
          if (row.offsetHeight) heights.current.set(row.dataset.messageId!, row.offsetHeight);
        setRevision(v => v + 1);
      }
      setViewport({ top: el.scrollTop, height: el.clientHeight || 600 });
      if (anchor.current.follow) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      positions.delete(id);
      positions.set(id, anchor.current);
      while (positions.size > 32) positions.delete(positions.keys().next().value!);
    };
  }, [id]);
  return (
    <div className="content-wrap conversation-wrap">
      {data.omitted && (
        <p className="notice">
          Some unusually complex records could not be previewed. Full contents are available on your Mac.
        </p>
      )}
      {data.progress && (
        <p className="muted" role="status">
          Updating conversation…
        </p>
      )}
      <div
        className="scroll agent-content"
        ref={ref}
        tabIndex={0}
        aria-label="Agent output"
        style={{ overflowAnchor: "none" }}
        onScroll={() => {
          const el = ref.current!,
            next = total - el.scrollTop - el.clientHeight < 40;
          const index = Math.min(data.messages.length - 1, locate(offsets, el.scrollTop));
          anchor.current = { id: data.messages[index]?.id ?? "", delta: el.scrollTop - offsets[index], follow: next };
          setFollow(next);
          setViewport({ top: el.scrollTop, height: el.clientHeight || 600 });
          if (el.scrollTop < 80 && !next) earlier?.();
        }}
      >
        <div className="messages" style={{ paddingTop: offsets[from], paddingBottom: total - offsets[to] }}>
          {data.messages.slice(from, to).map(m => (
            <Row key={m.id} id={m.id} measure={measure}>
              <Body message={m} open={opened.has(m.id)} toggle={toggle} />
            </Row>
          ))}
        </div>
      </div>
      {!follow && (
        <Button
          className="jump"
          onClick={() => {
            anchor.current = { id: "", delta: 0, follow: true };
            setFollow(true);
            ref.current!.scrollTop = ref.current!.scrollHeight;
          }}
        >
          <ArrowDown size={16} />
          Jump to latest
        </Button>
      )}
    </div>
  );
}
