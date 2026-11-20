import { afterEach, expect, test } from "bun:test";
import * as codePalette from "./code_palette";
import * as palette from "./palette";
import { contrast } from "./terminal_palette";

afterEach(() => codePalette.use(codePalette.defaults));
test.each([...codePalette.palettes])("%s supports both backgrounds without changing the application theme", name => {
  const app = { ...palette.colors };
  for (const code_background of [false, true]) {
    const choice = { code_palette: name, code_background };
    codePalette.use(choice);
    expect(palette.colors).toEqual(app);
    if (!code_background) {
      expect(codePalette.background()).toEqual(palette.colors.bg);
      expect(contrast(codePalette.color([0, 0, 128]), codePalette.background())).toBeGreaterThanOrEqual(4.6);
    }
  }
});
test("unknown palette values fall back to Dark+", () => {
  for (const value of [undefined, null, "future", 1]) expect(codePalette.parse(value)).toBe("dark-plus");
});
test("unrelated preferences do not invalidate code colors", () => {
  codePalette.use(codePalette.defaults);
  const generation = codePalette.generation;
  const prefs = { ...codePalette.defaults, unrelated: true };
  codePalette.use(prefs);
  expect(codePalette.generation).toBe(generation);
  expect(codePalette.current).toEqual(codePalette.defaults);
});
