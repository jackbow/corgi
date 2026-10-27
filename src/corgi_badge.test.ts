import { test, expect } from "bun:test";
import { State, reply_prefix, hit, mark } from "./corgi_badge";
const reply = (body: string) => reply_prefix + body + "\x1b\\";
test("the text mark is available before graphics probing and after rejection", () => {
  const s = new State();
  expect(s.mode()).toBe("mark");
  expect(mark).toBe(">_");
  expect(s.supports_kitty_graphics).toBe(false);
  expect(s.accept(reply("i=730031;ENOTSUP"))).toBe(true);
  expect(s.status).toBe("unavailable");
  expect(s.mode()).toBe("mark");
  expect(s.accept(reply("i=730031;OK"))).toBe(true);
  expect(s.supports_kitty_graphics).toBe(true);
  expect(s.mode()).toBe("mark");
});
test("mark hit area covers only the two visible cells", () => {
  for (const [x, y, expected] of [
    [1, 0, false],
    [2, 0, true],
    [3, 0, true],
    [4, 0, false],
    [2, 1, false],
  ] as const)
    expect(hit("mark", 30, x, y)).toBe(expected);
  expect(hit("none", 30, 2, 0)).toBe(false);
  expect(hit("mark", 0, 2, 0)).toBe(false);
});
test("graphics probe replies require exact IDs and complete packets", () => {
  const s = new State();
  for (const body of [
    "i=0;OK",
    "i=7300319;OK",
    "p=1;OK",
    "i=730031,p=2;OK",
    "i=730031,i=0;OK",
    "i=0,i=730031;OK",
    "i=730031,p=1,p=2;OK",
    "i=-730031;OK",
    "i=730031,p=4294967296;OK",
  ])
    expect(s.accept(reply(body))).toBe(false);
  expect(s.accept(reply_prefix + "i=730031;OK")).toBe(false);
  expect(s.accept("i=730031;OK\x1b\\")).toBe(false);
  expect(s.supports_kitty_graphics).toBe(false);
  expect(s.accept(reply("p=1,i=730031;OK"))).toBe(true);
  expect(s.supports_kitty_graphics).toBe(true);
});
