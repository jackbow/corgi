export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  name?: string;
  truncated?: boolean;
}
export interface Conversation {
  availability: "available" | "unavailable" | "indexing" | "replaced";
  version: string;
  messages: Message[];
  before: string | null;
  after: string | null;
  more: boolean;
  progress?: { read: number; total: number };
  omitted?: number;
}
