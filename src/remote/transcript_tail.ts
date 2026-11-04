import type { FileHandle } from "node:fs/promises";
import { Line } from "./transcript_line";

const CHUNK = 256 * 1024;

/** One request's disk and CPU budget, shared by boundary searches and decoding. */
export class Reads {
  private deadline = performance.now() + 150;
  constructor(private remaining: number) {}
  async read(file: FileHandle, offset: number, length: number, backwards = false): Promise<Buffer | undefined> {
    if (this.remaining <= 0 || performance.now() >= this.deadline) return;
    const bytes = Buffer.alloc(Math.min(length, CHUNK, this.remaining));
    if (backwards) offset += length - bytes.length;
    const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
    this.remaining -= bytesRead;
    if (bytesRead !== bytes.length) throw Error("TranscriptChanged");
    return bytes.subarray(0, bytesRead);
  }
}

/** Find complete JSONL records from the end; giant records never accumulate raw buffers. */
export class Tail {
  position: number;
  lastEnd = 0;
  private end: number | undefined;
  private block: Buffer = Buffer.alloc(0);
  private start = 0;
  private index = -1;
  private record?: { start: number; offset: number; end: number; line: Line };
  constructor(size: number) {
    this.position = size;
  }
  async next(file: FileHandle, reads: Reads) {
    while (true) {
      const record = this.record;
      if (record) {
        while (record.offset < record.end) {
          const bytes = await reads.read(file, record.offset, record.end - record.offset);
          if (!bytes) return undefined;
          for (const byte of bytes) if (byte !== 10) record.line.push(byte);
          record.offset += bytes.length;
        }
        this.record = undefined;
        return { value: record.line.value(), offset: record.start, line: record.line };
      }
      if (!this.position) {
        if (!this.end) return null;
        this.record = { start: 0, offset: 0, end: this.end, line: new Line() };
        this.end = 0;
        continue;
      }
      if (this.index < 0) {
        const length = Math.min(CHUNK, this.position),
          start = this.position - length;
        // Budget-limited reads must end at position, rather than skip unread bytes.
        const bytes = await reads.read(file, start, length, true);
        if (!bytes) return undefined;
        this.block = bytes;
        this.start = this.position - bytes.length;
        this.index = bytes.length - 1;
      }
      const newline = this.block.lastIndexOf(10, this.index);
      if (newline < 0) {
        this.position = this.start;
        this.index = -1;
        continue;
      }
      const boundary = this.start + newline + 1;
      this.index = newline - 1;
      this.position = boundary - 1;
      if (this.end === undefined) this.lastEnd = this.end = boundary;
      else {
        this.record = { start: boundary, offset: boundary, end: this.end, line: new Line() };
        this.end = boundary;
      }
    }
  }
}
