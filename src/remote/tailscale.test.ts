import { expect, test } from "bun:test";
import { CommandError, configure, elevatedCommand, origin, route } from "./tailscale";
const address = "https://mac.example.ts.net:8443",
  target = "unix:/tmp/corgi/http.sock";
const config = () => ({
  TCP: { "8443": { HTTPS: true } },
  Web: { "mac.example.ts.net:8443": { Handlers: { "/": { Proxy: target } } } },
});
test("only a running Tailscale node supplies the HTTPS address", () => {
  expect(origin({ BackendState: "Running", Self: { DNSName: "mac.example.ts.net.", Online: true } })).toBe(address);
  for (const s of [
    {},
    { BackendState: "NeedsLogin" },
    { BackendState: "Running", Self: { Online: false } },
    { BackendState: "Running", Self: { Online: true, DNSName: "mac.local" } },
  ])
    expect(() => origin(s)).toThrow();
});
test("Serve setup preserves other services and refuses Funnel", () => {
  expect(route({}, address, target)).toBe("absent");
  expect(route({ TCP: { "443": { HTTPS: true } } }, address, target)).toBe("absent");
  expect(route(config(), address, target)).toBe("owned");
  const other = config();
  other.Web["mac.example.ts.net:8443"].Handlers["/"].Proxy = "http://localhost:1234";
  expect(() => route(other, address, target)).toThrow("another service");
  expect(() => route({ ...config(), AllowFunnel: { "mac.example.ts.net:8443": true } }, address, target)).toThrow(
    "Funnel",
  );
  expect(() => route({ TCP: { "8443": { TCPForward: "localhost:22" } } }, address, target)).toThrow("another service");
});

test("Serve permission failures elevate only Tailscale, preserving exact arguments", async () => {
  const args = ["serve", "--bg", "--yes", "--https=8443", "unix:/tmp/private socket.sock"];
  const elevated: string[][] = [];
  await configure(args, {
    interactive: true,
    run: async words => {
      throw new CommandError(words, "401 Unauthorized: must be root");
    },
    elevate: async words => {
      elevated.push(words);
    },
  });
  expect(elevated).toEqual([args]);
  const argv = elevatedCommand(args, process.execPath);
  expect(argv.slice(0, 2)).toEqual(["/usr/bin/sudo", "--"]);
  expect(argv[2]).toBe(Bun.which(process.execPath)!);
  expect(argv.slice(3)).toEqual(args);
});
test("Serve avoids elevation when permitted, on unrelated failures, and without a terminal", async () => {
  let elevated = false;
  const elevate = async () => {
    elevated = true;
  };
  await configure(["serve"], { run: async () => "ok", elevate, interactive: true });
  expect(elevated).toBe(false);
  await expect(
    configure(["serve"], {
      run: async args => {
        throw new CommandError(args, "Serve is unavailable");
      },
      elevate,
      interactive: true,
    }),
  ).rejects.toThrow("Serve is unavailable");
  expect(elevated).toBe(false);
  await expect(
    configure(["serve"], {
      run: async args => {
        throw new CommandError(args, "401 Unauthorized");
      },
      elevate,
      interactive: false,
    }),
  ).rejects.toThrow("without sudo");
  expect(elevated).toBe(false);
  await expect(
    configure(["serve", "--https=8443", "off"], {
      run: async args => {
        throw new CommandError(args, "Access denied: permission required");
      },
      elevate,
      interactive: false,
    }),
  ).rejects.toThrow("remote stop");
});
test("a denied administrator prompt is reported without repeated retries", async () => {
  let attempts = 0;
  await expect(
    configure(["serve"], {
      interactive: true,
      run: async args => {
        throw new CommandError(args, "403 Forbidden");
      },
      elevate: async () => {
        attempts++;
        throw Error("Administrator denied");
      },
    }),
  ).rejects.toThrow("Administrator denied");
  expect(attempts).toBe(1);
});
