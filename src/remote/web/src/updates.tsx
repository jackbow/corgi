import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authenticated } from "./client";
import { Button } from "./ui";
import type { UpdateState } from "../../types";

export function MacUpdates({ request = authenticated }: { request?: <T>(path: string, body?: unknown) => Promise<T> }) {
  const cache = useQueryClient(),
    [confirm, setConfirm] = useState(false),
    [pending, setPending] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const query = useQuery({
    queryKey: ["mac-update"],
    queryFn: () => request<UpdateState>("/api/update"),
    retry: false,
    refetchInterval: q => (q.state.data?.phase === "running" ? 2000 : false),
  });
  const state = query.data;
  return (
    <div className="control-panel">
      <h3>Mac Corgi</h3>
      <p>{state?.message ?? (query.isError ? "Mac update status unavailable." : "Checking update support…")}</p>
      {state?.current && (
        <p className="muted">
          Installed: {state.current}
          {state.staged ? ` · Downloaded: ${state.staged}` : ""}
        </p>
      )}
      {confirm ? (
        <div role="alertdialog" aria-label="Update Mac Corgi">
          <p>
            Download and apply the latest signed release on the Mac? Compatible updates move the live session. If a
            restart is needed, finish on the Mac. Your phone feature build is separate.
          </p>
          <Button
            disabled={pending}
            onClick={async () => {
              if (pending || !state) return;
              setPending(true);
              try {
                cache.setQueryData(
                  ["mac-update"],
                  await request<UpdateState>("/api/update", { server: state.server, confirm: true }),
                );
              } catch {
                setUncertain(true);
              } finally {
                setPending(false);
                setConfirm(false);
              }
            }}
          >
            Confirm update
          </Button>
          <Button disabled={pending} onClick={() => setConfirm(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          disabled={!state || state.phase === "unsupported" || state.phase === "running" || pending || uncertain}
          onClick={() => setConfirm(true)}
        >
          Update Mac Corgi
        </Button>
      )}
      {uncertain && <p role="alert">Update not confirmed. Check corgi update status on the Mac before trying again.</p>}
    </div>
  );
}
