# Corgi changes

Application changes added during development.

## Diff viewer

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

- Added translations, refreshed site recordings, and regression tests for the diff changes.
- Fixed two Bun 1.3.9 crashes: native argument packing on macOS ARM64 and buffer cleanup during garbage collection.
- Integrated upstream's reconnecting HTTP/WebSocket transport, remote machines, assistant tools, provider improvements, docking, and reliability fixes while retaining the local features above.
- Failed asynchronous recovery saves clean up their temporary files and allow later saves to proceed.
