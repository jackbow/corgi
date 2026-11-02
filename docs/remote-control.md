# Phone remote control

Corgi remote is a small phone web UI for viewing existing workspaces, following
pane output, sending messages, and pressing terminal keys. Both your computer
and phone must be connected to the same Tailscale network. Local Wi-Fi is not
required: cellular plus Tailscale works.

## Setup

1. Install and connect Tailscale on the computer and phone. Enable MagicDNS
   and HTTPS certificates in the tailnet. Tailnet policy must allow the phone
   to reach this computer on TCP port 8443.
2. Keep your normal Corgi runtime running, then run:

   ```sh
   corgi remote start
   corgi remote pair
   ```

3. Open the printed one-time HTTPS link on the phone within 60 seconds. Enter
   a phone name and tap **Pair**. Compare the code with your computer, then
   type the matching code in the terminal to approve. Approval expires after
   two minutes. Pairing cannot be approved remotely.
4. Bookmark the address without its pairing fragment. Choose a workspace and
   pane. **Send** pastes the message; its checkbox controls whether to press
   Enter afterward. Terminal key buttons include arrows, Escape, Tab and Ctrl+C.

Use `corgi remote status` or `corgi remote devices` to see the service and paired
phone IDs. `corgi remote revoke ID` immediately removes a phone's access.
**Forget this phone** clears only the browser's local key; revoke it on the
computer to remove its enrollment. To disable remote access:

```sh
corgi remote stop
```

The background service survives detaching the desktop viewer and closing the
terminal. Run `remote start` after a reboot. It neither starts nor restarts the
Corgi daemon, and uses `CORGI_SOCKET` to select an existing runtime. Different
runtimes have separate pairings; only one may own the Tailscale HTTPS port.
Do not exit the pairing command before approval; a replacement pairing link
invalidates the earlier offer. Use the same browser for pairing and later use;
Safari and Home Screen apps can have separate storage, so pair each separately.

## Connection and privacy

The phone connects to `https://<computer>.<tailnet>.ts.net:8443`. Tailscale Serve
terminates HTTPS and forwards to a private Unix socket; Corgi opens no TCP
listener. Corgi does not enable Funnel, advertise a LAN address, or configure SSH.
Tailscale handles encryption, VPN connectivity, and HTTPS certificate renewal.
A preexisting service on port 8443 is left alone; stop that service yourself or
use another machine. Existing routes on other ports are preserved.

Pairing enrolls a P-256 public key. The private key stays in browser IndexedDB;
subsequent sign-ins use one-time signed challenges and 12-hour bearer sessions
held in memory. The server persists public keys only, in a private, versioned
`$XDG_STATE_HOME/corgi/remote/<runtime>/devices.json` file (default
`~/.local/state`). Sessions are cleared on restart. Runtime sockets and logs
live under `/tmp/corgi-UID/remote-<runtime>/`, with owner-only permissions.

Output refreshes while the page is visible, preserving scroll position unless
already following the bottom. Returning from suspension reconnects. Messages
are never automatically retried: if a send times out, check the pane before
sending again. Input is rejected when the daemon or pane identity changes.
The phone does not resize the desktop terminal or steal desktop focus.

This first version displays plain pane history, without terminal colors,
interactive terminal rendering, structured chat transcripts, images, uploads,
push notifications, or creating/closing workspaces. The computer must stay awake
and connected to Tailscale. Its existing panes remain live while the phone is
away.

If disconnected, check Tailscale on both devices, the Corgi daemon, computer
sleep, and tailnet access to port 8443. `remote status` reports the local service;
`tailscale serve status` reports the Tailscale route. If HTTPS is unavailable,
follow the Tailscale CLI's setup instructions and retry. Remote control never
falls back to plain HTTP over the network.

## Development

`src/remote/` contains the service, authentication, daemon adapter, and phone UI.
It uses Bun's HTTP server and Node cryptography, without new dependencies.
`bun test src/remote` covers authentication, private HTTP access, input validation,
route ownership, and stale-pane handling. `bun integration.ts remote --jobs 1`
exercises a compiled binary, actual Corgi panes, service lifecycle, and a fake
Tailscale CLI; it does not change the machine's real Tailscale configuration.

The architecture follows Herdr's separate mobile service and explicit local
pairing flow; this implementation does not copy its Rust server or web assets.
