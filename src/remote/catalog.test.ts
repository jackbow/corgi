import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalog } from "./catalog";
test("command discovery returns only bounded names and descriptions, scoped to the provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-catalog-"));
  try {
    await mkdir(join(dir, ".claude/commands/team"), { recursive: true });
    await mkdir(join(dir, ".agents/skills/check"), { recursive: true });
    await writeFile(
      join(dir, ".claude/commands/team/review.md"),
      "---\ndescription: Review the change\n---\nSECRET COMMAND BODY",
    );
    await writeFile(
      join(dir, ".agents/skills/check/SKILL.md"),
      "---\ndescription: Check the change\n---\nPRIVATE INSTRUCTIONS",
    );
    const commands = await catalog("claude", dir, join(dir, "account"));
    expect(commands).toContainEqual({ text: "/team:review", description: "Review the change" });
    expect(commands).toContainEqual({ text: "/check", description: "Check the change" });
    expect(JSON.stringify(commands)).not.toContain("SECRET");
    expect(JSON.stringify(commands)).not.toContain("PRIVATE");
    expect(JSON.stringify(commands)).not.toContain(dir);
    const codex = await catalog("codex", dir, join(dir, "account"));
    expect(codex).toContainEqual({ text: "$check", description: "Check the change" });
    expect(codex.some(c => c.text === "/team:review")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
