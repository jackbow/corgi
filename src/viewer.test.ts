import { expect, test } from "bun:test";
import * as viewer from "./viewer";
import { Controller } from "./controller";
import { version } from "./viewer_version";
import * as sound from "./sound";
import { spyOn } from "bun:test";

const text = (chunk: Uint8Array) => Buffer.from(chunk).toString();

test("pushed frames deliver permission notification targets once and honor mute", async () => {
  const view = new Controller({ request: async () => ({ ok: true }) } as any),
    bell = { seq: 0n },
    target = { conversation: 17 },
    received: unknown[] = [],
    play = spyOn(sound, "play").mockImplementation(() => {});
  view.notify = (...args) => {
    received.push(args);
  };
  const frame = {
    type: "view" as const,
    viewer_protocol: version,
    session: null,
    session_hash: 0n,
    resources: null,
    resources_hash: 0n,
    surfaces: [],
    bell_seq: 1n,
    bell_kind: "needs_input" as const,
    bell_target: target,
    controls: [],
    viewer: 1,
    detach: false,
  };
  try {
    await viewer.receive(view, frame, bell, true);
    await viewer.receive(view, frame, bell, true);
    expect(received).toEqual([["needs_input", target, view.machine]]);
    view.muted = true;
    await viewer.receive(view, { ...frame, bell_seq: 2n }, bell, true);
    expect(received).toHaveLength(1);
  } finally {
    play.mockRestore();
    viewer.close(view);
  }
});

test("keys that arrive while input is handled reach the next call", async () => {
  const input = [...Buffer.from("t")],
    decoder = new TextDecoder("utf-8", { ignoreBOM: true }),
    seen: string[] = [];
  await viewer.takeInput(input, decoder, async chunk => {
    seen.push(text(chunk));
    // Stdin appends to the same queue while a handler waits on the daemon.
    input.push(...Buffer.from("printf ok\r"));
  });
  await viewer.takeInput(input, decoder, async chunk => void seen.push(text(chunk)));
  expect(seen).toEqual(["t", "printf ok\r"]);
});

test("a split character waits for its last byte and an invalid byte keeps the keys after it", async () => {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true }),
    seen: string[] = [],
    handle = async (chunk: Uint8Array) => void seen.push(text(chunk));
  await viewer.takeInput([0x61, 0xc3], decoder, handle);
  await viewer.takeInput([0xa9], decoder, handle);
  await viewer.takeInput([0x62, 0xff, 0x63, 0x64, 0x65, 0x66], decoder, handle);
  expect(seen).toEqual(["a", "é", "b�cdef"]);
});
