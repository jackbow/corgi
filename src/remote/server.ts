import { chmodSync } from "node:fs";
import { Auth } from "./auth";
import { input, type Backend } from "./daemon";
import { str } from "../json";
import shell from "./web/index.html" with { type: "text" };
import script from "./web/app.js" with { type: "text" };
import style from "./web/app.css" with { type: "text" };
import { colors } from "../palette";

const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
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
      if (request.method === "GET" && ["/", "/app.js", "/app.css"].includes(path)) {
        const css = Object.entries(colors)
          .map(([key, rgb]) => `--${key.replaceAll("_", "-")}:rgb(${rgb.join(" ")});`)
          .join("");
        return new Response(path === "/" ? String(shell) : path === "/app.js" ? script : `:root{${css}}\n${style}`, {
          headers: {
            ...headers,
            "Content-Type":
              path === "/"
                ? "text/html; charset=utf-8"
                : path === "/app.js"
                  ? "text/javascript; charset=utf-8"
                  : "text/css; charset=utf-8",
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
      const pane = /^\/api\/panes\/([1-9]\d{0,9})\/(output|input)$/.exec(path);
      if (pane && Number(pane[1]) <= 0xffffffff) {
        if (pane[2] === "output" && request.method === "GET")
          return json({ text: await this.backend.read(Number(pane[1])) });
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
