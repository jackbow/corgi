import { closeSync, openSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { dirname } from "node:path";
import { flock } from "../native_bridge";
import { field, str } from "../json";
import { paths, privateDirectory } from "./paths";
import { Daemon } from "./daemon";
import { Remote, listen } from "./server";
import * as tailscale from "./tailscale";

export const help = `Corgi remote control (Tailscale only)
  corgi remote start       start background service and Tailscale HTTPS on port 8443
  corgi remote status      show service address and paired phones
  corgi remote pair        open a one-time pairing; approve the matching phone code
  corgi remote devices     list paired phone IDs
  corgi remote revoke ID   revoke a phone immediately
  corgi remote stop        remove Corgi's Tailscale route and stop the service

Connect both devices to the same tailnet first. Tailscale Serve and HTTPS must
be available; tailnet policy must allow the phone to reach this computer:8443.
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
  let http: ReturnType<typeof listen> | undefined, local: ReturnType<typeof listen> | undefined;
  try {
    for (const path of [p.http, p.control])
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    const remote = new Remote(p.devices, origin, new Daemon(socket));
    http = listen(p.http, request => remote.fetch(request));
    local = listen(p.control, async request => {
      try {
        const body: unknown = await request.json();
        switch (str(body, "command")) {
          case "status":
            return Response.json({ origin, pid: process.pid, devices: remote.auth.list() });
          case "pair":
            return Response.json(remote.auth.mint());
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
    await local?.stop(true);
    flock(lock, false);
    closeSync(lock);
  }
}
export async function command(socket: string, executable: string, args: string[]) {
  const [op, ...rest] = args;
  if (!op || op === "help" || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(help);
    return;
  }
  if (op === "__serve" && rest.length === 1) return serve(socket, rest[0]);
  if (
    (op === "revoke" ? rest.length !== 1 : rest.length !== 0) ||
    !["start", "stop", "status", "pair", "devices", "revoke"].includes(op)
  )
    throw Error(help);
  const p = paths(socket),
    target = `unix:${p.http}`;
  if (op === "start") {
    const address = tailscale.origin(JSON.parse(await tailscale.run(["status", "--json"])));
    tailscale.route(JSON.parse(await tailscale.run(["serve", "status", "--json"])), address, target);
    await new Daemon(socket).list();
    let current = await status(socket),
      started = false;
    if (current && str(current, "origin") !== address)
      throw Error("Tailscale address changed. Run corgi remote stop before starting again.");
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
    try {
      // Recheck after startup; never intentionally replace another service.
      const config = JSON.parse(await tailscale.run(["serve", "status", "--json"]));
      if (tailscale.route(config, address, target) === "absent")
        await tailscale.run(["serve", "--bg", "--yes", `--https=${tailscale.httpsPort}`, target]);
      if (tailscale.route(JSON.parse(await tailscale.run(["serve", "status", "--json"])), address, target) !== "owned")
        throw Error("Tailscale Serve did not install the Corgi route.");
    } catch (error) {
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
      if (tailscale.route(JSON.parse(await tailscale.run(["serve", "status", "--json"])), address, target) === "owned")
        await tailscale.run(["serve", `--https=${tailscale.httpsPort}`, "off"]);
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
  const offer = await control(socket, "pair");
  process.stdout.write(
    `Connect your phone to Tailscale, then open this one-time link (valid for 60 seconds):\n${str(offer, "url")}\nWaiting for your phone…\n`,
  );
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const pending = field(await control(socket, "pending"), "pending");
    if (pending) {
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const code = str(pending, "code");
        const answer = await reader.question(
          `Phone ${JSON.stringify(str(pending, "name"))}. If its code is ${code}, type ${code} to approve (anything else denies): `,
          { signal: AbortSignal.timeout(120_000) },
        );
        await control(socket, "approve", { claim: str(pending, "claim"), code, allow: answer.trim() === code });
        process.stdout.write(answer.trim() === code ? "Phone paired.\n" : "Pairing denied.\n");
      } finally {
        reader.close();
      }
      return;
    }
    await Bun.sleep(1000);
  }
  throw Error("Pairing expired. Run corgi remote pair again.");
}
