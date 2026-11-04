import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";
import type { Client } from "./client";
import type { Identity } from "./types";

export function Playback({ client, pane, identity }: { client: Client; pane: number; identity: Identity }) {
  const [url, setUrl] = useState(""),
    [status, setStatus] = useState(""),
    [pending, setPending] = useState(false),
    active = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (!client.speech) return null;
  return (
    <details className="control-panel">
      <summary>Listen to latest response</summary>
      <Button
        disabled={pending}
        onClick={async () => {
          if (active.current) return;
          const controller = new AbortController();
          active.current = controller;
          setPending(true);
          setStatus("");
          try {
            const blob = await client.speech!(pane, identity, controller.signal);
            if (!controller.signal.aborted) setUrl(URL.createObjectURL(blob));
          } catch {
            if (!controller.signal.aborted) setStatus("Audio unavailable. Your Mac must be awake and connected.");
          } finally {
            active.current = undefined;
            setPending(false);
          }
        }}
      >
        {pending ? "Preparing audio…" : url ? "Refresh audio" : "Prepare audio"}
      </Button>
      {pending && <Button onClick={() => active.current?.abort()}>Cancel</Button>}
      {url && (
        <audio
          controls
          src={url}
          preload="metadata"
          onPlay={() => {
            if ("mediaSession" in navigator && "MediaMetadata" in window)
              navigator.mediaSession.metadata = new MediaMetadata({ title: "Latest response", artist: "Corgi" });
          }}
        />
      )}
      <p role="status">{status}</p>
    </details>
  );
}
export function keepAwake(): boolean {
  try {
    return localStorage.getItem("corgi-keep-awake") === "on";
  } catch {
    return false;
  }
}
export function terminalInterval(): number {
  try {
    const n = Number(localStorage.getItem("corgi-terminal-interval"));
    return [250, 500, 1000, 2000, 5000].includes(n) ? n : 1000;
  } catch {
    return 1000;
  }
}
export function useWakeLock(terminal: boolean) {
  useEffect(() => {
    if (!terminal || !keepAwake() || !("wakeLock" in navigator)) return;
    let disposed = false,
      requesting = false,
      lock: WakeLockSentinel | undefined;
    const visible = () => document.visibilityState !== "hidden";
    const acquire = async () => {
      if (!visible() || disposed || requesting || (lock && !lock.released)) return;
      requesting = true;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (disposed || !visible()) await next.release();
        else lock = next;
      } catch {
        /* Unsupported, low battery or system policy. */
      } finally {
        requesting = false;
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
    };
  }, [terminal]);
}
