/** Bound decoded JSON strings while scanning through arbitrarily long JSONL records. */
export class Line {
  private bytes = Buffer.alloc(4096);
  private used = 0;
  private string = false;
  private length = 0;
  private escape = false;
  private unicode = 0;
  private keepEscape = false;
  truncated = false;
  omitted = false;
  push(byte: number) {
    if (this.omitted) return;
    if (!this.string) {
      this.add(byte);
      if (byte === 34) {
        this.string = true;
        this.length = 0;
      }
    } else if (this.unicode) {
      if (this.keepEscape) this.add(byte);
      this.unicode--;
    } else if (this.escape) {
      if (this.keepEscape) this.add(byte);
      this.escape = false;
      if (byte === 117) this.unicode = 4;
    } else if (byte === 34) {
      this.add(byte);
      this.string = false;
    } else {
      const keep = this.length++ < 64 * 1024;
      if (keep) this.add(byte);
      else this.truncated = true;
      if (byte === 92) {
        this.escape = true;
        this.keepEscape = keep;
      }
    }
  }
  private add(byte: number) {
    if (this.used === this.bytes.length) {
      if (this.used === 2 * 1024 * 1024) {
        this.omitted = true;
        return;
      }
      const next = Buffer.alloc(this.bytes.length * 2);
      this.bytes.copy(next);
      this.bytes = next;
    }
    this.bytes[this.used++] = byte;
  }
  value(): unknown {
    if (this.omitted) return null;
    const text = this.bytes.toString("utf8", 0, this.used).trim();
    return text ? JSON.parse(text) : null;
  }
}
