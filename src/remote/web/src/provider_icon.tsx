import claude from "../../../../assets/brand_icons/claude.svg?raw";
import codex from "../../../../assets/brand_icons/openai.svg?raw";
import type { Pane } from "./types";

function path(svg: string) {
  const value = / d="([^"]+)"/.exec(svg)?.[1];
  if (!value) throw Error("InvalidProviderIcon");
  return value;
}
const paths = { claude: path(claude), codex: path(codex) };
export function ProviderIcon({ provider }: { provider: Pane["provider"] }) {
  if (!provider) return null;
  const label = provider === "claude" ? "Claude" : "Codex";
  return (
    <svg
      className={`provider-icon ${provider}`}
      role="img"
      aria-label={label}
      viewBox="0 0 24 24"
      width="20"
      height="20"
    >
      <title>{label}</title>
      <path d={paths[provider]} fill="currentColor" />
    </svg>
  );
}
