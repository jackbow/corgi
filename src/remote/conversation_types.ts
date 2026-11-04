export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  name?: string;
  truncated?: boolean;
}
export interface Conversation {
  availability: "available" | "unavailable" | "oversized" | "replaced";
  version: string;
  messages: Message[];
  before: string | null;
  after: string | null;
  more: boolean;
}
