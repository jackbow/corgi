import { useEffect, useRef, useState } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Plus, TerminalSquare } from "lucide-react";
import { Agent, identityKey, useViewport } from "./agent";
import { Back, Button, Empty, Home } from "./ui";
import { claim, finishPair, stored, RequestError, type Client } from "./client";
import type { Conversation, Pane, Snapshot } from "./types";

export let transport: Client;
export function configure(client: Client) {
  transport = client;
}
export const pairingToken = new URLSearchParams(location.hash.slice(1)).get("pair") ?? "";
if (pairingToken) history.replaceState(null, "", location.pathname + location.search);
export function useSnapshot(interval = 2000) {
  return useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => transport.list(signal),
    refetchInterval: interval,
    retry: 1,
  });
}
export function Root() {
  useViewport();
  return (
    <div className="app">
      <Outlet />
    </div>
  );
}
export function HomeScreen() {
  const query = useSnapshot(),
    navigate = useNavigate();
  if (pairingToken || (query.error instanceof RequestError && query.error.status === 401)) return <Pairing />;
  return (
    <>
      {query.data ? (
        <Home
          data={query.data}
          open={id =>
            void navigate({ to: "/agents/$pane", params: { pane: String(id) }, search: { view: "conversation" } })
          }
          create={() => void navigate({ to: "/new" })}
          settings={() => void navigate({ to: "/settings" })}
        />
      ) : query.isPending ? (
        <Empty title="Connecting…" text="Reaching your Mac through Tailscale." />
      ) : query.error instanceof RequestError && query.error.status === 401 ? (
        <Pairing />
      ) : (
        <main className="scroll">
          <Empty title="Mac unavailable" text="Check Tailscale on both devices and that your Mac is awake." />
          <Button onClick={() => void query.refetch()}>Try reconnecting</Button>
        </main>
      )}
      {query.isError && query.data && <ConnectionError />}
    </>
  );
}
function ConnectionError() {
  return (
    <p className="notice" role="status">
      Reconnecting. Check Tailscale on both devices and that your Mac is awake.
    </p>
  );
}
export function Pairing() {
  const [name, setName] = useState("My phone"),
    [offer, setOffer] = useState<Awaited<ReturnType<typeof claim>>>(),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const queryClient = useQueryClient();
  const complete = useQuery({
    queryKey: ["pair", offer?.claim],
    enabled: !!offer,
    queryFn: () => finishPair(offer!.claim, offer!.keys),
    refetchInterval: q => (q.state.data === true || q.state.error ? false : 2000),
    retry: false,
  });
  useEffect(() => {
    if (complete.data) {
      void queryClient.invalidateQueries({ queryKey: ["session"] });
      location.replace("/");
    }
  }, [complete.data]);
  return (
    <main className="enrollment scroll">
      <TerminalSquare className="pair-icon" size={36} />
      <span className="eyebrow">Corgi on your phone</span>
      <h1>
        Pick up where
        <br />
        you left off.
      </h1>
      <p className="muted">Your Mac’s agents, wherever you are.</p>
      <div className="pair-card">
        <h2>{offer ? "Confirm on your Mac" : "Pair this phone"}</h2>
        {pairingToken ? (
          offer ? (
            <>
              <p>Check that this code matches the code on your Mac.</p>
              <strong className="pair-code">{offer.code}</strong>
              <p role="status">Waiting for approval…</p>
            </>
          ) : (
            <form
              onSubmit={async e => {
                e.preventDefault();
                if (pending) return;
                setPending(true);
                setError("");
                try {
                  setOffer(await claim(pairingToken, name));
                } catch {
                  setError("Pairing failed. Run corgi remote pair again for a fresh link.");
                } finally {
                  setPending(false);
                }
              }}
            >
              <label>
                Phone name
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  maxLength={64}
                  required
                  autoComplete="nickname"
                />
              </label>
              <Button variant="primary" disabled={pending}>
                {pending ? "Pairing…" : "Pair phone"}
              </Button>
            </form>
          )
        ) : (
          <>
            <p>Connect your phone to Tailscale, then run this on your Mac:</p>
            <pre>corgi remote pair</pre>
            <p>Open the pairing link on this phone and confirm the code on your Mac.</p>
            <Button onClick={() => location.reload()}>Try reconnecting</Button>
          </>
        )}
        {(error || complete.error) && (
          <p className="notice" role="alert">
            {error || complete.error?.message}
          </p>
        )}
      </div>
      <p className="muted">
        Device keys stay on this phone.
        <br />
        Approve each new phone on your Mac.
      </p>
    </main>
  );
}
export function SettingsScreen() {
  const navigate = useNavigate();
  return (
    <>
      <header className="header">
        <Back go={() => void navigate({ to: "/" })} />
        <h1>Settings</h1>
      </header>
      <main className="settings scroll">
        <h2>Connection</h2>
        <p>Connected through Tailscale</p>
        <p className="muted break">{location.origin}</p>
        <h2>This phone</h2>
        <p className="muted">
          Forgetting removes the key from this phone. To revoke access, run <code>corgi remote devices</code> on your
          Mac.
        </p>
        <Button
          onClick={async () => {
            await stored(null);
            location.replace("/");
          }}
        >
          Forget this phone
        </Button>
      </main>
    </>
  );
}
export function NewScreen() {
  const query = useSnapshot(),
    navigate = useNavigate(),
    [workspace, setWorkspace] = useState(""),
    [provider, setProvider] = useState<"codex" | "claude">("codex");
  const busy = useRef(false);
  const launching = useIsMutating({ mutationKey: ["launch"] }) > 0;
  const create = useMutation({
    mutationKey: ["launch"],
    mutationFn: () => {
      const data = query.data!;
      return transport.create({
        server: data.server,
        workspace: Number(workspace || data.workspaces[0]?.id),
        provider,
      });
    },
    retry: false,
    onSuccess: async result => {
      await query.refetch();
      void navigate({ to: "/agents/$pane", params: { pane: String(result.pane) }, search: { view: "conversation" } });
    },
    onError: () => {
      void query.refetch();
    },
  });
  return (
    <>
      <header className="header">
        <Back go={() => void navigate({ to: "/" })} />
        <h1>New agent</h1>
      </header>
      <main className="new-agent scroll">
        <span className="eyebrow">Start something</span>
        <h2>A fresh pair of eyes.</h2>
        <p className="muted">Launch on your Mac, using your configured defaults.</p>
        <form
          onSubmit={e => {
            e.preventDefault();
            if (busy.current || launching || create.isError) return;
            busy.current = true;
            create.mutate(undefined, {
              onSettled: () => {
                busy.current = false;
              },
            });
          }}
        >
          <label>
            Workspace
            <select
              value={workspace || query.data?.workspaces[0]?.id || ""}
              onChange={e => setWorkspace(e.target.value)}
            >
              {query.data?.workspaces.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Agent</legend>
            <div className="provider-options">
              {(["codex", "claude"] as const).map(p => (
                <label key={p} className={provider === p ? "provider selected" : "provider"}>
                  <input
                    type="radio"
                    name="provider"
                    value={p}
                    checked={p === provider}
                    onChange={() => setProvider(p)}
                  />
                  <TerminalSquare size={22} />
                  <span>{p === "codex" ? "Codex" : "Claude"}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <Button
            variant="primary"
            className="launch"
            disabled={launching || create.isPending || create.isError || !query.data?.workspaces.length}
          >
            <Plus size={18} />
            {create.isPending ? "Starting…" : "Start agent"}
          </Button>
        </form>
        {query.isError && <ConnectionError />}
        {query.data && !query.data.workspaces.length && <p className="notice">Open a workspace on your Mac first.</p>}
        {create.isError && (
          <div className="notice" role="alert">
            <p>Launch not confirmed. Check the agent list before trying again.</p>
            <Button onClick={() => void navigate({ to: "/" })}>Check agents</Button>
          </div>
        )}
      </main>
    </>
  );
}
function merge(previous: Conversation | undefined, next: Conversation, older = false): Conversation {
  if (next.availability === "indexing" && previous?.availability === "available" && previous.version === next.version)
    return { ...previous, progress: next.progress };
  if (!previous || !previous.messages.length || previous.version !== next.version || next.availability !== "available")
    return next;
  const messages = new Map(
    (older ? [...next.messages, ...previous.messages] : [...previous.messages, ...next.messages]).map(m => [m.id, m]),
  );
  return {
    ...next,
    messages: [...messages.values()],
    before: older ? next.before : previous.before,
    after: older ? previous.after : next.after,
  };
}
export function AgentScreen() {
  const { pane: id } = useParams({ strict: false }),
    search = useSearch({ strict: false }) as { view?: "terminal" | "conversation" },
    navigate = useNavigate(),
    query = useSnapshot(1000),
    p = query.data?.panes.find(p => p.id === Number(id));
  if (query.error instanceof RequestError && query.error.status === 401) return <Pairing />;
  if (!p)
    return (
      <>
        <header className="header">
          <Back go={() => void navigate({ to: "/" })} />
          <h1>Agent</h1>
        </header>
        {query.isError ? (
          <ConnectionError />
        ) : (
          <Empty
            title={query.isPending ? "Connecting…" : "Agent no longer available"}
            text="Return to your workspaces to choose an agent."
          />
        )}
      </>
    );
  return (
    <AgentData
      key={identityKey(p, query.data!.server)}
      pane={p}
      snapshot={query.data!}
      mode={search.view ?? "conversation"}
      setMode={view =>
        void navigate({ to: "/agents/$pane", params: { pane: String(p.id) }, search: { view }, replace: true })
      }
      back={() => void navigate({ to: "/" })}
      disconnected={query.isError}
    />
  );
}
function AgentData({
  pane,
  snapshot,
  mode,
  setMode,
  back,
  disconnected,
}: {
  pane: Pane;
  snapshot: Snapshot;
  mode: "conversation" | "terminal";
  setMode: (v: "conversation" | "terminal") => void;
  back: () => void;
  disconnected: boolean;
}) {
  const cache = useQueryClient(),
    id = { server: snapshot.server, binding: pane.binding, conversation: pane.conversation },
    key = ["conversation", identityKey(pane, snapshot.server)],
    lock = useRef(false);
  const conversation = useQuery({
    queryKey: key,
    enabled: mode === "conversation" && !pane.exited,
    queryFn: async ({ signal }) => {
      const prior = cache.getQueryData<Conversation>(key);
      let next = await transport.conversation(pane.id, id, prior?.after ?? "", "after", signal);
      if (next.availability === "replaced") return transport.conversation(pane.id, id, "", "before", signal);
      return merge(cache.getQueryData<Conversation>(key), next);
    },
    refetchInterval: 1000,
    retry: 1,
  });
  const older = useQuery({
    queryKey: [...key, "older", conversation.data?.before],
    enabled: false,
    queryFn: ({ signal }) => transport.conversation(pane.id, id, conversation.data?.before ?? "", "before", signal),
    retry: 1,
  });
  const surface = useQuery({
    queryKey: ["terminal", ...key.slice(1)],
    enabled: mode === "terminal" && !pane.exited,
    queryFn: ({ signal }) => transport.terminal(pane.id, id, signal),
    refetchInterval: 1000,
    retry: 1,
  });
  const history = useQuery({
    queryKey: ["history", ...key.slice(1)],
    enabled: mode === "terminal" && !pane.exited,
    queryFn: ({ signal }) => transport.history(pane.id, id, signal),
    refetchInterval: 2000,
    retry: 1,
  });
  const [keyStatus, setKeyStatus] = useState("");
  const inputKey = ["input", ...key.slice(1)];
  const inputPending = useIsMutating({ mutationKey: inputKey }) > 0;
  const send = useMutation({
    mutationKey: inputKey,
    mutationFn: (body: Parameters<Client["send"]>[1]) => transport.send(pane.id, body),
    retry: false,
  });
  const mutation = useMutation({
    mutationKey: inputKey,
    mutationFn: (key: string) => transport.send(pane.id, { ...id, key }),
    retry: false,
    onSuccess: () => {
      setKeyStatus("Key sent");
      void surface.refetch();
    },
    onError: () => setKeyStatus("Key not confirmed. Check the output before retrying."),
    onSettled: () => {
      lock.current = false;
    },
  });
  return (
    <Agent
      pane={pane}
      server={snapshot.server}
      data={conversation.data}
      surface={surface.data}
      history={history.data?.text}
      mode={mode}
      setMode={setMode}
      back={back}
      send={async body => {
        if (inputPending) throw Error("InputPending");
        await send.mutateAsync(body);
        void cache.invalidateQueries({ queryKey: key });
        void surface.refetch();
      }}
      older={() => {
        void older.refetch().then(result => {
          if (result.data?.availability === "available")
            cache.setQueryData<Conversation>(key, prior =>
              prior?.version === result.data!.version ? merge(prior, result.data!, true) : prior,
            );
          else if (result.data?.availability === "replaced") void cache.invalidateQueries({ queryKey: key });
        });
      }}
      olderPending={older.isFetching}
      terminalKey={key => {
        if (lock.current || inputPending) return;
        lock.current = true;
        setKeyStatus("");
        mutation.mutate(key);
      }}
      keyPending={inputPending}
      keyStatus={keyStatus}
      error={
        disconnected || conversation.isError || surface.isError
          ? "Reconnecting. Check Tailscale and refresh if this pane changed."
          : undefined
      }
    />
  );
}
