# Phone remote control

Corgi remote is a phone app for reading existing Codex and Claude conversations,
interacting with their terminals, and starting agents in existing workspaces. Both your computer
and phone must be connected to the same Tailscale network. Local Wi-Fi is not
required: cellular plus Tailscale works.

## Setup

1. Install and connect Tailscale on the computer and phone. Enable MagicDNS
   and HTTPS certificates in the tailnet. Tailnet policy must allow the phone
   to reach this computer on TCP ports 8443 (HTTPS) and 8080 (IP redirects).
2. Keep your normal Corgi runtime running, then run:

   ```sh
   corgi remote start
   corgi remote pair
   ```

   Run Corgi as your normal user, without `sudo`. Homebrew Tailscale may
   require administrator permission to configure a Unix-socket proxy. If so,
   Corgi runs only that Tailscale command through `sudo` and prompts in your
   terminal. Corgi and its connection to your existing panes remain unprivileged.

3. Scan the terminal QR code or open one of the three printed links: MagicDNS,
   Tailscale IPv4, or Tailscale IPv6. Enter a phone name and tap **Pair**. Compare
   the code with your computer, then type the matching code in the terminal to
   approve. Pairing stays open while the command runs, including while waiting
   for approval. Each approval or denial prints a fresh single-use QR and links
   for another phone. Press Ctrl+C to close pairing. Approval is local only.
4. Bookmark the address without its pairing fragment. Tap a workspace heading to
   collapse its agents; counts, activity, and provider icons remain visible.
   Collapsed groups are remembered in this tab, and search reveals matching agents.
   Open an agent. Conversation is the default; switch to **Terminal** for
   interactive prompts. **Send** pastes the message and presses Enter. Return
   inserts a newline; **Paste without Enter** only pastes. Drafts stay in this tab,
   separately for each pane and conversation. Terminal keys include Enter, arrows,
   Escape, Tab, and Ctrl+C; prompts are never automatically approved.
5. **New agent** starts Codex or Claude in an existing workspace using the Mac's
   configured defaults. Send its first prompt afterward. If a launch is not
   confirmed, check the agent list before trying again.

Use `corgi remote status` or `corgi remote devices` to see the service and paired
phone IDs. `corgi remote revoke ID` immediately removes a phone's access.
**Settings → Forget this phone** clears only the browser's local key; revoke it on the
computer to remove its enrollment. To disable remote access:

```sh
corgi remote stop
```

The background service survives detaching the desktop viewer and closing the
terminal. Run `remote start` after a reboot. It neither starts nor restarts the
Corgi daemon, and uses `CORGI_SOCKET` to select an existing runtime. Different
runtimes have separate pairings; only one may own the Tailscale HTTPS port.
Exiting the pairing command invalidates its pending offer. An abruptly killed
command loses its offer within 60 seconds. Starting another pairing command
replaces the earlier offer. Use the same browser for pairing and later use;
Safari and Home Screen apps can have separate storage, so pair each separately.

## Connection and privacy

The phone connects to `https://<computer>.<tailnet>.ts.net:8443`. The IP links use
HTTP on port 8080 only to redirect to this HTTPS address: Tailscale certificates
do not cover raw IPs, and MagicDNS must still work on the phone. Pairing secrets
stay in URL fragments, which browsers preserve across the redirect without
sending them to the redirect server. All app requests and authentication use HTTPS.
Tailscale Serve forwards HTTPS and the redirect port to separate private Unix
sockets; Corgi opens no TCP listener. Corgi does not enable Funnel, advertise a
LAN address, or configure SSH.
Tailscale handles encryption, VPN connectivity, and HTTPS certificate renewal.
A preexisting service on either port is left alone; stop that service yourself or
use another machine. Existing routes on other ports are preserved.

Pairing enrolls a P-256 public key. The private key stays in browser IndexedDB;
subsequent sign-ins use one-time signed challenges and 12-hour bearer sessions
held in memory. The server persists public keys only, in a private, versioned
`$XDG_STATE_HOME/corgi/remote/<runtime>/devices.json` file (default
`~/.local/state`). Sessions are cleared on restart. Runtime sockets and logs
live under `/tmp/corgi-UID/remote-<runtime>/`, with owner-only permissions.

The selected conversation, terminal, and activity refresh every second while visible;
the workspace list refreshes every two seconds. Updates reflect persisted transcript
records, not token-by-token streaming. Output preserves scroll position unless
already following the bottom. Returning from suspension reconnects. Messages
are never automatically retried: if a send times out, check the pane before
sending again. Input is rejected when the daemon or pane identity changes.
The phone does not resize the desktop terminal or steal desktop focus.

Conversation reads use the pane's current provider identity. System instructions,
hidden reasoning, and provider metadata are omitted. Transcripts are indexed
incrementally without a total file-size or record-count limit. The first read
shows indexing progress; subsequent reads process only appended bytes. The index
retains file offsets and Claude ancestry, with a small cache of recent message
bodies. Reads scan at most 8 MiB in 256 KiB chunks per request and return the
latest 10 messages. The phone refreshes this recent window without
loading older history. It renders only rows near the viewport, preserving the
reading position while messages remain in the window or change height.

Long messages are shortened independently. Unusually complex individual records
that exceed the decoded-record budget are omitted with a notice; uncached records
that exceed the page read budget show a placeholder. Neither blocks the rest of
the conversation. Missing or malformed transcripts offer Terminal instead.
The terminal displays styled, selectable text at its existing column count, with
horizontal scrolling and a separate recent plain-text history section.

Headless agents, saved-session resumption, PRs, diffs, images, uploads, and
creating/closing workspaces are outside this release. The computer must stay awake
and connected to Tailscale. Its existing panes remain live while the phone is
away.

If disconnected, check Tailscale on both devices, the Corgi daemon, computer
sleep, and tailnet access to ports 8443 and 8080. `remote status` reports the local service;
`tailscale serve status` reports the Tailscale route. If HTTPS is unavailable,
follow the Tailscale CLI's setup instructions and retry. Remote control never
serves the app or authentication over plain HTTP.

## Development

`src/remote/` contains the service, authentication, daemon adapter, and phone UI.
The React/Vite package is isolated in `src/remote/web/`. `bun build.ts` installs its
locked dependencies if needed, builds it, and embeds the explicit asset manifest
(including local Geist and Fira Code fonts). Production needs no Vite process or
frontend source directory. `bun typecheck.ts` includes frontend types; `bun format.ts`
includes frontend sources and styles. There is no service worker or offline cache.

For a fixture-only preview, run `bun install --frozen-lockfile` and `bun run dev`
inside `src/remote/web/`, then open `http://127.0.0.1:5173/?fixture=home`.
Other fixtures: `agent`, `waiting`, `new`, `settings`, `pairing`, `empty`, and `error`.
These are development-only and require no enrolled device or live session. The
development server has no proxy to the private control socket. Run `bun run test`
in that package for component, navigation, draft, reconnect, and authentication tests.

`bun test src/remote` covers authentication, private HTTP access, input validation,
provider normalization, pagination, route ownership, and stale-pane handling.
Build first so native libraries and frontend assets are available.
`bun integration.ts remote --jobs 1` exercises a test-enabled compiled binary,
embedded assets/deep links/fonts, actual Corgi panes, agent creation, service lifecycle, and a fake
Tailscale CLI; it does not change the machine's real Tailscale configuration.

Phone acceptance still requires actual iPhone Safari: check the composer with
the keyboard open, text selection, portrait/landscape scrolling, suspension,
and Tailscale reconnects. Also check browser layouts at 320, 390, and 430px.
Desktop emulation does not establish iPhone behavior.

The architecture follows Herdr's separate mobile service and explicit local
pairing flow; this implementation does not copy its Rust server or web assets.
