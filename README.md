# Corgi <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tals/corgi/3a9d723dc864fc924d23c960d920c449313c3716/corgi-dark.svg"><img src="https://raw.githubusercontent.com/tals/corgi/3a9d723dc864fc924d23c960d920c449313c3716/corgi-light.svg" alt="Corgi's corgi, wagging its tail"></picture>

**English** · [简体中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md)

Terminal multiplexer for humans (and agents). Powered by
[Ghostty](https://github.com/ghostty-org/ghostty), inspired by
[herdr](https://github.com/herdrdev/herdr).

[![Corgi with Claude Code and Codex running side by side](https://corgi.computer/images/hero.gif)](https://corgi.computer)

## How this fork differs from upstream

This fork extends [tals/corgi:main](https://github.com/tals/corgi/tree/main)
with the workflows below. See [corgi-changes.md](corgi-changes.md) for the detailed
feature list and behavior changes.

- **GitHub PR viewer:** click PR links for details or Option-click for a direct
  diff. Chat links prefetch basic metadata; the overview shows merge blockers,
  while discussion, stack, and individual CI checks load when opened. Use the viewer to
  inspect checks, reviews, discussions, and stacked PRs, retry failed checks,
  and mark ready or merge. Reply to review threads, post PR comments, and send
  comments to the agent with file, line, and code context.
  Detaching cancels pending GitHub requests so they do not hold up the shell.
- **Conversation PR lists and search:** collect links from user and agent
  messages, including later mentions by number. Cmd+Ctrl+G toggles a resizable
  list between workspace navigation and the conversation, with repository
  grouping, sorting, cached titles and relative timestamps, and folded merged PRs. Visibility
  is saved per conversation. Cmd+Shift+K finds conversations by PR number or link.
- **Code colors:** diffs and chat code blocks share Shiki highlighting, with
  VS Code Dark+ (default), VS Code Light+, and Terminal palettes in Settings.
  Preview both backgrounds, save or cancel, and recolor open views immediately.
- **Diff viewing:** local and PR diffs open fullscreen, with Cmd+Shift+Enter
  switching to pane mode. Resize, hide, search, expand, or collapse the file
  tree; use the draggable change minimap in full-file views. Fullscreen views capture
  mouse input and suppress background hover cards. Tests start hidden
  (`t` toggles them); `Z` toggles full-file context. PR diffs support refresh,
  stale indicators, and reopening with Cmd+Shift+B, retaining navigation and notes.
- **CLI and task orchestration:** compact `list`/`ls` output, detailed
  `list --tree` and `get`, consistent session-name targeting, tracked command
  and helper-agent runs, task-aware waits, and queued or steering messages.
- **Workspace and agent navigation:** move tabs between workspaces, keep tab
  and agent ordering aligned, and switch agent scope with Cmd+Shift+A.
  Archived conversations restore at a clean prompt with a resume hint.
  Sleeping agents show their last chat message's age, fading from green to gray.
- **Phone access and notifications:** a paired Tailscale phone app with
  conversation history, terminal control, agent management, launch profiles,
  archives, and web push. macOS alerts show conversation titles and previews
  and open the originating conversation when clicked.
- **Recovery and development polish:** ordered asynchronous recovery saves,
  retained local task and notification state across upstream migrations,
  portable development helpers with explicit SSH destinations, and fixes for
  resource-history and native-buffer crashes.

To use these additions, build this checkout via [Development](#development).
The installer below installs upstream releases.

## Install

macOS (Apple Silicon) or Linux (amd64 or arm64):

```sh
curl -fsSL https://corgi.computer/install.sh | bash
```

Run `corgi` in your project directory, choose a shortcut preset, and click
**New** to start an agent.

Press your prefix (Ctrl+B by default), then `?` for shortcuts. Choose
**Detach** in that menu to leave agents running; run `corgi` to reconnect.

See the [documentation](docs/reference.md) for setup, workspaces and troubleshooting.

Corgi and its installer support English, 简体中文, 日本語, 한국어 and русский.
Change the language in **Corgi setup → Language**.

## Agents

Run `claude`, `codex`, `pi`, `opencode` or `omp` in any pane. Corgi detects
them automatically and installs hooks for Claude Code and Codex, or an
extension for Pi and Oh My Pi. OpenCode needs no setup. Codex asks you to
trust the hooks once, in `/hooks`.

|                                      | Claude Code | Codex | Pi  | OpenCode | Oh My Pi |
| ------------------------------------ | :---------: | :---: | :-: | :------: | :------: |
| Status: ▶ working ● needs you ● done |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Activity summaries                   |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Subagents                            |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Context, tokens and rate limits      |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Rename and fork                      |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Resume after a crash or reboot       |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Multiple accounts                    |      ✓      |   ✓   |  ✓  | Built-in | Built-in |

## Scripting

Control the running session from any shell. Use `--json` for JSON output,
IDs from `corgi list` to target panes, or `current` for the pane you're in.

```sh
corgi list
corgi tab new --workspace 1 --command 'bun run dev'
corgi pane split current --right --command codex
corgi message 3 'run the tests'
corgi pane read 3 --lines 50
```

`corgi --help` lists the common commands and `corgi help --all` every one;
`corgi --skill` prints instructions for agents.

## Uninstall

```sh
curl -fsSL https://corgi.computer/install.sh | bash -s uninstall
```

## Development

Install [Bun](https://bun.sh), then run:

```sh
./go.ts
```

`go.ts` downloads the [pinned Zig toolchain](AGENTS.md#zig-toolchain), builds
and starts Corgi. Later runs reload changed builds while preserving panes.
See [HACKING.md](HACKING.md) for the development workflow and architecture.

## Acknowledgements

- [Ghostty](https://ghostty.org) and [Kitty](https://sw.kovidgoyal.net/kitty/):
  for their terminal emulation and graphics work.
- [herdr](https://github.com/herdrdev/herdr): Corgi's main inspiration. We
  borrow many of their ideas.
- [Pi](https://github.com/earendil-works/pi): we use its
  [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui) library.
- [Bun](https://bun.sh): Corgi's TypeScript runtime.

Corgi would not have been possible without the support of our early testers and
contributors:
[Max Bittker](https://x.com/MaxBittker),
[Aaron Blakeman](https://github.com/ablakeman),
[Kai Johnson](https://github.com/sirkaiserkai),
[Luke Alonso](https://github.com/lukealonso),
[Keith Adams](https://pebblebed.com/team/keith-adams) and
[Roland Huß](https://ro14nd.de).

## License

Corgi is released under the [MIT License](LICENSE).

The notification sounds in [`assets/sounds/`](assets/sounds/) come unchanged
from herdr and stay under herdr's
[Apache License 2.0](assets/sounds/LICENSE); see
[their README](assets/sounds/README.md).

`corgi licenses` prints these together with the licenses of the other
software Corgi includes, listed in [`assets/licenses.txt`](assets/licenses.txt).
