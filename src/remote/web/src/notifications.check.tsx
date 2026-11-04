import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotificationSettings, enableNotifications, disableNotifications, type PushAPI } from "./notifications";

const key = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
let enabled: boolean, local: PushSubscription | null;
let service: PushAPI;
const unsubscribe = vi.fn(async () => {
  local = null;
  return true;
});
const subscription = () =>
  ({
    options: {
      applicationServerKey: Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0))
        .buffer,
    },
    unsubscribe,
    toJSON: () => ({ endpoint: "https://web.push.apple.com/token", keys: { p256dh: key, auth: "secret" } }),
  }) as unknown as PushSubscription;
const subscribe = vi.fn(async () => {
  local = subscription();
  return local;
});
const permission = vi.fn(async () => "granted" as NotificationPermission);
let queries: QueryClient;
beforeEach(() => {
  enabled = false;
  local = null;
  vi.clearAllMocks();
  permission.mockResolvedValue("granted");
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", function () {});
  vi.stubGlobal("Notification", { permission: "granted", requestPermission: permission });
  const registration = { pushManager: { getSubscription: async () => local, subscribe } };
  vi.stubGlobal("navigator", {
    ...navigator,
    serviceWorker: {
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      getRegistration: vi.fn(async () => registration),
    },
  });
  service = {
    status: vi.fn(async () => ({ publicKey: key, enabled })),
    save: vi.fn(async value => {
      enabled = !!value;
      return { publicKey: key, enabled };
    }),
    test: vi.fn(async () => ({})),
  };
  queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  queries.clear();
  vi.unstubAllGlobals();
});
function settings() {
  render(
    <QueryClientProvider client={queries}>
      <NotificationSettings service={service} />
    </QueryClientProvider>,
  );
}
it("requests permission only from Enable, subscribes with VAPID and supports test and disable", async () => {
  settings();
  const enable = await screen.findByRole("button", { name: "Enable notifications" });
  expect(permission).not.toHaveBeenCalled();
  await userEvent.click(enable);
  const disable = await screen.findByRole("button", { name: "Disable notifications" });
  expect(permission).toHaveBeenCalledTimes(1);
  expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
  expect(service.save).toHaveBeenCalledWith(local!.toJSON());
  await userEvent.click(screen.getByRole("button", { name: "Send test notification" }));
  expect(service.test).toHaveBeenCalledTimes(1);
  await userEvent.click(disable);
  await screen.findByRole("button", { name: "Enable notifications" });
  expect(service.save).toHaveBeenLastCalledWith(null);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
it("retains the ability to retry after a denied permission without subscribing", async () => {
  permission.mockResolvedValue("denied");
  await expect(enableNotifications(service)).rejects.toThrow("Allow notifications");
  expect(subscribe).not.toHaveBeenCalled();
  expect(service.save).not.toHaveBeenCalled();
});
it("reuses existing subscriptions and repairs a rotated server key", async () => {
  local = subscription();
  await enableNotifications(service);
  expect(subscribe).not.toHaveBeenCalled();
  expect(unsubscribe).not.toHaveBeenCalled();
  local = { ...subscription(), options: { applicationServerKey: new Uint8Array([1]).buffer } } as PushSubscription;
  await enableNotifications(service);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(subscribe).toHaveBeenCalledTimes(1);
});
it("does not forget local enrollment when disabling at the Mac fails", async () => {
  local = subscription();
  vi.mocked(service.save).mockRejectedValue(Error("Mac offline"));
  await expect(disableNotifications(service)).rejects.toThrow("Mac offline");
  expect(unsubscribe).not.toHaveBeenCalled();
});
it("explains Home Screen installation when push is unavailable", async () => {
  vi.stubGlobal("PushManager", undefined);
  vi.stubGlobal("isSecureContext", false);
  settings();
  expect(screen.getByText(/Share → Add to Home Screen/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Enable notifications" })).toBeNull();
  expect(service.status).not.toHaveBeenCalled();
});
it("disables duplicate submissions and exposes uncertain enrollment failures without retrying", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(service.save).mockImplementation(
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  settings();
  await userEvent.click(await screen.findByRole("button", { name: "Enable notifications" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Updating…" }).hasAttribute("disabled")).toBe(true));
  reject(Error("Enrollment not confirmed. Check the Mac’s connection."));
  await screen.findByText(/Enrollment not confirmed/);
  expect(service.save).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole("button", { name: "Enable notifications" })).toBeTruthy();
});

it("can disable delivery in a browser that has service workers but no Push API", async () => {
  vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => ({}) } });
  await disableNotifications(service);
  expect(service.save).toHaveBeenCalledWith(null);
});
