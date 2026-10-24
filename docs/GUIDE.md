# JIBES Studio – the full guide

Everything JIBES Studio (Studio for short) does, in detail. For a short introduction and how to install it, see the [README](../README.md).


A desktop video studio for the video models of [Venice.ai](https://venice.ai) or [fal.ai](https://fal.ai) – you choose
the service in Settings (see [Services](#services-venice-and-fal-ai)). Studio lets you generate short clips from
text, a start image or a set of reference photos (and voices), keep a library of **characters**, **environments**,
**products**, **outfits** and **poses** with their reference photos — and what the characters and places sound
like —, **directors** that give every clip they direct the same way of being made, and save the prompts that work. Clips are chained into longer films that continue seamlessly from one clip's last frame into
the next, and a clip in the middle that didn't turn out can be redone so it fits exactly between its neighbours. A
film can also start as a **storyboard**: one picture for every milestone — made with the service's image models or taken
from what you already have — with the clips between the pictures generated for you. Your **own footage** can be
brought in and continued with AI clips, and any finished film — a clip, a take, an exported film or your own — can
be changed in the **Editor**: cut, faded, its sound cleaned up or its voice taken out, new lines spoken in
another or a cloned voice, music and effects added, a stretch redone or changed with a prompt, every change a new
version next to the untouched original. Everything lives in a plain folder you choose, with human-readable folder
and file names, and your own AI agents can work in the app over [MCP](https://modelcontextprotocol.io) much as you
do — creating characters and products with the photos and sound they upload, preparing references, prompts,
sequences and storyboards, editing films, and reviewing what the generations became to write better prompts next
time — while every paid generation and every removal still waits for your approval. *Activity* shows what is
being made right now and what is ready to watch, wherever you are in the app.

Built with Electron, React, TypeScript, SQLite (`better-sqlite3`) and ffmpeg.

## Features

- **Generate** with the service's video models in three modes: text-to-video, image-to-video (start and optional end image)
  and reference-to-video (up to 9 reference photos for Seedance, plus up to 3 voice or sound clips with the models
  that take reference audio, and with Seedance 2.x up to 3 or 10 **reference videos** for motion, camera and style,
  `@Video1` …). The mode switch (*Text*, *Start image*, *References*) sits at the top, and what sets the price —
  *Duration*, *Resolution*, *Aspect ratio* and *Sound* — in one row right above the button, which shows the price
  before you generate; the line under it says what is still missing, or *⌘↵ to generate* (⌘↵ works from any field of
  the form). Without an API key that line starts with *Add your Venice API key in Settings* (or fal.ai's, when that
  is the service), and when nothing else is missing the button opens *Settings → Service*. Empty optional sections (reference videos, voices and sound) are a
  single row, and one *＋ From library* adds characters, places, products, outfits and poses. *Use again* reloads a
  generation's settings. **Variants:** *×1 ×2 ×3 ×4* beside *Generate* (and beside a sequence clip's or a storyboard
  transition's *Generate take*) sends that many takes of the same settings at once — each its own generation, with its
  own seed, at the full price; the button shows the total (*Generate ×3 · $3.09*), ⌘↵ sends as many, and each place
  remembers its choice. The list beside the form shows what you made there this session; everything older is in Media.
- **Media:** everything you've made in one place, in three tabs — *Clips*, *Images* and *Films* (see
  [Media](#media)). *Clips* is a live clip feed built for many clips: queued, rendering and finished videos
  as big cards or a compact table (*Cards* / *Table*, with keyboard navigation), search in the prompts, filters
  (source, status with counts, model, the asset whose photos or voice were used, rating (★★★, ★★ or more, ★ or more,
  *Thumbs down*), unrated or reviewed, time, standalone or a take, *New* — not watched yet; a filter shows only while
  it is set or can narrow the list), sorting (newest, oldest, rating, cost, length) and a summary of the filtered
  clips. A detail drawer shows the player, the prompt with its
  tokens (and the sent prompt, exactly as it went to Venice, when descriptions were appended) — hover a token
  to see its picture, or to play the part of the voice that was sent — the references
  and voices that were sent, the settings, and your own rating (👎 *thumbs down* or one to three stars), note and tags
  next to the agents' reviews.
- **A reference-aware prompt editor.** In reference mode the prompt points at the photos as `@Image1`, `@Image2` …
  and at the voice and sound clips as `@Audio1`, `@Audio2` …; the editor colours each token like the asset it points
  at, shows the photo on hover and plays the voice, offers an `@` menu, flags wrong or malformed tokens with one-click
  fixes, and blocks generation while a reference is wrong. The same check runs again in the main process before
  anything is sent to Venice. **Drag a reference photo or voice to another place** and its number changes, with
  every token in the prompt following it. **The descriptions of the referenced characters, places, products, outfits
  and poses are appended automatically** when the prompt is sent, as a short *References* list that also says who
  wears each outfit, so you write what happens rather than what everyone looks like.
- **Library of characters, environments, products, outfits and poses**: a name, a description and ordered
  reference photos, each in its own folder. A character can have a default outfit that comes along automatically,
  and **a voice**; an environment can have **a soundscape**. Each audio clip has a 2–15 s reference window, the part that is sent, which you pick on
  a timeline. A **product** is a specific item to show in the film — a package, a bottle, a gadget — with clear
  packshots and a description (brand, model, colours, what the packaging says); in the form a character can hold it
  (*Held by*). A **pose** is a photo or sketch of how people stand relative to each other, applied to the characters
  in the shot. Every asset page has the name, a line with what it holds, then *Generate with …* and ⋯ (*Open folder*,
  *Delete…*); *Copy* sits by the description. Drag a photo or focus it and press ⌥← / ⌥→ to change the order (the
  first is the cover); removing one asks first. Of the voice or sound clips the first is the *Default* (*Make
  default* picks another), and each row has *Start here* and *Exact times…* for the part that is sent; its grip moves
  it with ⌥↑ / ⌥↓.
- **Directors**: a way of making a film, reused wherever you choose it — how it is cut, its look, the camera, the
  light, the framing, the rhythm, the acting and the sound, what it never does, style frames and style videos, and
  the model and format it prefers. Eight ready-made ones (Documentary, Music video, Noir, Commercial, Dreamy, Action,
  Vintage film, Minimal) plus your own; choose one in Generate, for a whole sequence or music video (a clip can
  choose another, or none) or for a storyboard, and Studio adds its *Direction* to every prompt it directs (see
  [Directors](#directors)).
- **Prompt library** with titles, tags, favourites, a negative prompt and usage counts, and **Learnings**:
  short insights about what works, recorded by you or your agents, with the clips they are based on. Both lists work
  like the side lists (↑ / ↓ open a row, Enter in the search opens the first match); ⌘↵ on a prompt — in the list or
  in its editor — puts it in Generate (*Generate with the prompt*), and ⌘K has *New prompt* and *New learning*.
- **Sequences:** films made of clips. Each clip has its own prompt, references, voices and settings,
  *Notes* for yourself (never sent), any number of takes in a strip under the player — **click a take and it becomes the clip's take** and plays,
  with sound; ← / → choose with the keyboard, ⌥-click previews without choosing — and start/end trims that each take
  remembers for itself. A clip can start on the previous clip's last
  (trimmed) frame (*Start on the previous clip's last frame*) — by default with the reference photos and voices it
  carries, so the characters stay themselves (*With references*), or as an exact cut (*Exact start frame*) — and end
  on the next clip's first frame (*End on the next clip's first frame*), both taken out automatically with ffmpeg, or on start and
  end images of its own. *Generate missing*
  renders the clips in the order their frames allow; *Export* cuts the selected takes into one mp4 with ffmpeg.
  Space plays and pauses the clip, I and O set where its take starts and ends, and ⌥← / ⌥→ move a clip card.
- **Storyboards** (their own view, next to Sequences): mock up a film's milestones as pictures, one per board,
  then generate the clips between them. A board's picture is made with **Create image…** (Venice's image
  models, about $0.06, with characters, products, outfits, places, poses, other storyboard pictures — or the previous board's
  picture, for continuity — as references) or taken from what you have: a library photo, an uploaded or dropped
  file, a frame of any clip. Between every two neighbouring boards there is a **transition**, the clip that goes
  from the first picture to the second (what happens, length, price, takes). *Generate missing* makes every missing
  one, *Preview* plays them in order, *Export* cuts them into one film, and a menu command carries
  them over to Sequences as a sequence for further editing.
- **Your own clips** (*Own clips*): bring your own video files into the library — *Import own clips…* in
  Media's *Clips*, adding a clip or a take from a file in a sequence, or a drop on a sequence's timeline — and use
  them like any clip: AI clips continue from their last frame, end on their first, or redo a clip between them.
  Files are copied into `Own clips/<day>/` as an APFS clone where the disk allows (no extra space); a phone or camera film that can't be used as it is (HDR, 10-bit, 4K, a variable frame
  rate, rotation, ProRes, spatial audio, non-square pixels, sound and picture starting apart) gets an H.264 SDR
  working copy next to the untouched original. A film already imported is reused. Agents can import video files
  they upload the same way.
- **The Editor**: open a clip from Media, a take, an exported film or your own film and change it (*＋ New* →
  *Own film from file…*, *From Media…* or *From an export…*, or drop a film anywhere in the Editor). Every edit is
  in the list on the left, as in Sequences, and the Editor always opens one — the one open last, else the most
  recently changed; *All edits* (the grid button in its header) shows them all as cards or a table. Every change is a
  new **version** (*v1 Original*, *v2* …) in a tree you can go back and forth in, compare and send to a sequence; the
  original is never touched. Click a version to look at it in the player; *Use* (or *Use v2* on the player while
  comparing) makes it the one the actions change. A player with in/out marks, frame stepping and *Loop* in the
  selection's chip, and a timeline with the picture, the sound's waveform and — once they have something — the added
  sound layers and the transcript. The actions are in four tabs, *Picture*, *Sound* (music and effects too), *Voice*
  and *Text*, and ⌘↵ runs the card that has the focus; ⋯ in the header holds *Rename*, *Clean up versions…*, *Open
  folder* and *Delete…*.
  - **Free, on your Mac:** keep or cut out a marked range, fade in and out, volume (the whole film, the marked
    range, or only the voice or the background), mute, removing the voice or keeping only the voice (voice and
    background separated with macOS's own sound isolation), noise reduction, even loudness (−14 / −16 / −23 LUFS), and adding
    sound from the library, from earlier results or from a file.
  - **Paid, through the service, with the price on the button:** transcription (lines with times, editable, saved as
    `.srt`), *Change voice* (speech to speech, when the service lists a voice changer), lines read again and new
    lines (spoken in a preset voice or a character's cloned voice, fitted to the old line's length),
    music and sound effects on their own layers, *Regenerate section* (a stretch regenerated between the frame before
    and the frame after it), *Edit with prompt* (video-to-video edits of a short stretch), *Extend* and
    *Upscale* (2×/4×), and on fal.ai *Lip sync* (the mouths in a stretch follow its sound). Clicking the button is
    the approval; above $5, or when the service can't price all of it, a
    second question asks first. A job interrupted by quitting Studio never sends its remaining parts by itself, and
    a paid AI take that couldn't be put into the film (a full disk) is put in again for free when you continue the job.
- **New voices for characters:** *Design a voice with AI…* designs a voice from a description and adds it as a voice
  clip, and a character's voice clip can be cloned for new lines once you tick *May be cloned for new lines*.
- **Export format** per sequence (⋯ in its header): automatic (the first clip's size) or 480p / 720p / 1080p, for
  films that mix your own footage with AI clips. Every export records where its clips meet, which the Editor shows as
  cut markers.
- **Redo a clip between its neighbours** (*Redo between neighbours*): a clip in the middle that didn't turn out is
  set up to start exactly on the previous clip's last frame and end exactly on the next clip's first frame — both
  taken out automatically, with live previews — and a new take fits the cut without touching the neighbours.
- **Activity**: every sidebar view shows what runs there (a spinner and a count) and
  what has finished that you haven't looked at yet (a dot), and so do the lists, the cards, the takes, the
  transitions, the versions and the voices. The *Activity* row at the bottom of the sidebar opens a panel that
  lists everything that runs — with its progress and an estimate —, what is ready to watch and what failed, with
  *Mark all as seen* (and *Undo*). A video counts as seen once it has played for a second or you chose it; the
  Dock icon shows the number of new results.
- **Spending and a budget:** *Settings → Spending* shows what Studio has paid for today (to Venice and fal.ai), this month and per
  day over the last 30 days, and this month by kind (videos, images, Editor jobs, voices, transcripts), by place
  (Generate, each sequence, storyboard and edit) and by who asked (you, or the agent whose request you approved).
  An optional daily and monthly budget: anything paid that would take the spending past one asks first (*Send
  anyway* / *Cancel*), and an agent's request shows the same warning in its approval dialog.
- **The same list on the left** in Characters, Environments, Products, Outfits, Poses, Directors, Sequences,
  Storyboards and the Editor: *＋ New* at the top, a search field (⌘F) that looks in the names — and in the
  descriptions of the library kinds and where a film came from in the Editor —, ↑ / ↓ to move to a row and open it,
  Enter in the search to open the first match and Esc to clear it. **✕ on a row** (on hover or keyboard focus, or ⌫
  on a focused row) asks in the row itself — *Delete “Anna”?*, one line on what goes and what stays, *Cancel* /
  *Delete* — and shows there what went wrong if it couldn't; the open one gives way to the row below.
- **A grouped sidebar that folds away:** *Create* (Generate, Sequences, Storyboards, Editor) and *Library*
  (Media, the five kinds, Directors and Prompts), one icon set, slim status rows at the bottom — *Activity*, and the
  agent while the connection is on or a request waits (otherwise ⌘K → *Agent*) — above *Settings* (with a dot until
  there is an API key), and a 72 px icon rail (⌃⌘S, or the button by the wordmark) that gives the views more room.
- **⌘K — search everywhere:** from any view, also while typing in a field (or with the search button by the
  wordmark), one field finds the views and Settings' panes, actions such as *New sequence*, *New character*,
  *New director*, *New prompt* or *New learning*, and the library: assets and directors (the ready-made ones too) by name and description, saved prompts (Enter puts one in Generate's form), sequences and their
  clips' notes, storyboards' boards and transitions, edits, clips (newest first), images by prompt and exported films.
  Case and accents don't matter and each word matches the start of a word; ↑ / ↓ and Enter (or a click) open the
  result where Studio always shows it, Esc closes. With nothing typed it lists what you changed last and the
  *New …* actions. It is for you only: agents search with their own list tools.
- **Your own folder:** a base folder you choose, with human-readable folder and file names (in English). Paths in
  the database are stored relative to it, so the library can be moved, switched or tidied up from Settings.
- **Export & import** of the whole library as one zip, for moving it to another Mac (*Settings → Library → Move to
  another computer*).
- **Agent connection (MCP):** an optional Streamable HTTP MCP server (off by default, loopback + Tailscale only,
  bearer token) through which your own agents work much as you do: they create assets of every kind and give them
  photos and sound (sent as uploads or URLs Studio fetches — never paths on your Mac), set references, voices and
  prompts, build, trim and export sequences and storyboards, import own clips, edit films in the Editor (free
  operations directly, paid ones by request), *request* paid generations, pictures, edits and voices — and any
  removal — that you approve or decline in an in-app dialog, follow what runs, and look back at finished clips and
  exported films (frames, sound, the references used) to review them and record learnings for the next prompt.
  Claude Desktop connects in one click: *Add to Claude Desktop* installs Studio there as an extension.
- **Updates from GitHub**: a check once a day (it can be switched off) and *Check for Updates…*; *Update now*
  downloads the new version, checks it and installs it in place (see [Updates](#updates)).
- **Separate development profile** ("Studio Dev") so development never touches the library the installed app uses.

## Status

Early, personal project, now open source. Things work and are used daily, but expect rough edges and breaking
changes.

- **macOS on Apple Silicon and Windows x64.** On a Mac ffmpeg comes from Homebrew and secrets use the macOS
  Keychain through Electron's `safeStorage`; on Windows ffmpeg comes with Studio (see [On Windows](#on-windows)).
- There is no automated test suite yet (CI typechecks and builds every pull request); see
  [docs/DEVELOPMENT.md](DEVELOPMENT.md) for how changes are tested without spending money.

## On Windows

Studio for Windows works like the Mac version; this guide is written for the Mac, so read it with Windows' keys and
places:

- **Ctrl instead of ⌘, Alt instead of ⌥, Shift for ⇧** — the app's own hints and tooltips say so, and
  [Keyboard shortcuts](#keyboard-shortcuts) lists them all. Ctrl+K searches everywhere, Ctrl+, opens Settings, Ctrl+F
  searches a list, Ctrl+Enter generates, Ctrl+Shift+F opens the larger prompt window, Ctrl+Z goes back a version in
  the Editor, Ctrl+scroll zooms its timeline, Alt+← / Alt+→ move a reference, a clip, a photo or a board, and
  Alt+click previews a take. Two are different: **Ctrl+Shift+S** folds the sidebar (⌃⌘S on a Mac) and **Ctrl+Y**
  redoes in the Editor (Ctrl+Shift+Z works too). There is no menu bar; its shortcuts still work (Ctrl+0, Ctrl+Plus,
  Ctrl+-, F11, and Ctrl+, for Settings).
- **Voice separation is macOS only** (it is Apple's sound isolation). *Remove the voice*, *Only the voice*, keeping
  the background under a new voice and *Separate the vocals* of a song stay off and say why — where a voice changes,
  the original sound is lowered instead, and lyrics are transcribed from the whole song. Everything else works.
- **Where things are:** *Show in File Explorer* wherever this guide says *Show in Finder*; deleted files go to the
  **Recycle Bin**; the suggested library folder is *JIBES Studio* in your **Videos** folder; settings are in
  `%APPDATA%\Studio\settings.json`, the API key and the agent token encrypted for your Windows user account; new or
  failed results show as a dot on Studio's **taskbar** button (the Dock counts them on a Mac). ffmpeg comes with
  Studio (*Settings → About* shows it); if it is ever missing, reinstall Studio.

## Requirements

- **Node.js** — the version in [`.nvmrc`](../.nvmrc) (24); at least 22.12 (`engines` in `package.json`).
- **ffmpeg** (with `ffprobe`) — `brew install ffmpeg`. Studio looks in `/opt/homebrew/bin`, `/usr/local/bin`,
  `/usr/bin` and then `PATH`. It is needed for posters, durations, the start and end frames clips take from their
  neighbours (and their previews), saving a frame as a still, exports, voice and sound clips (measuring them and
  cutting out the part that is sent), own clips, everything in the Editor and the frames agents review; generating
  without voices works without it.
- **An API key for [Venice.ai](https://venice.ai/settings/api) or [fal.ai](https://fal.ai/dashboard/keys)** — added
  under **Settings → Service**. Generations cost money on that account.
- **Optional: the Xcode Command Line Tools** (`xcode-select --install`), to build the small Swift helper that
  separates voice and background (`npm run build:helpers`, run automatically by `dev`, `build` and `app`). Without
  it Studio works as before, and the Editor says that voice separation isn't available.

## Quick start

```bash
nvm use            # or any Node >= 22.12
npm install        # also rebuilds better-sqlite3 for Electron (postinstall)
npm run dev
```

`npm run dev` first builds the voice separation helper into `build/bin/` (skipped in a fraction of a second when it
is up to date, and with a note when the Swift compiler isn't installed), then starts **Studio Dev**, the development
profile: its own settings
(`~/Library/Application Support/Studio Dev/`), its own suggested base folder (`~/Movies/JIBES Studio Dev`) and a yellow
**Dev** badge in the sidebar. It never touches the library the installed JIBES Studio.app uses, and both can run at the
same time. The first launch asks you to choose a base folder; then add your Venice API key under **Settings**.

Other ways to run it (see [docs/DEVELOPMENT.md](DEVELOPMENT.md)):

| Command | Profile |
| --- | --- |
| `npm run dev` | Studio Dev — separate settings and library |
| `npm run dev:real` | The real Studio profile (quit JIBES Studio.app first; only one can run) |
| `STUDIO_PROFILE_DIR=/tmp/studio-test npm run dev` | A throwaway profile under that folder |

## Building JIBES Studio.app

```bash
npm run app           # builds dist/mac-arm64/Studio.app
npm run app:install   # builds it and copies it to /Applications (replacing an earlier copy)
```

The voice separation helper is built first and bundled into the app (without the Swift compiler the app is built
without it, and runs without voice separation). The app is signed ad hoc (no Apple Developer ID, no notarization),
which is enough to run it on the Mac that built it. JIBES Studio.app uses the real profile
(`~/Library/Application Support/Studio/`). The icon is drawn in `build/icon.svg`.

A second copy, **Studio Test**, runs beside JIBES Studio.app with its own settings and library:

```bash
npm run app:install:test   # builds "JIBES Studio Test.app" and copies it to /Applications
```

It has its own settings (`~/Library/Application Support/Studio Test/`), its own suggested base folder
(`~/Movies/JIBES Studio Test`), its own Venice API key and a pink **Test** badge, and runs beside JIBES Studio.app and
Studio Dev. It never updates itself from GitHub – run the command again to bring it up to date.

## Updates

Studio asks GitHub once a day, when it starts, whether a newer version is out – and whenever you ask: **Check for
Updates…** in the Studio menu (macOS) or **Check for updates** under **Settings → About**. A newer version shows
as a small notice in the bottom right corner: **Update now** downloads it, checks it and installs it, **Release notes**
opens its page on GitHub, and **Later** hides that version until a newer one comes out.

- **On a Mac** Studio replaces itself where it is (in Applications or wherever you keep it) and restarts; the old
  version goes to the Trash. It must be allowed to write there: if it isn't – another user's copy, a read-only disk, or
  Studio opened straight from Downloads, which macOS runs from a temporary place – the notice says so and offers the
  release page instead. Running the install command from the README again also updates it.
- **On Windows** Studio downloads the installer (`JIBES-Studio-win-x64-setup.exe`), closes and runs it without questions;
  it updates Studio where it is installed and opens it again. The portable zip can't update itself: download the new
  zip from the release page.
- **Checked before it is installed.** The download must match the SHA-256 checksum GitHub records for the file (or the
  release's `SHA256SUMS.txt`); one that doesn't is never installed. Nothing is installed while something runs that a
  restart would cut off – generations at Venice, an export, an import, a library export or import, an agent's request
  – Studio says what to wait for. If anything goes wrong, the Studio you have stays as it was.
- **What it sends:** the check is one request to GitHub (`api.github.com`) for the newest release's details, the
  download only happens when you choose *Update now*, and nothing about you or your library goes with either. Turn the
  daily check off with **Check for updates automatically** under **Settings → About**; Studio then only asks
  when you do.
- **Studio Dev**, **Studio Test** and other development builds (`npm run dev`, `npm run dev:real`) never look for
  updates: they come from git.

## Where things are stored

**Settings** live in `~/Library/Application Support/Studio/settings.json`: the base folder, the prompt language,
*Safe mode for images* (Venice blurs adult content in pictures it makes; on by default), the spending budget,
accepted Venice consents, the agent connection's port and the daily update check (on or off, and when Studio last
checked). The Venice API key and the agent token are stored
encrypted with Electron `safeStorage` (macOS Keychain).

**The library** lives in a base folder you choose on first launch (suggested: `~/Movies/JIBES Studio`). It can be switched
or moved under **Settings → Library**, and **Tidy up** puts
every file the library knows about back where it belongs.

The folders have English names. A library made by an earlier version, with Swedish folder names (`Karaktärer`,
`Sekvenser` …), is renamed the first time this version opens it: the folders are only renamed in place – nothing is
copied or removed – and everything Studio remembers about the files follows. If a folder of your own already has one
of the English names, Studio says which and changes nothing until you have moved it. An earlier version can't open the
library afterwards.

```
<base folder>/
├── Characters/<Name>/                      Characters: reference photos and voice clips (original file names)
│                                           + Description.txt
├── Environments/<Name>/                    Environments: photos of the place, soundscape clips + Description.txt
├── Products/<Name>/                        Products: packshots of the item + Description.txt
├── Outfits/<Name>/                         Outfits: photos of the garments + Description.txt
├── Poses/<Name>/                           Poses: photos or sketches of the positions + Description.txt
├── Directors/<Name>/                       Your own directors: style frames, style videos + Description.txt
├── Reference images/<YYYY-MM-DD>/          Start, end and reference images and reference audio picked from
│                                           outside the library, copied here when a generation is submitted;
│                                           stills that belong to no sequence (any more)
├── Generations/<YYYY-MM-DD>/<HH.MM> <prompt>.mp4
│                                           Generated videos that don't belong to a sequence
├── Sequences/<Sequence name>/
│                                           ├── Takes/<YYYY-MM-DD HH.MM> <prompt>.mp4
│   │                                       Takes of the sequence's clips
│   ├── Storyboard/                         Stills used as the clips' start and end images (keyframes):
│   │                                       pictures made for a clip, frames saved from takes
│                                           └── <Sequence name> <YYYY-MM-DD HH.MM>.mp4
│                                           Exported films
├── Storyboards/<Storyboard name>/
│                                           ├── Transitions/<YYYY-MM-DD HH.MM> <prompt>.mp4
│   │                                       Takes of the transitions between the boards
│   ├── Images/                             The boards' pictures: made with Create image (<HH.MM> <prompt>.png),
│   │                                       uploaded or dropped files, frames saved from clips
│                                           └── <Storyboard name> <YYYY-MM-DD HH.MM>.mp4
│                                           Exported films
├── Own clips/<YYYY-MM-DD>/<file name>      Your own imported films (an APFS clone of the file where possible);
│                                           "<name> (working copy).mp4" next to the original when a working copy
│                                           was needed
├── Edits/<Edit name>/                      One folder per edit in the Editor:
│   ├── <Edit name> v2 – <change>.mp4       its versions (v1 is the film it started from, used where it is;
│   │                                       an exported film is copied in as v1)
│   ├── Takes/                              AI takes made for picture operations
│   ├── Audio/                              spoken lines, converted voices, music, effects and added sound
│   └── Inputs/                             the frames and short proxies that were sent to Venice
└── .studio/                                Hidden app data:
    ├── studio.db                           the SQLite database
    ├── requested-by.json                   which agent asked for each paid item you approved (Spending)
    ├── thumbnails/                         poster frames (thumbnails)
    ├── frames/                             extracted frames used to continue clips or end on the next one
    ├── stems/                              separated voice and background stems (a cache, at most 4 GB)
    ├── edit-jobs/                          paid edit jobs' downloaded parts while they are put together
    ├── timeline/                           the Editor's filmstrips and waveforms (a cache)
    └── tmp/                                scratch files, cleared when the library is opened (agents' uploads
                                            wait in tmp/agent-uploads/ until a tool copies them in)
```

Paths in the database are stored relative to the base folder whenever they point into one of these folders, so
the whole library can be moved by moving its folders. Files of your own elsewhere in the base folder are left
alone. A library from an earlier layout (`studio.db`, `generations/`, `thumbs/` … directly in the folder) is
converted to this layout when it is opened.

**Export & import.** *Settings → Library → Move to another computer → Export library…* packs the whole library into one
zip (saved in `~/Downloads` by default, named with the date): a consistent copy of the database and every file in the
library's folders. Caches Studio rebuilds by itself (posters, frames, stems, filmstrips, scratch) stay out, except a
frame a take was started from; your own files elsewhere in the base folder, settings, the API key and the agent token
never come along. *Import a library…* checks the zip (it must be a Studio export, not from a newer Studio),
unpacks it into a new or empty folder (suggested: `~/Movies/<zip name>`), checks the database and files, and opens it
as your library; the library you had open stays where it is. On a new Mac the first screen offers *Import a
library…* too. Posters are made again in the background. While an export runs, switching libraries and *Tidy up*
have to wait until it is done; an export and an import can both be cancelled (*Cancel*).

## Media

**Media**, first under *Library* in the sidebar, holds everything you've made, in three tabs (the one you
used last opens again):

- **Clips** — every video: generations, takes of sequence clips and storyboard transitions, your own films and
  the Editor's versions. Cards or a table (*Cards* / *Table*), search (⌘F; Enter opens the first match, ↑ from the
  table's first row goes back to it), the filters and sorting described under [Features](#features) — a filter chip
  shows only while it is set or can narrow the list, and *Status* counts what is done, in progress and failed
  —, *Import own clips…* (or drop video files on it), and the detail drawer with the player, the prompt, the
  references, the settings, *Show in Finder* and your rating, note and tags. *Use again* opens Generate with the
  clip's settings in the form. Pointing at a card shows *Use again* and *Add to sequence*; its ⋯ has *Edit…* (open it
  in the Editor), *Show in Finder* and *Delete…*, which asks in the menu.
- **Images** — every picture, as framed cards: made with *Create image…*, your own (uploaded or dropped), frames
  saved from clips. Filters for where it came from (*Source*: created, *Own images*, frames) and where it belongs
  (*Placement*: a sequence, a storyboard, or *Reference images* — none); click one to see it large, ← / → for the
  next.
- **Films** — the films exported from sequences and storyboards, with their length (*1 min 24 s*) and number of
  clips. Play one (Space, ← / → for the next, *Close (Esc)*), change it in the Editor (*Edit…*) or go to the
  sequence or storyboard it came from.

**Generate** shows only this session beside its form: what you made there since Studio started, and clips that were
still being made when it started (they stay once they are done). Closing the window keeps the session; quitting Studio ends it, and next time the list starts
empty — the clips are all in Media, which Generate links to. *Activity* counts Generate's clips under
Generate while they are in its list and under Media after that, together with pictures that belong to no
sequence or storyboard.

## Prompts, `@ImageN`, `@AudioN` and `@VideoN` references

In **reference mode** the model receives the reference images in order, and the prompt refers to them as
`@Image1`, `@Image2` … in that order. Picking a character, environment, product, outfit or pose (*＋ From library*,
which opens on the kind you added last) adds its photos to the reference images, and a label for each asset inserts
the right tokens, for example:

```
Anna (@Image1, @Image2) wearing Red dress (@Image3) walks along the beach promenade (@Image4) …
```

The connecting word follows **Settings → Generation → Prompt language**: `wearing` in English
(the default; the models understand English best) or `i` in Swedish.

**Voices and sounds.** With a model that takes reference audio (Seedance's reference-to-video models among them),
adding a character that has a voice also adds its first voice clip (a switch on the chip turns it off; an
environment's soundscape comes along when you switch it on there), and the prompt refers to the clips as `@Audio1`,
`@Audio2` … in order: `Anna (@Image1, @Image2, voice @Audio1) says …`, `the harbour (@Image4, sound @Audio2)`
(`röst` and `ljud` in Swedish). Venice uses the clips as a guide to timbre, tone and pacing, not as an exact clone.
At most 3 clips, each 2–15 s, 15 s in all, and only together with at least one reference image; Studio cuts each
clip's window out of the file and sends it as mono MP3. A voice from a recording shorter than 2 s can't be sent, so
it doesn't come along (a note says so).

**Reference videos.** With a Seedance 2.x reference model, **Reference videos** (under the reference images) takes
videos whose motion, camera movement or style the clip should follow: *＋ Video* adds a clip from Media, a take of a
sequence clip, an exported film, or a file (or drop one on the row, which is a single line while it is empty). They
are references only – never edited, extended or shown in the result – and the prompt refers to them as `@Video1`,
`@Video2` … in order: `the camera moves as in @Video1`. Each tile shows the part that is sent and plays it while you
point at it; click it to choose the part (drag the window or its edges, *Start here*, *Whole video*), drag it or press
⌥← / ⌥→ to change the order (the tokens follow, like the pictures'), ✕ removes it. A new video sends its first 5 s (or
all of it when it is shorter). Seedance 2.0 takes at most 3 videos of 2–15 s, 15 s together; Seedance 2.5 at most 10
of 2–30 s, 30 s together – the row counts along and says what is over. The video seconds are priced too, so a clip
with reference videos costs more; the price beside *Generate* follows the parts you choose. Studio cuts each part to a
small MP4, sends it as `<Video 1>` …, and the legend tells the model what to take from it (`Refer to the action,
camera movement and style in @Video1`). Other reference models take no videos: the row then offers the family's
Seedance reference model. A sequence clip takes videos the same way (the cast doesn't: videos aren't library assets),
and a clip that continues the previous one with references carries them along like its pictures – but references of
its own, even a single video, replace everything it would carry (the clip editor says so).

**Poses.** A pose chip applies to the characters you choose (all of them by default):
`Anna (@Image1) and Erik (@Image3) posed as in Hug (@Image5)` (`… och … i posen …` in Swedish).

**Outfits.** An outfit chip says who wears it (*Worn by*): by default the character whose default outfit it is,
else the only character in the form; pick another character or nobody. The choice is saved with the form, a
sequence clip and the generation (*Use again* brings it back), and the legend says it when the prompt is sent (see
below), so the clothes can't be taken for anyone else's. Changing the outfit on a character chip carries the choice to the
new outfit.

**Products.** A product chip can be held by one of the characters in the form (*Held by*; nobody by default):
`Anna (@Image1) holding Kaffeburken (@Image4)` (`… håller …` in Swedish). Video models rarely render small text or
logos exactly, so medium and close shots that show the product large work best.

**Reordering.** Drag a reference thumbnail (or a voice or sound chip) to another place — an insertion marker
shows where it lands and every badge shows the number it will get — or focus it and press ⌥← / ⌥→. Its `@ImageN`
(or `@AudioN`) changes, and every token in the prompt and the negative prompt is renumbered in the same step so it
keeps pointing at the same picture or clip: with references [A, B, C] and `@Image1 hugs @Image3`, dragging C to
the front gives [C, A, B] and `@Image2 hugs @Image1`. Pictures past the model's limit are marked *not sent*;
dragging one forward sends it instead of the last one. This works in Generate and in the sequence clip editor, so
photos can be renumbered without picking or uploading them again in another order; *Create image…*'s references
move the same way.

**A closer look.** Rest the pointer on a reference thumbnail (or Tab to it) and a larger picture shows beside it,
with what it is: `@Image2 · Anna · photo 2 of 3`, and *not sent* for one past the model's limit. It goes away
while you drag and never covers the thumbnail or its ✕. The start and end images and *Create image…*'s references
show it too.

**Swapping.** Click a reference picture (or press Enter on it) to swap it — a drag never does; it reorders (above).
A library photo opens a list of the library's assets, its own kind first, and the one you pick takes **every place**
of that asset. One character for another brings everything that belongs to it along: its outfit goes to the new
character's default outfit (or, when the new one has none, the old outfit stays and the new character wears it), its
voice to the new one's voice (when it has one), and poses (*applies to*) and products (*held by*) that applied to it
apply to the new one. *Pick a single image instead…* swaps only the picture you clicked. A picture of your own
opens the picture list: the library's photos by kind, saved pictures and a file. No number changes, so the
prompt keeps every token, and the name written right before a group of tokens that all changed follows
(`Anna (@Image1, voice @Audio1)` → `Bo (@Image1, voice @Audio1)`), as does the description switch; what the swap did
is said under the references for a moment. A name before a group that still holds some of the old asset's pictures
stays. This works in Generate and in the sequence clip editor; a click on a start or end image, or on one of *Create
image…*'s references, swaps that one picture the same way. ✕ removes a picture.

**Descriptions are appended to the prompt.** When a generation is sent, Studio appends the descriptions of the
assets whose photos or voices it sends as a *References* legend, with each asset's tokens:

```
Anna (@Image1, @Image2, voice @Audio1) walks along the beach promenade (@Image4) …

References:
- Anna (@Image1, @Image2; voice @Audio1): tall woman in her thirties, short red hair
- Red dress (@Image3), worn by Anna (@Image1, @Image2): a red silk dress with thin straps
- Beach promenade (@Image4): a windswept pebble beach at dawn
```

The legend is composed when the generation is sent, from the descriptions as they are in the library then — so
an edited description applies to the next generation — and is never written into the prompt you edit (so *Use
again* doesn't add it twice). The box **Added to the prompt** under the prompt shows it live: each described
asset with its tokens and an excerpt (an outfit with *worn by* and who wears it — also one without a description,
whose line then only says that), a switch per asset, *Include descriptions* to switch them all off,
a link to open the asset and edit its description, and the composed length against the model's prompt limit. If the
legend would make the prompt too long, the descriptions are shortened at word boundaries (and marked so); if not even
the names fit, none are appended. The heading and words follow **Prompt language** (`Referenser:`, `röst` and `bärs av` in
Swedish). A clip's drawer keeps both texts: the prompt you wrote and the sent prompt, what Venice got.

In the prompt editor:

- each `@ImageN` and `@AudioN` is coloured like the asset it points at, `@VideoN` in a colour of its own; hover to
  see the photo, play the voice or watch the part of the video that is sent; wrong references turn red;
- typing `@` opens a menu with the selected photos, sounds and videos and *Add from the library*;
- the list under the editor — folded behind *References in the prompt (N)*, and it remembers whether you opened it —
  shows every reference with its token, marks photos and clips the prompt never mentions
  (*not mentioned*) — only those the legend doesn't explain: one whose description (or wearer) is appended is marked
  *described* instead, and isn't warned about — and offers quick fixes such as changing a token to `@Image3`,
  removing `@Image7`, removing `@Audio2` when the voices add up to more than 15 s, or switching to a model that
  takes reference videos;
- **Generate** is blocked while a reference is wrong, and the line under it says why;
- the character count shows once the prompt nears the model's limit.

The rules live in [`src/shared/prompt-refs.ts`](../src/shared/prompt-refs.ts) and are applied by the editor, by the
main process before every paid submission (including *Generate missing* and agent requests) and by the agent
tools, so a mistyped `@Image9` or a 20 s voice clip is never sent to Venice. Text-to-video and image-to-video
prompts must not contain tokens (and get no legend: they send no references). The legend is composed by
[`src/shared/prompt-compose.ts`](../src/shared/prompt-compose.ts) and tokens are renumbered by
[`src/shared/prompt-remap.ts`](../src/shared/prompt-remap.ts), both shared by the window, the main process and the
agent tools.

## Directors

A **director** is a way of making a film that you choose once and Studio writes into every prompt it directs, so a
whole film — or every clip you make in Generate — is cut, lit and shot the same way without repeating it in each
prompt. It lives in the library (*Directors*, after Poses in the sidebar), in the same list as the other kinds:
**Ready-made** directors at the bottom, your own above them under *Yours*.

- **Ready-made** directors (Documentary, Music video, Noir, Commercial, Dreamy, Action, Vintage film, Minimal) can
  direct as they are, but not be changed: their page has *Generate with the director* and **Copy to edit**, which
  makes one of your own from one — named “Noir (copy)”, its name ready to retype — to change and give style frames
  and videos. Their settings are shown as text.
- **Your own** (*＋ New* in the list, or ⌘K → *New director*) has a name, a line about what it is good for and a field
  for each part under **Direction**, saved as you type: **Editing** (pace, cuts, long takes), **Look** (grade,
  contrast, grain, palette), **Camera**, **Light**, **Framing** (shot sizes and their order), **Rhythm** (tempo, slow
  motion), **Performance** (how the actors play), **Sound** (music, ambience, silence; only sent with sound) and
  **Avoid** (what it never does; added to the negative prompt). Each part is a prompt field like the others: `/` puts
  in a building block, ⌘⇧F opens the larger window, and where the building blocks have phrases for a part a chip
  beside it (*＋ Camera*, *＋ Light*, *＋ Style* …) puts one in; a part's label explains it when you point at it.
  Short, concrete phrases work best — what the camera does and what the light is, not how good the film is.
- Under the parts, **Added to the prompt** (*Show the text*) shows the *Direction* section exactly as a clip gets
  it, in the prompt language, and what it adds to the negative prompt.
- **Style frames** are its pictures (dropped or added like a character's photos, first one the cover): stills whose
  grade, light and texture the clips should match — never their people, places or objects. **Style videos** (from a
  file, Media, a take or an exported film, copied into the director's folder, each with the part that is sent, 2–15
  s) give the camera movement to follow.
- **Shots and defaults**, folded at the bottom with a summary of what is set:
  - **In a sequence:** the **shot length** it aims for (2–15 s: new clips get the nearest duration the model offers,
    and a song's clips are cut near it) and what happens **between shots** — *Cut* (new clips start fresh), *Flow*
    (new clips continue from the previous clip's last frame) or *Sequence's own*. Only new clips get them; clips you
    already have aren't changed.
  - **Defaults:** a model, an aspect ratio and a resolution that choosing the director sets, each only where the
    model offers it.
- At the top, *Generate with the director* opens Generate directed by it, and ⋯ holds *Open folder* and *Delete…*.

**Where you choose one.**

- **Generate:** *Director* under *Model* (none by default). Choosing one applies its defaults. *Added to the prompt*
  lists its lines after the descriptions of the references, and its style frames and videos are shown under the
  reference images and videos as *from the director* — they come after your own (`@Image4`, `@Video2` …) and can
  only be changed in the director.
- **Sequences and music videos:** the **Director** chip in the header (beside *Cast* and *Song*) directs every clip.
  Choosing one sets the sequence's defaults for new clips; existing clips keep their settings. A clip's *Directed by*
  is *Follow the sequence* by default, or another director, or *None*; a clapperboard on the clip's card marks a clip
  that doesn't follow the sequence.
- **Storyboards:** the chip in the header directs every transition (the transition's editor says by whom), and
  **Create image…** for a board says which look the picture gets.

**What is sent.** After the prompt and its *References* list comes the director's section, one line per part it
writes (in Swedish with the Swedish prompt language: *Regi*, *Klippning* …; the texts are sent as written):

```
Direction (Noir):
- Editing: slow, deliberate cuts with lingering holds; cut on a look or a sound
- Look: high-contrast black and white, deep inky shadows, fine film grain
- Camera: slow dolly moves, low angles, a slight Dutch tilt for tension
- Style frames (@Image4, @Image5): match their look – grade, light, texture – never their people, places or objects.
- @Video2: follow its camera movement only – not its people or places.
```

*Sound* is only sent with a clip made with sound. *Avoid* joins the negative prompt after the clip's own, without
repeating a phrase. Style frames go only in reference mode, after the clip's own pictures and only as many as the
model still takes (never with a clip that starts on the previous clip's last frame); style videos only to Seedance 2.x
reference models, within their count and seconds — what isn't sent is said under *Added to the prompt*. When the
model's prompt limit is tight, your prompt and the references come first, and parts of the direction are left out
from the end. A take records the director it was made with; *Use again* fills the form with the clip's own references
and the director, which adds its own again. **Create image…** pictures get only the look, light and framing as plain
words after the prompt, and the *Avoid* in the negative prompt. Deleting a director leaves the sequences, storyboards
and clips it directed without one.

## Sequences

A **sequence** is an ordered list of clips. Each clip stores the settings for new takes; every
generation for it is a **take**, and one take per clip is selected for the cut and can be trimmed at the start and
end. A clip that **continues from the previous one** (*Start on the previous clip's last frame*) starts on the previous
clip's last frame: when it is generated, the previous clip's selected take is cut at its trim point and that frame is
extracted with ffmpeg. Under the switch you choose how. **With references** (the default) sends the clip in
reference mode with the reference photos and voices it carries — its own if you give it any, otherwise those of the
clip it continues from (back to the first clip with references) — plus the frame as one more reference image, and
the prompt as sent starts with an instruction to begin on it; a line under the switch (the assets, plus the last
frame) says what goes along. The characters stay themselves, also when they leave the picture and come back; the first
frame comes very close to the previous clip's last one but isn't guaranteed identical. Reorder, remove or add
references in the clip they come from, and the clips that carry them keep each `@Image` and `@Audio` on the same
picture or voice (and the frame's token on the frame); a token whose picture no longer goes along is taken out. Swap
one there (click it) and their tokens stay as they are, with the name in front following as in the clip itself. **Exact start frame** sends
image-to-video from the frame itself — an exact cut, but no references (the clip's own references and their `@`
tokens are taken out). A clip that also ends on the next clip (*End on the next clip's first frame*, *Redo between
neighbours*) or has an end image of its own is always sent exactly. If the model takes 9 reference images and the
clip carries 9, the 9th gives way for the frame (a note says so). A
clip can likewise take its **end image from the next clip** (*End on the next clip's first frame*): the next clip's first
frame after its start trim, sent as the end image to a model that takes one (Seedance's image-to-video models do;
turning the switch on picks one). Each switch shows only where there is a neighbour to take a frame from.
**Generate missing** generates every clip without a finished
selected take, each after the clips whose frames it needs, waiting for each one; if two clips wait on each other's
frames it says which switch to turn off before anything is paid for. The button shows only while something is
missing, always with the count (*Generate missing (3)*); the price, and the accent colour, only when the run can
start. When it can't — no API key, a clip without a prompt, a missing frame — its tooltip says why, and a click
shows the clip in the way (or *Settings → Service* for the key). **Export** renders the selected, trimmed
takes into one H.264/AAC mp4 in the sequence's folder, showing a picture two clips share at a cut only once. The
rest is under ⋯ in the header: *Export format*, *Edit latest export*, *Open folder*, *Mark all as seen*, *Add a
song…* and *Delete sequence…*, which asks in the menu.

**Working on a clip.** Click a clip's card — or move along the cards with ← / → and press Enter — to open it in the
clip editor beside the player. Drag a card, or focus it and press ⌥← / ⌥→, to move the clip (a song's clips keep the
song's order). **Notes** at the top of the clip editor are for you — who is in the shot, the framing, ideas — and are
never sent; the prompt is. Space plays and pauses the clip anywhere in the view (not while you type, and not on a
button you reached with the keyboard, which Space presses), and I and O set where the chosen take starts and ends at
the playhead; the trim fields read *Starts at* and *Ends at*. *Generate take* waits at the bottom of the clip editor
with ×1–×4, the price and, right above it, *Duration*, *Resolution*, *Aspect ratio* and *Sound*; ⌘↵ sends it from any
field. Lengths are written *6 s*, *7.4 s* or *1 min 23 s*.

**The cast.** *Cast* in the sequence's header holds the characters, outfits (and who wears them), environments,
products and poses of the whole sequence, chosen once instead of per clip: *+ Add* adds an asset at the end (a character
with its default outfit and voice, as the pickers do), and each row has its `@Image` / `@Audio` numbers, *Voice*, ↑ / ↓,
*Swap* (another asset takes its places, as clicking a reference does) and ✕; an outfit says who wears it. New clips
start with the cast as their references — a clip that continues in reference mode needs none of its own: it carries
those of the clip it continues from. A clip **follows** the cast while its references are exactly the cast's (the same
pictures and sounds in the same order); the clip editor says *Follows the cast* (or *Carries the cast from clip 1*), and
the panel lists which clips follow. Change the cast and every clip that follows it changes in the same step, its prompt
kept on the same pictures: an asset added goes last, so no number changes; a removed one takes its tokens out of the
prompts and the later numbers move down; a reorder renumbers; a swap keeps every number, and the name written in front
of its tokens follows ("Anna (@Image1)" → "Bo (@Image1)"). Change a clip's references by hand and it stops following
(*Own references*); *Use the cast* there gives it the cast again, its tokens following their pictures. The cast is kept
in the sequence's defaults (no schema change) and moves with the library like a clip's pictures.

**Takes.** Every take of a clip is a thumbnail in the strip under the player, newest first (so one being made comes
first), each keeping its place when it finishes. Click one and it becomes the clip's take and plays from its kept start,
with sound; click it again to start over. ← / → (and Home / End) choose takes at once without playing them, ⌥-click or
the take's preview button plays one without choosing it (then choose it, or go back to the chosen one), hovering
scrubs a silent preview, and the menu (right-click or ⋯) uses the take's prompt, opens the take in the Editor,
shows it in Finder (*Show in Finder*) or deletes it. *＋ From file…* above the strip adds a film of your own as a
take. Each take keeps its own trims: trim A, choose B, choose A again, and A's trims are back. A new take
is chosen by itself only when the clip has no usable one; otherwise it waits in the strip, marked *New*. *×2*–*×4*
beside *Generate take* makes that many takes at once (variants of the same settings, the total on the button): all
of them land in the strip, and the first to finish is chosen only if the clip had no usable take.

**Start and end images.** A clip can also start or end on a picture of its own (a file or a library photo in the
clip editor; agents can also put in pictures made with Venice's image models or frames of takes). A clip with a
start or end image is generated with the image-to-video model of its family: the look comes from the pictures, so
its reference photos are dropped (and their `@` tokens taken out of the prompt), and the prompt describes what
happens between them. Pictures made or saved for a sequence's clips are kept as stills in its `Storyboard/` folder.

**Redo between neighbours.** When one clip in the middle came out badly, this button (in the clip editor, under the
frame switches) sets it to start on the previous clip's last frame and end on the next clip's first frame, with an
image-to-video model that takes an end image, keeping its prompt, length and sound. The first or last clip only gets
the one neighbour it has. The editor shows both frames and the price; the neighbours need finished selected takes.
When the new take is ready, click it in the take strip — the old take stays selected until you choose, and stays
among the takes in case you want it back.

**A music video from your song.** *＋ New sequence* → *From a song…* (also ⌘K *New sequence from a song…*, or drop an
audio file on the list of sequences) takes an MP3, WAV, M4A, AAC, AIFF, FLAC or OGG file and shows its name and length
(▶ to listen) with three choices. *Separate the vocals* (free, on this Mac; off, with the reason, on a Mac that can't)
gives the singing shots only the voice to hear, which keeps the lips in time. *Transcribe the lyrics* (paid, the price
on the box before anything is sent; *More* picks the model and the language) writes down the words with their times,
so every clip knows what is sung in it. *Clips of about* 4, 6, 8, 10 or 12 s sets how finely the song is cut. The
sequence opens at once and its **song strip** says what is going on (*Separating the vocals… 40%*, *Transcribing the
lyrics…*, *Finding the beat…*); then the song is split into clips at its lines and phrases, on the beat, each clip
empty and following the cast. Set the *Cast* — the singer, the outfit, the stage — and every clip has them.

The song strip, above the clips, shows the waveform (the vocals tinted once separated), the beats and bars and every
clip's place in the song. Drag a boundary to move a cut: it snaps to the beat, ⌥ puts it anywhere, and no place gets
shorter than 2 s (the strip says why it stops). *Split at playhead* cuts the clip under the playhead in two, *Merge with
next* gives the open clip the next one's place, a click on a place opens its clip, and the song plays, pauses and
scrubs right there (Space while the strip has the focus). The lyric lines run under the waveform: click one to correct
it — with as many words as before each keeps its time, otherwise the words share the line's. The cards below are as wide
as their places and keep the song's order (the cuts move in the strip, not by dragging cards). *Song* in the header
tells whether the vocals are separated and the lyrics transcribed (and does either again), and replaces or removes the
song (the clips stay, as ordinary clips; the song's files stay in the sequence's folder); *⋯ → Add a song…* cuts a sequence you already have to
a song.

A song clip's editor starts with its **place in the song** ("0:16.0 – 0:24.0 · 8.0 s") and the words sung there, and
*What the clip hears*: *Vocals – lip sync* sends the vocals of its place (the whole song where they aren't separated)
as the clip's reference audio, for a shot of someone singing it; *Music – mood and rhythm* sends the whole song there,
for a shot that moves with it; *No song* sends nothing of it. *Who sings* picks the singer among the clip's characters,
or *Nobody on screen*. The duration is automatic — the shortest the model offers that holds the place and a second more
("9 s for 8.0 s of the song") — and the prompt is written as usual: "@Image1 sings into a microphone on a concert stage,
medium close-up, static camera". Hearing the song takes a model with reference audio (Seedance 2.5 R2V).

When a take of a singing clip is done, Studio measures where its singing sits against the song and starts the take
there in the cut: the clip says *In sync (+0.32 s)* or *No singing found – check the lips*, and so does the take's tile.
Nudge the start by a frame or a tenth of a second (the cut keeps the place's length) or *Measure again*. *Preview* and
*Export* play the song over the whole film and leave the clips' own sound out.

Tips: singing shots work best as close-ups or medium close-ups with the singer facing the camera; put the wide shots,
the band and the crowd on *Music – mood and rhythm*. A singing place sends at most its first 15 s. Check the lips of
every singing take before you export — *In sync* means the voice lines up, not that each syllable looks right.

## Storyboards

A **storyboard** is a different way to make a film: first the milestones as pictures, then the motion between them.
It has a name, a format (16:9 by default; 9:16, 1:1, 4:3, 3:4 or 21:9) and an ordered row of **boards**,
and it lives in its own view, **Storyboards** — storyboards never show up in Sequences, nor sequences here.
*＋ New* asks only for the format; the new storyboard opens with its name field ready in the header, and the format
can be changed later under ⋯ → *Format*.

- **One picture per board**, with a short note under it (what the picture shows). Click the picture (or the empty
  board) to make one with **Create image…**, to take any photo of a character, place, product, outfit or pose from
  the library (used where it is), to reuse a picture made or added for this storyboard before (one can also be opened
  full size, where it can be used or deleted), to upload one (or drop a file on the board; it is copied into the
  storyboard's `Images/`) or to take a frame of a clip (scrub any finished clip in the library and save the frame;
  needs ffmpeg). A picture whose shape differs from the storyboard's format is marked as another format: the clips
  to and from it get the picture's shape. A board may stay empty while you plan.
- **Boards are reordered** by dragging them or with ⌥← / ⌥→, added with **+** before, between or after them (several
  pictures dropped on the new-board button become one board each) and removed with a two-step confirmation. ← / →
  move along the row, board → transition → board.
- **Transitions.** Between every two neighbouring boards there is a transition (*Transition N*): the clip from the
  first board's picture (the start image) to the second's (the end image). Click it to edit what happens — what moves
  and how the camera travels from one picture to the other; a suggestion button fills in a plain template from the two
  boards' notes — and its length (5 s by default), resolution (480p), sound and model (only image-to-video models that
  take an end image; Seedance by default). *Generate take* at the bottom of the editor shows the price first (⌘↵ sends
  it from any field, Space plays the take); every take is kept, and you choose the one that is used. *×2*–*×4* beside
  it sends that many takes at once (the total on the button); the card's own *Generate* on the board row, shown when
  the transition can be sent, sends one. Moving, inserting or removing a board removes the transitions between boards
  that are no longer neighbours — their prompts go, their takes become ordinary clips in Media, nothing is deleted —
  and new neighbours get a new, empty transition; Studio asks first when a move or a new board would remove a
  transition with a prompt or takes. A take made before one of its boards got another picture is marked as made from
  an earlier picture; a new take made from the pictures there now takes its place when it is done, and deleting the
  selected take selects another finished one. A negative prompt an agent gave a transition is shown under its prompt,
  where it can be removed.
- **Generate missing** sends every transition without a finished take, with the total price on the button. The
  transitions don't depend on each other, so they are sent one after another without waiting for each to render;
  nothing is paid for while any of them can't be made (no API key, a board without a picture, a missing prompt) —
  the button then shows no price, its tooltip says why, and a click shows the transition that stands in the way (or
  *Settings → Service* for the key).
- **Preview** plays the selected takes back to back; **Export** cuts them into one mp4 in the storyboard's
  folder. Two neighbouring transitions both show the board between them (one ends on it, the next starts on it), so
  where both takes were made from the same picture the export drops the later one's first frame and the board is
  shown once.
- **Making a sequence** of it (⋯ → *Convert to sequence*) gives an ordinary sequence named after the storyboard,
  with one clip per transition and a copy of its selected take, so the film can be trimmed, extended and redone in
  Sequences. The storyboard stays as it is. ⋯ also holds *Format*, *Edit latest export*, *Open folder*, *Mark all as
  seen* and *Delete…*.

**Create image…** makes a picture with Venice's image models — from a prompt alone, or combining references (the first
one is the base picture the model edits) — with model, format (the storyboard's by default), resolution and quality
to choose, the price on the button (*Create · $0.06*; ⌘↵ from any field) and a button to try again. The previous
board's picture starts as the first reference, marked *Previous*, so place, light and people carry over from one
milestone to the next; ✕ removes it and *＋ Previous board's image* brings it back. ⌥← / ⌥→ reorder the references,
and the negative prompt is a *Negative prompt* fold with building blocks. The finished picture goes onto the board,
and every result is kept in the storyboard's `Images/` folder. **Safe mode for images** (*Settings → Generation*, on
by default; *Safe mode on · Turn off* in the dialog) lets Venice blur adult content.

## Settings

**Settings** (⌘, — or *Settings…* in the Studio menu, or the bottom of the sidebar) has six panes, shown one at a
time: beside their list, or as tabs above them in a narrow window.

- **Service** — which service Studio generates with, *Venice* or *fal.ai* (see [Services](#services-venice-and-fal-ai)),
  and its API key, with *Test*. While the active service has none the field is ready to type in, with a link to the
  service's key page, Settings has a dot in the sidebar, and every paid form says *Add your Venice API key in Settings*
  (or fal.ai's) under its button (which then opens this pane). Each service's key is kept, so switching back needs no
  new one.
- **Spending** — today and this month, then the optional daily and monthly **budget**, then *Spending details*: the
  last 30 days as a chart (*Show as a table*) and this month by kind, by place and by who asked.
- **Generation** — *Prompt language* and *Safe mode for images*.
- **Library** — *Folder* (where the library is, *Show in Finder*, *Change folder…* and *What's in the folder*), *Move
  to another computer* (*Export library…*, *Import a library…*, see [Where things are
  stored](#where-things-are-stored)) and *Tidy up*.
- **Agent connection** — see [Connecting your own agent](#connecting-your-own-agent).
- **About** — the version, updates (*Check for updates*, *Check for updates automatically*), ffmpeg and voice
  separation.

A field saved with a button (the key, the budget, the agent port) shows *Save* and *Undo* while it has changes —
Enter saves, Esc undoes — and then *Saved*.

## Services: Venice and fal.ai

Studio generates with one service at a time, chosen in **Settings → Service**: [Venice.ai](https://venice.ai) (the
default) or [fal.ai](https://fal.ai). Each has its own API key, stored encrypted. Switching keeps the other key, starts
the window over with the new service's models and prices, and opens Settings again. What you made with one service
stays, and a clip, a take or an Editor job already sent finishes at the service it went to. A clip or a form saved
with the other service's model is made with the same mode's model of the active service (Seedance 2.5 on both), and
priced so.

**The same on both.** Every view works on both services: Generate (text, a start image with an optional end image,
references with photos, voices and reference videos), sequences and storyboards, *Create image…*, the Editor's paid
cards (transcription, *Change voice*, lines read again and new lines, a character's cloned voice, music, sound
effects, *Regenerate section*, *Edit with prompt*, *Extend*, *Upscale*), *Design a voice with AI…*, a song's lyrics,
Spending and the budget, and the agents' tools.

**Models on fal.ai.** Studio offers a chosen set rather than fal's whole catalogue: Seedance 2.5, Seedance 2.0 and 2.0
Fast (text, start image, references), Kling 4.0, Kling 3 and O3, Veo 3.1 and Veo 3.1 Fast; in the Editor Seedance 2.5's
edit task, Wan 2.7 Edit and Gemini Omni Flash Edit, Topaz to upscale and Sync Lipsync 2; Seedream 5.0 Pro and Nano
Banana 2.1 for pictures; ElevenLabs v3 (lines in a voice), its voice changer, sound effects and Scribe v2
(transcripts), Chatterbox (a character's cloned voice), Qwen 3 TTS (voice design), ACE-Step and ElevenLabs Music.

**What differs on fal.ai.**

- **Prices** — fal has no quote that looks at a request, so Studio works the price out from fal's published rates:
  per second by resolution (and sound, for Veo and Kling 3), Seedance's reference videos at their reduced rate on the
  input and output together, Kling 4.0's at least twice the output. Token-priced models (Seedance, Nano Banana) come
  out within a few percent. Spending records the price as for Venice.
- **No negative prompt on some models** — Seedance, Kling 4.0 and Kling O3 take none. The negative prompt, with a
  director's *Avoid*, goes last in the prompt as one line, *Avoid: …*, and *Added to the prompt* shows it.
- **Lip sync** (fal.ai only) — the Editor's *Lip sync* card (Picture) makes the mouths in the selection follow the
  sound it has now, after re-recorded lines, say; the film's sound stays as it is. Speech alone works best.
- **A character's cloned voice** — Chatterbox on fal takes the voice clip with every line instead of keeping a clone:
  "cloning" costs nothing, and the clip is uploaded again after a day.
- **Balance** — fal shows it only to keys made for billing, so *Test* checks the key; fal's dashboard has the balance.
- **Safe mode for images** — fal's own checks can't be switched off on most models; the setting is used where fal
  allows it.
- **Files and privacy** — fal's models take files as links, so the pictures, sound and video a request needs are
  uploaded to fal's storage first. Studio asks fal to keep no request history and to delete uploads and results after
  a day. Without that history fal keeps a finished result for an hour only, so **quitting while fal.ai is still
  working asks first**: a result that is done while Studio is closed is lost if Studio isn't opened again within the
  hour.
- **Queue** — a new fal account runs two jobs at a time; more wait in fal's queue (variants ×2–×4 too).

## Keyboard shortcuts

The same keys work the same way in every view. On Windows read Ctrl for ⌘ and Alt for ⌥ (see [On
Windows](#on-windows)); the app's tooltips show them that way.

| Where | Keys | What they do |
| --- | --- | --- |
| Anywhere (not while a dialog is open) | ⌘K | Search everywhere, also while typing in a field |
| | ⌘, | Settings |
| | ⌃⌘S | Fold or unfold the sidebar |
| | ⌘F | The view's search, in the views that have one |
| Dialogs, menus, viewers | Esc | Closes the topmost one only, and gives the focus back |
| Forms | ⌘↵ | Sends the form from any of its fields: Generate, a sequence clip, a storyboard transition, *Create image…*, the Editor card that has the focus; in Prompts, *Generate with the prompt*. Plain Enter never sends anything paid |
| | ⌘⇧F | Opens the prompt in a larger window |
| | / | A building block at the caret |
| | @ | A reference at the caret (reference mode) |
| Lists (the side lists, Prompts, Learnings) | ↑ ↓, Home, End | Move to a row and open it |
| | Enter, in the search | Opens the first match (also in Media) |
| | ↓ in the search, ↑ on the first row | Between the search and the list (also in Media's table) |
| | Esc, in the search | Clears it |
| | ⌫ or Delete | Asks to delete the row (the side lists) |
| | ⌘↵ on a row | Prompts: generates with the prompt |
| Strips | ← → | Between clips (Sequences) and along the boards and transitions (Storyboards); Enter opens a clip or a transition |
| | ⌥← / ⌥→ | Moves the focused item one place, wherever it can be dragged: references, voices and sounds, reference videos, clips, boards, an asset's photos |
| | ⌥↑ / ⌥↓ | The same in a list that runs down: cast rows, voice and sound clips (by the grip) |
| Take strip | ← → (Home, End) | Choose a take at once |
| | ⌥← / ⌥→, ⌥-click | Preview the next or previous take (or the one clicked) without choosing it |
| | Space, Enter | Play or pause; play from the start |
| | ⌫ or Delete | Asks to delete the take |
| Players | Space | Play or pause: the clip in Sequences, a transition, the Editor, Media's film player (not in a field, nor on a button reached with the keyboard) |
| | I, O | Where the take starts and ends (Sequences); the selection's in and out (Editor) |
| | ← → | The previous or next picture or film in Media's viewers |
| Editor | ← → | One frame back or forward |
| | ⇧← / ⇧→ | One second back or forward |
| | J, K, L | Play backwards, pause, play (J or L again: faster) |
| | Esc | Clears the selection |
| | ⌘Z, ⌘⇧Z | The previous or next version (Ctrl+Y too on Windows) |
| | ⌘-scroll | Zooms the timeline |
| Tabs and choices | ← →, Home, End | Move between tabs or options and pick one; a row of them is one Tab stop |
| Menus | ↑ ↓, Home, End, Enter | Move and choose |

## Connecting your own agent

Studio can run an MCP server so agents such as Claude Desktop, Claude Code, Hermes Agent or OpenClaw can work in
the app: read the library and see its photos (and hear its voices), choose references, write and validate prompts,
fill in the Generate form, build sequences (also with your own clips), plan storyboards (boards, their pictures and
the transitions' prompts), set a clip up to be redone between its neighbours, and edit films in the Editor.
They create characters, products and the other assets and add photos and sound to them, import own clips and export
films; files reach Studio as uploads — a URL Studio fetches (public addresses or the agent's own machine), a raw
`PUT` with the token, or a small file inline — never as paths on your Mac. They can also look back: review finished
clips and exported films frame by frame next to the references they were made from, record reviews, and save
*learnings* that every later session reads before it writes a prompt. Agents **cannot generate or remove anything on
their own** — the paid tools (videos, pictures, paid edits and designed voices) and `request_delete` only create a
request that Studio shows you (with the prompt, references, voices and price, or with what would be removed and what
depends on it), and nothing is sent to Venice or removed until you approve it. A request that would take your
spending past the budget says so in its dialog; approving it is your yes. Settings (the budget too), the library
folder, consents and your own ratings and learnings stay yours.

To check a request before you approve it, hover an `@ImageN` or `@AudioN` token in its prompt or in the appended
References legend (or Tab to it): a card shows the picture large enough to recognise — the asset, *photo 2 of 3*, and
*not sent* for one past the model's limit — or names the voice with its window and a play button for exactly the
part that is sent (Enter on a focused voice token plays it too). Tokens and the reference tiles or voice rows they name
light up together, whichever you hover. The tiles, start and end images, a neighbour's frame, storyboard boards and
an edit's frames show a larger picture the same way when hovered or tabbed to. Nothing opens on a click — a request
can be looked at there, not changed — and Esc closes a card before it closes the dialog.

Turn it on under **Settings → Agent connection** (*Allow agents to connect*); it listens on
`http://127.0.0.1:8770/mcp` and on this Mac's Tailscale address. Once it is on, **Connect an agent** has a tab per
agent — *Claude Desktop*, *Claude Code* (a ready-made `claude mcp add` command), *Hermes* and *OpenClaw* (their
configuration) — and **Advanced** (folded) holds the token, the addresses, Claude Desktop on another computer and the
port. While the connection is on, the agent's row at the bottom of the sidebar shows what it does and opens the
Agent panel; with it off, the row is gone and ⌘K → *Agent* opens the panel. See **[docs/AGENTS.md](AGENTS.md)** for
configuration examples, the full list of its 99 tools, sending files, the review loop and troubleshooting.

**Claude Desktop** needs no configuration: under *Connect an agent → Claude Desktop*, **Add to Claude Desktop** makes
a Claude Desktop extension with this Mac's address and the token and opens it in Claude Desktop, which asks you to
install it. For Claude Desktop on another computer in your tailnet, open *Advanced → For Claude Desktop on another
computer…*, choose the Tailscale address and save the file there instead. The file holds the token, so don't share
it; after you change the token, add Studio to Claude Desktop again. If Claude Desktop starts before Studio, its
Studio tools appear once Studio is running.

## Security

Studio is a local app. The agent connection is off by default, listens only on loopback and the Tailscale
interface (never on your LAN or `0.0.0.0`), requires a 256-bit bearer token, refuses browser requests, fetches
agents' URLs only from public addresses (or the agent's own machine), and paid actions and removals always need your
approval in the app. Secrets are encrypted with the macOS Keychain. Apart from Venice, the only thing Studio contacts
on its own is GitHub, once a day, to see whether a newer Studio is out (switch it off under **Settings →
About**). Details, the threat
model and how to report a vulnerability: **[SECURITY.md](../SECURITY.md)**.

## Documentation

- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — processes, modules, data model, jobs, sequences, the agent bridge
- [docs/AGENTS.md](AGENTS.md) — connecting agents over MCP
- [docs/DEVELOPMENT.md](DEVELOPMENT.md) — profiles, testing without spending money, packaging, migrations
- [CONTRIBUTING.md](../CONTRIBUTING.md) — branches, Conventional Commits, pull requests
- [CHANGELOG.md](../CHANGELOG.md)

## Roadmap

Done:

1. Basics: API key, generate a video, see the result
2. Characters with reference photos, the prompt library
3. Sequences: chaining clips through the last frame, timeline, export with ffmpeg
4. Environments and outfits, a default outfit per character
5. A prompt editor that checks references; the agent connection (MCP) with approval of paid generations
6. Voices and soundscapes (`@AudioN`), poses, a clip feed with filters and a table view, ratings, and a review and
   learning loop for agents
7. Start and end images (keyframes) and *Create image…*, redoing a clip between its neighbours
8. Asset descriptions appended to the prompt automatically, references reordered by drag and drop
9. Storyboards as a workflow of their own: milestone pictures, with the clips between them generated
10. The Editor (an AI editor for any finished film), own clips in sequences, designed and cloned voices
11. Products, click-to-select takes with per-take trims, *Activity*, a grouped and collapsible sidebar, and
    agents that work like the user (uploads, every content tool, removals by approval)

Next:

12. Cost overview, cancelling a running export, fades between clips; continuing the motion of an own clip,
    upscaling long films in parts, subtitles burned into the picture

Ideas where help is welcome: an automated test suite, signed and notarized builds.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](../CONTRIBUTING.md) (Conventional Commits, branch names,
the PR checklist) and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Studio is released under the [MIT License](../LICENSE).
