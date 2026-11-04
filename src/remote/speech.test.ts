import { expect, test } from "bun:test";
import { spoken, speech, hasAudio } from "./speech";
test("speech omits fenced code and bounds long responses", async () => {
  expect(spoken("Summary\n```sh\nsecret command\n```\nDone")).toBe("Summary\n Code block omitted. \nDone");
  expect(spoken("x".repeat(10000))).toHaveLength(6000);
  if (process.platform === "darwin")
    await expect(speech(" ", new AbortController().signal)).rejects.toThrow("NothingToRead");
});
test("empty or malformed speech output is rejected instead of playing silent audio", () => {
  const bytes = Buffer.alloc(22);
  bytes.write("RIFF");
  bytes.write("WAVE", 8);
  bytes.write("data", 12);
  expect(hasAudio(bytes)).toBe(false);
  bytes.writeUInt32LE(2, 16);
  expect(hasAudio(bytes)).toBe(true);
  bytes.writeUInt32LE(4, 16);
  expect(hasAudio(bytes)).toBe(false);
});
