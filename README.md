# Studio

A desktop video studio for [Venice.ai](https://venice.ai)'s video models. Studio lets you generate short clips from
text, a start image or a set of reference photos (and voices), keep a library of **characters**, **environments**,
**outfits** and **poses** with their reference photos — and what the characters and places sound like — and save
the prompts that work. Clips are chained into longer films that continue seamlessly from one clip's last frame into
the next, planned as **storyboards** with start and end images that Studio can make for you, and a clip in the
middle that didn't turn out can be redone so it fits exactly between its neighbours. Everything lives in a plain
folder you choose, with human-readable folder and file names, and your own AI agents can work in the app over
[MCP](https://modelcontextprotocol.io) — preparing references, prompts, sequences and storyboards, and reviewing
what the generations became to write better prompts next time — while every paid generation still waits for your
approval.

Built with Electron, React, TypeScript, SQLite (`better-sqlite3`) and ffmpeg.

## Features

- **Generate** with Venice's video models in three modes: text-to-video, image-to-video (start and optional end
  image) and reference-to-video (up to 9 reference photos for Seedance, plus up to 3 voice or sound clips with the
  models that take reference audio). Price quote before you generate, *Använd igen* ("use again") to reload a
  generation's settings.
- **A live clip feed built for many clips.** Queued, rendering and finished videos as big cards or a compact table
  (*Kort* / *Tabell*, with keyboard navigation), search in the prompts, filters (status, model, the asset whose
  photos or voice were used, rating, unrated or reviewed, time, standalone or in a sequence), sorting (newest,
  oldest, rating, cost, length) and a summary of the filtered clips. A detail drawer shows the player, the prompt
  with its tokens (and *Skickad prompt*, the prompt exactly as it was sent, when descriptions were appended), the
  references and voices that were sent, the settings, and your own rating (1–5 stars), note and tags next to the
  agents' reviews.
- **A reference-aware prompt editor.** In reference mode the prompt points at the photos as `@Image1`, `@Image2` …
  and at the voice and sound clips as `@Audio1`, `@Audio2` …; the editor colours each token like the asset it points
  at, shows the photo on hover and plays the voice, offers an `@` menu, flags wrong or malformed tokens with one-click
  fixes, and blocks generation while a reference is wrong. The same check runs again in the main process before
  anything is sent to Venice. **Drag a reference photo or voice to another place** and its number changes, with
  every token in the prompt following it. **The descriptions of the referenced characters, places, outfits and
  poses are appended automatically** when the prompt is sent, as a short *References* list, so you write what
  happens rather than what everyone looks like.
- **Library of characters, environments, outfits and poses** (*Karaktärer*, *Miljöer*, *Kläder*, *Poser*): a name, a
  description and ordered reference photos, each in its own folder. A character can have a default outfit that comes
  along automatically, and **a voice** (*Röst*); an environment can have **a soundscape** (*Ljudmiljö*). Each audio
  clip has a 2–15 s reference window, the part that is sent, which you pick on a timeline. A **pose** is a photo or
  sketch of how people stand relative to each other, applied to the characters in the shot.
- **Prompt library** with titles, tags, favourites, a negative prompt and usage counts, and **Lärdomar**
  (learnings): short insights about what works, recorded by you or your agents, with the clips they are based on.
- **Sequences:** films made of clips. Each clip has its own prompt, references, voices and settings, any number of
  takes, a selected take and start/end trims. A clip can start on the previous clip's last (trimmed) frame
  (*Startbild från föregående klipp*) and end on the next clip's first frame (*Slutbild från nästa klipp*), both
  taken out automatically with ffmpeg. *Generate missing* renders the clips in the order their frames allow;
  *Export* cuts the selected takes into one mp4 with ffmpeg.
- **Storyboards:** the same sequence as panels (*Tidslinje / Storyboard*): each clip with a start image, an end
  image and *Vad händer* notes. A slot takes an uploaded or dropped picture, a library photo, a frame picked from
  any take, a picture made with **Skapa bild…** (Venice's image models, about $0.06, with characters, outfits,
  places, poses or other stills as references), or automatically the previous clip's last frame / the next clip's
  first frame. Clips with images are generated image-to-video from them.
- **Redo a clip between its neighbours** (*Gör om mellan grannarna*): a clip in the middle that didn't turn out is
  set up to start exactly on the previous clip's last frame and end exactly on the next clip's first frame — both
  taken out automatically, with live previews — and a new take fits the cut without touching the neighbours.
- **Your own folder:** a base folder you choose, with Swedish, human-readable folders and file names. Paths in the
  database are stored relative to it, so the library can be moved, switched or tidied up from Settings.
- **Agent connection (MCP):** an optional Streamable HTTP MCP server (off by default, loopback + Tailscale only,
  bearer token) through which your own agents read the library, set references, voices and prompts, build sequences
  and storyboards, *request* paid generations and pictures that you approve or decline in an in-app dialog, and
  look back at finished clips and exported films (frames, sound, the references used) to review them and record
  learnings for the next prompt.
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
  `/usr/bin` and then `PATH`. It is needed for posters, durations, the start and end frames clips take from their
  neighbours (and their previews), saving a frame as a still, exports, voice and sound clips (measuring them and
  cutting out the part that is sent) and the frames agents review; generating without voices works without it.
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
*Säkert läge för bilder* (image safe mode: Venice blurs adult content in pictures it makes; on by default), accepted
Venice consents and the agent connection's port. The Venice API key and the agent token are stored
encrypted with Electron `safeStorage` (macOS Keychain).

**The library** lives in a base folder you choose on first launch (suggested: `~/Movies/Studio`). It can be switched
or moved under **Inställningar → Bibliotek**, and **Städa upp mappstrukturen** ("tidy up the folder structure") puts
every file the library knows about back where it belongs.

```
<base folder>/
├── Karaktärer/<Name>/                      Characters: reference photos and voice clips (original file names)
│                                           + Beskrivning.txt
├── Miljöer/<Name>/                         Environments: photos of the place, soundscape clips + Beskrivning.txt
├── Kläder/<Name>/                          Outfits: photos of the garments + Beskrivning.txt
├── Poser/<Name>/                           Poses: photos or sketches of the positions + Beskrivning.txt
├── Referensbilder/<YYYY-MM-DD>/            Start, end and reference images and reference audio picked from
│                                           outside the library, copied here when a generation is submitted;
│                                           stills that belong to no sequence (any more)
├── Genereringar/<YYYY-MM-DD>/<HH.MM> <prompt>.mp4
│                                           Generated videos that don't belong to a sequence
├── Sekvenser/<Sequence name>/
│   ├── Tagningar/<YYYY-MM-DD HH.MM> <prompt>.mp4
│   │                                       Takes of the sequence's clips
│   ├── Storyboard/                         Stills: pictures made with Skapa bild (<HH.MM> <prompt>.png),
│   │                                       pictures uploaded into a panel, frames saved from takes
│   └── <Sequence name> <YYYY-MM-DD HH.MM>.mp4
│                                           Exported films
└── .studio/                                Hidden app data:
    ├── studio.db                           the SQLite database
    ├── miniatyrer/                         poster frames (thumbnails)
    ├── bildrutor/                          extracted frames used to continue clips or end on the next one
    └── tmp/                                scratch files, cleared when the library is opened
```

Paths in the database are stored relative to the base folder whenever they point into one of these folders, so
the whole library can be moved by moving its folders. Files of your own elsewhere in the base folder are left
alone. A library from an earlier layout (`studio.db`, `generations/`, `thumbs/` … directly in the folder) is
converted to this layout when it is opened.

## Prompts, `@ImageN` and `@AudioN` references

In **reference mode** the model receives the reference images in order, and the prompt refers to them as
`@Image1`, `@Image2` … in that order. Picking a character, environment, outfit or pose adds its photos to the
reference images, and a label for each asset inserts the right tokens, for example:

```
Anna (@Image1, @Image2) wearing Red dress (@Image3) walks along the beach promenade (@Image4) …
```

The connecting word follows **Inställningar → Promptspråk** (prompt language): `wearing` in English (the default;
the models understand English best) or `i` in Swedish.

**Voices and sounds.** With a model that takes reference audio (Seedance's reference-to-video models among them),
adding a character that has a voice also adds its first voice clip (*Ta med rösten* on the chip turns it off; an
environment's soundscape comes along with *Ta med ljudmiljön*), and the prompt refers to the clips as `@Audio1`,
`@Audio2` … in order: `Anna (@Image1, @Image2, voice @Audio1) says …`, `the harbour (@Image4, sound @Audio2)`
(`röst` and `ljud` in Swedish). Venice uses the clips as a guide to timbre, tone and pacing, not as an exact clone.
At most 3 clips, each 2–15 s, 15 s in all, and only together with at least one reference image; Studio cuts each
clip's window out of the file and sends it as mono MP3. A voice from a recording shorter than 2 s can't be sent, so
it doesn't come along (a note says so).

**Poses.** A pose chip applies to the characters you choose (all of them by default):
`Anna (@Image1) and Erik (@Image3) posed as in Hug (@Image5)` (`… och … i posen …` in Swedish).

**Reordering.** Drag a reference thumbnail (or a voice or sound chip) to another place — an insertion marker
shows where it lands and every badge shows the number it will get — or focus it and press ⌥← / ⌥→. Its `@ImageN`
(or `@AudioN`) changes, and every token in the prompt and the negative prompt is renumbered in the same step so it
keeps pointing at the same picture or clip: with references [A, B, C] and `@Image1 hugs @Image3`, dragging C to
the front gives [C, A, B] and `@Image2 hugs @Image1`. Pictures past the model's limit are marked *skickas inte*
(not sent); dragging one forward sends it instead of the last one. This works in Generera and in the sequence
clip editor, so photos can be renumbered without picking or uploading them again in another order.

**Descriptions are appended to the prompt.** When a generation is sent, Studio appends the descriptions of the
assets whose photos or voices it sends as a *References* legend, with each asset's tokens:

```
Anna (@Image1, @Image2, voice @Audio1) walks along the beach promenade (@Image3) …

References:
- Anna (@Image1, @Image2; voice @Audio1): tall woman in her thirties, short red hair, green raincoat
- Beach promenade (@Image3): a windswept pebble beach at dawn
```

The legend is composed when the generation is sent, from the descriptions as they are in the library then — so
an edited description applies to the next generation — and is never written into the prompt you edit (so *Använd
igen* doesn't add it twice). The box **Läggs till i prompten** under the prompt shows it live: each described
asset with its tokens and an excerpt, a switch per asset, *Ta med beskrivningar* to switch them all off,
*Ändra beskrivning* to open the asset, and the composed length against the model's prompt limit. If the legend
would make the prompt too long, the descriptions are shortened at word boundaries (marked *förkortad*); if not even
the names fit, none are appended. The heading and words follow **Promptspråk** (`Referenser:` and `röst` in
Swedish). The clip feed keeps both texts: the prompt you wrote and, as *Skickad prompt*, what Venice got.

In the prompt editor:

- each `@ImageN` and `@AudioN` is coloured like the asset it points at; hover to see the photo or play the voice;
  wrong references turn red;
- typing `@` opens a menu with the selected photos and *Lägg till från biblioteket* (add from the library);
- the list under the editor shows every reference with its token, marks photos and clips the prompt never mentions
  and offers quick fixes such as *Byt till @Image3* (change to @Image3), *Ta bort @Image7* (remove @Image7) or
  *Ta bort @Audio2* when the voices add up to more than 15 s;
- **Generera** is disabled while a reference is wrong, and says why.

The rules live in [`src/shared/prompt-refs.ts`](src/shared/prompt-refs.ts) and are applied by the editor, by the
main process before every paid submission (including *Generate missing* and agent requests) and by the agent
tools, so a mistyped `@Image9` or a 20 s voice clip is never sent to Venice. Text-to-video and image-to-video
prompts must not contain tokens (and get no legend: they send no references). The legend is composed by
[`src/shared/prompt-compose.ts`](src/shared/prompt-compose.ts) and tokens are renumbered by
[`src/shared/prompt-remap.ts`](src/shared/prompt-remap.ts), both shared by the window, the main process and the
agent tools.

## Sequences

A **sequence** is an ordered list of clips (*Klipp*). Each clip stores the settings for new takes; every
generation for it is a **take**, and one take per clip is selected for the cut and can be trimmed at the start and
end. A clip that **continues from the previous one** (*Startbild från föregående klipp*) is generated
image-to-video: when it is generated, the previous clip's selected take is cut at its trim point and that last frame
(extracted with ffmpeg) becomes the start image, so it sends no reference photos or voices of its own. A clip can
likewise take its **end image from the next clip** (*Slutbild från nästa klipp*): the next clip's first frame after
its start trim, sent as the end image to a model that takes one (Seedance's image-to-video models do; turning the
switch on picks one). **Generera saknade** (generate missing) generates every clip without a finished selected
take, each after the clips whose frames it needs, waiting for each one; if two clips wait on each other's frames it
says which switch to turn off before anything is paid for. **Exportera** renders the selected, trimmed takes into
one H.264/AAC mp4 in the sequence's folder, showing a picture two clips share at a cut only once.

**Storyboard.** *Tidslinje / Storyboard* in the sequence header shows the clips as panels: number, take, start
image → end image, *Vad händer* notes, the prompt and the price, with *Generera tagning*. Drag panels to reorder
them and add new ones with *+ Ny ruta*. Put a picture into a slot by dropping or uploading it, picking a library
photo or a still, *Bildruta från ett klipp* (scrub any finished take of the sequence and save the frame),
**Skapa bild…** or *Från föregående / nästa klipp*. A clip with a start or end image is generated with the
image-to-video model of its family: the look comes from the pictures, so its reference photos are dropped (and
their `@` tokens taken out of the prompt), and the prompt describes what happens between them.

**Skapa bild…** makes a picture with Venice's image models — from a prompt alone, or combining references (the
first one is the base picture the model edits) — with model, format, resolution and quality to choose, the price on
the button, *Skapa igen* for another attempt and *Använd som startbild / slutbild*. Every result is saved in the
sequence's `Storyboard/` folder, and the stills strip under the panels holds them all, together with the pictures
uploaded or dropped into slots and the frames saved from takes. **Säkert läge för bilder** (Inställningar → Bilder,
on by default, also switchable in the dialog) lets Venice blur adult content.

**Gör om mellan grannarna.** When one clip in the middle came out badly, this button (on the timeline cards, the
panels and in the clip editor) sets it to start on the previous clip's last frame and end on the next clip's first
frame, with an image-to-video model that takes an end image, keeping its prompt, length and sound. The first or
last clip only gets the one neighbour it has. The editor shows both frames and the price; the neighbours need
finished selected takes. When the new take is ready, the panel offers *Använd den* — the old take stays selected
until you choose, and stays among the takes in case you want it back.

## Connecting your own agent

Studio can run an MCP server so agents such as OpenClaw, Hermes Agent, Claude Desktop or Claude Code can work in
the app: read the library and see its photos (and hear its voices), choose references, write and validate prompts,
fill in the Generate form, build sequences and storyboards, and set a clip up to be redone between its neighbours.
They can also look back: review finished clips and exported films frame by frame next to the references they were
made from, record reviews, and save *learnings* that every later session reads before it writes a prompt. Agents
**cannot generate anything on their own** — the paid tools (videos and pictures) only create a request that Studio
shows you with the prompt, references, voices and price, and nothing is sent to Venice until you approve it.

Turn it on under **Inställningar → Agentanslutning**; it listens on `http://127.0.0.1:8770/mcp` and on this Mac's
Tailscale address. See **[docs/AGENTS.md](docs/AGENTS.md)** for configuration examples, the full list of its 47
tools, the review loop and troubleshooting.

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
6. Voices and soundscapes (`@AudioN`), poses, a clip feed with filters and a table view, ratings, and a review and
   learning loop for agents
7. Storyboards with start and end images and *Skapa bild…*, redoing a clip between its neighbours
8. Asset descriptions appended to the prompt automatically, references reordered by drag and drop

Next:

9. Cost overview, cancelling a running export, transitions (fades) between clips

Ideas where help is welcome: an English UI (i18n), an automated test suite, signed and notarized builds.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) (Conventional Commits, branch names,
the PR checklist) and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Studio is released under the [MIT License](LICENSE).
