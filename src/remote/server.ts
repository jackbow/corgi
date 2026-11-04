import { chmodSync } from "node:fs";
import { Auth } from "./auth";
import { identity, input, launch, type Backend } from "./daemon";
import { field, str } from "../json";
import { files } from "./web_assets";
import { Notifications } from "./notifications";
import { management, positive } from "./controls";
import { audit } from "./audit";
import { speech } from "./speech";
import { releaseVersion, releaseCommit, builtAt } from "../build_config";
import type { Snapshot } from "./types";

const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; worker-src 'self'; manifest-src 'self'; img-src 'self'; media-src 'self' blob:; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
/** IP links carry tokens only in their fragment; browsers retain it across this redirect. */
export function redirect(request: Request, origin: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "MethodNotAllowed" }, 405);
  return new Response(null, { status: 303, headers: { ...headers, Location: `${origin}/` } });
}
export class Limit {
  private buckets = new Map<string, { start: number; count: number }>();
  take(key: string, max: number, now = Date.now()) {
    for (const [key, b] of this.buckets) if (now - b.start >= 60_000) this.buckets.delete(key);
    const b = this.buckets.get(key) ?? { start: now, count: 0 };
    if (++b.count > max) throw Error("RateLimited");
    this.buckets.set(key, b);
  }
}
export class Remote {
  readonly auth: Auth;
  readonly notifications: Notifications;
  private limit = new Limit();
  private streams = new Map<string, number>();
  private speaking = false;
  constructor(
    private file: string,
    readonly origin: string,
    private backend: Backend,
  ) {
    this.auth = new Auth(file, origin);
    this.notifications = new Notifications(
      `${file}.push`,
      origin,
      () => this.auth.list(),
      () => this.backend.activity?.() ?? this.backend.list(),
      undefined,
      (pane, identity) => this.backend.lastResponse?.(pane, identity) ?? Promise.resolve(""),
    );
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (request.method === "GET") {
        const route = /^(\/|\/agents\/[1-9]\d{0,9}|\/new|\/settings)$/.test(path);
        const asset = route ? files["/index.html"] : Object.hasOwn(files, path) ? files[path] : undefined;
        // Compatibility aliases for previously opened pages.
        const alias =
          path === "/app.js"
            ? Object.keys(files).find(p => p.startsWith("/assets/") && p.endsWith(".js"))
            : path === "/app.css"
              ? Object.keys(files).find(p => p.startsWith("/assets/") && p.endsWith(".css"))
              : undefined;
        const file = asset ?? (alias ? files[alias] : undefined);
        if (file)
          return new Response(Bun.file(file), {
            headers: {
              ...headers,
              "Content-Type": file.endsWith(".woff2")
                ? "font/woff2"
                : route
                  ? "text/html; charset=utf-8"
                  : path.endsWith(".js")
                    ? "text/javascript; charset=utf-8"
                    : path.endsWith(".css")
                      ? "text/css; charset=utf-8"
                      : path.endsWith(".webmanifest")
                        ? "application/manifest+json"
                        : Bun.file(file).type,
            },
          });
      }
      if (!path.startsWith("/api/")) return json({ error: "NotFound" }, 404);
      const origin = request.headers.get("Origin");
      if ((request.method !== "GET" && origin !== this.origin) || (origin && origin !== this.origin))
        return json({ error: "OriginRejected" }, 403);
      this.limit.take("all", 2400);
      const publicRoutes = ["/api/pair", "/api/pair/status", "/api/challenge", "/api/session"];
      if (request.method === "POST" && publicRoutes.includes(path)) {
        this.limit.take("auth", 120);
        const body: unknown = await this.body(request);
        switch (path) {
          case "/api/pair":
            return json(this.auth.claim(str(body, "token"), str(body, "name"), str(body, "key")));
          case "/api/pair/status":
            return json(this.auth.outcome(str(body, "claim")));
          case "/api/challenge":
            return json(this.auth.challenge(str(body, "device")));
          case "/api/session":
            return json(
              this.auth.login(str(body, "nonce"), str(body, "signature"), Date.now(), field(body, "assertion")),
            );
        }
      }
      const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
      const device = this.auth.authenticate(token);
      this.limit.take(device, 900);
      const readOnly = ["/api/push", "/api/push/test", "/api/push/preferences", "/api/device/lock"];
      if (
        request.method !== "GET" &&
        !readOnly.includes(path) &&
        !/^\/api\/panes\/\d+\/speech$/.test(path) &&
        this.auth.role(device) !== "controller"
      ) {
        audit(`${this.file}.audit`, device, "forbidden-write", "denied");
        return json({ error: "Forbidden" }, 403);
      }
      if (request.method === "GET" && path === "/api/me") return json(this.auth.details().find(d => d.id === device));
      if (path === "/api/update" && ["GET", "POST"].includes(request.method)) {
        if (this.auth.role(device) !== "controller") return json({ error: "Forbidden" }, 403);
        if (!this.backend.update) throw Error("Unsupported");
        if (request.method === "GET") return json(await this.backend.update());
        const body = await this.body(request);
        if (field(body, "confirm") !== true) throw Error("InvalidInput");
        const state = await this.backend.update(positive(field(body, "server")));
        audit(`${this.file}.audit`, device, "update-mac", "ok");
        return json(state, 202);
      }
      if (request.method === "GET" && path === "/api/version")
        return json({
          version: releaseVersion,
          commit: releaseCommit,
          builtAt,
          installation: "mac",
          reason:
            "Phone feature builds are installed separately on the Mac. Managed Mac releases can be updated below.",
        });
      if (request.method === "POST" && path === "/api/device/lock") {
        this.auth.lock(device, await this.body(request));
        return json({ ok: true });
      }
      if (request.method === "GET" && path === "/api/devices") {
        if (this.auth.role(device) !== "controller") return json({ error: "Forbidden" }, 403);
        return json({ devices: this.auth.details(), pending: this.auth.invited(device) });
      }
      if (request.method === "POST" && path === "/api/devices/invite") {
        const role = str(await this.body(request), "role");
        if (role !== "controller" && role !== "reader") throw Error("InvalidInput");
        return json(this.auth.invite(device, role));
      }
      if (request.method === "POST" && path === "/api/devices/approve") {
        const body = await this.body(request);
        if (typeof field(body, "allow") !== "boolean") throw Error("InvalidInput");
        this.auth.approveInvite(device, str(body, "claim"), str(body, "code"), field(body, "allow") === true);
        return json({ ok: true });
      }
      if (request.method === "POST" && path === "/api/devices/revoke") {
        this.auth.revoke(str(await this.body(request), "id"));
        return json({ ok: true });
      }
      if (request.method === "GET" && path === "/api/profiles") return json((await this.backend.profiles?.()) ?? []);
      if (request.method === "GET" && path === "/api/events") return this.events(request, token, device);
      if (request.method === "POST" && path === "/api/manage") {
        if (!this.backend.manage) throw Error("Unsupported");
        const action = management(await this.body(request), identity);
        try {
          await this.backend.manage(action);
          audit(`${this.file}.audit`, device, action.action, "ok");
        } catch (error) {
          audit(`${this.file}.audit`, device, action.action, "failed");
          throw error;
        }
        return json({ ok: true });
      }
      if (request.method === "GET" && path === "/api/session") return json(await this.backend.list());
      if (request.method === "GET" && path === "/api/push") return json(this.notifications.status(device));
      if (request.method === "POST" && path === "/api/push/preferences")
        return json(this.notifications.configure(device, await this.body(request)));
      if (request.method === "POST" && path === "/api/push") {
        const body = await this.body(request);
        if (body === null) this.notifications.remove(device);
        else this.notifications.subscribe(device, body);
        return json(this.notifications.status(device));
      }
      if (request.method === "POST" && path === "/api/push/test") {
        this.limit.take(`push-test:${device}`, 5);
        await this.notifications.test(device);
        return json({ ok: true });
      }
      if (request.method === "POST" && path === "/api/agents")
        return json(await this.backend.create(launch(await this.body(request))));
      const pane =
        /^\/api\/panes\/([1-9]\d{0,9})\/(output|input|terminal|conversation|prompt|respond|archive|speech|commands)$/.exec(
          path,
        );
      const readIdentity = () => {
        const server = url.searchParams.get("server");
        if (!server || !/^\d+$/.test(server) || !url.searchParams.has("conversation")) throw Error("InvalidInput");
        return identity({
          server: Number(server),
          binding: url.searchParams.get("binding"),
          conversation: url.searchParams.get("conversation"),
        });
      };
      if (pane && Number(pane[1]) <= 0xffffffff) {
        if (pane[2] === "commands" && request.method === "GET")
          return json((await this.backend.commands?.(Number(pane[1]), readIdentity())) ?? []);
        if (pane[2] === "speech" && request.method === "POST") {
          this.limit.take(`speech:${device}`, 3);
          if (this.speaking) throw Error("RateLimited");
          const q = identity(await this.body(request));
          if (!this.backend.lastResponse) throw Error("Unsupported");
          this.speaking = true;
          try {
            const data = await speech(await this.backend.lastResponse(Number(pane[1]), q), request.signal);
            return new Response(new Uint8Array(data), { headers: { ...headers, "Content-Type": "audio/wav" } });
          } finally {
            this.speaking = false;
          }
        }
        if (pane[2] === "archive" && request.method === "GET") {
          if (!this.backend.archive) throw Error("Unsupported");
          const cursor = url.searchParams.get("cursor") ?? "";
          if (cursor && !/^[A-Za-z0-9_-]{32}$/.test(cursor)) throw Error("InvalidInput");
          return json(await this.backend.archive(Number(pane[1]), readIdentity(), cursor));
        }
        if (pane[2] === "prompt" && request.method === "GET")
          return json((await this.backend.prompt?.(Number(pane[1]), readIdentity())) ?? null);
        if (pane[2] === "respond" && request.method === "POST") {
          if (!this.backend.respond) throw Error("Unsupported");
          const body = await this.body(request),
            id = identity(field(body, "identity")),
            fingerprint = str(body, "prompt");
          if (!/^[A-Za-z0-9_-]{43}$/.test(fingerprint)) throw Error("InvalidInput");
          try {
            await this.backend.respond(Number(pane[1]), id, fingerprint, positive(field(body, "choice")));
            audit(`${this.file}.audit`, device, "respond", "ok");
          } catch (error) {
            audit(`${this.file}.audit`, device, "respond", "failed");
            throw error;
          }
          return json({ ok: true });
        }
        if (request.method === "GET" && (pane[2] === "terminal" || pane[2] === "conversation")) {
          const q = readIdentity();
          if (pane[2] === "terminal") return json(await this.backend.terminal(Number(pane[1]), q));
          const cursor = url.searchParams.get("cursor") ?? "",
            direction = url.searchParams.get("direction") ?? "before";
          if (cursor.length > 512 || !["before", "after"].includes(direction)) throw Error("InvalidInput");
          return json({
            ...(await this.backend.conversation(Number(pane[1]), q, cursor, direction as "before" | "after")),
            ...q,
            pane: Number(pane[1]),
          });
        }
        if (pane[2] === "output" && request.method === "GET") {
          const lines = Number(url.searchParams.get("lines") ?? 300);
          if (![100, 300, 500, 1000, 10000].includes(lines)) throw Error("InvalidInput");
          return json({
            text: await this.backend.read(
              Number(pane[1]),
              url.searchParams.has("server") ? readIdentity() : undefined,
              lines,
            ),
          });
        }
        if (pane[2] === "input" && request.method === "POST") {
          await this.backend.send(Number(pane[1]), input(await this.body(request)));
          return json({ ok: true });
        }
      }
      return json({ error: "NotFound" }, 404);
    } catch (error) {
      const name = error instanceof Error ? error.message : "Unavailable";
      if (name === "Unauthorized") return json({ error: name }, 401);
      if (name === "Forbidden") return json({ error: name }, 403);
      if (name === "RateLimited") return json({ error: name }, 429);
      if (
        [
          "InvalidPairing",
          "InvalidName",
          "InvalidKey",
          "InvalidInput",
          "PromptChanged",
          "AgentBusy",
          "PaneChanged",
          "InvalidSnapshot",
          "InvalidBody",
          "InvalidSubscription",
          "SubscriptionInUse",
          "NotificationsDisabled",
          "SubscriptionExpired",
        ].includes(name)
      )
        return json({ error: name }, 400);
      return json({ error: "Unavailable" }, 503);
    }
  }
  private events(request: Request, token: string, device: string) {
    if ((this.streams.get(device) ?? 0) >= 2) throw Error("RateLimited");
    this.streams.set(device, (this.streams.get(device) ?? 0) + 1);
    const abort = new AbortController();
    let timer: ReturnType<typeof setInterval>,
      closed = false;
    let end = () => {};
    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      abort.abort();
      request.signal.removeEventListener("abort", end);
      const remaining = (this.streams.get(device) ?? 1) - 1;
      if (remaining > 0) this.streams.set(device, remaining);
      else this.streams.delete(device);
    };
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let latest: Snapshot | undefined;
        const emit = (type: string, data?: Snapshot) => {
          if (closed || (controller.desiredSize ?? 0) <= 0) return false;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ type, data }) + "\n"));
          return true;
        };
        end = () => {
          if (!closed) {
            stop();
            controller.close();
          }
        };
        request.signal.addEventListener("abort", end, { once: true });
        const start = Date.now();
        timer = setInterval(() => {
          try {
            this.auth.authenticate(token);
            if (Date.now() - start > 60_000 || request.signal.aborted) end();
            else if (latest) {
              if (emit("session", latest)) latest = undefined;
            } else emit("activity");
          } catch {
            end();
          }
        }, 1000);
        emit("session");
        if (this.backend.watch)
          void this.backend
            .watch(abort.signal, data => {
              latest = data;
            })
            .then(end, end);
        if (request.signal.aborted) end();
      },
      cancel: stop,
    });
    return new Response(stream, {
      headers: { ...headers, "Content-Type": "application/x-ndjson", "X-Accel-Buffering": "no" },
    });
  }
  private async body(request: Request): Promise<unknown> {
    if (request.headers.get("Content-Type") !== "application/json") throw Error("InvalidBody");
    const text = await request.text();
    if (Buffer.byteLength(text) > 16 * 1024) throw Error("InvalidBody");
    try {
      return JSON.parse(text);
    } catch {
      throw Error("InvalidBody");
    }
  }
}
export function listen(path: string, fetch: (request: Request) => Promise<Response>) {
  const server = Bun.serve({ unix: path, maxRequestBodySize: 16 * 1024, fetch });
  chmodSync(path, 0o600);
  return server;
}
