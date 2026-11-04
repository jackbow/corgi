import { forwardRef, useState, type ButtonHTMLAttributes } from "react";
import { ChevronLeft, GitBranch, TerminalSquare, Plus, Settings, Search, ChevronRight } from "lucide-react";
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
export function Status({ pane }: { pane: Pane }) {
  const waiting = pane.attention === "needs_input" || pane.state === "blocked";
  const label = pane.exited ? "Ended" : waiting ? "Needs input" : pane.state === "working" ? "Working" : "Ready";
  return (
    <span className={`status ${waiting ? "waiting" : pane.state === "working" ? "working" : ""}`}>
      <span aria-hidden="true">{waiting ? "●" : pane.state === "working" ? "▶" : "○"}</span> {label}
    </span>
  );
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
  const [search, setSearch] = useState("");
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
    }));
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
            onChange={e => setSearch(e.target.value)}
          />
        </label>
        <div className="eyebrow">
          Your workspaces <span>{data.panes.filter(p => p.provider !== null).length} agents</span>
        </div>
        {groups
          .filter(w => !search || w.panes.length)
          .map(w => (
            <section className="workspace" key={w.id}>
              <h2>
                {w.name}
                <span>{w.panes.length}</span>
              </h2>
              {w.panes.map(p => (
                <button className="agent-row" key={p.id} onClick={() => open(p.id)}>
                  <TerminalSquare className="row-icon" size={19} />
                  <div className="row-body">
                    <div className="agent-name">{p.name}</div>
                    <div className="metadata">
                      <span>{p.provider === "claude" ? "Claude" : "Codex"}</span>
                      {p.branch && (
                        <span className="branch">
                          <GitBranch size={12} />
                          {p.branch}
                        </span>
                      )}
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
            </section>
          ))}
        {!data.workspaces.length && (
          <Empty title="No workspaces" text="Open a workspace in Corgi on your Mac to get started." />
        )}
        {search && groups.every(w => !w.panes.length) && (
          <Empty title="No matching agents" text="Try another name or branch." />
        )}
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
