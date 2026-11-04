import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { field, str } from "../json";
import type { Identity, Snapshot } from "./types";
import { generateKey, publicKey, send, subscription, type Subscription } from "./web_push";

export interface Alert {
  title: string;
  body: string;
  tag: string;
  url: string;
}
interface AgentAlert extends Alert {
  pane: number;
  identity: Identity;
}
import type { Preferences } from "./types";
export type { Preferences } from "./types";
export const defaults: Preferences = {
  finished: true,
  input: true,
  failed: true,
  cooldown: 0,
  settle: 0,
  snoozeUntil: 0,
};
export function preferences(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Object.keys(value).some(k => !Object.hasOwn(defaults, k)))
    throw Error("InvalidInput");
  const p = { ...defaults, ...value };
  if (
    [p.finished, p.input, p.failed].some(v => typeof v !== "boolean") ||
    !Number.isInteger(p.cooldown) ||
    p.cooldown < 0 ||
    p.cooldown > 3600 ||
    !Number.isInteger(p.settle) ||
    p.settle < 0 ||
    p.settle > 30 ||
    !Number.isSafeInteger(p.snoozeUntil) ||
    p.snoozeUntil < 0 ||
    p.snoozeUntil > Date.now() + 7 * 86400_000
  )
    throw Error("InvalidInput");
  return p;
}
interface Delivery {
  device: string;
  alert: Alert;
  attempts: number;
  next: number;
  expires: number;
}
function preview(text: string, limit: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "") + "…" : flat;
}
interface Observed {
  waiting: boolean;
  completion: string;
  state: string;
}
export class Changes {
  private prior = new Map<string, Observed>();
  update(snapshot: Snapshot): AgentAlert[] {
    const next = new Map<string, Observed>(),
      alerts: AgentAlert[] = [];
    for (const pane of snapshot.panes) {
      if (!pane.provider || !pane.conversation || pane.exited) continue;
      const identity = JSON.stringify([snapshot.server, pane.id, pane.binding, pane.conversation]);
      const value = {
        waiting: pane.attention === "needs_input" || pane.state === "blocked",
        completion: pane.completion ?? "",
        state: pane.state,
      };
      const old = this.prior.get(identity);
      next.set(identity, value);
      if (!old) continue; // Establish a baseline after startup or a new pane binding.
      const waiting = value.waiting && !old.waiting;
      const finished =
        !value.waiting &&
        (value.completion
          ? value.completion !== old.completion && value.completion !== "0" && pane.outcome !== "interrupted"
          : old.state === "working" && pane.state === "idle" && pane.attention === "finished");
      if (!waiting && !finished) continue;
      const search = new URLSearchParams({ view: waiting ? "terminal" : "conversation", notification: identity });
      alerts.push({
        title: waiting ? "needs input" : pane.outcome === "failed" ? "failed" : "finished",
        body: preview(pane.name, 100),
        tag: `corgi-${snapshot.server}-${pane.id}-${pane.binding}`,
        url: `/agents/${pane.id}?${search}`,
        pane: pane.id,
        identity: { server: snapshot.server, binding: pane.binding, conversation: pane.conversation },
      });
    }
    this.prior = next;
    return alerts;
  }
  reset() {
    this.prior.clear();
  }
}
/** Private, per-paired-phone subscriptions; no session bearer tokens are retained. */
export class Notifications {
  private key: string;
  private subscriptions = new Map<string, Subscription>();
  private changes = new Changes();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private preferences = new Map<string, Preferences>();
  private queue: Delivery[] = [];
  private last = new Map<string, number>();
  private ticking = false;
  private saved = "";
  constructor(
    private file: string,
    private origin: string,
    private devices: () => { id: string }[],
    private snapshot: () => Promise<Snapshot>,
    private deliver = send,
    private response: (pane: number, identity: Identity) => Promise<string> = async () => "",
    private now = Date.now,
  ) {
    try {
      const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (field(saved, "version") !== 1 || !Array.isArray(field(saved, "subscriptions")))
        throw Error("InvalidPushState");
      this.key = str(saved, "key");
      if (publicKey(this.key).length !== 65) throw Error("InvalidPushState");
      if (str(saved, "origin") === origin)
        for (const entry of field(saved, "subscriptions") as unknown[]) {
          const device = str(entry, "device");
          if (!device || this.subscriptions.has(device) || this.subscriptions.size >= 16)
            throw Error("InvalidPushState");
          this.subscriptions.set(device, subscription(field(entry, "subscription")));
        }
      if (str(saved, "origin") === origin) {
        const entries = field(saved, "preferences");
        if (Array.isArray(entries))
          for (const entry of entries.slice(0, 16))
            this.preferences.set(str(entry, "device"), preferences(field(entry, "value")));
        const queue = field(saved, "queue");
        if (Array.isArray(queue))
          this.queue = queue.slice(-128).filter((v): v is Delivery => {
            const alert = field(v, "alert");
            return (
              typeof field(v, "device") === "string" &&
              typeof field(v, "attempts") === "number" &&
              Number.isSafeInteger(field(v, "next")) &&
              Number.isSafeInteger(field(v, "expires")) &&
              typeof field(alert, "title") === "string" &&
              typeof field(alert, "body") === "string" &&
              str(alert, "body").length < 1024 &&
              str(alert, "url").startsWith("/") &&
              typeof field(alert, "tag") === "string"
            );
          });
      }
      chmodSync(file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.key = generateKey();
      this.save();
    }
  }
  private save() {
    const contents =
      JSON.stringify({
        version: 1,
        origin: this.origin,
        key: this.key,
        subscriptions: [...this.subscriptions].map(([device, subscription]) => ({ device, subscription })),
        preferences: [...this.preferences].map(([device, value]) => ({ device, value })),
        queue: this.queue,
      }) + "\n";
    if (contents === this.saved) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, contents, { flag: "wx", mode: 0o600 });
      renameSync(temp, this.file);
      this.saved = contents;
    } finally {
      try {
        unlinkSync(temp);
      } catch {}
    }
  }
  status(device: string) {
    return {
      publicKey: publicKey(this.key).toString("base64url"),
      enabled: this.subscriptions.has(device),
      preferences: this.preferences.get(device) ?? defaults,
    };
  }
  configure(device: string, value: unknown) {
    const previous = this.preferences.get(device),
      next = preferences(value);
    this.preferences.set(device, next);
    try {
      this.save();
    } catch (error) {
      previous ? this.preferences.set(device, previous) : this.preferences.delete(device);
      throw error;
    }
    return this.status(device);
  }
  subscribe(device: string, value: unknown) {
    if (!this.devices().some(d => d.id === device)) throw Error("Unauthorized");
    const target = subscription(value);
    if ([...this.subscriptions].some(([id, existing]) => id !== device && existing.endpoint === target.endpoint))
      throw Error("SubscriptionInUse");
    const previous = this.subscriptions.get(device);
    this.subscriptions.set(device, target);
    try {
      this.save();
    } catch (error) {
      if (previous) this.subscriptions.set(device, previous);
      else this.subscriptions.delete(device);
      throw error;
    }
  }
  remove(device: string) {
    const previous = this.subscriptions.get(device);
    if (!previous) return;
    this.subscriptions.delete(device);
    this.queue = this.queue.filter(q => q.device !== device);
    if (!this.subscriptions.size) this.changes.reset();
    try {
      this.save();
    } catch (error) {
      this.subscriptions.set(device, previous);
      throw error;
    }
  }
  private async notify(device: string, target: Subscription, alert: Alert) {
    if (this.subscriptions.get(device) !== target || !this.devices().some(d => d.id === device)) return;
    const status = await this.deliver(target, this.key, this.origin, alert);
    if (status === 404 || status === 410) {
      if (this.subscriptions.get(device) === target) this.remove(device);
      return;
    }
    if (status < 200 || status >= 300) throw Error(`PushDeliveryFailed:${status}`);
  }
  async test(device: string) {
    const target = this.subscriptions.get(device);
    if (!target) throw Error("NotificationsDisabled");
    await this.notify(device, target, {
      title: "test notification",
      body: "Notifications are working. Your Mac will alert you when an agent needs input or finishes.",
      tag: "corgi-test",
      url: "/",
    });
    if (!this.subscriptions.has(device)) throw Error("SubscriptionExpired");
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.flush();
    } finally {
      this.ticking = false;
    }
  }
  private async flush() {
    const active = new Set(this.devices().map(d => d.id));
    for (const device of this.preferences.keys()) if (!active.has(device)) this.preferences.delete(device);
    for (const device of this.subscriptions.keys()) if (!active.has(device)) this.remove(device);
    if (!this.subscriptions.size) {
      this.changes.reset();
      this.queue = [];
      this.save();
      return;
    }
    const snapshot = await this.snapshot(),
      alerts = this.changes.update(snapshot);
    const current = new Map(
      snapshot.panes.filter(p => !p.exited).map(p => [`corgi-${snapshot.server}-${p.id}-${p.binding}`, p]),
    );
    let failed = false;
    for (const { pane, identity, ...alert } of alerts) {
      try {
        const text = preview(await this.response(pane, identity), 240);
        if (text) alert.body += `\n${text}`;
      } catch {} // A missing transcript must not suppress an agent status alert.
      for (const device of this.subscriptions.keys()) {
        const p = this.preferences.get(device) ?? defaults,
          now = this.now();
        if (!this.allowed(p, alert) || now < p.snoozeUntil) continue;
        // A newer status for the same agent replaces a still-settling delivery.
        this.queue = this.queue.filter(q => q.device !== device || q.alert.tag !== alert.tag);
        this.queue.push({ device, alert, attempts: 0, next: now + p.settle * 1000, expires: now + 3600_000 });
      }
    }
    this.queue = this.queue.slice(-128);
    this.save(); // Persist before network delivery, including across remote-service restarts.
    for (const delivery of [...this.queue]) {
      const now = this.now(),
        target = this.subscriptions.get(delivery.device),
        p = this.preferences.get(delivery.device) ?? defaults;
      const key = `${delivery.device}:${delivery.alert.tag}`,
        last = this.last.get(key) ?? 0;
      if (
        !target ||
        !active.has(delivery.device) ||
        delivery.expires <= now ||
        !this.allowed(p, delivery.alert) ||
        now < p.snoozeUntil
      ) {
        this.queue = this.queue.filter(q => q !== delivery);
        continue;
      }
      if (delivery.next > now || now - last < p.cooldown * 1000) continue;
      if (p.settle > 0) {
        const pane = current.get(delivery.alert.tag),
          waiting = pane?.attention === "needs_input" || pane?.state === "blocked";
        if (!pane || (delivery.alert.title === "needs input" ? !waiting : pane.state === "working")) {
          this.queue = this.queue.filter(q => q !== delivery);
          continue;
        }
      }
      try {
        await this.notify(delivery.device, target, delivery.alert);
        this.last.set(key, now);
        this.queue = this.queue.filter(q => q !== delivery);
      } catch {
        delivery.attempts++;
        delivery.next = now + Math.min(300_000, 2000 * 2 ** delivery.attempts);
        if (delivery.attempts >= 6) this.queue = this.queue.filter(q => q !== delivery);
        failed = true;
      }
    }
    this.save();
    while (this.last.size > 512) this.last.delete(this.last.keys().next().value!);
    if (failed) throw Error("PushDeliveryFailed");
  }
  private allowed(p: Preferences, alert: Alert) {
    return alert.title === "needs input" ? p.input : alert.title === "failed" ? p.failed : p.finished;
  }
  start(onError: (error: unknown) => void) {
    if (this.running) return;
    this.running = true;
    const poll = async () => {
      try {
        await this.tick();
      } catch (error) {
        onError(error);
      }
      if (this.running) this.timer = setTimeout(poll, 2000);
    };
    void poll();
  }
  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }
}
