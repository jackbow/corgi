import { expect, test } from "bun:test";
import { files } from "./web_assets";

test("phone assets have local scripts/fonts and no offline cache or inline executable code", async () => {
  const html = await Bun.file(files["/index.html"]).text();
  expect(html).toContain('type="module"');
  expect(html).not.toMatch(/https?:\/\/|serviceWorker|<script[^>]*>[^<\s]/);
  expect(Object.keys(files).some(path => path.endsWith(".woff2"))).toBe(true);
  for (const match of html.matchAll(/(?:src|href)="(\/[^\"]+)"/g)) expect(files[match[1]]).toBeDefined();
});
