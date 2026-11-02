import { expect, test } from "bun:test";
import { origin, route } from "./tailscale";
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
