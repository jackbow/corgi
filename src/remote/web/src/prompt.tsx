import { useRef, useState } from "react";
import { Button } from "./ui";
import type { Prompt } from "../../types";

export function PromptCard({
  prompt,
  respond,
  terminal,
  disabled,
}: {
  prompt: Prompt;
  respond: (choice: number) => Promise<void>;
  terminal: () => void;
  disabled?: boolean;
}) {
  const lock = useRef(false),
    [pending, setPending] = useState(false),
    [status, setStatus] = useState("");
  return (
    <section className="prompt-card" aria-label="Agent question">
      <p className="eyebrow">Needs your response</p>
      <pre>{prompt.text}</pre>
      {prompt.choices.map(choice => (
        <Button
          key={choice.index}
          disabled={pending || disabled || !!status}
          onClick={async () => {
            if (lock.current) return;
            lock.current = true;
            setPending(true);
            try {
              await respond(choice.index);
              setStatus("Response sent. Waiting for the agent…");
            } catch {
              setStatus("Response not confirmed or prompt changed. Check Terminal before trying again.");
            } finally {
              setPending(false);
            }
          }}
        >
          {choice.text}
        </Button>
      ))}
      <Button variant="ghost" onClick={terminal}>
        Open Terminal
      </Button>
      <p role="status">{status}</p>
    </section>
  );
}
