import { expect, test } from "bun:test";
import { context, files } from "./remote";

test("PR patches preserve per-file hunks, renames, additions, deletions, and binaries", () => {
  const parsed = files(`diff --git a/a.ts b/a.ts
index a..b 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
@@ -20 +20 @@
-before
+after
diff --git a/old name b/new name
similarity index 100%
rename from old name
rename to new name
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+added
diff --git a/gone b/gone
deleted file mode 100644
--- a/gone
+++ /dev/null
@@ -1 +0,0 @@
-deleted
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
`);
  expect(parsed.map(f => [f.change.path, f.change.kind])).toEqual([
    ["a.ts", "modified"],
    ["new name", "renamed"],
    ["new.ts", "added"],
    ["gone", "deleted"],
    ["image.png", "modified"],
  ]);
  expect(parsed[0].change.adds).toBe(2);
  expect(parsed[0].loaded.kind === "diff" && parsed[0].loaded.diff.rows.at(-1)?.new_no).toBe(20);
  expect(parsed[1].change.from).toBe("old name");
  expect(parsed[4].loaded.kind).toBe("binary");
});
test("quoted Git paths decode UTF-8 octal sequences", () => {
  expect(files('diff --git "a/\\303\\251.ts" "b/\\303\\251.ts"\n')[0].change.path).toBe("é.ts");
});

test("spaces followed by b/ in file names are not mistaken for the header separator", () => {
  const result = files(
    "diff --git a/dir b/name b/dir b/name\n--- a/dir b/name\n+++ b/dir b/name\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/image b/one.png b/image b/one.png\nBinary files a/image b/one.png and b/image b/one.png differ\n",
  );
  expect(result.map(file => file.change.path)).toEqual(["dir b/name", "image b/one.png"]);
});

test("large PR files use the diff viewer's size limit", () => {
  const file = files(
    "diff --git a/huge.ts b/huge.ts\n--- a/huge.ts\n+++ b/huge.ts\n@@ -0,0 +1 @@\n+" + "a".repeat(2_000_001),
  )[0];
  expect(file.loaded.kind).toBe("too_large");
  expect(file.change.path).toBe("huge.ts");
});

test("full PR context fills gaps around multiple hunks without changing edits or line numbers", () => {
  const old = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`),
    head = [...old];
  head[4] = "replacement";
  head.splice(12, 0, "inserted");
  head.splice(20, 1);
  const file = files(
    "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -5 +5 @@\n-line 5\n+replacement\n@@ -12,0 +13 @@\n+inserted\n@@ -20 +20,0 @@\n-line 20\n",
  )[0];
  const loaded = context(file, head.join("\n") + "\n");
  expect(loaded.kind).toBe("diff");
  if (loaded.kind !== "diff") return;
  expect(loaded.diff.old).toEqual(old);
  expect(loaded.diff.new).toEqual(head);
  expect(loaded.diff.adds).toBe(2);
  expect(loaded.diff.dels).toBe(2);
  expect(loaded.diff.rows.at(-1)).toMatchObject({ old_no: 30, new_no: 30 });
  expect(loaded.diff.units.some(unit => unit.kind === "fold")).toBe(true);
  expect(() => context(file, "different revision\n")).toThrow("does not match");
});

test("full PR context supports added, deleted, renamed, empty and CRLF files and respects limits", () => {
  for (const [patch, content, expectedOld, expectedNew] of [
    ["new file mode 100644\n@@ -0,0 +1 @@\n+added\n", "added", [], ["added"]],
    ["deleted file mode 100644\n@@ -1 +0,0 @@\n-deleted\n", "deleted\n", ["deleted"], []],
    ["rename from old.ts\nrename to new.ts\n", "same\r\n", ["same"], ["same"]],
    ["new file mode 100644\n", "", [], []],
  ] as const) {
    const loaded = context(files("diff --git a/old.ts b/new.ts\n" + patch)[0], content);
    expect(loaded.kind).toBe("diff");
    if (loaded.kind === "diff") {
      expect(loaded.diff.old).toEqual([...expectedOld]);
      expect(loaded.diff.new).toEqual([...expectedNew]);
    }
  }
  const file = files("diff --git a/a b/a\n")[0];
  expect(context(file, "a".repeat(2_000_001)).kind).toBe("too_large");
  expect(context(file, "\n".repeat(50_001)).kind).toBe("too_large");
  expect(context(file, "binary\0data").kind).toBe("binary");
});
