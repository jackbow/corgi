import { expect, test } from "bun:test";
import decodeQR from "qr/decode.js";
import { links, qr } from "./pair";

test("terminal QR decodes to the full pairing URL, including its secret fragment", () => {
  const url = "https://mac.tailnet-example.ts.net:8443/#pair=" + "a".repeat(43);
  const lines = qr(url)
    .trimEnd()
    .split("\n")
    .map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const width = lines[0].length * 8,
    height = lines.length * 16,
    data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c = lines[Math.floor(y / 16)][Math.floor(x / 8)];
      const dark = c === "█" || (y % 16 < 8 ? c === "▀" : c === "▄");
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = dark ? 0 : 255;
      data[i + 3] = 255;
    }
  expect(decodeQR({ width, height, data })).toBe(url);
});
test("all three pairing links share the token and IPv6 is bracketed", () => {
  const url = "https://mac.example.ts.net:8443/#pair=secret";
  expect(
    links(url, {
      dns: "https://mac.example.ts.net:8443",
      ipv4: "http://100.64.1.2:8080/",
      ipv6: "http://[fd7a:115c:a1e0::1]:8080/",
    }),
  ).toEqual({
    dns: url,
    ipv4: "http://100.64.1.2:8080/#pair=secret",
    ipv6: "http://[fd7a:115c:a1e0::1]:8080/#pair=secret",
  });
});
