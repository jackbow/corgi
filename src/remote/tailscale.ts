import { str, field } from "../json";
export const httpsPort = 8443;
export function origin(value: unknown): string {
  const self = field(value, "Self"),
    dns = str(self, "DNSName").replace(/\.$/, "");
  if (str(value, "BackendState") !== "Running" || field(self, "Online") !== true)
    throw Error("Connect this computer to Tailscale first.");
  if (!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(dns)) throw Error("Tailscale MagicDNS is required.");
  return `https://${dns.toLowerCase()}:${httpsPort}`;
}
/** Only our exclusive HTTPS listener may be reused or removed. */
export function route(config: unknown, address: string, target: string): "absent" | "owned" {
  const host = new URL(address).host;
  if (field(field(config, "AllowFunnel"), host))
    throw Error("Disable Funnel on the Corgi port before enabling remote control.");
  const tcp = field(field(config, "TCP"), String(httpsPort)),
    web = field(field(config, "Web"), host);
  if (!tcp && !web) return "absent";
  const handlers = field(web, "Handlers");
  if (
    field(tcp, "HTTPS") === true &&
    handlers &&
    typeof handlers === "object" &&
    Object.keys(handlers).length === 1 &&
    str(field(handlers, "/"), "Proxy") === target
  )
    return "owned";
  throw Error(`Tailscale port ${httpsPort} already has another service; its configuration was left unchanged.`);
}
export async function run(args: string[]): Promise<string> {
  const child = Bun.spawn([process.env.CORGI_TAILSCALE ?? "tailscale", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new CommandError(args, stderr.trim() || stdout.trim() || "command failed");
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the CLI's authorization error once, at the process boundary. */
export class CommandError extends Error {
  readonly denied: boolean;
  constructor(args: string[], output: string) {
    super(`tailscale ${args.slice(0, 2).join(" ")}: ${output}`);
    this.denied = /401 Unauthorized|403 Forbidden|Access denied:/.test(output);
  }
}
export function elevatedCommand(args: string[], program = process.env.CORGI_TAILSCALE ?? "tailscale") {
  const binary = Bun.which(program);
  if (!binary) throw Error("Tailscale is not installed or not on PATH.");
  return ["/usr/bin/sudo", "--", binary, ...args];
}
async function elevate(args: string[]) {
  const child = Bun.spawn(elevatedCommand(args), { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    if ((await child.exited) !== 0) throw Error("Tailscale configuration failed; see the error above.");
  } finally {
    clearTimeout(timer);
  }
}
/** Keep Corgi unprivileged; elevate only the Serve configuration if required. */
export async function configure(
  args: string[],
  options: { run?: typeof run; elevate?: typeof elevate; interactive?: boolean } = {},
) {
  try {
    await (options.run ?? run)(args);
  } catch (error) {
    if (!(error instanceof CommandError) || !error.denied) throw error;
    if (!(options.interactive ?? (process.stdin.isTTY === true && process.stderr.isTTY === true))) {
      const command = args.at(-1) === "off" ? "stop" : "start";
      throw Error(
        `Tailscale requires administrator permission. Run corgi remote ${command} in an interactive terminal as your normal user, without sudo; Corgi will elevate only Tailscale.`,
      );
    }
    process.stderr.write(
      "Tailscale needs administrator permission for its private-socket route. Only Tailscale will run with sudo; Corgi stays under your account.\n",
    );
    await (options.elevate ?? elevate)(args);
  }
}
