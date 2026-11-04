import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authenticated, RequestError } from "./client";
import { Button } from "./ui";
import type { Preferences } from "../../types";

export interface PushStatus {
  publicKey: string;
  enabled: boolean;
  preferences?: Preferences;
}
export interface PushAPI {
  status(): Promise<PushStatus>;
  save(subscription: PushSubscriptionJSON | null): Promise<PushStatus>;
  test(): Promise<unknown>;
  configure?(preferences: Preferences): Promise<PushStatus>;
}
const api: PushAPI = {
  status: () => authenticated("/api/push"),
  save: value => authenticated("/api/push", value),
  test: () => authenticated("/api/push/test", {}),
  configure: value => authenticated("/api/push/preferences", value),
};
export const pushSupported = () =>
  window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export function registerPushWorker() {
  return navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
}
export async function enableNotifications(service = api) {
  // iOS requires this call directly from the Enable button's user gesture.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw Error("Allow notifications in iPhone Settings, then try again.");
  const status = await service.status();
  await registerPushWorker();
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  const expected = bytes(status.publicKey);
  const actual = subscription?.options.applicationServerKey;
  if (subscription && (!actual || new Uint8Array(actual).join() !== expected.join())) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expected });
  await service.save(subscription.toJSON());
}
export async function disableNotifications(service = api) {
  // Remove delivery at the Mac first, including when this browser lost its subscription.
  try {
    await service.save(null);
  } catch (error) {
    if (!(error instanceof RequestError && error.status === 401)) throw error;
  }
  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.getRegistration("/");
    await (await registration?.pushManager?.getSubscription())?.unsubscribe();
  }
}
export function NotificationSettings({ service = api }: { service?: PushAPI }) {
  const supported = pushSupported(),
    queries = useQueryClient();
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  const query = useQuery({
    queryKey: ["push"],
    enabled: supported,
    queryFn: async () => {
      const status = await service.status();
      const registration = await navigator.serviceWorker.getRegistration("/");
      const local = await registration?.pushManager.getSubscription();
      return { ...status, active: status.enabled && !!local && Notification.permission === "granted" };
    },
    retry: false,
  });
  const run = async (operation: () => Promise<unknown>, success = "") => {
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      await operation();
      setMessage(success);
    } catch (error) {
      setMessage(
        error instanceof Error && !(error instanceof RequestError)
          ? error.message
          : "Couldn’t update notifications. Check the Mac’s connection and try again.",
      );
    } finally {
      setPending(false);
      void queries.invalidateQueries({ queryKey: ["push"] });
    }
  };
  return (
    <section className="notification-settings" aria-labelledby="notifications-heading">
      <h2 id="notifications-heading">Notifications</h2>
      <p className="muted">Alerts when an agent needs input or finishes. Your Mac must be awake with Corgi running.</p>
      <p className="muted">
        On iPhone or iPad, use Share → Add to Home Screen, then open Corgi from its icon. You may need to pair the Home
        Screen app separately.
      </p>
      {!supported ? (
        <p>Notifications aren’t available in this browser. Try opening Corgi from your Home Screen.</p>
      ) : (
        <>
          {Notification.permission === "denied" && (
            <p className="notice">Notifications are blocked. Allow them in your device’s notification settings.</p>
          )}
          <p role="status">
            {query.isPending
              ? "Checking notifications…"
              : query.isError
                ? "Couldn’t reach your Mac."
                : query.data?.active
                  ? "Notifications enabled on this phone."
                  : "Notifications are off on this phone."}
          </p>
          <div className="notification-actions">
            <Button
              disabled={pending || query.isPending || query.isError}
              onClick={() =>
                void run(() => (query.data?.active ? disableNotifications(service) : enableNotifications(service)))
              }
            >
              {pending ? "Updating…" : query.data?.active ? "Disable notifications" : "Enable notifications"}
            </Button>
            {query.data?.enabled && !query.data.active && (
              <Button disabled={pending} onClick={() => void run(() => disableNotifications(service))}>
                Disable notifications
              </Button>
            )}
            {query.data?.active && (
              <Button disabled={pending} onClick={() => void run(() => service.test(), "Test notification sent.")}>
                Send test notification
              </Button>
            )}
            {query.isError && (
              <Button disabled={pending} onClick={() => void query.refetch()}>
                Try reconnecting
              </Button>
            )}
          </div>
          {query.data?.preferences && service.configure && (
            <PreferencesForm
              key={JSON.stringify(query.data.preferences)}
              value={query.data.preferences}
              pending={pending}
              save={value => void run(() => service.configure!(value), "Notification preferences saved.")}
            />
          )}
        </>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
function PreferencesForm({
  value,
  pending,
  save,
}: {
  value: Preferences;
  pending: boolean;
  save: (value: Preferences) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <form
      className="control-panel"
      onSubmit={e => {
        e.preventDefault();
        save(draft);
      }}
    >
      {(
        [
          ["input", "Needs input"],
          ["finished", "Finished"],
          ["failed", "Failed"],
        ] as const
      ).map(([key, label]) => (
        <label className="check-label" key={key}>
          <input type="checkbox" checked={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.checked })} />
          {label}
        </label>
      ))}
      <label>
        Settle delay
        <select value={draft.settle} onChange={e => setDraft({ ...draft, settle: Number(e.target.value) })}>
          {[0, 2, 5, 10, 30].map(n => (
            <option key={n} value={n}>
              {n === 0 ? "Immediately" : `${n} seconds`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Per-agent cooldown
        <select value={draft.cooldown} onChange={e => setDraft({ ...draft, cooldown: Number(e.target.value) })}>
          {[0, 30, 60, 300, 900, 3600].map(n => (
            <option key={n} value={n}>
              {n === 0 ? "Every change" : n < 60 ? `${n} seconds` : `${n / 60} minutes`}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        {draft.snoozeUntil > Date.now()
          ? `Snoozed until ${new Date(draft.snoozeUntil).toLocaleTimeString()}`
          : "Notifications are not snoozed."}
      </p>
      <div className="notification-actions">
        <Button type="button" disabled={pending} onClick={() => save({ ...draft, snoozeUntil: Date.now() + 3600_000 })}>
          Snooze 1 hour
        </Button>
        <Button type="button" disabled={pending} onClick={() => save({ ...draft, snoozeUntil: 0 })}>
          Resume alerts
        </Button>
        <Button disabled={pending}>Save preferences</Button>
      </div>
    </form>
  );
}
