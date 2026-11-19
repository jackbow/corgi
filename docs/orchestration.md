# Tasks and helper agents

Corgi tracks command runs and submitted agent assignments without replacing its
terminal runtime. Every helper remains an ordinary tab with the usual rendering,
input, history, and provider integration.

```sh
corgi run --name tests -- bun test
corgi run --bg --agent codex --name reviewer "Review this branch"
corgi message reviewer "Check error handling" --busy queue --wait
corgi wait --children all
corgi task list
corgi task get task:123
```

See the bundled `corgi --skill` instructions for the full workflow and `corgi
help --all` for syntax. Commands require a running daemon. `task list` shows all
tracked tasks on that daemon; `--workspace ID` filters it. Outside a managed
pane, launching work and resolving names require `--workspace ID`; a canonical
task ID can be collected anywhere.
Helpers inherit their parent's workspace and cwd. Names are aliases within that
workspace and do not follow mutable tab titles. Explicit parent links stay on
one daemon, including when that daemon is selected through an existing remote
machine connection.

## Delivery and completion

`run --agent AGENT PROMPT` resolves existing launcher configuration, opens a
tab, and waits for readiness before sending the prompt. A trust/approval dialog
is attention, not readiness. The launch task remains inspectable if startup
fails. Agent tasks complete from Corgi's existing lifecycle receipts, with their
evidence source included; process exit is interruption, not successful work.

Tracked messaging defaults to rejecting busy targets. `--busy queue` stores a
FIFO in the daemon, independent of the caller connection. `--busy steer`
requires provider support for the current turn and reports `joined: true`;
it shares that turn's result. Codex and updated OMP extensions support steering;
Claude's existing inbox queues, so it cannot fulfill that policy. Unknown
delivery never retries or releases subsequent queued prompts automatically.
Inspect the session, cancel unsent prompts, and close/replace the helper if its
delivery state cannot be established. `task cancel` does not kill running work.

`wait NAME` selects its latest tracked assignment at registration. `wait
--children any` consumes the parent's unseen attention/completion news. `all`
snapshots the direct children and their accepted assignments; later assignments
do not extend it. Blocked work returns attention rather than success. These
acknowledgments do not change viewer unread indicators.

Command `--output TEXT` waits match new plain output only, across PTY reads and
terminal escape boundaries. They do not search historic output. A truncated
interval is reported rather than treated as readiness. Command output merges
stdout/stderr because it comes from the terminal.
Exiting without a fresh match returns `output_not_found` and a nonzero status.

Waits default to 180 seconds. Timeout (exit 124) and Ctrl+C (130) end only the
CLI waiter. Foreground command runs return the command's status; unsuccessful
agent/aggregate waits return 1. `--json` returns the reason and task records.

## Notifications and lifetime

Automatic notes report completed, blocked, failed, and exited child work through
the existing messaging path, waiting around busy parents and recognized drafts
or approval dialogs. Notes identify a task to collect; they do not invent a
summary of its results. `--no-notify` opts a helper out. Automatic notes never
create another orchestration task. Explicit reports use `message parent`.

Orchestration links are separate from native subagents and may cross providers.
They bind to the parent's conversation/generation. Closing or replacing a parent
suppresses delivery to it and leaves its helpers running. Automatic helper
cleanup and cross-daemon parentage are outside this version.

## Retention and reload

Each task retains a valid UTF-8 output tail of at most 256 KiB. At most 256 settled
records are retained in addition to pending work and live helpers' latest
assignments. Pruned IDs return `TaskExpired`. There are at most 1024 pending
assignments and 1024 recent parent events.

Live handoff preserves task records, FIFO prompts, links, output decoding state,
and notification progress. CLI subscriptions reconnect without repeating a
launch or send. A small private command exit receipt preserves the shell's exit
status even after its original daemon has gone. Missing exit evidence returns
unknown. In-flight delivery during handoff is uncertain and never retried.
Cold recovery marks unfinished tasks unknown and clears their unsent prompts;
it does not automatically resume an old assignment.
