import { expect, test } from "bun:test";
import { Canvas } from "./canvas";
import { colors } from "./palette";
import { Writer } from "./text";

test("canvas views share styled cells and translate hit positions", () => {
  const canvas = new Canvas<{ action: string }>(3, 4, 6, 4);
  const view = canvas.view(2, 1, 2, 2);
  view.put(0, 0, "x", colors.accent, null, false, 7);
  view.hit(0, 0, 1, 1, { action: "open" });
  const writer = new Writer();
  canvas.flush(writer);
  expect(writer.buffered().toString()).toContain("\x1b[1m\x1b[3m\x1b[4m");
  expect(canvas.hits).toEqual([{ x: 5, y: 5, w: 1, h: 1, action: "open" }]);
  view.fill(0, null);
  expect(canvas.cells[1][2]).toMatchObject({ ch: " ", bold: false, italic: false, underline: false });
});
