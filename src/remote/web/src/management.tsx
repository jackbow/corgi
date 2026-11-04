import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "./ui";
import type { Client } from "./client";
import type { Pane, Snapshot } from "./types";
import type { Management } from "../../types";

function useManagement(client: Client) {
  const cache = useQueryClient(),
    lock = useRef(false);
  const [pending, setPending] = useState(false),
    [status, setStatus] = useState("");
  const run = async (action: Management) => {
    if (lock.current || !client.manage) return;
    lock.current = true;
    setPending(true);
    setStatus("");
    try {
      await client.manage(action);
      setStatus("Updated");
    } catch {
      setStatus("Action not confirmed. Check the list before trying again.");
    } finally {
      lock.current = false;
      setPending(false);
      void cache.invalidateQueries({ queryKey: ["session"] });
    }
  };
  return { run, pending, status };
}
export function AgentActions({ client, pane, server }: { client: Client; pane: Pane; server: number }) {
  const { run, pending, status } = useManagement(client),
    [name, setName] = useState(pane.name),
    [confirm, setConfirm] = useState<"stop-agent" | "clear-agent" | null>(null);
  if (!client.manage) return null;
  const identity = { server, binding: pane.binding, conversation: pane.conversation };
  return (
    <details className="control-panel agent-actions">
      <summary>Agent actions</summary>
      <form
        onSubmit={e => {
          e.preventDefault();
          void run({ action: "rename-agent", pane: pane.id, identity, name });
        }}
      >
        <label>
          Agent name
          <input value={name} maxLength={128} onChange={e => setName(e.target.value)} required />
        </label>
        <Button disabled={pending || !name.trim()}>Rename agent</Button>
      </form>
      <div className="notification-actions">
        <Button disabled={pending || pane.state !== "idle"} onClick={() => setConfirm("clear-agent")}>
          New conversation
        </Button>
        <Button disabled={pending} onClick={() => setConfirm("stop-agent")}>
          Stop agent
        </Button>
      </div>
      {confirm && (
        <div role="alertdialog" aria-label="Confirm agent action" className="notice">
          <p>
            {confirm === "stop-agent"
              ? "Stop this agent and close its pane on your Mac?"
              : "Clear this agent’s context and start a new conversation?"}
          </p>
          <Button
            disabled={pending}
            onClick={() => {
              const action = confirm;
              setConfirm(null);
              void run({ action, pane: pane.id, identity, confirm: true });
            }}
          >
            Confirm
          </Button>
          <Button disabled={pending} onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        </div>
      )}
      <p role="status">{status}</p>
    </details>
  );
}
export function WorkspaceControls({ client, data }: { client: Client; data: Snapshot }) {
  const { run, pending, status } = useManagement(client),
    [name, setName] = useState(""),
    [cwd, setCwd] = useState(""),
    [closing, setClosing] = useState<number | null>(null);
  if (!client.manage) return null;
  return (
    <section className="control-panel">
      <h2>Workspaces</h2>
      {data.workspaces.map((w, index) => (
        <div key={w.id} className="workspace-control">
          <form
            onSubmit={e => {
              e.preventDefault();
              const name = new FormData(e.currentTarget).get("name") as string;
              void run({ action: "rename-workspace", server: data.server, workspace: w.id, name });
            }}
          >
            <label className="sr-only" htmlFor={`workspace-name-${w.id}`}>
              Rename {w.name}
            </label>
            <input id={`workspace-name-${w.id}`} name="name" defaultValue={w.name} maxLength={128} required />
            <Button disabled={pending}>Rename</Button>
          </form>
          <div className="notification-actions">
            {index > 0 && (
              <Button
                aria-label={`Move ${w.name} up`}
                disabled={pending}
                onClick={() =>
                  void run({
                    action: "move-workspace",
                    server: data.server,
                    workspace: w.id,
                    before: data.workspaces[index - 1].id,
                  })
                }
              >
                Move up
              </Button>
            )}
            <Button disabled={pending} onClick={() => setClosing(w.id)}>
              Close workspace
            </Button>
          </div>
          {closing === w.id && (
            <div role="alertdialog" aria-label={`Close ${w.name}`} className="notice">
              <p>Close {w.name} and stop all its panes on your Mac? This does not delete its directory.</p>
              <Button
                disabled={pending}
                onClick={() => {
                  setClosing(null);
                  void run({ action: "close-workspace", server: data.server, workspace: w.id, confirm: true });
                }}
              >
                Confirm close
              </Button>
              <Button disabled={pending} onClick={() => setClosing(null)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      ))}
      <details>
        <summary>Open a workspace</summary>
        <form
          onSubmit={e => {
            e.preventDefault();
            void run({ action: "create-workspace", server: data.server, name, cwd });
          }}
        >
          <label>
            Workspace name
            <input value={name} onChange={e => setName(e.target.value)} maxLength={128} required />
          </label>
          <label>
            Existing directory on Mac
            <input
              value={cwd}
              onChange={e => setCwd(e.target.value)}
              placeholder="/Users/you/projects/app"
              maxLength={4096}
              autoCapitalize="off"
              autoCorrect="off"
              required
            />
          </label>
          <Button disabled={pending || !cwd.startsWith("/") || !name.trim()}>Open workspace</Button>
        </form>
      </details>
      <p role="status">{status}</p>
    </section>
  );
}
