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
}
export interface Snapshot {
  server: number;
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
}
