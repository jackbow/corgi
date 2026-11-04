import { join } from "node:path";
import { existsSync } from "node:fs";

const directory = join(import.meta.dir, "../src/remote/web");
export async function command(name: "build" | "typecheck" | "test") {
  if (!existsSync(join(directory, "node_modules/react"))) {
    const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
      cwd: directory,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (await install.exited) throw Error("Phone dependency install failed");
  }
  const process_ = Bun.spawn([process.execPath, "run", name], { cwd: directory, stdout: "inherit", stderr: "inherit" });
  return process_.exited;
}
export async function build(): Promise<string> {
  if (await command("build")) throw Error("Phone build failed");
  const files = [...new Bun.Glob("**/*").scanSync({ cwd: join(directory, "dist"), onlyFiles: true })]
    .filter(path => /\.(html|js|css|woff2|txt)$/.test(path))
    .sort();
  return (
    files
      .map((path, i) => `import asset${i} from ${JSON.stringify(join(directory, "dist", path))} with {type:"file"};`)
      .join("\n") +
    `\nexport const files={${files.map((path, i) => `${JSON.stringify("/" + path)}:asset${i}`).join(",")}};`
  );
}
