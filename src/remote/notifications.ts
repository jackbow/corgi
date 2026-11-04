import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { field, str } from "../json";
import type { Snapshot } from "./types";
import { generateKey, publicKey, send, subscription, type Subscription } from "./web_push";

export interface Alert {
  title: string;
  body: string;
  tag: string;
  url: string;
}
interface Observed {
  waiting: boolean;
  completion: string;
  state: string;
}
export class Changes {
  private prior = new Map<string, Observed>();
  update(snapshot: Snapshot): Alert[] {
    const next = new Map<string, Observed>(),
      alerts: Alert[] = [];
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
        title: "Corgi",
        body: `${pane.name.slice(0, 100)} ${waiting ? "needs input" : pane.outcome === "failed" ? "stopped with an error" : "finished"}.`,
        tag: `corgi-${snapshot.server}-${pane.id}-${pane.binding}`,
        url: `/agents/${pane.id}?${search}`,
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
  constructor(
    private file: string,
    private origin: string,
    private devices: () => { id: string }[],
    private snapshot: () => Promise<Snapshot>,
    private deliver = send,
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
      chmodSync(file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.key = generateKey();
      this.save();
    }
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(
        temp,
        JSON.stringify({
          version: 1,
          origin: this.origin,
          key: this.key,
          subscriptions: [...this.subscriptions].map(([device, subscription]) => ({ device, subscription })),
        }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      renameSync(temp, this.file);
    } finally {
      try {
        unlinkSync(temp);
      } catch {}
    }
  }
  status(device: string) {
    return { publicKey: publicKey(this.key).toString("base64url"), enabled: this.subscriptions.has(device) };
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
      title: "Corgi",
      body: "Notifications are working. Your Mac will alert you when an agent needs input or finishes.",
      tag: "corgi-test",
      url: "/",
    });
    if (!this.subscriptions.has(device)) throw Error("SubscriptionExpired");
  }
  async tick() {
    const active = new Set(this.devices().map(d => d.id));
    for (const device of this.subscriptions.keys()) if (!active.has(device)) this.remove(device);
    if (!this.subscriptions.size) {
      this.changes.reset();
      return;
    }
    const alerts = this.changes.update(await this.snapshot());
    let failed = false;
    // Changes are consumed once; a failed request is not replayed into duplicate alerts.
    for (const alert of alerts) {
      const deliveries = await Promise.allSettled(
        [...this.subscriptions].map(([device, target]) => this.notify(device, target, alert)),
      );
      failed ||= deliveries.some(result => result.status === "rejected");
    }
    if (failed) throw Error("PushDeliveryFailed");
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
