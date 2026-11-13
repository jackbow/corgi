# Phone remote control

Corgi remote is a phone app for reading existing Codex and Claude conversations,
interacting with their terminals, starting agents, and managing workspaces. Both your computer
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
   for another phone. Press Ctrl+C to close pairing. The first device needs Mac approval;
   an enrolled controller can invite and approve subsequent devices in Settings.
4. Bookmark the address without its pairing fragment. Tap a workspace heading to
   collapse its agents; agent counts and activity remain visible. Agent rows use
   status icons, a truncated last response, and status and activity details underneath.
   Collapsed groups are remembered in this tab, and search reveals matching agents.
   Settings includes a Pure black toggle for OLED screens, enabled by default and saved on this phone.
   Open an agent. Conversation is the default; switch to **Terminal** for
   interactive prompts. **Send** pastes the message and presses Enter. Return
   inserts a newline; **Paste without Enter** only pastes. Drafts stay on this phone
   for 48 hours, separately for each pane and conversation. **Sensitive input** is
   masked and never saved. Terminal keys include Enter, arrows, modifiers and function
   keys; prompts are never automatically approved.
5. **New agent** starts Codex or Claude in an existing workspace using the Mac's
   configured defaults or an existing saved launch profile. Send its first prompt afterward. If a launch is not
   confirmed, check the agent list before trying again.

Use `corgi remote status` or `corgi remote devices` to see the service and paired
phone IDs. `corgi remote revoke ID` immediately removes a phone's access.
**Settings → Forget this phone** clears the browser's local key and drafts; revoke it on the
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
To enroll the Home Screen app, run `corgi remote pair` on the Mac and paste its
HTTPS MagicDNS pairing link into **Pairing link** inside the app. Keep that
command running and approve the matching code on the Mac.

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
the workspace list refreshes every two seconds. An authenticated live subscription also
invalidates changed topology; polling remains a reconnect fallback. Terminal refresh
can be adjusted from 250 ms to five seconds in Settings. Updates reflect persisted transcript
records, not token-by-token streaming. Output preserves scroll position unless
already following the bottom. Returning from suspension reconnects. Messages
are never automatically retried: if a send times out, check the pane before
sending again. Input is rejected when the daemon or pane identity changes.
The phone does not resize the desktop terminal or steal desktop focus.

Conversation reads use the pane's current provider identity. System instructions,
hidden reasoning, and provider metadata are omitted. Cold reads start at the end
of the transcript and stop after finding the latest 20 entries, including tool
activity. Codex's header is checked for conversation identity; Claude reads follow
the active parent chain, scanning further back only when needed. The Mac caches
this bounded window and subsequent reads process appended bytes. Each request
reads at most 8 MiB in 256 KiB chunks, plus small file identity checks; unusually
large records or distant Claude parents can take multiple requests. The phone
refreshes this recent window without
loading older history. It renders only rows near the viewport, preserving the
reading position while messages remain in the window or change height.

## Additional phone controls

- **Settings → Workspaces** opens an existing absolute directory on the Mac, renames
  or reorders workspaces, and closes workspaces with confirmation. Closing stops their
  panes, without deleting directories. Worktrees and file/Git browsing are not exposed.
- Supported numbered prompts appear as question cards. Responses are checked against
  the current pane, conversation and terminal surface, and consumed once before sending
  keys. Unsupported checkbox, free-text and tabbed forms use Terminal. Uncertain responses
  are never retried automatically.
- Terminal history can show 100–10,000 lines, bounded to 512 KiB, with a text filter.
  Desktop terminal dimensions remain unchanged. Command and skill suggestions insert
  into the draft without sending; discovery returns names and descriptions only.
- Controllers can create one-use reader or controller invitations, compare approval codes,
  and revoke devices in Settings. Readers cannot send input, launch/manage agents or
  workspaces, or administer devices. Optional passkey verification protects sign-in and
  locks the app when backgrounded. Keep access to the Mac CLI for revocation/re-enrollment
  if a passkey is lost. Remote write receipts record action metadata only in a private,
  bounded `devices.json.audit` file.
- Settings shows the phone feature build and can refresh phone assets. Controllers can
  explicitly download and apply signed updates to a managed Mac installation using
  its existing updater, including compatible live handoffs. Updates needing a restart
  remain downloaded until approved from an outside Mac terminal. Unmanaged builds cannot
  update this way. The phone feature service remains separate: its build must still be
  installed on the Mac; it does not switch to a stable release that lacks these features.

Existing controller enrollments remain compatible. Saving a reader role or a passkey
uses device-store version 2, which older remote binaries reject instead of silently
granting controller access. This does not change the desktop daemon protocol or saved runtime.
These features are independently implemented for Corgi; relay source/assets are not imported.

Long messages are shortened independently. Unusually complex individual records
that exceed the decoded-record budget are omitted with a notice. Neither blocks the rest of
the conversation. Missing or malformed transcripts offer Terminal instead.
The terminal displays styled, selectable text at its existing column count, with
horizontal scrolling and a separate recent plain-text history section.

Headless agents, saved-session resumption, PRs, diffs, images, uploads, and
worktree management are outside this release. The computer must stay awake
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
includes frontend sources and styles. The push service worker does not cache authenticated content.

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

### Phone notifications

On iOS/iPadOS 16.4 or later, use Safari’s **Share → Add to Home Screen**, then
open Corgi from that icon. Pair the Home Screen app if requested. In **Settings →
Notifications**, tap **Enable notifications** and allow the system prompt. Use
**Send test notification** to check delivery, including with the screen locked.
Notifications can be disabled in Corgi or in the device’s notification settings.

The Mac’s remote service watches for agents needing input and new completion
receipts even while the phone app is closed. Existing statuses establish a
baseline on startup; reopening Corgi or marking a reply unread does not resend old
alerts. Alerts show the status as their title, followed by the agent name and a
truncated preview of the latest assistant response, with a link back to the same
pane and conversation. Input prompts open Terminal; notifications never approve
prompts. If the transcript is unavailable, the response preview is omitted.
Confirmed tool permission prompts show **needs permission** and use the input
notification preference. Codex automatic reviews do not alert unless a prompt
is visible in its terminal.
iOS may also display its own app attribution, which the website cannot remove.

On macOS, desktop viewers use Corgi’s native notifier for both completion and
permission/input alerts, with the conversation title, latest response preview,
and click-to-conversation behavior. Allow **Corgi** in macOS notification settings;
Focus may silence banners. Alerts retain their conversation identity through
daemon reloads, so reused panes cannot redirect an old alert.

Without a local desktop viewer, the daemon sends permission/input alerts through
`terminal-notifier` (`brew install terminal-notifier`). This fallback avoids
duplicate banners while a desktop viewer is attached. Clicks require a viewer
to be open and reject panes that have switched conversations. Ghostty, iTerm2,
Terminal, WezTerm and Kitty support fallback app activation.
Set `CORGI_NOTIFICATIONS=off` when starting Corgi to disable Mac banners
independently of sounds and phone push.

The Mac must be awake, Corgi and remote control running, and both devices need
internet access to the browser’s push service. Apple Web Push uses outbound
HTTPS; the Mac stays private behind Tailscale. Tailscale is needed to enroll and
open conversations, but a received push contains everything needed to display
its notification. Delivery is subject to iOS Focus and notification settings.

Push keys and subscriptions are saved privately alongside the paired-device
store (`devices.json.push`). Revoking or forgetting a phone disables its
notifications; expired subscriptions are removed. The service worker handles
push and notification clicks only, and does not cache authenticated content for
offline use. Per-phone preferences control categories, settle delay, cooldown and snooze.
Transient failures retry with bounded exponential backoff, across service restarts, for
up to an hour and six attempts. Each phone has at most one queued alert per agent;
newer status supersedes it. Revocation, expiry and disabled categories suppress pending
deliveries. Stable notification tags replace duplicates after an uncertain push response.
Check the Mac's remote-service log if a test notification fails.
