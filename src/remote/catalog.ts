import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Provider } from "./types";
import type { Command } from "./types";
export type { Command } from "./types";
export async function catalog(provider: Provider, cwd: string, account = ""): Promise<Command[]> {
  const result = new Map<string, Command>();
  for (const [name, description] of [
    [provider === "codex" ? "new" : "clear", "Start a new conversation"],
    ["compact", "Compact conversation context"],
    ["help", "Show provider help"],
    ["status", "Show session status"],
  ])
    result.set(`/${name}`, { text: `/${name}`, description });
  const base = account || join(homedir(), provider === "codex" ? ".codex" : ".claude");
  const roots: { path: string; skills: boolean }[] = [{ path: join(base, "skills"), skills: true }];
  if (provider === "claude") roots.push({ path: join(base, "commands"), skills: false });
  if (cwd) {
    roots.push(
      { path: join(cwd, ".agents", "skills"), skills: true },
      { path: join(cwd, provider === "codex" ? ".codex" : ".claude", "skills"), skills: true },
    );
    if (provider === "claude") roots.push({ path: join(cwd, ".claude", "commands"), skills: false });
  }
  let entries = 0;
  const read = async (path: string, name: string, skill: boolean) => {
    if (!/^[a-zA-Z0-9_:-]{1,96}$/.test(name)) return;
    try {
      if ((await stat(path)).size > 64 * 1024) return;
      const file = await readFile(path, "utf8"),
        front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(file)?.[1] ?? "";
      const description = (/^description:\s*(.+)$/m.exec(front)?.[1] ?? (skill ? "Skill" : "Custom command"))
        .replace(/^["']|["']$/g, "")
        .slice(0, 200);
      const text = `${provider === "codex" && skill ? "$" : "/"}${name}`;
      result.set(text, { text, description });
    } catch {
      /* Missing or inaccessible provider configuration is optional. */
    }
  };
  const walk = async (path: string, prefix: string, skills: boolean, depth: number) => {
    try {
      const dirs = await readdir(path, { withFileTypes: true });
      for (const entry of dirs) {
        if (++entries > 256) return;
        const name = prefix + entry.name;
        if (entry.isDirectory()) {
          if (skills) await read(join(path, entry.name, "SKILL.md"), name, true);
          else if (depth < 2) await walk(join(path, entry.name), name + ":", false, depth + 1);
        } else if (!skills && entry.isFile() && name.endsWith(".md"))
          await read(join(path, entry.name), name.slice(0, -3), false);
      }
    } catch {
      /* A provider need not define custom commands. */
    }
  };
  for (const root of roots) await walk(root.path, "", root.skills, 0);
  return [...result.values()].slice(0, 128);
}
