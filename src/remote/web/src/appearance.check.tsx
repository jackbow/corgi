import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyAppearance, pureBlack, setPureBlack } from "./appearance";

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("localStorage", sessionStorage);
  document.documentElement.removeAttribute("data-pure-black");
});
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-pure-black");
});
it("defaults to black and restores the saved appearance before rendering", () => {
  expect(pureBlack()).toBe(true);
  setPureBlack(false);
  expect(pureBlack()).toBe(false);
  expect(document.documentElement.hasAttribute("data-pure-black")).toBe(false);
  setPureBlack(true);
  expect(pureBlack()).toBe(true);
  document.documentElement.removeAttribute("data-pure-black");
  applyAppearance(pureBlack());
  expect(document.documentElement.hasAttribute("data-pure-black")).toBe(true);
});
it("still changes appearance when phone storage is unavailable", () => {
  vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
    throw Error("Unavailable");
  });
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw Error("Unavailable");
  });
  expect(pureBlack()).toBe(true);
  setPureBlack(true);
  expect(document.documentElement.hasAttribute("data-pure-black")).toBe(true);
  setPureBlack(false);
  expect(document.documentElement.hasAttribute("data-pure-black")).toBe(false);
});
