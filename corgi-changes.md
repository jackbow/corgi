# Corgi changes

Application changes added during development.

## Portable development helpers

- macOS probe and signing-key transfer scripts require explicit SSH host settings (`CORGI_PROBE_HOST` and `CORGI_RELEASE_HOST`); the probe also requires `CORGI_PROBE_REMOTE` for the remote checkout path.

## GitHub PR viewer

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

## Compatibility and validation

- Ignore retained resource-history process entries missing a valid identity, fixing a viewer crash (`Invalid argument type in ToBigInt operation`) when opening resource details or navigating diffs.

- Added translations, refreshed site recordings, and regression tests for the diff changes.
- Fixed two Bun 1.3.9 crashes using pointer-sized native arguments on macOS ARM64 and copied buffers during garbage collection.
