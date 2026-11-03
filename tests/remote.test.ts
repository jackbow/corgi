import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime, EXE } from "./runtime";
import { Pty, deadline, registerCase, run, sleep, writeExecutable } from "./support";
import { paths } from "../src/remote/paths";
import { signed } from "../src/remote/auth";

const origin = "https://mac.example.ts.net:8443";
class RemoteControl extends Runtime {
  async configure() {
    const state = join(this.temp.name, "tailscale.json");
    writeFileSync(
      state,
      JSON.stringify({
        TCP: { "443": { HTTPS: true } },
        Web: { "mac.example.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:1234" } } } },
      }),
    );
    this.env.CORGI_FAKE_TS_STATE = state;
    this.env.CORGI_TAILSCALE = writeExecutable(
      join(this.temp.name, "tailscale"),
      `
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2), file = process.env.CORGI_FAKE_TS_STATE;
if (args[0] === "status") console.log(JSON.stringify({BackendState:"Running",Self:{DNSName:"mac.example.ts.net.",Online:true,TailscaleIPs:["100.101.102.103","fd7a:115c:a1e0::1234"]}}));
else if (args[0] === "serve" && args[1] === "status") console.log(readFileSync(file,"utf8"));
else if (args[0] === "serve") {
  if (process.env.CORGI_FAKE_TS_FAIL && (process.env.CORGI_FAKE_TS_FAIL !== "redirect" || args.includes("--tcp=8080"))) {
    console.error(process.env.CORGI_FAKE_TS_FAIL === "permission" ? "401 Unauthorized: must be root" : "Serve is unavailable");
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(file,"utf8"));
  const tcp = args.includes("--tcp=8080"), port = tcp ? "8080" : "8443";
  if (args.at(-1) === "off") { delete config.TCP[port]; if (!tcp) delete config.Web["mac.example.ts.net:8443"]; }
  else if (tcp) config.TCP[port]={TCPForward:args.at(-1)};
  else { config.TCP[port]={HTTPS:true}; config.Web["mac.example.ts.net:8443"]={Handlers:{"/":{Proxy:args.at(-1)}}}; }
  writeFileSync(file,JSON.stringify(config));
} else process.exit(2);
`,
    );
  }
  async remote(...args: string[]) {
    return run([EXE, "remote", ...args], { env: this.env, timeout: 15000 });
  }
  async local(command: string, value: Record<string, unknown> = {}) {
    const response = await fetch("http://localhost/", {
      unix: paths(this.path).control,
      method: "POST",
      body: JSON.stringify({ command, ...value }),
      signal: AbortSignal.timeout(3000),
    });
    this.assertEqual(response.status, 200);
    return response.json();
  }
  async api(path: string, body?: unknown, token = "") {
    return fetch(`http://localhost${path}`, {
      unix: paths(this.path).http,
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
  }
  async wait_stopped() {
    for (let i = 0; i < 100; i++) {
      try {
        await this.local("status");
      } catch {
        return;
      }
      await sleep(0.02);
    }
    throw Error("Remote service did not stop");
  }
  async tearDown() {
    delete this.env.CORGI_FAKE_TS_FAIL;
    try {
      if (existsSync(paths(this.path).control)) {
        await this.remote("stop");
        await this.wait_stopped();
      }
    } finally {
      rmSync(paths(this.path).runtime, { recursive: true, force: true });
      await super.tearDown();
    }
  }
  async test_phone_control_survives_restart_without_resizing_desktop_panes() {
    const pane = (await this.command("pane.create", { workspace: 1, cwd: this.temp.name })).pane;
    const before = (await this.rpc({ op: "session.snapshot" })).panes.find((p: { id: number }) => p.id === pane);
    await this.remote("start");
    const first = await this.local("status");
    this.assertEqual(first.origin, origin);
    await this.remote("start");
    this.assertEqual((await this.local("status")).pid, first.pid);
    const offer = await this.local("pair"),
      keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const claim = await (
      await this.api("/api/pair", {
        token: new URL(offer.url).hash.slice(6),
        name: "Test phone",
        key: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
      })
    ).json();
    this.assertEqual((await this.local("pending")).pending.code, claim.code);
    await this.local("approve", { claim: claim.claim, code: claim.code, allow: true });
    const { device } = await (await this.api("/api/pair/status", { claim: claim.claim })).json();
    const login = async () => {
      const { nonce } = await (await this.api("/api/challenge", { device })).json();
      const signature = sign("sha256", Buffer.from(signed(origin, nonce)), {
        key: keys.privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return (await (await this.api("/api/session", { nonce, signature })).json()).token;
    };
    let token = await login();
    const session = await (await this.api("/api/session", undefined, token)).json(),
      target = session.panes.find((p: { id: number }) => p.id === pane);
    const send = await this.api(
      `/api/panes/${pane}/input`,
      { server: session.server, binding: target.binding, text: "printf 'REMOTE_%s\\n' WORKED", enter: true },
      token,
    );
    this.assertEqual(send.status, 200);
    let text = "";
    for (let i = 0; i < 100; i++) {
      text = (await (await this.api(`/api/panes/${pane}/output`, undefined, token)).json()).text;
      if (text.includes("REMOTE_WORKED")) break;
      await sleep(0.02);
    }
    this.assertIn("REMOTE_WORKED", text);
    const after = (await this.rpc({ op: "session.snapshot" })).panes.find((p: { id: number }) => p.id === pane);
    this.assertEqual([after.pid, after.cols, after.rows], [before.pid, before.cols, before.rows]);
    this.assertEqual(statSync(paths(this.path).http).mode & 0o777, 0o600);
    const css = await this.api("/app.css");
    this.assertIn("--text:rgb(", await css.text());
    this.assertEqual((await this.api("/api/rpc", { op: "shutdown" }, token)).status, 404);
    await this.remote("stop");
    await this.wait_stopped();
    const config = JSON.parse(readFileSync(this.env.CORGI_FAKE_TS_STATE!, "utf8"));
    this.assertEqual(config.TCP, { "443": { HTTPS: true } });
    await this.remote("start");
    this.assertEqual((await this.api("/api/session", undefined, token)).status, 401);
    token = await login();
    this.assertEqual((await this.api("/api/session", undefined, token)).status, 200);
    await this.remote("revoke", device);
    this.assertEqual((await this.api("/api/session", undefined, token)).status, 401);
  }
  async test_start_leaves_conflicting_routes_unchanged_and_rolls_back_failed_setup() {
    const file = this.env.CORGI_FAKE_TS_STATE!,
      original = JSON.parse(readFileSync(file, "utf8"));
    const config = structuredClone(original);
    config.TCP["8443"] = { HTTPS: true };
    config.Web["mac.example.ts.net:8443"] = { Handlers: { "/": { Proxy: "http://localhost:9999" } } };
    writeFileSync(file, JSON.stringify(config));
    const result = await run([EXE, "remote", "start"], { env: this.env, check: false });
    this.assertNotEqual(result.code, 0);
    this.assertIn("already has another service", result.stderr);
    this.assertEqual(JSON.parse(readFileSync(file, "utf8")), config);
    this.assertFalse(existsSync(paths(this.path).control));
    writeFileSync(file, JSON.stringify(original));
    this.env.CORGI_FAKE_TS_FAIL = "1";
    const failed = await run([EXE, "remote", "start"], { env: this.env, check: false });
    this.assertNotEqual(failed.code, 0);
    this.assertIn("Serve is unavailable", failed.stderr);
    await this.wait_stopped();
    this.assertEqual(JSON.parse(readFileSync(file, "utf8")), original);
    delete this.env.CORGI_FAKE_TS_FAIL;
    await this.remote("start");
    this.assertEqual((await this.local("status")).origin, origin);
  }
  async test_permission_denial_without_a_terminal_explains_sudo_and_rolls_back() {
    const file = this.env.CORGI_FAKE_TS_STATE!,
      original = readFileSync(file, "utf8");
    this.env.CORGI_FAKE_TS_FAIL = "permission";
    const failed = await run([EXE, "remote", "start"], { env: this.env, check: false });
    this.assertNotEqual(failed.code, 0);
    this.assertIn("interactive terminal as your normal user, without sudo", failed.stderr);
    await this.wait_stopped();
    this.assertEqual(readFileSync(file, "utf8"), original);
  }
  async test_redirect_setup_failure_removes_only_new_routes() {
    const file = this.env.CORGI_FAKE_TS_STATE!,
      original = readFileSync(file, "utf8");
    this.env.CORGI_FAKE_TS_FAIL = "redirect";
    const failed = await run([EXE, "remote", "start"], { env: this.env, check: false });
    this.assertNotEqual(failed.code, 0);
    await this.wait_stopped();
    this.assertEqual(readFileSync(file, "utf8"), original);
  }
  async test_pair_prints_qr_and_three_links_until_interrupted() {
    await this.remote("start");
    const redirect = await fetch("http://localhost/api/session?secret=discard", {
      unix: paths(this.path).redirect,
      redirect: "manual",
    });
    this.assertEqual(redirect.status, 303);
    this.assertEqual(redirect.headers.get("Location"), origin + "/");
    const pty = await Pty.spawn([EXE, "remote", "pair"], { env: this.env, cols: 140, rows: 60 });
    try {
      await pty.waitFor("Waiting for your phone");
      this.assertIn("\x1b[30;47m", pty.output);
      const url = pty.output.match(/MagicDNS: (\S+)/)![1],
        token = new URL(url).hash.slice(6);
      this.assertIn(`IPv4:     http://100.101.102.103:8080/#pair=${token}`, pty.output);
      this.assertIn(`IPv6:     http://[fd7a:115c:a1e0::1234]:8080/#pair=${token}`, pty.output);
      const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const claim = await (
        await this.api("/api/pair", {
          token,
          name: "QR phone",
          key: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
        })
      ).json();
      await pty.waitFor("to approve");
      pty.write(claim.code + "\n");
      await pty.waitFor(output => (output.match(/MagicDNS:/g)?.length ?? 0) === 2);
      this.assertEqual((await (await this.api("/api/pair/status", { claim: claim.claim })).json()).state, "approved");
      this.assertEqual(pty.proc.exitCode, null);
      const next = [...pty.output.matchAll(/MagicDNS: (\S+)/g)].at(-1)![1];
      // Cross a heartbeat, then verify the command still accepts a new phone.
      await sleep(11);
      const pending = await (
        await this.api("/api/pair", {
          token: new URL(next).hash.slice(6),
          name: "Second phone",
          key: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
        })
      ).json();
      await pty.waitFor("Second phone");
      pty.write("\x03");
      this.assertEqual(await deadline(pty.proc.exited, 3000), 0);
      this.assertEqual((await this.api("/api/pair/status", { claim: pending.claim })).status, 400);
      this.assertEqual(
        (
          await this.api("/api/pair", {
            token: new URL(next).hash.slice(6),
            name: "Too late",
            key: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
          })
        ).status,
        400,
      );
    } finally {
      await pty.close();
    }
  }
}
registerCase("RemoteControl", RemoteControl, { inherited: false });
