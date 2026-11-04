import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function spoken(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .slice(0, 6000)
    .trim();
}
export function hasAudio(bytes: Buffer) {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString("ascii", offset, offset + 4) === "data") return size > 0 && offset + 8 + size <= bytes.length;
    offset += 8 + size + (size % 2);
  }
  return false;
}
export async function speech(text: string, signal: AbortSignal): Promise<Uint8Array> {
  if (process.platform !== "darwin") throw Error("Unsupported");
  const value = spoken(text);
  if (!value) throw Error("NothingToRead");
  const dir = await mkdtemp(join(tmpdir(), "corgi-speech-"));
  const run = async (args: string[], input?: string) => {
    const process = Bun.spawn(args, {
      stdin: input ? new Blob([input]) : "ignore",
      stdout: "ignore",
      stderr: "ignore",
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    if ((await process.exited) !== 0) throw Error("SpeechUnavailable");
  };
  try {
    await run(
      ["/usr/bin/say", "--file-format=WAVE", "--data-format=LEI16@22050", "-r", "180", "-o", join(dir, "speech.wav")],
      value,
    );
    if ((await stat(join(dir, "speech.wav"))).size > 32 * 1024 * 1024) throw Error("SpeechUnavailable");
    const bytes = await readFile(join(dir, "speech.wav"));
    if (!hasAudio(bytes)) throw Error("SpeechUnavailable");
    return bytes;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
