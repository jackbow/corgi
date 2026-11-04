import { chmodSync } from "node:fs";
import { Auth } from "./auth";
import { identity, input, launch, type Backend } from "./daemon";
import { str } from "../json";
import { files } from "./web_assets";

const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
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
  private limit = new Limit();
  constructor(
    file: string,
    readonly origin: string,
    private backend: Backend,
  ) {
    this.auth = new Auth(file, origin);
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
            ? Object.keys(files).find(p => p.endsWith(".js"))
            : path === "/app.css"
              ? Object.keys(files).find(p => p.endsWith(".css"))
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
            return json(this.auth.login(str(body, "nonce"), str(body, "signature")));
        }
      }
      const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
      const device = this.auth.authenticate(token);
      this.limit.take(device, 180);
      if (request.method === "GET" && path === "/api/session") return json(await this.backend.list());
      if (request.method === "POST" && path === "/api/agents")
        return json(await this.backend.create(launch(await this.body(request))));
      const pane = /^\/api\/panes\/([1-9]\d{0,9})\/(output|input|terminal|conversation)$/.exec(path);
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
        if (pane[2] === "output" && request.method === "GET")
          return json({
            text: await this.backend.read(Number(pane[1]), url.searchParams.has("server") ? readIdentity() : undefined),
          });
        if (pane[2] === "input" && request.method === "POST") {
          await this.backend.send(Number(pane[1]), input(await this.body(request)));
          return json({ ok: true });
        }
      }
      return json({ error: "NotFound" }, 404);
    } catch (error) {
      const name = error instanceof Error ? error.message : "Unavailable";
      if (name === "Unauthorized") return json({ error: name }, 401);
      if (name === "RateLimited") return json({ error: name }, 429);
      if (
        [
          "InvalidPairing",
          "InvalidName",
          "InvalidKey",
          "InvalidInput",
          "PaneChanged",
          "InvalidSnapshot",
          "InvalidBody",
        ].includes(name)
      )
        return json({ error: name }, 400);
      return json({ error: "Unavailable" }, 503);
    }
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
