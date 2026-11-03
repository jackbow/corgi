import { closeSync, openSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { flock } from "../native_bridge";
import { field, str } from "../json";
import { paths, privateDirectory } from "./paths";
import { Daemon } from "./daemon";
import { Remote, listen, redirect } from "./server";
import * as tailscale from "./tailscale";
import * as pairing from "./pair";

export const help = `Corgi remote control (Tailscale only)
  corgi remote start       start background service and Tailscale HTTPS on port 8443
  corgi remote status      show service address and paired phones
  corgi remote pair        show a QR and three links; keep pairing open until Ctrl+C
  corgi remote devices     list paired phone IDs
  corgi remote revoke ID   revoke a phone immediately
  corgi remote stop        remove Corgi's Tailscale route and stop the service

Connect both devices to the same tailnet first. Tailscale Serve and HTTPS must
be available; tailnet policy must allow ports 8443 (HTTPS) and 8080 (IP redirects).
CORGI_SOCKET selects the existing Corgi runtime. Remote start does not start it.
`;
export async function control(socket: string, command: string, value: Record<string, unknown> = {}) {
  const response = await fetch("http://localhost/", {
    unix: paths(socket).control,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, ...value }),
    signal: AbortSignal.timeout(3000),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw Error(str(result, "error") || "RemoteControlFailed");
  return result;
}
async function status(socket: string) {
  try {
    return await control(socket, "status");
  } catch {
    return null;
  }
}
async function stopLocal(socket: string) {
  await control(socket, "stop");
  for (let i = 0; i < 50; i++) {
    if (!(await status(socket))) return;
    await Bun.sleep(100);
  }
  throw Error("Remote service did not stop.");
}
async function serve(socket: string, origin: string) {
  if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net:8443$/.test(origin)) throw Error("InvalidRemoteOrigin");
  const p = paths(socket);
  privateDirectory(dirname(p.runtime));
  privateDirectory(p.runtime);
  privateDirectory(p.state);
  const lock = openSync(p.lock, "a", 0o600);
  if (!flock(lock)) {
    closeSync(lock);
    throw Error("RemoteAlreadyRunning");
  }
  let http: ReturnType<typeof listen> | undefined,
    local: ReturnType<typeof listen> | undefined,
    gateway: ReturnType<typeof listen> | undefined;
  try {
    for (const path of [p.http, p.redirect, p.control])
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    const remote = new Remote(p.devices, origin, new Daemon(socket));
    http = listen(p.http, request => remote.fetch(request));
    gateway = listen(p.redirect, async request => redirect(request, origin));
    local = listen(p.control, async request => {
      try {
        const body: unknown = await request.json();
        switch (str(body, "command")) {
          case "status":
            return Response.json({
              origin,
              pid: process.pid,
              remote_protocol: pairing.remoteProtocol,
              devices: remote.auth.list(),
            });
          case "pair":
            return Response.json(remote.auth.mint());
          case "pair.renew":
            remote.auth.renew(str(body, "id"));
            return Response.json({ ok: true });
          case "pair.close":
            remote.auth.close(str(body, "id"));
            return Response.json({ ok: true });
          case "pending":
            return Response.json({ pending: remote.auth.pending() });
          case "approve":
            remote.auth.approve(str(body, "claim"), str(body, "code"), field(body, "allow") === true);
            return Response.json({ ok: true });
          case "revoke":
            remote.auth.revoke(str(body, "device"));
            return Response.json({ ok: true });
          case "stop":
            setTimeout(() => process.emit("SIGTERM"), 50);
            return Response.json({ ok: true });
          default:
            return Response.json({ error: "UnknownCommand" }, { status: 400 });
        }
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 400 });
      }
    });
    await new Promise<void>(resolve => {
      const stop = () => {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
        process.off("SIGHUP", stop);
        resolve();
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      process.on("SIGHUP", stop);
    });
  } finally {
    await http?.stop(true);
    await gateway?.stop(true);
    await local?.stop(true);
    flock(lock, false);
    closeSync(lock);
  }
}
function networkRoutes(address: string, socket: string) {
  const p = paths(socket),
    https = `unix:${p.http}`,
    tcp = `unix:${p.redirect}`;
  return [
    {
      flag: `--https=${tailscale.httpsPort}`,
      target: https,
      check: (config: unknown) => tailscale.route(config, address, https),
    },
    {
      flag: `--tcp=${tailscale.redirectPort}`,
      target: tcp,
      check: (config: unknown) => tailscale.redirectRoute(config, tcp),
    },
  ];
}
export async function command(socket: string, executable: string, args: string[]) {
  const [op, ...rest] = args;
  if (!op || op === "help" || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(help);
    return;
  }
  if (process.getuid?.() === 0)
    throw Error(
      "Do not run Corgi with sudo. Run corgi remote start as your normal user; only Tailscale setup may request administrator permission.",
    );
  if (op === "__serve" && rest.length === 1) return serve(socket, rest[0]);
  if (
    (op === "revoke" ? rest.length !== 1 : rest.length !== 0) ||
    !["start", "stop", "status", "pair", "devices", "revoke"].includes(op)
  )
    throw Error(help);
  const p = paths(socket);
  if (op === "start") {
    const address = tailscale.origin(JSON.parse(await tailscale.run(["status", "--json"])));
    const routes = networkRoutes(address, socket),
      initial = JSON.parse(await tailscale.run(["serve", "status", "--json"]));
    for (const route of routes) route.check(initial);
    await new Daemon(socket).list();
    let current = await status(socket),
      started = false;
    if (current && str(current, "origin") !== address)
      throw Error("Tailscale address changed. Run corgi remote stop before starting again.");
    if (current && field(current, "remote_protocol") !== pairing.remoteProtocol) {
      await stopLocal(socket);
      current = null;
    }
    if (!current) {
      privateDirectory(dirname(p.runtime));
      privateDirectory(p.runtime);
      const fd = openSync(p.log, "a", 0o600);
      try {
        const child = spawn(executable, ["remote", "__serve", address], {
          detached: true,
          stdio: ["ignore", fd, fd],
          env: { ...process.env, CORGI_SOCKET: socket, CORGI_APP_EXE: executable },
        });
        let failure: Error | null = null;
        child.once("error", error => {
          failure = error;
        });
        child.unref();
        for (let i = 0; i < 50; i++) {
          if (failure) throw failure;
          current = await status(socket);
          if (current) break;
          await Bun.sleep(100);
        }
        if (!current) throw Error(`Remote service did not start. See ${p.log}`);
        started = true;
      } finally {
        closeSync(fd);
      }
    }
    const created: typeof routes = [];
    try {
      // Recheck after startup; never intentionally replace another service.
      for (const route of routes) {
        const config = JSON.parse(await tailscale.run(["serve", "status", "--json"]));
        if (route.check(config) === "absent") {
          await tailscale.configure(["serve", "--bg", "--yes", route.flag, route.target]);
          created.push(route);
        }
      }
      const installed = JSON.parse(await tailscale.run(["serve", "status", "--json"]));
      for (const route of routes)
        if (route.check(installed) !== "owned") throw Error("Tailscale Serve did not install the Corgi routes.");
    } catch (error) {
      for (const route of created.reverse()) {
        try {
          if (route.check(JSON.parse(await tailscale.run(["serve", "status", "--json"]))) === "owned")
            await tailscale.configure(["serve", route.flag, "off"]);
        } catch {}
      }
      if (started) await stopLocal(socket).catch(() => {});
      throw error;
    }
    process.stdout.write(
      `${address}\nRemote control is running. Connect your phone to Tailscale, then run corgi remote pair.\n`,
    );
    return;
  }
  if (op === "stop") {
    const current = await status(socket);
    try {
      const address = current
        ? str(current, "origin")
        : tailscale.origin(JSON.parse(await tailscale.run(["status", "--json"])));
      for (const route of networkRoutes(address, socket)) {
        if (route.check(JSON.parse(await tailscale.run(["serve", "status", "--json"]))) === "owned")
          await tailscale.configure(["serve", route.flag, "off"]);
      }
    } finally {
      if (current) await stopLocal(socket);
    }
    process.stdout.write("Remote control stopped.\n");
    return;
  }
  if (op === "status" || op === "devices") {
    const current = await status(socket);
    process.stdout.write(current ? JSON.stringify(current, null, 2) + "\n" : "Remote control is stopped.\n");
    return;
  }
  if (op === "revoke") {
    await control(socket, "revoke", { device: rest[0] });
    process.stdout.write("Phone revoked.\n");
    return;
  }
  if (!process.stdin.isTTY) throw Error("Run corgi remote pair in an interactive terminal to approve the phone.");
  const current = await control(socket, "status");
  if (field(current, "remote_protocol") !== pairing.remoteProtocol)
    throw Error("Remote service needs updating. Run corgi remote start, then pair again.");
  const addresses = tailscale.addresses(JSON.parse(await tailscale.run(["status", "--json"])));
  if (addresses.dns !== str(current, "origin"))
    throw Error("Tailscale address changed. Restart remote control before pairing.");
  await pairing.run((command, value) => control(socket, command, value), addresses);
}
