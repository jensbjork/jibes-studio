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

The agent connection lets the user's own AI agents work in Studio. It is designed so that a connected agent can do
the user's work but never spend money or remove anything on its own, never make Studio read a file of the user's
Mac it wasn't given, and so that nothing outside the user's devices can reach it.

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
- **Limits.** `/mcp` request bodies over 1 MB, or not in within 60 seconds, are refused; headers must arrive within
  20 seconds; at most 24 sessions are kept and idle sessions are dropped after 12 hours.
- **MagicDNS** names shown in Settings are resolved only through Tailscale's own resolver and must resolve back to
  the same address, so the local network's DNS can't choose where agents are pointed.
- **Same rules as the UI.** Agent tools call the same services as the window, with the same validation. Agents
  cannot change settings, switch, move or tidy up the library, give Venice's or a voice clone's consent, approve
  requests, mark anything seen, or set the user's own rating, note, tags or learnings. The handlers for those (and
  for deleting or pruning edits and versions) also refuse an agent's call themselves, behind the tool list.
- **No paths from agents.** No tool takes a file path. Files arrive as uploads (below) or are named by the id of
  something the library already holds. Every handler that takes a path checks an agent's call (`assertAgentFiles`):
  the path must resolve — symlinks followed on both sides, compared the way macOS compares names — to a regular file
  inside the library's upload staging folder, or to a file the library records in one of its own folders with no
  symlink leading out. Anything else (`/etc/hosts`, a file elsewhere in the home folder, `..` tricks, a symlink in
  staging that points out) is refused before a byte is read, and the services copy or clone such a file, never move
  it. A file used as a form image or a reference is first imported as a still, so a scratch path never enters a
  generation's settings.
- **Uploads by `PUT`.** `PUT /uploads/<id>` on the agent port goes through the same peer, `Origin` and bearer token
  checks as `/mcp`, then: `PUT` only, a `Content-Length` equal to the size declared in `begin_upload` (chunked bodies
  are refused), an upload that is waiting for its bytes and was begun from the same peer address, and room on the
  library's disk (2 GB must stay free; 507 otherwise). All of this is checked before `100 Continue` is sent, and every refused `PUT` is answered with `Connection: close` and the socket
  destroyed, so a refused body is never read. A body may not run past the declared size (413), stops after 60 seconds
  without data and 30 minutes in all (408: the answer goes out first, then the connection is closed, discarding what
  still arrives for at most 2 seconds), and is hashed (an optional SHA-256 is compared). The server has no overall
  request timeout for this reason; `/mcp` bodies keep their own 60-second limit.
- **Uploads by URL.** Studio fetches an agent's URL with Node's own `http` / `https` (no system proxy, no cookies or
  credentials, `Accept-Encoding: identity`), `http:` and `https:` only, without user info. DNS is resolved once and
  the socket connects to the very address that was checked, so a name can't be re-pointed between the check and the
  connection. Only public addresses are fetched: loopback, private (10/8, 172.16/12, 192.168/16), CGNAT and Tailscale
  (100.64/10, `fd7a:115c:a1e0::/48`), link-local, unique-local, documentation, benchmarking, multicast and reserved
  ranges are refused, IPv4 embedded in IPv6 (mapped, compatible, NAT64, 6to4) is judged as IPv4, Teredo is refused and
  other IPv6 must be global unicast. The one exception is the agent's own machine — the peer address of its session
  (any loopback address for an agent on the same Mac) — on any port but Studio's own agent port. At most 3 redirects,
  each checked again; no downgrade from `https` to `http`; status 200 only; the size cap is checked against
  `Content-Length` before reading and counted while reading; 10 s to connect, 30 s without data, 2 minutes in all (30
  for a video); two fetches at a time. Fetching reveals the Mac's public IP address to the server fetched from. The
  activity log and an asset file's recorded origin keep only the host, never the URL (which may carry a token), and
  a fetched file is named after the URL's last path segment only when that looks like a file name (the kind's
  extension, no token-like run of letters and digits); otherwise it gets a plain name.
- **Uploads are checked and contained.** What an upload is comes from its bytes, not its name or `Content-Type`:
  JPEG, PNG, WebP or HEIC pictures (dimensions read from the header and refused above 16 384 px a side or 80
  megapixels before any decoder runs; HEIC converted with macOS's `sips`; then decoded), MP3, WAV, AIFF, FLAC, OGG,
  AAC or MP4 sound (probed with ffprobe), MP4/MOV, WebM or MKV video (the own-clip inspection); SVG, GIF and TIFF are
  refused. Caps: 30 MB per picture, 100 MB per sound, 4 GB per video; at most 16 live uploads and 8 GB staged, and 2
  GB must stay free on the disk — counting what transfers under way have declared but not yet written, and checked
  again while a URL downloads (its size is only known as it arrives), so neither many URLs nor overlapping `PUT`s can
  fill the disk. Uploads are staged in the library's `.studio/tmp/agent-uploads/`, live two hours once ready, and are
  thrown away when the token is replaced, the library is switched or moved, the connection is turned off or Studio
  quits (`.studio/tmp` is also cleared at every library open). What a content tool fetches from a `{url}` source is
  thrown away once the call has answered, unless its error names it for the agent to go on with.
- **Removals need approval in the app.** No tool removes anything. `request_delete` only creates a request listing
  every item with what else would change; nothing is removed until the user approves it, all or nothing. While the
  dialog is open the request is checked again every 2 seconds and on focus, and on approval it is checked once more;
  anything changed since the agent asked makes the whole request lapse (expired). Only then are the items removed
  through the window's own handlers with the user's authority (`callApproved`, used by nothing else); the rules an
  agent's own call would meet there — only its own reviews and learnings, never the user's own review or learnings the
  user wrote, edited or pinned, nothing during a run (no take or video of a clip in a running *Generera saknade*
  either, which would otherwise be generated again, paid, without its own approval) — are enforced by the planner and
  the re-check. A board added or moved
  by an agent that would drop a storyboard transition with a prompt or takes is refused by the service itself, inside
  its transaction; such a move also goes through `request_delete`.
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
  including photos, and add to it and change it (never remove anything or spend money without approval), so only
  give the token to agents you trust with that content.
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
- A URL fetch is allowed to reach the agent's own machine (its session's peer address) on any port but Studio's, so
  a token holder can make Studio fetch from a local service on that machine; for an agent on the same Mac that means
  this Mac's loopback services. The fetched bytes must still pass the upload checks, and only the agent sees them.
- Builds are signed ad hoc, without hardened runtime or notarization, and are meant to be built and run on the same
  Mac. The voice separation helper (`studio-voice-isolate`, built from `native/voice-isolate/main.swift` by
  `npm run build:helpers`) is signed the same way; it only reads and writes the audio files Studio passes it and
  makes no network connections.
