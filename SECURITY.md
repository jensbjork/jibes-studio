# Security policy

## Supported versions

Studio is an early project without a release branch. Security fixes go into `main` and the next release; only the
latest version is supported.

| Version | Supported |
| --- | --- |
| `main` / latest release (0.1.x) | Yes |
| Older versions | No |

## Reporting a vulnerability

**Please do not report vulnerabilities in public issues, pull requests or discussions.**

- Use GitHub's **private vulnerability reporting**: the repository's *Security* tab → *Report a vulnerability*.
- If that isn't available yet (for example before the repository is public), contact the maintainer privately
  through the contact options on the repository owner's GitHub profile and ask for a private channel.

Please include what is affected (version or commit), how to reproduce it, and what an attacker could achieve. Never
include real API keys or tokens — revoke any that were exposed. Studio is maintained in spare time, so reports are
handled on a best-effort basis; you will get an acknowledgement, and a fix or an explanation, as soon as possible.
Please give us a reasonable time to fix the issue before disclosing it.

## Threat model

Studio is a local desktop app for macOS. What it protects:

- **Money** — the Venice API key spends real money on every generation.
- **Secrets** — the Venice API key and the agent connection's bearer token.
- **The user's library** — private photos of people and places, prompts and videos.

### Secrets

- The Venice API key and the agent token are stored in the profile's `settings.json`, encrypted with Electron
  `safeStorage` (backed by the macOS Keychain). Nothing else in `settings.json` is secret.
- The API key never reaches the renderer (it only learns *whether* a key is set). The agent token is sent to the
  renderer only when the user shows or copies it in Settings.
- Venice is called over HTTPS. The pre-signed download URLs Venice returns are kept in the main process.

### The window

- The renderer loads only Studio's bundled code, runs with `contextIsolation` and without Node integration, and
  talks to the main process only through the typed `window.studio` bridge. A Content Security Policy allows only
  the app's own scripts, `media:` and `data:` images, and `media:` video.
- Navigation away from the app is blocked; links open in the default browser.
- **`media://` protocol**: local photos and videos reach the renderer through a privileged custom scheme handled
  in the main process (with HTTP Range support for seeking). It is not a network server — only Studio's own
  renderer can use it.

### The agent connection (MCP server)

The agent connection lets the user's own AI agents work in Studio. It is designed so that a connected agent can
prepare work but never spend money on its own, and so that nothing outside the user's devices can reach it.

- **Off by default.** It only runs after the user switches it on in Settings.
- **Loopback and Tailscale only.** It binds explicitly to `127.0.0.1` and to this Mac's Tailscale IPv4 addresses,
  never to `0.0.0.0` or a LAN address. Tailscale is recognised by its tunnel interface (a `utun` interface with a
  single `100.64.0.0/10` address next to Tailscale's own IPv6 range), so other VPNs or carrier networks that use
  `100.x` addresses are not listened on.
- **Per-socket peer checks.** The loopback socket only accepts loopback peers; the Tailscale socket only accepts
  Tailscale IPv4 peers that are not on a network the Mac is directly attached to. Anything else gets 403.
- **Bearer token.** Every request needs `Authorization: Bearer <token>`: 256 random bits, stored encrypted,
  compared in constant time, replaceable at any time (which disconnects every session and expires pending
  requests).
- **No browsers.** Requests carrying an `Origin` header are refused, so web pages (including DNS-rebinding
  attempts) cannot talk to the server.
- **Limits.** Request bodies over 1 MB are refused; at most 24 sessions are kept and idle sessions are dropped after
  12 hours.
- **MagicDNS** names shown in Settings are resolved only through Tailscale's own resolver and must resolve back to
  the same address, so the local network's DNS can't choose where agents are pointed.
- **Same rules as the UI.** Agent tools call the same services as the window, with the same validation; agents
  cannot add photos, import video or audio files from disk, delete assets, generations, sequences, stills, edits or
  versions, give consent to clone a voice, export, change settings or switch the library. The handlers that import
  files, delete or prune edits and versions, or record clone consent also refuse an agent's call themselves, behind
  the tool list.
- **Paid actions need approval in the app.** Paid tools (videos, pictures, paid edits in Redigera and designed
  voices) only create a request. Studio shows it with the prompt, the reference images or frames and the price, and
  submits only after the user approves. Before submitting, Studio checks that the clips, the image files and the
  version to be edited are still exactly what was shown (an edit also re-plans and refuses a higher price), and each
  take is re-checked right before it is sent. A paid edit job interrupted by quitting Studio never sends its
  remaining parts by itself.
- **Only library files are uploaded.** The video Redigera sends to Venice (a short proxy or a stand-in for a free
  quote) is read only from inside the library; params that name any other file are refused before anything is
  read. Requests expire after 30 minutes and immediately when the token is replaced, the library is switched or
  the connection is turned off; at most 10 can be pending.

Plain HTTP is used on purpose: loopback traffic never leaves the Mac, and Tailscale traffic is encrypted end to end
by WireGuard. Every device in the user's tailnet that has the token can connect; Tailscale ACLs can restrict that
further.

### Out of scope

- An attacker who already controls the user's macOS account or the Studio process.
- What a trusted agent does with the library data it was given access to: a connected agent can read the library,
  including photos, so only give the token to agents you trust with that content.
- Vulnerabilities in Venice.ai, Tailscale, Electron or ffmpeg themselves (please report those upstream), unless
  Studio uses them in an unsafe way.

### Known limitations

These are deliberate trade-offs or open hardening work; reports that show a concrete attack through them are
welcome.

- The `media://` handler serves files by absolute path and is not limited to the library folder (the UI previews
  images picked from anywhere on disk). It relies on the renderer running only Studio's own code.
- The renderer is not sandboxed (`sandbox: false`).
- An `Origin: null` header (an opaque origin) is not refused by the `Origin` check; such requests still need the
  bearer token.
- Builds are signed ad hoc, without hardened runtime or notarization, and are meant to be built and run on the same
  Mac. The voice separation helper (`studio-voice-isolate`, built from `native/voice-isolate/main.swift` by
  `npm run build:helpers`) is signed the same way; it only reads and writes the audio files Studio passes it and
  makes no network connections.
