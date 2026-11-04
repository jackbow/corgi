import { expect, test } from "bun:test";
import { Line } from "./transcript_line";
function decode(value: unknown) {
  const line = new Line();
  for (const byte of Buffer.from(JSON.stringify(value))) line.push(byte);
  return line;
}
test("shortens giant strings without losing following metadata or JSON escape boundaries", () => {
  for (const ending of ['"', "\\", "\n", "\u0001", "😀"]) {
    for (let padding = 65530; padding <= 65537; padding++) {
      const line = decode({ text: "a".repeat(padding) + ending + "b".repeat(100000), uuid: "tail-id" });
      const value = line.value() as { text: string; uuid: string };
      expect(value.uuid).toBe("tail-id");
      expect(value.text.length).toBeLessThanOrEqual(65542);
      expect(line.truncated).toBe(true);
    }
  }
});
test("normal strings and non-string JSON values round trip", () => {
  const input = { nested: [null, true, 3, { text: 'text\\\"\n😀' }], uuid: "id" };
  expect(decode(input).value()).toEqual(input);
});
