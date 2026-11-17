//! A GitHub patch becomes the same file/diff model as a local checkout.
import * as diff from "./diff";
import type { Change, Loaded } from "./git";

export interface File {
  change: Change;
  loaded: Loaded;
}
/** Fill unchanged gaps from one pinned side; changed lines remain exactly as GitHub reported. */
export function context(file: File, content: string): Loaded {
  if (file.loaded.kind !== "diff") return file.loaded;
  const bytes = Buffer.byteLength(content);
  if (bytes > diff.max_bytes) return { kind: "too_large", bytes };
  if (content.includes("\0")) return { kind: "binary" };
  const lines = content ? content.split("\n") : [];
  if (content.endsWith("\n")) lines.pop();
  if (lines.length > diff.max_lines) return { kind: "too_large", bytes };
  const base = file.change.kind === "deleted",
    result = new diff.FileDiff();
  let old = 0,
    next = 0,
    size = 0;
  const push = (kind: diff.Kind, value: string) => {
    value = value.replace(/\r$/, "");
    result.rows.push({
      kind,
      old_no: kind === "insertion" ? 0 : ++old,
      new_no: kind === "deletion" ? 0 : ++next,
      old_at: kind === "insertion" ? -1 : result.old.length,
      new_at: kind === "deletion" ? -1 : result.new.length,
    });
    if (kind !== "insertion") result.old.push(value);
    if (kind !== "deletion") result.new.push(value);
    if (kind === "insertion") result.adds++;
    if (kind === "deletion") result.dels++;
    size += Buffer.byteLength(value) * (kind === "context" ? 2 : 1);
  };
  const gap = (count: number) => {
    if (count < 0 || !Number.isSafeInteger(count)) throw Error("GitHub patch has inconsistent line numbers");
    for (let i = 0; i < count; i++) {
      const line = lines[base ? old : next];
      if (line === undefined) throw Error("GitHub file does not match the PR patch");
      push("context", line);
    }
  };
  const patch = file.loaded.diff;
  for (const row of patch.rows) {
    const oldGap = row.old_no ? row.old_no - old - 1 : null,
      newGap = row.new_no ? row.new_no - next - 1 : null;
    if (oldGap !== null && newGap !== null && oldGap !== newGap)
      throw Error("GitHub patch has inconsistent line numbers");
    gap(oldGap ?? newGap ?? 0);
    const value = patch.text(row);
    if (
      (base ? row.kind !== "insertion" : row.kind !== "deletion") &&
      lines[base ? old : next]?.replace(/\r$/, "") !== value
    )
      throw Error("GitHub file does not match the PR patch");
    push(row.kind, value);
  }
  gap(lines.length - (base ? old : next));
  if (result.old.length + result.new.length > diff.max_lines || size > diff.max_bytes)
    return { kind: "too_large", bytes: size };
  result.units = diff.fold(result.rows);
  return { kind: "diff", diff: result };
}
function path(value: string): string {
  if (!value.startsWith('"')) return value;
  const octal = /\\[0-7]{3}/.test(value);
  const decoded: string = JSON.parse(
    value.replace(/\\([0-7]{3})/g, (_, digits: string) => `\\u00${parseInt(digits, 8).toString(16).padStart(2, "0")}`),
  );
  return octal ? Buffer.from(decoded, "latin1").toString("utf8") : decoded;
}
export function files(patch: string): File[] {
  const result: File[] = [];
  for (const block of patch.split(/(?=^diff --git )/m)) {
    if (!block.startsWith("diff --git ")) continue;
    const header = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/m.exec(block);
    if (!header) throw new Error("Unrecognized GitHub diff header");
    const oldMarker = /^--- (.+)$/m.exec(block),
      newMarker = /^\+\+\+ (.+)$/m.exec(block);
    const renamedFrom = /^(?:rename|copy) from (.+)$/m.exec(block),
      renamedTo = /^(?:rename|copy) to (.+)$/m.exec(block);
    const raw = block.slice("diff --git ".length, block.indexOf("\n") < 0 ? undefined : block.indexOf("\n"));
    const middle = (raw.length - 1) / 2;
    const same =
      Number.isInteger(middle) &&
      raw.slice(0, 2) === "a/" &&
      raw.slice(middle, middle + 3) === " b/" &&
      raw.slice(2, middle) === raw.slice(middle + 3);
    const old = renamedFrom
      ? path(renamedFrom[1])
      : oldMarker && oldMarker[1] !== "/dev/null"
        ? path(oldMarker[1]).replace(/^a\//, "")
        : same
          ? raw.slice(2, middle)
          : path(header[1]).replace(/^a\//, "");
    const next = renamedTo
      ? path(renamedTo[1])
      : newMarker && newMarker[1] !== "/dev/null"
        ? path(newMarker[1]).replace(/^b\//, "")
        : same
          ? raw.slice(middle + 3)
          : path(header[2]).replace(/^b\//, "");
    const added = /^new file mode /m.test(block),
      deleted = /^deleted file mode /m.test(block);
    const bytes = Buffer.byteLength(block),
      parsed = bytes > diff.max_bytes ? null : diff.parse(block),
      binary = parsed === "binary";
    result.push({
      change: {
        path: deleted ? old : next,
        from: old !== next ? old : null,
        kind: added ? "added" : deleted ? "deleted" : old !== next ? "renamed" : "modified",
        adds: binary || !parsed ? null : parsed.adds,
        dels: binary || !parsed ? null : parsed.dels,
        binary,
        generated: false,
        funcname: false,
      },
      loaded: binary ? { kind: "binary" } : !parsed ? { kind: "too_large", bytes } : { kind: "diff", diff: parsed },
    });
  }
  return result;
}
