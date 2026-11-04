import { forwardRef, useEffect, useState, type ButtonHTMLAttributes } from "react";
import {
  ChevronLeft,
  TerminalSquare,
  Plus,
  Settings,
  Search,
  ChevronRight,
  ChevronDown,
  CirclePlay,
  CircleAlert,
  CircleCheck,
  CircleStop,
} from "lucide-react";
import type { Pane, Snapshot } from "./types";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "ghost" | "primary" | "secondary" }
>(({ className = "", variant = "secondary", ...props }, ref) => (
  <button ref={ref} className={`button ${variant} ${className}`} {...props} />
));
export function Back({ go }: { go: () => void }) {
  return (
    <Button variant="ghost" aria-label="Back to agents" onClick={go}>
      <ChevronLeft size={22} />
    </Button>
  );
}
type State = "waiting" | "working" | "ready" | "ended";
const labels: Record<State, string> = { waiting: "Needs input", working: "Working", ready: "Ready", ended: "Ended" };
const icons = { waiting: CircleAlert, working: CirclePlay, ready: CircleCheck, ended: CircleStop };
function state(pane: Pane): State {
  if (pane.exited) return "ended";
  if (pane.attention === "needs_input" || pane.state === "blocked") return "waiting";
  return pane.state === "working" ? "working" : "ready";
}
export function Status({ pane }: { pane: Pane }) {
  const value = state(pane);
  return (
    <span className={`status ${value}`}>
      <span aria-hidden="true">{value === "waiting" ? "●" : value === "working" ? "▶" : "○"}</span> {labels[value]}
    </span>
  );
}
function StatusIcon({ pane }: { pane: Pane }) {
  const value = state(pane),
    Icon = icons[value];
  return <Icon className={`status status-icon ${value}`} size={22} role="img" aria-label={labels[value]} />;
}
function Overview({ panes }: { panes: Pane[] }) {
  const counts = { waiting: 0, working: 0, ready: 0, ended: 0 };
  for (const pane of panes) counts[state(pane)]++;
  return (
    <>
      {(Object.keys(counts) as State[])
        .filter(s => counts[s])
        .map(s => (
          <span className={`status ${s}`} key={s}>
            {counts[s]} {labels[s].toLowerCase()}
          </span>
        ))}
    </>
  );
}
function rememberedCollapsed(): Set<number> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem("corgi-collapsed-workspaces") ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((v): v is number => Number.isSafeInteger(v)) : []);
  } catch {
    return new Set();
  }
}
export function Home({
  data,
  open,
  create,
  settings,
}: {
  data: Snapshot;
  open: (id: number) => void;
  create: () => void;
  settings: () => void;
}) {
  const [search, setSearch] = useState(""),
    [collapsed, setCollapsed] = useState(rememberedCollapsed),
    [searchCollapsed, setSearchCollapsed] = useState(new Set<number>());
  useEffect(() => {
    try {
      sessionStorage.setItem("corgi-collapsed-workspaces", JSON.stringify([...collapsed]));
    } catch {
      /* Tab preferences are optional. */
    }
  }, [collapsed]);
  const groups = [...data.workspaces]
    .sort((a, b) => a.order - b.order)
    .map(w => ({
      ...w,
      panes: data.panes
        .filter(
          p =>
            p.workspace === w.id &&
            p.provider !== null &&
            `${w.name} ${p.name} ${p.branch} ${p.provider}`.toLowerCase().includes(search.toLowerCase()),
        )
        .sort((a, b) => a.order - b.order),
    }))
    .filter(w => !search || w.panes.length || w.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <header className="header">
        <div className="brand">
          <TerminalSquare size={22} />
          <h1>Agents</h1>
        </div>
        <div className="flex">
          <Button variant="ghost" aria-label="Settings" onClick={settings}>
            <Settings size={20} />
          </Button>
          <Button variant="ghost" aria-label="New agent" onClick={create}>
            <Plus size={22} />
          </Button>
        </div>
      </header>
      <main className="home scroll" data-scroll-restoration-id="home">
        <label className="search">
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="Search agents"
            placeholder="Search agents or workspaces"
            value={search}
            onChange={e => {
              setSearch(e.target.value);
              setSearchCollapsed(new Set());
            }}
          />
        </label>
        <div className="eyebrow">
          Your workspaces <span>{data.panes.filter(p => p.provider !== null).length} agents</span>
        </div>
        <div className="home-overview" aria-label="Agent overview">
          <Overview panes={data.panes.filter(p => p.provider !== null)} />
        </div>
        {groups.map(w => {
          const expanded = !(search ? searchCollapsed : collapsed).has(w.id),
            contentId = `workspace-agents-${w.id}`;
          return (
            <section className="workspace" key={w.id} aria-label={w.name}>
              <h2>
                <button
                  className="workspace-toggle"
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${w.name}`}
                  aria-expanded={expanded}
                  aria-controls={contentId}
                  aria-describedby={`workspace-overview-${w.id}`}
                  onClick={() => {
                    const toggle = (prior: Set<number>) => {
                      const next = new Set(prior);
                      if (next.has(w.id)) next.delete(w.id);
                      else next.add(w.id);
                      return next;
                    };
                    (search ? setSearchCollapsed : setCollapsed)(toggle);
                  }}
                >
                  <span className="workspace-body">
                    <span className="workspace-name" title={w.name}>
                      {w.name}
                    </span>
                    <span className="workspace-overview" id={`workspace-overview-${w.id}`}>
                      <span>
                        {w.panes.length} {w.panes.length === 1 ? "agent" : "agents"}
                      </span>
                      <Overview panes={w.panes} />
                    </span>
                  </span>
                  <ChevronDown size={16} className={`workspace-chevron ${expanded ? "expanded" : ""}`} />
                </button>
              </h2>
              <div id={contentId} hidden={!expanded} className="workspace-agents">
                {w.panes.map(p => (
                  <button className="agent-row" key={p.id} onClick={() => open(p.id)}>
                    <StatusIcon pane={p} />
                    <div className="row-body">
                      <div className="agent-name">{p.name}</div>
                      <div className="response-preview truncate">
                        {p.lastResponse?.availability === "available"
                          ? p.lastResponse.text || "No response yet"
                          : p.lastResponse?.availability === "indexing"
                            ? "Loading last response…"
                            : "Response unavailable"}
                      </div>
                      <div className="activity">
                        <Status pane={p} />
                        <span className="truncate">{p.activity}</span>
                      </div>
                    </div>
                    <ChevronRight size={16} className="row-chevron" />
                  </button>
                ))}
                {!w.panes.length && <p className="muted empty-workspace">No agents in this workspace.</p>}
              </div>
            </section>
          );
        })}
        {!data.workspaces.length && (
          <Empty title="No workspaces" text="Open a workspace in Corgi on your Mac to get started." />
        )}
        {search && !groups.length && <Empty title="No matching agents" text="Try another name or branch." />}
      </main>
      <footer className="home-footer">
        <Button variant="primary" onClick={create}>
          <Plus size={18} />
          New agent
        </Button>
        <span className="muted">Connected to your Mac</span>
      </footer>
    </>
  );
}
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <TerminalSquare size={28} aria-hidden="true" />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
