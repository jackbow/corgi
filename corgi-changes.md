# Corgi changes

Application changes added during development.

## Diff viewer defaults

- Local and PR diffs open fullscreen. Cmd+Shift+Enter toggles between fullscreen and a pane beside the agent.
- Fullscreen diffs show a full-height file tree on the left; pane mode keeps the resizable tree above the diff. Narrow fullscreen windows also stack the tree to leave room for code.
- Test files are hidden by default; `t` shows or hides them. Saved per-conversation choices are retained.
- The bottom hint ribbon shows the clickable `Z` shortcut for switching between hunks and full-file context, including PR diffs.

## Compact CLI discovery

- `list` and its new `ls` alias show one row per live pane or headless agent, with pane/tab/workspace IDs, provider, separate workspace/session names and status. Piped text keeps full names. Inactive sessions are counted; `--all` includes them.
- `list --tree` preserves the full workspace/tab/pane outline, split positions, activity, directories and viewer IDs. `--workspace ID` filters text and JSON; default JSON keeps the full snapshot.
- `get TARGET` shows session location, cwd, activity, latest task and parent/helper links, including sessions without tracked tasks.
- Pane commands, focus and task commands resolve exact session/helper names consistently, with workspace scoping and ambiguity errors. Numeric pane IDs, `pane:ID`, `current` and canonical task IDs remain available; closed command tasks can still be collected.

## Task orchestration

- `task list` works without caller or workspace context, lists all daemon tasks by default, and supports an explicit workspace filter. Text rows identify their workspace; empty results print `no tasks`.
- `run` launches commands or configured agent helpers in ordinary tabs, with retained task IDs, workspace names, output tails, and exit results.
- Task-aware `wait` supports completion, fresh command output, child any/all waits, timeout without cancellation, and reconnecting across live reloads.
- Tracked messages support reject, FIFO queue, and provider-supported steering. Helper links and deferred parent notifications remain separate from native subagents; helpers survive parent closure.
- Task records and queues survive live handoff; cold recovery never replays assignments. Existing plain messaging and viewer behavior are retained.

## Portable development helpers

- macOS probe and signing-key transfer scripts require explicit SSH host settings (`CORGI_PROBE_HOST` and `CORGI_RELEASE_HOST`); the probe also requires `CORGI_PROBE_REMOTE` for the remote checkout path.

## GitHub PR viewer

- Discussion comments can be sent to the conversation's agent input with the PR link, author, file/line range, old-side/outdated markers, and GitHub's saved code context. Sending pastes without submitting; shell panes copy the comment instead.
- Review threads show numbered diff previews where GitHub provides them. **Reply to thread** posts a native review reply; **New comment** (`c`) posts a PR-wide comment. The multiline composer uses Enter for a new line and Tab to select **Post to GitHub** or **Cancel**. Failed posts retain the draft; a successful post clears it even if refreshing fails.

- PR links mentioned by either the user or assistant are collected per conversation, ordered by latest mention. Later `#123` or bare `123` mentions raise an already linked PR when its number is unambiguous in that conversation. PR links stay in the Conversation PRs panel; agent sidebar rows keep their usual activity and animation.
- Cmd+Ctrl+G directly toggles the visibility of the **Conversation PRs** list without taking keyboard focus. Opening it brings a fullscreen viewer back into pane mode without taking its keyboard focus. The list stays open while different PRs open in the GitHub PR viewer. Repositories use rounded group boxes by default (`g` toggles grouping), with bold PR numbers, owner-free labels, fully wrapped titles, and created/updated ages on one line. `s` cycles latest mention, PR number, created, and updated sorting; `n`/`c`/`u` select number/created/updated directly. Merged PRs live in a collapsed section at the bottom (`m` toggles it). Enter opens the selected PR and `r` refreshes metadata.
- Cmd+Shift+K opens a PR conversation search popup across tracked workspaces. Type a PR number or paste its GitHub link for inline results showing workspace and agent title; Up/Down select and Enter switches to the conversation. Links disambiguate repositories, and merged PR mentions remain searchable. Esc closes the popup.
- Opening PR details does not change mention order; transcript rebuilds publish only complete lists so older mentions do not temporarily reorder links.

- PR and local/remote diff views survive viewer restarts and conversation resumes, including navigation and diff layout, keyed by provider session identity.
- Readiness shows unresolved comments, compact **Mark ready** and **Merge** buttons, and a **Resolve conflicts with Codex** button that launches a background `gpt-6.1-sol` agent at medium effort to resolve in an isolated worktree and push the fix.
- **Merge** uses `gh pr merge --auto` with the displayed head: merge immediately when allowed or wait for requirements. A popup warns about stacked dependents before confirming.
- `s` refreshes readiness/checks without reloading discussion, description, or stack; `r` still refreshes everything. The Stack tab only appears for stacks and displays the current position, such as **Stack (2/3)**.
- Cmd+Shift+G toggles the conversation’s PR viewer, preserving its navigation; the shortcut is customizable.
- Merge readiness, checks, reviewers, labels, discussion entries, stack, and merge confirmations use the description-style rounded cards.
- Framed, theme-aware pi-tui panel with Overview, Discussion, and Stack tabs, rendered Markdown, mouse hover/click/scroll interactions, fixed navigation controls, and readiness actions.

- Clicking a GitHub PR link in chat opens a panel with its description, status, merge conflicts, approval requirements, requested reviewers, labels, discussion, and review comments.
- Clicking the check summary expands failed and pending check titles inline. Clicking a failed check retries it; `R` retries all failed checks that GitHub can rerun. Actions retries target individual jobs, with live head/status checks before submitting.
- Discussion shows newest comments first, with unresolved review threads expanded and resolved threads folded. Toggle all discussion/unresolved-only with `u` or a click; inline code uses the syntax blue rather than warning orange.
- The Discussion tab shows the unresolved count, such as **Discussion (2)**, and hides the count when none remain.
- Stack views follow branch dependencies from base PRs to dependents, with titles, a current-PR marker, and separate sibling branches.
- PR details and remote diffs stay with their conversation, retaining tabs, scroll, and thread filters when switching chats.
- Draft status is orange, with an inline **Draft [ Mark ready - v ]** control in merge readiness; the clickable PR-number header and bottom **Open** control open GitHub (`o`); the diff control is labeled **Diff** (`d`).
- PullApprove approval summaries published as GitHub statuses appear in the overview using the existing `gh` login.
- Description content has its own framed heading. Draft and closed PRs explain why merge controls are disabled, and unavailable mergeability is labeled explicitly.
- Merge controls use GitHub's branch rules; merging asks for a method before submitting.
- **Open diff** displays the PR's pinned revisions in the existing diff viewer without changing the checkout. `Z` loads missing context from GitHub on demand and toggles whole files/hunks, reusing loaded content. Failed loads preserve readable hunks and can be retried. **PR details** or `P` returns to the PR panel.
- PR diff comments send to the associated conversation instead of the internal diff pane. Comment and search fields accept reserved shortcut letters normally, including `r` and `P`.
- Views use a 100-entry memory/disk cache with least-recently-used eviction and no expiry. Opening renders cached data first; unmerged PRs older than two days refresh in the background. Merged PRs stay fresh until evicted. `r` always refreshes manually; `o` opens GitHub in the browser.
- `corgi action pull-request <GitHub PR URL>` also opens the panel. It uses the viewer machine's existing `gh` login.

## Diff viewer

- Pasting a directory path into the diff viewer opens it immediately, replacing the path editor’s current value. Note and search-field paste remain normal text input.
- Each conversation has its own diff visibility and selected repo/subfolder, remembered for the lifetime of the viewer.
- Repo/subfolder selection supports fuzzy suggestions, Up/Down selection, Tab/Right completion, and initially unselected text. Outside a Git checkout, the empty state explains that `r` opens another repo by path.
- `C` adds a whole-file review comment for the associated conversation.
- Cmd+Shift+B opens, focuses, or closes the diff viewer.
- Cmd+Shift+Enter toggles fullscreen; leaving fullscreen reveals the conversation panes again.
- `Z` switches between folded hunks and full-file context.
- `t` hides/shows files matching `*.test.*` or located in `test/` or `tests/` folders. The filter stays with each conversation.
- Shift+S switches unified/split diff mode, with the shortcut shown in the bottom band and help panel. The mode stays with each conversation.
- Split diffs support side-by-side line alignment, navigation, wrapping, and comments on either side.

## Workspaces and agents

- New workspaces are created with a single press, without a countdown or holding Enter.
- Right-clicking a tab or agent offers **Move tab to workspace…**, preserving the tab's splits and running processes and following it to the destination.
- Cmd+Shift+A toggles between the workspace-specific agent list and all agents, remembering the preference across viewer restarts.
- The top-left bitmap icon is replaced with a themed `>_` terminal mark.
- Agent rows and tabs share their visual order. Reordering either updates the other; docking, moving, and restoring tabs preserve that order.
- Ctrl+Tab and Ctrl+Shift+Tab cycle through agents in visual order.

## Phone controls and notifications

- The embedded phone app provides paired, authenticated access over Tailscale, with collapsible workspaces, conversation reading, terminal interaction, and Codex/Claude launches.
- Conversations read a bounded recent window (20 messages), reuse cached reads, and process appended records without indexing the full transcript. Drafts survive navigation and failed sends.
- Home Screen support includes a local app icon, an OLED black setting, and integrated web push for completion and permission requests. Permission notifications open the conversation needing attention.
- Phone controls also include agent management, saved launch profiles, slash commands, conversation archives, and local build updates.
- macOS notifications show the conversation and latest response or permission request; clicking focuses the originating conversation. The bundled notification helper preserves this behavior across the upstream multi-machine viewer.
- Phone background services restart automatically when their daemon transport becomes incompatible, retaining paired devices and Tailscale routes.


## Compatibility and validation

- Cancelling or completing sign-in can clean up a staged account even when the system denies process listing; the sign-in process itself is still stopped.
- Tests isolate managed provider settings and avoid requiring directory-watch events or external account-database commands. Hook assertions use bounded waits so missing events fail without hanging.

- Ignore retained resource-history process entries missing a valid identity, fixing a viewer crash (`Invalid argument type in ToBigInt operation`) when opening resource details or navigating diffs.

- Added translations, refreshed site recordings, and regression tests for the diff changes.
- Fixed two Bun 1.3.9 crashes using pointer-sized native arguments on macOS ARM64 and copied buffers during garbage collection.

- Integrated the PR viewer and persistent diff views with phone controls, multi-machine connections, upstream prompt/agent tools, and cursor-style support.
- Failed asynchronous recovery saves clean up temporary files and allow later saves to proceed.
