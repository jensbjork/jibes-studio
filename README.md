# Studio

A desktop video studio for [Venice.ai](https://venice.ai)'s video models. Studio lets you generate short clips from
text, a start image or a set of reference photos, keep a library of **characters**, **environments** and **outfits**
with their reference photos, save the prompts that work, and chain clips into longer films that continue seamlessly
from one clip's last frame into the next. Everything lives in a plain folder you choose, with human-readable folder
and file names, and your own AI agents can work in the app over [MCP](https://modelcontextprotocol.io) — preparing
references, prompts and sequences — while every paid generation still waits for your approval.

Built with Electron, React, TypeScript, SQLite (`better-sqlite3`) and ffmpeg.

## Features

- **Generate** with Venice's video models in three modes: text-to-video, image-to-video (start and optional end
  image) and reference-to-video (up to 9 reference photos for Seedance). Price quote before you generate, a live
  feed of queued, rendering and finished videos, *Använd igen* ("use again") to reload a generation's settings.
- **A reference-aware prompt editor.** In reference mode the prompt points at the photos as `@Image1`, `@Image2` …;
  the editor colours each token like the asset it points at, shows the photo on hover, offers an `@` menu, flags
  wrong or malformed tokens with one-click fixes, and blocks generation while a reference is wrong. The same check
  runs again in the main process before anything is sent to Venice.
- **Library of characters, environments and outfits** (*Karaktärer*, *Miljöer*, *Kläder*): a name, a description and
  ordered reference photos, each in its own folder. A character can have a default outfit that comes along
  automatically.
- **Prompt library** with titles, tags, favourites, a negative prompt and usage counts.
- **Sequences:** films made of clips. Each clip has its own prompt, references and settings, any number of takes, a
  selected take and start/end trims. A clip can *continue from the previous one*: its start image is the previous
  clip's last (trimmed) frame. *Generate missing* renders the clips in order; *Export* cuts the selected takes into
  one mp4 with ffmpeg.
- **Your own folder:** a base folder you choose, with Swedish, human-readable folders and file names. Paths in the
  database are stored relative to it, so the library can be moved, switched or tidied up from Settings.
- **Agent connection (MCP):** an optional Streamable HTTP MCP server (off by default, loopback + Tailscale only,
  bearer token) through which your own agents read the library, set references and prompts, build sequences and
  *request* paid generations that you approve or decline in an in-app dialog.
- **Separate development profile** ("Studio Dev") so development never touches the library the installed app uses.

## Status

Early, personal project, now open source. Things work and are used daily, but expect rough edges and breaking
changes.

- **The UI is in Swedish.** Code, comments and documentation are in English.
- **macOS on Apple Silicon only** for now (the build targets `arm64`, ffmpeg comes from Homebrew, secrets use the
  macOS Keychain through Electron's `safeStorage`).
- There is no automated test suite yet (CI typechecks and builds every pull request); see
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for how changes are tested without spending money.

## Requirements

- **Node.js** — the version in [`.nvmrc`](.nvmrc) (24); at least 22.12 (`engines` in `package.json`).
- **ffmpeg** (with `ffprobe`) — `brew install ffmpeg`. Studio looks in `/opt/homebrew/bin`, `/usr/local/bin`,
  `/usr/bin` and then `PATH`. It is needed for posters, durations, continuation frames and exports; generating
  works without it.
- **A Venice.ai API key** — added under **Inställningar** (Settings). Generations cost money on your Venice account.

## Quick start

```bash
nvm use            # or any Node >= 22.12
npm install        # also rebuilds better-sqlite3 for Electron (postinstall)
npm run dev
```

`npm run dev` starts **Studio Dev**, the development profile: its own settings
(`~/Library/Application Support/Studio Dev/`), its own suggested base folder (`~/Movies/Studio Dev`) and a yellow
**Dev** badge in the sidebar. It never touches the library the installed Studio.app uses, and both can run at the
same time. The first launch asks you to choose a base folder; then add your Venice API key under **Inställningar**.

Other ways to run it (see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)):

| Command | Profile |
| --- | --- |
| `npm run dev` | Studio Dev — separate settings and library |
| `npm run dev:real` | The real Studio profile (quit Studio.app first; only one can run) |
| `STUDIO_PROFILE_DIR=/tmp/studio-test npm run dev` | A throwaway profile under that folder |

## Building Studio.app

```bash
npm run app           # builds dist/mac-arm64/Studio.app
npm run app:install   # builds it and copies it to /Applications (replacing an earlier copy)
```

The app is signed ad hoc (no Apple Developer ID, no notarization), which is enough to run it on the Mac that built
it. Studio.app uses the real profile (`~/Library/Application Support/Studio/`). The icon is drawn in
`build/icon.svg`.

## Where things are stored

**Settings** live in `~/Library/Application Support/Studio/settings.json`: the base folder, the prompt language,
accepted Venice consents and the agent connection's port. The Venice API key and the agent token are stored
encrypted with Electron `safeStorage` (macOS Keychain).

**The library** lives in a base folder you choose on first launch (suggested: `~/Movies/Studio`). It can be switched
or moved under **Inställningar → Bibliotek**, and **Städa upp mappstrukturen** ("tidy up the folder structure") puts
every file the library knows about back where it belongs.

```
<base folder>/
├── Karaktärer/<Name>/                      Characters: reference photos (original file names) + Beskrivning.txt
├── Miljöer/<Name>/                         Environments: photos of the place + Beskrivning.txt
├── Kläder/<Name>/                          Outfits: photos of the garments + Beskrivning.txt
├── Referensbilder/<YYYY-MM-DD>/            Start, end and reference images picked from outside the library,
│                                           copied here when a generation is submitted
├── Genereringar/<YYYY-MM-DD>/<HH.MM> <prompt>.mp4
│                                           Generated videos that don't belong to a sequence
├── Sekvenser/<Sequence name>/
│   ├── Tagningar/<YYYY-MM-DD HH.MM> <prompt>.mp4
│   │                                       Takes of the sequence's clips
│   └── <Sequence name> <YYYY-MM-DD HH.MM>.mp4
│                                           Exported films
└── .studio/                                Hidden app data:
    ├── studio.db                           the SQLite database
    ├── miniatyrer/                         poster frames (thumbnails)
    ├── bildrutor/                          extracted frames used to continue clips
    └── tmp/                                scratch files, cleared when the library is opened
```

Paths in the database are stored relative to the base folder whenever they point into one of these folders, so
the whole library can be moved by moving its folders. Files of your own elsewhere in the base folder are left
alone. A library from an earlier layout (`studio.db`, `generations/`, `thumbs/` … directly in the folder) is
converted to this layout when it is opened.

## Prompts and `@ImageN` references

In **reference mode** the model receives the reference images in order, and the prompt refers to them as
`@Image1`, `@Image2` … in that order. Picking a character, environment or outfit adds its photos to the reference
images, and a label for each asset inserts the right tokens, for example:

```
Anna (@Image1, @Image2) wearing Red dress (@Image3) walks along the beach promenade (@Image4) …
```

The connecting word follows **Inställningar → Promptspråk** (prompt language): `wearing` in English (the default;
the models understand English best) or `i` in Swedish. In the prompt editor:

- each `@ImageN` is coloured like the asset it points at; hover to see the photo; wrong references turn red;
- typing `@` opens a menu with the selected photos and *Lägg till från biblioteket* (add from the library);
- the list under the editor shows every reference with its token, marks photos the prompt never mentions and
  offers quick fixes such as *Byt till @Image3* (change to @Image3) or *Ta bort @Image7* (remove @Image7);
- **Generera** is disabled while a reference is wrong, and says why.

The rules live in [`src/shared/prompt-refs.ts`](src/shared/prompt-refs.ts) and are applied by the editor, by the
main process before every paid submission (including *Generate missing* and agent requests) and by the agent
tools, so a mistyped `@Image9` is never sent to Venice. Text-to-video and image-to-video prompts must not contain
tokens.

## Sequences

A **sequence** is an ordered list of clips (*Klipp*). Each clip stores the settings for new takes; every
generation for it is a **take**, and one take per clip is selected for the cut and can be trimmed at the start and
end. A clip that **continues from the previous one** is generated image-to-video: when it is generated, the
previous clip's selected take is cut at its trim point and that last frame (extracted with ffmpeg) becomes the
start image. **Generera saknade** (generate missing) generates every clip without a finished selected take, in
order, waiting for each one so continuation clips get their frame. **Exportera** renders the selected, trimmed
takes into one H.264/AAC mp4 in the sequence's folder.

## Connecting your own agent

Studio can run an MCP server so agents such as OpenClaw, Hermes Agent, Claude Desktop or Claude Code can work in
the app: read the library and see its photos, choose references, write and validate prompts, fill in the Generate
form and build sequences. Agents **cannot generate anything on their own** — paid tools only create a request that
Studio shows you with the prompt, references and price, and nothing is sent to Venice until you approve it.

Turn it on under **Inställningar → Agentanslutning**; it listens on `http://127.0.0.1:8770/mcp` and on this Mac's
Tailscale address. See **[docs/AGENTS.md](docs/AGENTS.md)** for configuration examples, the full tool list and
troubleshooting.

## Security

Studio is a local app. The agent connection is off by default, listens only on loopback and the Tailscale
interface (never on your LAN or `0.0.0.0`), requires a 256-bit bearer token, refuses browser requests, and paid
actions always need your approval in the app. Secrets are encrypted with the macOS Keychain. Details, the threat
model and how to report a vulnerability: **[SECURITY.md](SECURITY.md)**.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — processes, modules, data model, jobs, sequences, the agent bridge
- [docs/AGENTS.md](docs/AGENTS.md) — connecting agents over MCP
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — profiles, testing without spending money, packaging, migrations
- [CONTRIBUTING.md](CONTRIBUTING.md) — branches, Conventional Commits, pull requests
- [CHANGELOG.md](CHANGELOG.md)

## Roadmap

Done:

1. Basics: API key, generate a video, see the result
2. Characters with reference photos, the prompt library
3. Sequences: chaining clips through the last frame, timeline, export with ffmpeg
4. Environments and outfits, a default outfit per character
5. A prompt editor that checks references; the agent connection (MCP) with approval of paid generations

Next:

6. Cost overview, cancelling a running export, transitions (fades) between clips

Ideas where help is welcome: an English UI (i18n), an automated test suite, signed and notarized builds.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) (Conventional Commits, branch names,
the PR checklist) and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Studio is released under the [MIT License](LICENSE).
