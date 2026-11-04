import { join } from "node:path";

/** Replaced by the compiler with an explicit table of embedded files. */
export const files: Record<string, string> = Object.fromEntries(
  [...new Bun.Glob("**/*").scanSync({ cwd: join(import.meta.dir, "web/dist"), onlyFiles: true })]
    .filter(path => /\.(html|js|css|woff2|txt|webmanifest|svg|png)$/.test(path))
    .map(path => ["/" + path, join(import.meta.dir, "web/dist", path)]),
);
