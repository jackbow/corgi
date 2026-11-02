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
    if (code !== 0)
      throw Error(`tailscale ${args.slice(0, 2).join(" ")}: ${stderr.trim() || stdout.trim() || "command failed"}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
