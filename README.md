# Studio

A desktop video studio for [Venice.ai](https://venice.ai)'s video models. Studio lets you generate short clips from
text, a start image or a set of reference photos (and voices), keep a library of **characters**, **environments**,
**outfits** and **poses** with their reference photos — and what the characters and places sound like — and save
the prompts that work. Clips are chained into longer films that continue seamlessly from one clip's last frame into
the next, and a clip in the middle that didn't turn out can be redone so it fits exactly between its neighbours. A
film can also start as a **storyboard**: one picture for every milestone — made with Venice's image models or taken
from what you already have — with the clips between the pictures generated for you. Your **own footage** can be
brought in and continued with AI clips, and any finished film — a clip, a take, an exported film or your own — can
be changed in **Redigera**, the editor: cut, faded, its sound cleaned up or its voice taken out, new lines spoken in
another or a cloned voice, music and effects added, a stretch redone or changed with a prompt, every change a new
version next to the untouched original. Everything lives in a plain folder you choose, with human-readable folder
and file names, and your own AI agents can work in the app over [MCP](https://modelcontextprotocol.io) — preparing
references, prompts, sequences and storyboards, editing films, and reviewing what the generations became to write
better prompts next time — while every paid generation still waits for your approval.

Built with Electron, React, TypeScript, SQLite (`better-sqlite3`) and ffmpeg.

## Features

- **Generate** with Venice's video models in three modes: text-to-video, image-to-video (start and optional end
  image) and reference-to-video (up to 9 reference photos for Seedance, plus up to 3 voice or sound clips with the
  models that take reference audio). Price quote before you generate, *Använd igen* ("use again") to reload a
  generation's settings.
- **A live clip feed built for many clips.** Queued, rendering and finished videos as big cards or a compact table
  (*Kort* / *Tabell*, with keyboard navigation), search in the prompts, filters (status, model, the asset whose
  photos or voice were used, rating, unrated or reviewed, time, standalone or a take), sorting (newest, oldest,
  rating, cost, length) and a summary of the filtered clips. A detail drawer shows the player, the prompt with its
  tokens (and *Skickad prompt*, the prompt exactly as it was sent, when descriptions were appended), the references
  and voices that were sent, the settings, and your own rating (1–5 stars), note and tags next to the agents'
  reviews.
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
- **Sequences:** films made of clips. Each clip has its own prompt, references, voices and settings, *Vad händer*
  notes, any number of takes, a selected take and start/end trims. A clip can start on the previous clip's last
  (trimmed) frame (*Startbild från föregående klipp*) and end on the next clip's first frame (*Slutbild från nästa
  klipp*), both taken out automatically with ffmpeg, or on start and end images of its own. *Generate missing*
  renders the clips in the order their frames allow; *Export* cuts the selected takes into one mp4 with ffmpeg.
- **Storyboards** (their own view, next to Sekvenser): mock up a film's milestones as pictures, one per board
  (*ruta*), then generate the clips between them. A board's picture is made with **Skapa bild…** (Venice's image
  models, about $0.06, with characters, outfits, places, poses, other storyboard pictures — or the previous board's
  picture, for continuity — as references) or taken from what you have: a library photo, an uploaded or dropped
  file, a frame of any clip. Between every two neighbouring boards there is a **transition**, the clip that goes
  from the first picture to the second (*Vad händer?*, length, price, takes). *Generera saknade* makes every missing
  one, *Förhandsvisa* plays them in order, *Exportera* cuts them into one film, and *Gör om till sekvens* carries
  them over to Sekvenser for further editing.
- **Your own clips** (*Egna klipp*): bring your own video files into the library — *Importera egna klipp…* in the clip
  feed, *Fler sätt → Eget klipp från fil…* under *Lägg till klipp* or a drop on a sequence's timeline, *Lägg till
  tagning från fil…* on a clip — and use them like any clip: AI clips continue from their last frame, end on their
  first, or redo a clip between them. Files are copied into `Egna klipp/<day>/` as an APFS clone where the disk allows
  (no extra space); a phone or camera film that can't be used as it is (HDR, 10-bit, 4K, a variable frame
  rate, rotation, ProRes, spatial audio, non-square pixels, sound and picture starting apart) gets an H.264 SDR
  working copy next to the untouched original. A film already imported is reused. Agents can use your clips once
  they are in, but never import files themselves.
- **Redigera**, the editor: open a feed clip, a take, an exported film or your own film and change it. Every change
  is a new **version** (*v1 Original*, *v2* …) in a tree you can go back and forth in, compare (*Jämför ⇄*) and send
  to a sequence; the original is never touched. A player with in/out marks and frame stepping, and a timeline with
  the picture, the sound's waveform, added sound layers and the transcript.
  - **Free, on your Mac:** keep or cut out a marked range, fade in and out, volume (the whole film, the marked
    range, or only the voice or the background), mute, *Ta bort rösten* / *Bara rösten* (voice and background
    separated with macOS's own sound isolation), noise reduction, even loudness (−14 / −16 / −23 LUFS), and adding
    sound from the library, from earlier results or from a file.
  - **Paid, through Venice, with the price on the button:** *Transkribera* (lines with times, editable, saved as
    `.srt`), *Byt röst* (speech to speech, when Venice lists a voice changer), *Läs in repliker på nytt* and *Ny
    replik* (spoken lines in a preset voice or a character's cloned *Röst*, fitted to the old line's length),
    music and sound effects on their own layers, *Gör om avsnittet* (a stretch regenerated between the frame before
    and the frame after it), *Ändra med prompt* (video-to-video edits of a short stretch), *Förläng* and
    *Uppskala* (2×/4×). Clicking the button is the approval; above $5, or when Venice can't price all of it, a
    second question asks first. A job interrupted by quitting Studio never sends its remaining parts by itself, and
    a paid AI take that couldn't be put into the film (a full disk) is put in again for free with *Fortsätt*.
- **New voices for characters:** *Skapa röst med AI…* designs a voice from a description and adds it as a *Röst*
  clip, and a character's *Röst* clip can be cloned for new lines once you tick *Får klonas för nya repliker*.
- **Exportformat** per sequence: *Automatiskt* (the first clip's size) or 480p / 720p / 1080p, for films that mix
  your own footage with AI clips. Every export records where its clips meet, which Redigera shows as cut markers.
- **Redo a clip between its neighbours** (*Gör om mellan grannarna*): a clip in the middle that didn't turn out is
  set up to start exactly on the previous clip's last frame and end exactly on the next clip's first frame — both
  taken out automatically, with live previews — and a new take fits the cut without touching the neighbours.
- **Your own folder:** a base folder you choose, with Swedish, human-readable folders and file names. Paths in the
  database are stored relative to it, so the library can be moved, switched or tidied up from Settings.
- **Agent connection (MCP):** an optional Streamable HTTP MCP server (off by default, loopback + Tailscale only,
  bearer token) through which your own agents read the library, set references, voices and prompts, build sequences
  and storyboards, edit films in Redigera (free operations directly, paid ones by request), *request* paid
  generations, pictures, edits and voices that you approve or decline in an in-app dialog, and look back at
  finished clips and exported films (frames, sound, the references used) to review them and record learnings for
  the next prompt.
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
  cutting out the part that is sent), own clips, everything in Redigera and the frames agents review; generating
  without voices works without it.
- **A Venice.ai API key** — added under **Inställningar** (Settings). Generations cost money on your Venice account.
- **Optional: the Xcode Command Line Tools** (`xcode-select --install`), to build the small Swift helper that
  separates voice and background (`npm run build:helpers`, run automatically by `dev`, `build` and `app`). Without
  it Studio works as before, and Redigera says that voice separation isn't available.

## Quick start

```bash
nvm use            # or any Node >= 22.12
npm install        # also rebuilds better-sqlite3 for Electron (postinstall)
npm run dev
```

`npm run dev` first builds the voice separation helper into `build/bin/` (skipped in a fraction of a second when it
is up to date, and with a note when the Swift compiler isn't installed), then starts **Studio Dev**, the development
profile: its own settings
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

The voice separation helper is built first and bundled into the app (without the Swift compiler the app is built
without it, and runs without voice separation). The app is signed ad hoc (no Apple Developer ID, no notarization),
which is enough to run it on the Mac that built it. Studio.app uses the real profile
(`~/Library/Application Support/Studio/`). The icon is drawn in `build/icon.svg`.

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
│   ├── Storyboard/                         Stills used as the clips' start and end images (keyframes):
│   │                                       pictures made for a clip, frames saved from takes
│   └── <Sequence name> <YYYY-MM-DD HH.MM>.mp4
│                                           Exported films
├── Storyboards/<Storyboard name>/
│   ├── Övergångar/<YYYY-MM-DD HH.MM> <prompt>.mp4
│   │                                       Takes of the transitions between the boards
│   ├── Bilder/                             The boards' pictures: made with Skapa bild (<HH.MM> <prompt>.png),
│   │                                       uploaded or dropped files, frames saved from clips
│   └── <Storyboard name> <YYYY-MM-DD HH.MM>.mp4
│                                           Exported films
├── Egna klipp/<YYYY-MM-DD>/<file name>     Your own imported films (an APFS clone of the file where possible);
│                                           "<name> (arbetskopia).mp4" next to the original when a working copy
│                                           was needed
├── Redigeringar/<Edit name>/               One folder per edit in Redigera:
│   ├── <Edit name> v2 – <change>.mp4       its versions (v1 is the film it started from, used where it is;
│   │                                       an exported film is copied in as v1)
│   ├── Tagningar/                          AI takes made for picture operations
│   ├── Ljud/                               spoken lines, converted voices, music, effects and added sound
│   └── Underlag/                           the frames and short proxies that were sent to Venice
└── .studio/                                Hidden app data:
    ├── studio.db                           the SQLite database
    ├── miniatyrer/                         poster frames (thumbnails)
    ├── bildrutor/                          extracted frames used to continue clips or end on the next one
    ├── stammar/                            separated voice and background stems (a cache, at most 4 GB)
    ├── redigering/                         paid edit jobs' downloaded parts while they are put together
    ├── tidslinje/                          Redigera's filmstrips and waveforms (a cache)
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

**Start and end images.** A clip can also start or end on a picture of its own (a file or a library photo in the
clip editor; agents can also put in pictures made with Venice's image models or frames of takes). A clip with a
start or end image is generated with the image-to-video model of its family: the look comes from the pictures, so
its reference photos are dropped (and their `@` tokens taken out of the prompt), and the prompt describes what
happens between them. Pictures made or saved for a sequence's clips are kept as stills in its `Storyboard/` folder.

**Gör om mellan grannarna.** When one clip in the middle came out badly, this button (on the timeline cards and in
the clip editor) sets it to start on the previous clip's last frame and end on the next clip's first frame, with an
image-to-video model that takes an end image, keeping its prompt, length and sound. The first or last clip only gets
the one neighbour it has. The editor shows both frames and the price; the neighbours need finished selected takes.
When the new take is ready, pick it with *Välj* under *Tagningar* — the old take stays selected until you choose,
and stays among the takes in case you want it back.

## Storyboards

A **storyboard** is a different way to make a film: first the milestones as pictures, then the motion between them.
It has a name, a format (16:9 by default; 9:16, 1:1, 4:3, 3:4 or 21:9) and an ordered row of **boards** (*rutor*),
and it lives in its own view, **Storyboards** — storyboards never show up in Sekvenser, nor sequences here.

- **One picture per board**, with a short note under it (*Vad visar bilden?*). Click the picture (or the empty
  board) for **Skapa bild…**, *Från biblioteket…* (any photo of a character, place, outfit or pose, used where it
  is), *Storyboardbilder* (pictures made or added for this storyboard before; *Visa* opens one full size, where it
  can be used or deleted), *Ladda upp en bild…* (or drop a file on the board; it is copied into the storyboard's
  `Bilder/`) or *Bildruta ur ett klipp…* (scrub any finished clip in the library and save the frame; needs ffmpeg). A picture whose shape differs from the storyboard's format is marked
  *Annat format*: the clips to and from it get the picture's shape. A board may stay empty while you plan.
- **Boards are reordered** by dragging them or with ⌥← / ⌥→, added with **+** before, between or after them (several
  pictures dropped on *Ny ruta* become one board each) and removed with a two-step confirmation.
- **Transitions.** Between every two neighbouring boards there is a transition (*Övergång N*): the clip from the
  first board's picture (the start image) to the second's (the end image). Click it to edit *Vad händer?* — what
  moves and how the camera travels from one picture to the other; *Föreslå* fills in a plain template from the two
  boards' notes — and its length (5 s by default), resolution (480p), sound and model (only image-to-video models that
  take an end image; Seedance by default). **Generera** shows the price first; every take is kept, and you choose the
  one that is used. Moving, inserting or removing a board removes the transitions between boards that are no longer
  neighbours — their prompts go, their takes go back to the clip feed in Generera, nothing is deleted — and new
  neighbours get a new, empty transition; Studio asks first when a move or a new board would remove a transition with
  a prompt or takes. A take made before one of its boards got another picture is marked *Tidigare bild*; a new take
  made from the pictures there now takes its place when it is done, and deleting the selected take selects another
  finished one. A negative prompt an agent gave a transition is shown under *Vad händer?*, where it can be removed.
- **Generera saknade** sends every transition without a finished take, with the total price on the button. The
  transitions don't depend on each other, so they are sent one after another without waiting for each to render;
  nothing is paid for while any of them can't be made (a board without a picture, a missing prompt) — the button then
  shows no price, and a click shows the transition that stands in the way.
- **Förhandsvisa** plays the selected takes back to back; **Exportera** cuts them into one mp4 in the storyboard's
  folder. Two neighbouring transitions both show the board between them (one ends on it, the next starts on it), so
  where both takes were made from the same picture the export drops the later one's first frame and the board is
  shown once.
- **Gör om till sekvens** (under ⋯) makes an ordinary sequence, *"<name> (sekvens)"*, with one clip per transition and
  a copy of its selected take, so the film can be trimmed, extended and redone in Sekvenser. The storyboard stays as
  it is.

**Skapa bild…** makes a picture with Venice's image models — from a prompt alone, or combining references (the first
one is the base picture the model edits) — with model, format (the storyboard's by default), resolution and quality
to choose, the price on the button and *Skapa igen* for another attempt. **Använd föregående bild som referens** (on
by default when the previous board has a picture) puts that picture first among the references, so place, light and
people carry over from one milestone to the next. The finished picture goes onto the board, and every result is
kept in the storyboard's `Bilder/` folder. **Säkert läge för bilder** (Inställningar → Bilder, on by default, also
switchable in the dialog) lets Venice blur adult content.

## Connecting your own agent

Studio can run an MCP server so agents such as OpenClaw, Hermes Agent, Claude Desktop or Claude Code can work in
the app: read the library and see its photos (and hear its voices), choose references, write and validate prompts,
fill in the Generate form, build sequences (also with your own clips), plan storyboards (boards, their pictures and
the transitions' prompts), set a clip up to be redone between its neighbours, and edit films in Redigera.
They can also look back: review finished clips and exported films frame by frame next to the references they were
made from, record reviews, and save *learnings* that every later session reads before it writes a prompt. Agents
**cannot generate anything on their own** — the paid tools (videos, pictures, paid edits and designed voices) only
create a request that Studio shows you with the prompt, references, voices and price, and nothing is sent to Venice
until you approve it. They also cannot import files from disk or delete edits and versions.

Turn it on under **Inställningar → Agentanslutning**; it listens on `http://127.0.0.1:8770/mcp` and on this Mac's
Tailscale address. See **[docs/AGENTS.md](docs/AGENTS.md)** for configuration examples, the full list of its 73
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
7. Start and end images (keyframes) and *Skapa bild…*, redoing a clip between its neighbours
8. Asset descriptions appended to the prompt automatically, references reordered by drag and drop
9. Storyboards as a workflow of their own: milestone pictures, with the clips between them generated
10. Redigera (an AI editor for any finished film), own clips in sequences, designed and cloned voices

Next:

11. Cost overview, cancelling a running export, fades between clips; continuing the motion of an own clip,
    upscaling long films in parts, subtitles burned into the picture

Ideas where help is welcome: an English UI (i18n), an automated test suite, signed and notarized builds.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) (Conventional Commits, branch names,
the PR checklist) and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Studio is released under the [MIT License](LICENSE).
