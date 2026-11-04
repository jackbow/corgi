import type { Outcome } from "../observation";
export type Provider = "codex" | "claude";
export interface LastResponse {
  availability: "available" | "indexing" | "unavailable";
  text: string;
}
export interface Pane {
  id: number;
  workspace: number;
  name: string;
  state: string;
  activity: string;
  binding: string;
  exited: boolean;
  provider: Provider | null;
  conversation: string;
  branch: string;
  order: number;
  attention: string;
  lastResponse?: LastResponse;
  completion?: string;
  outcome?: Outcome;
}
export interface Snapshot {
  server: number;
  observed?: number;
  workspaces: { id: number; name: string; order: number }[];
  panes: Pane[];
}
export interface Identity {
  server: number;
  binding: string;
  conversation: string;
}
export interface Terminal extends Identity {
  pane: number;
  cols: number;
  rows: number;
  lines: string[];
}
export interface Launch {
  server: number;
  workspace: number;
  provider: Provider;
  profile?: string;
}
export interface Profile {
  id: string;
  name: string;
  provider: Provider;
}

export type Management =
  | { action: "rename-agent"; pane: number; identity: Identity; name: string }
  | { action: "stop-agent" | "clear-agent"; pane: number; identity: Identity; confirm: true }
  | { action: "create-workspace"; server: number; name: string; cwd: string }
  | { action: "rename-workspace"; server: number; workspace: number; name: string }
  | { action: "close-workspace"; server: number; workspace: number; confirm: true }
  | { action: "move-workspace"; server: number; workspace: number; before: number };

export interface Prompt {
  id: string;
  text: string;
  choices: { index: number; text: string; selected: boolean }[];
  multiple: boolean;
}

export interface Preferences {
  finished: boolean;
  input: boolean;
  failed: boolean;
  cooldown: number;
  settle: number;
  snoozeUntil: number;
}

export interface Command {
  text: string;
  description: string;
}

export interface UpdateState {
  phase: "idle" | "running" | "complete" | "failed" | "deferred" | "unsupported";
  server: number;
  current?: string;
  staged?: string;
  message: string;
}
