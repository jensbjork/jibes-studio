# Architecture

This document describes how Studio is put together: its processes, the modules in each, the data model, how
files are stored, how a generation travels from the form to a video on disk, how voices and sounds reach Venice,
how sequences are exported, how reviews and learnings close the loop, and how the agent connection (MCP server)
plugs into all of it. It reflects the code in `src/`; when they disagree, the code wins — please fix the document.

- [Processes](#processes)
- [Module map](#module-map)
- [Data model](#data-model)
- [Stored paths](#stored-paths)
- [IPC surface](#ipc-surface)
- [Jobs: from submit to saved video](#jobs-from-submit-to-saved-video)
- [Reference audio: from a file to `@AudioN`](#reference-audio-from-a-file-to-audion)
- [Sequences and export](#sequences-and-export)
- [Reviews and learnings](#reviews-and-learnings)
- [The agent bridge](#the-agent-bridge)
- [Shared modules](#shared-modules)

## Processes

Studio is an [electron-vite](https://electron-vite.org) project with the usual three parts. The `@shared/*` alias
(see `electron.vite.config.ts` and the `tsconfig.*.json` files) points at `src/shared/` in all of them.

| Part | Source | Role |
| --- | --- | --- |
| **Main** | `src/main/` | Node.js side of Electron. Owns everything with side effects: the Venice client and job queue, the SQLite database, the library folder and every file operation, ffmpeg, the `media://` protocol, settings and secrets, and the MCP server for agents. |
| **Preload** | `src/preload/` | Exposes one typed object, `window.studio` (the `StudioApi`), through `contextBridge`. Every method is an `ipcRenderer.invoke` of a named channel or a subscription to a main → renderer event. |
| **Renderer** | `src/renderer/` | React 19 UI styled with Tailwind CSS v4 (theme tokens in `styles.css`). Holds UI state only — including the Generate form, which agents read and fill through the bridge — and talks to main exclusively through `window.studio`. |

The window runs with `contextIsolation: true` and without Node integration, under a Content Security Policy that
allows only the app's own scripts plus `media:` and `data:` images (`src/renderer/index.html`). Navigation away
from the app is blocked and `window.open` hands links to the default browser.

Local files reach the renderer through the privileged `media://` scheme (`media://local/<URL-encoded absolute
path>`, see `media-protocol.ts` and `renderer/src/lib/media.ts`), which supports HTTP Range requests so `<video>`
and `<audio>` can seek.

At startup (`src/main/index.ts`) main picks the profile (`STUDIO_DEV_PROFILE`, `STUDIO_PROFILE_DIR`, see
[DEVELOPMENT.md](DEVELOPMENT.md)), takes the single-instance lock (two instances would poll and download the same
paid jobs), registers the `media://` scheme and every IPC handler, opens the configured library
(`prepareLibrary`), creates the window and finally starts the agent connection if it is enabled. On quit it stops
the agent server, kills running ffmpeg processes (removing their partial files) and closes the database, which
folds the SQLite WAL back into `studio.db`.

## Module map

### `src/main`

| Module | Responsibility |
| --- | --- |
| `index.ts` | App entry: profiles, single-instance lock, window creation, the core IPC handlers (settings, models, quote/generate, generations, files), wiring of the services (generations are sent with their review summary), shutdown. |
| `settings.ts` | `settings.json` in the profile's `userData`: base folder, prompt language, accepted Venice consents, agent port/on-off; the Venice API key and the agent token encrypted with `safeStorage`. |
| `venice.ts` | Venice API client (`/models` incl. `audio_input`, `/api_keys/rate_limits`, `/video/quote`, `/video/queue`, `/video/retrieve`, `/video/complete`), request bodies (images become downscaled JPEG data URLs; each reference audio window becomes an MP3 data URL of whole frames, 2–15 s each and 15 s in all), measuring reference audio (`resolveReferenceAudios`), `VeniceError` / `NetworkError`. |
| `jobs.ts` | `JobManager`: the guard in front of every paid submission (`prepareSubmission`: `@ImageN`/`@AudioN` checks, canonical tokens, audio clips measured), queueing at Venice, polling with backoff, saving videos into the library, posters and durations, resuming pending jobs and backfilling missing posters. |
| `db.ts` | The SQLite connection (WAL, foreign keys), the migrations, generation rows, and stored-path maintenance: prefix rewrites, relativizing, "is this path recorded" checks. |
| `paths.ts` | Folder layout constants (`FOLDERS`, `APP_DATA`, `TAKES_FOLDER`), conversion between absolute and stored paths, Finder-safe names, unique names, verified moves and renames, the "base folder is still there" check and the library-wide operation lock. |
| `library-root.ts` | The base folder's lifecycle: opening it at startup, status, choosing/inspecting/switching (`move`, `open`, `new`), converting an earlier layout, refusing a library from before a folder existed whose base folder holds a folder of the user's own by that name (*Miljöer*, *Kläder* from schema 6, *Poser* from 7), *Städa upp* (reorganize, asset photos and audio clips included), revealing folders in Finder. |
| `library.ts` | The prompt library (CRUD, tags, favourites, usage) and registration of the asset and prompt IPC handlers. |
| `assets.ts` | Characters, environments, outfits and poses: rows, one folder per asset with copies of its photos (and, for characters and environments, audio clips probed with ffprobe, each with a clamped reference window) and `Beskrivning.txt`, renames that move the folder, deletes to the Trash (a photo or clip that generations still use is kept in `Referensbilder`), default outfits. |
| `references.ts` | Copies start/end/reference images and reference audio from outside the library into `Referensbilder/<day>/` (deduplicated by content hash) and the shared `placeFile` / `copyInto` helpers that write via the scratch folder. |
| `reviews.ts` | The user's and agents' reviews of generations (`attachReviewSummary` puts the user's rating and the review count on generations), learnings, the list of exported films, and their IPC handlers (an agent writes under its own name and may only change its own). |
| `sequences.ts` | `SequenceService`: sequences and clips (reference audio included; continuing clips drop it), takes, continuation frames, *Generera saknade* runs, keeping sequence folders in step with names, export, and the sequence IPC handlers. |
| `sequence-store.ts` | Row access and assembly for sequences and segments (takes with their review summary), take selection and trim clamping, folder and file naming. |
| `sequence-export.ts` | Turns the selected, trimmed takes into ffmpeg concat clips and reserves the export's file name. |
| `ffmpeg.ts` | Finds `ffmpeg`/`ffprobe`, probes videos and audio files (decoding when the header only estimates the length), extracts frames and posters, cuts reference audio windows to mono MP3 (`encodeAudioClip`), JPEG frames and sound previews for agents' reviews (`extractFrames`, `extractAudioPreview`), renders the concat export, and kills/cleans up running processes on quit. |
| `media-protocol.ts` | The `media://` scheme (video, image and audio types). |
| `agent/index.ts` | Public entry of the agent connection. |
| `agent/service.ts` | `AgentService`: on/off, port, token, following the Tailscale address, status for the UI, one MCP server per client session. |
| `agent/server.ts` | The HTTP server: peer, `Origin` and bearer checks, body limits, MCP Streamable HTTP sessions and their lifecycle, and the protocol version each session speaks (audio content needs 2025-03-26). |
| `agent/network.ts` | Loopback and Tailscale address detection, the peer allow-list, MagicDNS lookup through Tailscale's resolver. |
| `agent/approvals.ts` | `ApprovalStore`: paid requests waiting for the user's decision. |
| `agent/activity.ts` | The activity log of tool calls shown in the app (ring of 200 entries). |
| `agent/bridge.ts` | `FormBridge`: main ↔ renderer commands for the Generate form. |
| `agent/local-ipc.ts` | Records the `ipcMain` handlers so agent tools call exactly the services the window calls (`callService`, `isAgentCall`). |
| `agent/ipc.ts` | IPC handlers for the agent settings, the activity drawer and the approval dialog. |
| `agent/guide.ts` | The MCP server instructions, the Studio guide and the prompt-writing guide for agents. |
| `agent/images.ts` | Photos and posters as MCP image content (JPEG, at most 768 px), with a small cache, and the MCP image and audio content blocks for the JPEG frames and MP3s ffmpeg makes. |
| `agent/media.ts` | Video frames, a clip's sound and reference audio windows as MCP image and audio content for the review tools (through `ffmpeg.ts`). |
| `agent/studio.ts` | Helpers shared by the tools: asset index (photos and audio clips), `@ImageN` and `@AudioN` token maps, model and option checks, prompt problems. |
| `agent/tools/*.ts` | The MCP tools (`library.ts`, `form.ts`, `sequences.ts`, `paid.ts`, and `review.ts` for reviewing clips, films and sequences, reviews and learnings), the `defineTool` frame (`kit.ts`, image and audio content, older clients get a note instead of audio) and registration of the tools, the `write_video_prompt` prompt and the `studio://guide` resource (`index.ts`). |

### `src/preload`

| Module | Responsibility |
| --- | --- |
| `index.ts` | Implements `StudioApi` on top of `ipcRenderer` and exposes it as `window.studio`. |
| `index.d.ts` | Declares `window.studio` for the renderer's type checking. |

### `src/renderer/src`

| Module | Responsibility |
| --- | --- |
| `main.tsx`, `App.tsx` | Entry and root component: the library gate (setup screen until a base folder is open), the views, the agent feed, bridge and approval dialog. |
| `styles.css` | Tailwind CSS v4 import and theme tokens (`bg`, `panel`, `raised`, `line`, `muted`, `text`, `accent`). |
| `lib/generateStore.ts` | The Generate form as an app-level store above the views, persisted to `localStorage`, so agents can read and fill it while another view is open. Follows library audio clips that move or get a new window. |
| `lib/agentBridge.ts` | The renderer half of the form bridge: applies `get_form`, `set_form`, `set_references` (photos and audio clips, with the 3-clip and 15 s caps) and `open` to the form store and replies with the token maps. |
| `lib/agent.ts` | Live agent status, activity and approval requests for the indicator, the drawer, the dialog and Settings. |
| `lib/promptIssues.ts` | The `@ImageN` and `@AudioN` checks for a set of params, with the rules main applies. |
| `lib/hooks.ts` | Shared data hooks (model list, assets, prompts, price quote) and `ipcErrorMessage`. |
| `lib/library.ts` | `localStorage` keys that hold library data and how they are rewritten or forgotten after a library switch; `withImportedCopies`, which points the form at the copies in `Referensbilder` of images and audio picked from outside the library once a generation is submitted. |
| `lib/assets.ts`, `lib/media.ts`, `lib/navigation.ts`, `lib/workspace.ts` | Asset kind wording, `media://` URLs and formatting, cross-view navigation intents, where the user is in the sequence editor. |
| `components/GenerateView.tsx`, `ParamsForm.tsx`, `GenerationCard.tsx`, `ImageInput.tsx` | The Generate view: the form (references, voices and sounds, poses), the clip feed's cards, image inputs. |
| `components/feed/` | The clip feed in Generera: toolbar with search, filters (the shared `generation-filter`), sort and summary; poster-only cards; a windowed table with sortable columns and keyboard navigation; the detail drawer with player, highlighted `@ImageN`/`@AudioN`, the references and audio windows sent, settings, the user's rating, note and tags, and agents' reviews; kept live through `onGenerationUpdate`, `onGenerationDelete` and `onReviewChange`. |
| `components/prompt/` | The reference-aware prompt editor: `@ImageN` and `@AudioN` colouring, hover cards and players, the `@` menu, issue list and quick fixes. |
| `components/prompts/` | The prompt library view (*Prompter*) and its *Lärdomar* tab (learnings: list, editor, evidence clips). |
| `components/assets/` | The *Karaktärer*, *Miljöer*, *Kläder* and *Poser* views: list, editor, photos, default outfit, and the sound section (voice or soundscape clips, a shared player, the reference window editor). |
| `components/pickers/` | Pickers and dialogs shared by the views (assets, audio clips, outfits, prompts, sequences, modal, popover) and the form's asset and audio helpers (`assetRefs`, `audioRefs`). |
| `components/sequences/` | The *Sekvenser* view: list, header, timeline, clip editor, takes, trims, preview player. |
| `components/library/` | Library setup screen, folder choice, switching overlay and *Inställningar → Bibliotek*. |
| `components/agent/` | Agent settings section, sidebar indicator, activity drawer, approval dialog (with the voices a request sends) and their Swedish wording. |
| `components/SettingsView.tsx`, `Sidebar.tsx`, `ConsentDialog.tsx`, `DevBadge.tsx` | Settings, navigation, Venice's consent dialog, the *Dev* badge. |

## Data model

The database is `<base folder>/.studio/studio.db` (SQLite through `better-sqlite3`, WAL journal, foreign keys on).
Each library has its own database; nothing about the library lives in the profile's settings except where the
base folder is.

| Table | Holds |
| --- | --- |
| `generations` | Every generation: model, prompt, params (JSON), status (`queued`, `processing`, `completed`, `failed`), Venice queue id, price quote, timings, `file_path`, `thumb_path`, `video_duration`, and `segment_id` when it is a take of a sequence clip. |
| `assets` | Characters, environments, outfits and poses: `kind` (`character`, `environment`, `outfit`, `pose`), name, description, `folder`, `default_outfit_id` (characters only, a self-reference set to NULL when the outfit is deleted). |
| `asset_images` | An asset's photos: `file_path` and `position` (position 0 is the cover). |
| `asset_audio` | A character's voice or an environment's soundscape clips: `file_path`, `position` (position 0 comes along when the character is added to a form), `duration`, and the reference window `clip_start` / `clip_length` (NULL: the default, min(duration, 10 s)). Deleted with their asset. |
| `generation_reviews` | Reviews of a generation: `author` (`user`, at most one per generation by a partial unique index, or an agent's name), `rating` 1–5, `tags` (JSON), `note`. Deleted with their generation. |
| `learnings` | Insights about prompting: `title`, `insight`, `model` (NULL: every model), `tags` and `evidence` (generation ids, JSON), `author`, `pinned`. |
| `prompts` | The prompt library: title, body, negative prompt, tags (JSON), favourite, use count, last used. |
| `sequences` | Name, `defaults` (JSON params for new clips), `folder`. |
| `segments` | A sequence's clips: `position`, `params` (JSON template for new takes), `continue_from_previous`, `selected_generation_id`, `trim_start`, `trim_end`. Deleted with their sequence. |
| `exports` | Exported films (`file_path`, `sequence_id`), so they follow folder renames and library moves. |

### Migrations

Migrations are SQL strings in the `migrations` array in `src/main/db.ts`. `PRAGMA user_version` records how many
have run; on open, each missing one runs in its own transaction. The array is **append-only**: never edit or
reorder an entry, add a new one at the end (see [DEVELOPMENT.md](DEVELOPMENT.md#database-migrations)).

| # | What it did |
| --- | --- |
| 1 | Created `generations`. |
| 2 | Created `characters` and `character_images` (+ index by character and position). |
| 3 | Created `prompts`. |
| 4 | Created `sequences` and `segments` (+ index); added `segment_id`, `thumb_path` and `video_duration` to `generations` (+ index by segment). |
| 5 | Human-readable folders: added `folder` to `characters` and `sequences`; created `exports`. Paths are stored relative to the base folder from here on. |
| 6 | Assets: renamed `characters` → `assets` and `character_images` → `asset_images` (`character_id` → `asset_id`), added `kind` (existing rows become `character`) and `default_outfit_id`, rebuilt the indexes. `ASSETS_SCHEMA_VERSION = 6` marks libraries that own *Miljöer* and *Kläder*. |
| 7 | Voices, reviews and learnings: created `asset_audio` (+ index by asset and position), `generation_reviews` (+ index by generation, unique user review per generation) and `learnings`. Poses need no schema change (`assets.kind` is text); `POSES_SCHEMA_VERSION = 7` marks libraries that own *Poser*. |

A library from before the base folder could be chosen (`studio.db`, `generations/`, `thumbs/`, `characters/`,
`exports/`, `frames/` directly in the folder) is converted to the current layout by `library-root.ts` when it is
opened; an interrupted conversion resumes on the next open.

## Stored paths

The rules live in `src/main/paths.ts` and `src/main/db.ts`:

- **Relative inside the library's own folders.** A path inside one of the library's top-level folders
  (`Karaktärer`, `Miljöer`, `Kläder`, `Poser`, `Referensbilder`, `Genereringar`, `Sekvenser`, `.studio`, and the old
  layout's folders until they are converted) is stored relative to the base folder, POSIX-style and
  NFC-normalised. Anything else — including files of the user's own elsewhere in the base folder — keeps its
  absolute path, because moving the library only takes its own folders along.
- **Converted at the database boundary.** Code outside `db.ts` works with absolute paths. `toStoredPath` /
  `fromStoredPath` and `toStoredParams` / `fromStoredParams` convert on the way in and out.
- **Every path column is known.** `generations.file_path`, `generations.thumb_path`, the `startImage`, `endImage`,
  `referenceImages` and `referenceAudios[].path` in `generations.params` and `segments.params`,
  `asset_images.file_path`, `asset_audio.file_path` and `exports.file_path`. `mapStoredPaths` visits all of them,
  and so do the "is this path recorded" checks and `followRewrites`; a new path column must be added there.
- **Renames rewrite in one transaction.** `renameLibraryFolder` moves the folder on disk, then
  `rewriteStoredPrefix` rewrites every stored path under it in a transaction (moving the folder back if that
  fails). A submit that was uploading meanwhile follows the rewrites (`followRewrites`). The generations a rewrite
  changed are sent to the windows again (`takeRewrittenGenerations`, broadcast as `generation:update` once the
  files have moved), since the clip feed loads its list only once.
- **Normalised on open.** `relativizeStoredPaths` runs on every open and is idempotent.
- **Names never collide.** File and folder names come from `safeName` (keeps å ä ö, replaces characters macOS or
  exFAT reject, cuts long text at a word, `Namnlös` as fallback; times are written `HH.MM`). `uniqueName` adds
  ` (2)`, ` (3)` … and treats a name that a database row still records as taken, compared case-insensitively
  like the disk.
- **Files arrive complete.** Videos, frames and exports are written to `.studio/tmp` (or a `.part` sibling) and
  moved into place, so Finder never shows half a file; moves across volumes are copied, verified and only then
  removed.
- **A vanished base folder is never recreated.** `assertRootIntact` compares the folder's device and inode with
  what was opened; if it was renamed, moved or unmounted, the library is closed instead of recreating an empty
  folder at the old path.
- **Library-wide operations are exclusive.** A switch, move or *Städa upp* holds `beginLibraryOperation`; asset,
  sequence and delete work waits with `libraryOperationSettled`, and a switch is refused while generations,
  exports or asset work are running.

## IPC surface

`StudioApi` in `src/shared/types.ts` is the single contract between renderer and main; `src/preload/index.ts`
implements it one line per method. Requests use `ipcRenderer.invoke` on `<area>:<action>` channels; main rejects
with Swedish, user-facing messages.

| Group | Methods | Channels |
| --- | --- | --- |
| Settings | `getSettings`, `setApiKey`, `testApiKey`, `ffmpegStatus`, `setPromptLanguage` | `settings:*`, `ffmpeg:status` |
| Generation | `listModels`, `quote`, `generate`, `acceptConsent`, `listGenerations` (with the user's rating and the review count), `deleteGeneration` | `models:list`, `video:quote`, `video:generate`, `consent:accept`, `generations:*` |
| Reviews and learnings | `listReviews`, `setUserReview`, `deleteReview`, `listLearnings`, `saveLearning`, `deleteLearning`, `listExports` | `reviews:*`, `learnings:*`, `exports:list` |
| Assets | `listAssets`, `saveAsset`, `deleteAsset`, `addAssetImages`, `removeAssetImage`, `reorderAssetImages`, `addAssetAudio`, `removeAssetAudio`, `updateAssetAudio`, `reorderAssetAudio` | `assets:*` |
| Prompt library | `listPrompts`, `savePrompt`, `deletePrompt`, `markPromptUsed` | `prompts:*` |
| Sequences | `listSequences`, `getSequence`, `createSequence`, `updateSequence`, `deleteSequence`, `addSegment`, `updateSegment`, `deleteSegment`, `moveSegment`, `generateSegment`, `generateAllSegments`, `stopGenerateAll`, `exportSequence` | `sequences:*`, `segments:*` |
| Library folder | `libraryStatus`, `chooseLibraryFolder`, `inspectLibraryFolder`, `setLibraryRoot`, `reorganizeLibrary`, `revealLibraryFolder` | `library:*` |
| Agent connection | `getAgentStatus`, `setAgentEnabled`, `setAgentPort`, `restartAgent`, `getAgentToken`, `regenerateAgentToken`, `listAgentActivity`, `listApprovals`, `resolveApproval`, `replyAgentCommand` | `agent:*` |
| Files | `revealFile`, `pickImages`, `pickAudio`, `pathForFile` (local, via `webUtils`) | `file:*` |

Events from main to the window (subscribe with the `on…` methods, which return an unsubscribe function):
`generation:update` (with the review summary), `generation:delete`, `review:change` (the generation id),
`learnings:change`, `library:change`, `sequence:change`, `export:progress`, `agent:status`, `agent:activity`,
`agent:approval` and `agent:command`. The window answers `agent:command` with `agent:reply` (`ipcRenderer.send`).
After a library switch main reloads every window.

Two details matter when changing handlers:

- `sequences:missingClips` and `reviews:add` are registered but not part of `StudioApi`; only the agent connection
  uses them. The review and learning handlers take the agent's name as a last argument (only from an agent's call,
  `isAgentCall`), refuse `reviews:setUser` for agents, and let an agent change or delete only what it wrote.
- `segments:generate` and `sequences:generateAll` accept an optional *submit guard* function. Only in-process
  calls from an approved agent request can pass one (an IPC message cannot carry a function).

## Jobs: from submit to saved video

Every paid generation — the Generate button, a clip's *Generera tagning*, *Generera saknade*, an approved agent
request — ends in `JobManager.submit` (`src/main/jobs.ts`):

1. **Guard.** `prepareSubmission` checks the `@ImageN` and `@AudioN` references against what will actually be
   sent and refuses before anything is copied or paid for. Tokens are canonicalised and inputs the model does not
   use are dropped (`paramsForSubmit`: images outside their mode, reference audio unless the model is
   reference-to-video with `audio_input`, anything past the model's limits). Every reference audio clip is then
   measured with ffprobe and its window filled in, and the checks run again on the real lengths (each clip 2–15 s,
   15 s in all, at least one reference image). The `video:generate` handler (and a sequence take) runs this before
   it quotes the price and counts the submit as busy, so a library switch can't close the database under it.
2. **Prepare.** The library must be open; every image and audio file must still exist. Images and audio from
   outside the library are copied into `Referensbilder/<day>/` so the stored params point at the library's copies.
   The request body carries the images as JPEG data URLs (at most 2048 px) and each audio window as a mono
   44.1 kHz MP3 data URL (`reference_audio_urls`, encoded to whole MP3 frames so the clips stay within Venice's
   limits), plus Venice's consent attestation for Seedance models once the user has accepted it.
3. **Queue.** `POST /video/queue`. A `409 needs_consent` comes back as a `NEEDS_CONSENT:` error that the window
   turns into the consent dialog. On success a `generations` row is written with status `queued` and the queue id,
   and `generation:update` is broadcast.
4. **Poll.** Every 5 seconds `POST /video/retrieve`: still processing (status `processing`, timings updated), the
   video itself, or a download URL. Network errors, 5xx and 429 are retried with backoff (up to 70 attempts, a bit
   over an hour, since the job is already paid for); other unexpected errors get 5 quick retries; other 4xx
   responses fail the job.
5. **Save.** The video is written to `.studio/tmp/<id>.mp4` and moved to its place: `Sekvenser/<name>/Tagningar/`
   for a take, `Genereringar/<day>/` otherwise, named after the submit time and the prompt's first line.
6. **Poster.** `ffprobe` reads the duration and `ffmpeg` writes a poster to `.studio/miniatyrer/<id>.jpg`. This is
   best effort: a missing ffmpeg never fails a generation.
7. **Settle.** The row becomes `completed` (or `failed` with the error), `settled` fires once (sequences use it to
   select a fresh take automatically) and `POST /video/complete` asks Venice to delete its copy.

When a library is opened, `resume()` picks up jobs that were still pending (a job that never got a queue id is
failed) and backfills missing posters and durations in the background.

## Reference audio: from a file to `@AudioN`

Venice's reference-to-video models whose model list says `constraints.audio_input` (`VideoModel.audioInput`;
`supportsAudioInput` in `shared/models.ts`) accept `reference_audio_urls`: clips that steer a voice's timbre, tone
and pacing, or a place's ambience. Venice takes 2–15 s per clip and 15 s in all, and only together with at least
one reference image. Studio keeps the whole path inside those limits:

1. **Library.** Only characters (*Röst*) and environments (*Ljudmiljö*) have audio (`assets.ts`). `addAssetAudio`
   probes every file with `probeAudio` before anything is copied — a file without an audio stream or under a
   second refuses the whole batch — then copies the files into the asset's folder under their original names (made
   Finder-safe and unique) and records them in `asset_audio`. Each clip has a **reference window**:
   `resolveAudioWindow` defaults it to min(duration, 10 s) from the start and keeps it 2–15 s and inside the file
   (`clip_length` NULL in the database means the default). A removed clip goes to the Trash, or to
   `Referensbilder/<today>/` while generations or sequence clips still use it.
2. **Form and clips.** In `GenerationParams.referenceAudios` a clip is `{ path, start, length }` (absolute path
   over IPC, stored relative like images); `@Audio1` is the first. Adding a character to a form whose model takes
   audio also adds its first voice clip with the asset's window (`pickers/audioRefs.ts`; *Ta med rösten* on the
   chip, *Ta med ljudmiljön* for an environment), up to `maxReferenceAudios` (3) clips and
   `MAX_REFERENCE_AUDIO_SECONDS` (15) together. A clip whose window is under 2 s (`isAudioClipTooShort`; only a
   recording that short has one) is never added on the user's or an agent's behalf: it could never be sent and would
   only block the form, so the chip's toggle and the pickers say why, and agents get it in `not_added_audio`. `lib/generateStore.ts` follows library clips that move or get a new
   window. Sequence clips carry their own reference audio with the windows they had when it was added; a clip that
   continues from the previous one drops it with its reference images.
3. **Checks.** `prompt-refs.ts` checks `@AudioN` like `@ImageN` — near misses (`@audio 1`, `@Ljud1`, `@Voice1`,
   `@Röst1`), tokens past the clips or the model, a model without audio input, a window outside 2–15 s, more than
   15 s in all, audio without a reference image, clips the prompt never names — in the editor, in the agent tools
   and in `prepareSubmission`. Main does not trust the windows the renderer sent: `resolveReferenceAudios`
   (`venice.ts`) measures every file with ffprobe, fills in missing windows (start 0, min(rest of the file, 10 s)),
   cuts them at the end of the file, refuses a window that starts past it, and the checks run again on the real
   lengths. `video:generate` and every sequence take (also in *Generera saknade*) do this before the price is
   quoted, and `request_generation` and `request_segment_generation` before the user is asked to approve.
4. **Sending.** Clips from outside the library are copied into `Referensbilder/<day>/` with the images (each keeps
   its window). `buildRequestBody` then cuts each window with `encodeAudioClip` (ffmpeg: mono, 44.1 kHz, 128 kb/s
   MP3 without the file's tags) and sends the clips in order as `data:audio/mpeg;base64,…` URLs in
   `reference_audio_urls`. `mp3FramePlan` sizes each cut in whole MP3 frames, so the encoder's padding can't take
   a 15 s window, or two that add up to 15 s, over Venice's limits.
5. **Playing.** The renderer plays clips and windows through `media://`, which serves audio with its proper type
   and Range requests; agents hear the same window as MCP audio content (`get_asset`, `review_generation`).

## Sequences and export

A sequence (`sequences.ts`, `sequence-store.ts`) is an ordered list of segments (*clips*). Each segment's `params`
are the template for new takes; its takes are `generations` rows with its `segment_id`; one take is selected and
trimmed for the cut.

- **Continuation.** A clip with `continue_from_previous` (never the first) is generated with the image-to-video
  sibling of its model and no reference images or audio. At submit time the previous clip's selected take is cut
  where its end trim cuts it and that frame is extracted with ffmpeg into `.studio/bildrutor/` (cached per take
  and timestamp) to become the start image. The previous clip therefore needs a finished selected take first.
- **Generera saknade.** `startGenerateAll` walks the clips in order and, for each clip without a finished
  selected take (and none rendering), submits a take and waits for it, so the next continuation clip gets its
  frame. It can be stopped between clips; errors end up in `Sequence.runError`. While it runs, agents may not
  change the sequence's clips.
- **Files follow names.** Each sequence has a folder in `Sekvenser/`; renaming the sequence renames the folder
  (once nothing is being written into it). Deleting a clip or a sequence releases its takes to
  `Genereringar/` as ordinary generations; exports stay where they are.
- **Export.** Every clip needs a usable selected take. `buildConcatClips` turns them into `{path, start, end}`
  clips, skipping half a frame at the start of continuation clips so the shared frame doesn't freeze at the cut.
  `concatClips` builds one ffmpeg filter graph: each clip is trimmed, set to the first clip's frame rate, scaled
  and padded to its size, audio resampled to 48 kHz stereo (silence for clips without audio), then concatenated
  and encoded as H.264 (CRF 18) / AAC 192 kb/s with `+faststart`. Progress is read from `-progress pipe:1` and
  sent as `export:progress`. The film is rendered into `.studio/tmp`, moved to
  `Sekvenser/<name>/<name> <YYYY-MM-DD HH.MM>.mp4` and recorded in `exports`.

## Reviews and learnings

The review loop exists so prompts get better from what earlier prompts actually produced. The user rates clips in
the feed; agents look at finished clips and films, review them and distil *learnings* that every later session
reads first. `src/main/reviews.ts` owns the data and its IPC handlers; the agent side is `agent/tools/review.ts`
with `agent/media.ts`.

- **Reviews** (`generation_reviews`). The user has at most one review per generation (author `user`, enforced by
  a partial unique index): stars, a note and tags, set field by field with `reviews:setUser` from the feed's cards,
  table and detail drawer, and removed once all three are empty. Agents add any number with `reviews:add`, each
  under the agent's client name (`agentAuthor`: one line, never `user`). Reviews are deleted with their
  generation.
- **Learnings** (`learnings`). A title, the insight, an optional model (NULL: every model), tags, evidence
  (generation ids, which must exist when added) and `pinned`. They are written in *Prompter → Lärdomar* (author
  `user`) or by agents (`save_learning`), and listed pinned first, then by last change.
- **Who may change what.** A call from the window is the user's; a call from an agent tool (`isAgentCall`) carries
  the agent's name as its last argument. The user may delete any review and change or delete any learning; agents
  can't set the user's review, and may only update their own learnings and delete their own reviews and learnings
  (names compared ignoring letter case). A learning the user has pinned can't be updated or deleted by agents, and
  one the user has changed (anything but the pin) becomes the user's (`author` turns `user`).
- **Keeping views live.** Every write broadcasts `review:change` (with the generation id) or `learnings:change`,
  also when an agent made it. `attachReviewSummary` puts the user's `rating`, the `reviewCount` and the agents'
  `agentReviewCount` (the feed's review badge) on generations — for `generations:list`, every `generation:update`
  and the takes in a `Sequence` — with one query, so the feed's rating filter and sort and the agents'
  `list_generations` read the same numbers.
- **One filter for both.** `shared/generation-filter.ts` is the clip feed's search, filters and sort. A generation
  "uses" an asset when one of its start, end or reference images or reference audio paths is one of the asset's
  files (`indexAssetPaths`), so filtering by a character also finds clips that only used its voice.
- **Looking at results.** `ffmpeg.ts` makes what agents look at, on the fly and without writing into the library:
  `extractFrames` (JPEG frames at given times, 512 px wide by default), `extractAudioPreview` (a video's sound as
  mono 96 kb/s MP3; agents get at most 30 s) and `encodeAudioClip` (a reference window as Venice gets it).
  `review_export` works out where each clip sits in an exported film from its sequence as it is now — the selected
  takes, their trims and the frame a continuing clip skips — and only trusts that cut when the takes are older
  than the export and add up to the film's length (within max(0.35 s, 2 %)); otherwise it spreads frames evenly
  and says why.
- **Feeding back.** The agent guide (`get_studio_guide`, `studio://guide`) ends with the pinned learnings and the
  ten most recently changed ones, and `write_video_prompt` lists those that apply to its model, so a new session
  starts from what earlier reviews found.

## The agent bridge

The agent connection (`src/main/agent/`) is an MCP server for the user's own agents. It is off by default and is
switched on under *Inställningar → Agentanslutning*. See [AGENTS.md](AGENTS.md) for the user-facing side and
[SECURITY.md](../SECURITY.md) for the threat model.

```
agent ──HTTP──▶ AgentServer (/mcp) ──▶ McpServer per session ──▶ tools
                                                                  │
            ┌──────────────── callService('assets:save', …) ◀─────┤  library, sequences, models…
            │                 (the same ipcMain handlers the window uses)
            │                                                     │
            │    FormBridge ── 'agent:command' ──▶ renderer agentBridge ──▶ Generate form store
            │               ◀── 'agent:reply' ───┘                │
            │                                                     │
            └── ApprovalStore ◀── request_* tools ────────────────┘
                     │  'agent:approval' ──▶ ApprovalDialog ── resolveApproval ──▶ verify ──▶ execute
                     ▼
               JobManager.submit (same guard as every other generation)
```

- **Server.** `AgentService` listens on `127.0.0.1` and on each Tailscale IPv4 address of this Mac (never
  `0.0.0.0`), port 8770 by default, re-checking the Tailscale address every 30 seconds. `AgentServer` serves MCP
  over Streamable HTTP at `/mcp`, one transport and one `McpServer` per client session (sessions idle for 12 hours
  are dropped, at most 24 are kept). Each request passes the peer check, the `Origin` check and a constant-time
  bearer token check before it reaches MCP; bodies over 1 MB are refused. The `X-Studio-Agent-Name` header, or
  else the client's MCP `clientInfo`, names the agent in the activity log and on approval requests.
- **Tools.** `defineTool` (`tools/kit.ts`) validates input with zod, answers with compact JSON plus labelled
  images and audio (each block after a text label; audio is replaced by a one-line note for a session whose
  protocol version predates audio content, 2025-03-26), turns exceptions into tool errors the agent can read
  (Swedish, like the UI) and records every call in the activity log. Tools carry MCP annotations (`readOnlyHint`,
  `destructiveHint`, `openWorldHint`). The 39 tools live in `tools/library.ts`, `form.ts`, `sequences.ts`,
  `paid.ts` and `review.ts`; [AGENTS.md](AGENTS.md#tools) lists them.
- **Same services as the window.** `recordIpcHandlers` wraps `ipcMain.handle` before any module registers its
  handlers, so `callService(channel, …args)` runs exactly the handler a window would, with every validation, busy
  check, folder move and change notification. Handlers can tell an agent's call apart with `isAgentCall(event)`
  (used to refuse clip changes during *Generera saknade*).
- **Form commands.** The Generate form lives in the renderer (`lib/generateStore.ts`), because it is what the user
  sees and edits. `FormBridge.send` posts `agent:command` (`get_form`, `set_form`, `set_references` or `open`, with
  a deadline) to the focused window, and `lib/agentBridge.ts` applies it with the form's own rules (mode switching,
  model options, the reference cap) and answers with `agent:reply`. Only the window that got the command may
  answer, and main gives up after 10 seconds ("is the window open?").
- **Approvals.** The paid tools (`tools/paid.ts`) validate the request (`request_generation` and
  `request_segment_generation` run `prepareSubmission`, so reference audio is measured before the user is asked;
  `request_generation` keeps the measured windows in the request), quote the price and create an `ApprovalPlan` in
  `ApprovalStore`: a fingerprint (an identical pending request is reused), a target (a newer request for the same
  clip replaces the older one), `verify` (refuses if the clip or the actual image and audio files changed since)
  and `execute`. The window shows `ApprovalDialog` with the prompt, references and voices (the Dock icon bounces if
  Studio isn't focused). Approving runs `verify`, then `execute`, which calls `video:generate`, `segments:generate` or
  `sequences:generateAll` through `callService` — the latter two with a submit guard that re-checks the clip
  against what the user approved right before each take is sent. Requests expire after 30 minutes; at most 10 can
  be pending; regenerating the token, switching the library or turning the connection off expires them all.
- **Guidance.** `guide.ts` provides the server instructions sent at `initialize`, the `get_studio_guide` tool, the
  `studio://guide` resource and the `write_video_prompt` prompt. Prompt-writing advice follows the user's prompt
  language setting; the guide covers voices (`@AudioN`), poses and the review loop, and ends with the pinned and
  ten most recent learnings.
- **Looking back.** The review tools (`tools/review.ts`) give agents what a generation, a sequence or an exported
  film actually became: frames as JPEG images captioned with their time, the reference images next to them, and —
  when asked, for clients on MCP 2025-03-26 or later — the clip's sound and the voice windows as MP3 audio content.
  Reviews and learnings are written through the same IPC handlers as the window, under the agent's name (see
  [Reviews and learnings](#reviews-and-learnings)). None of them spends money.

## Shared modules

`src/shared/` is imported by main, preload and renderer and must stay free of Node and DOM dependencies.

| Module | Contents |
| --- | --- |
| `types.ts` | Every type that crosses the process boundary, the `StudioApi` interface, `NEEDS_CONSENT`. |
| `models.ts` | The three modes (`KINDS`), `DEFAULT_MODEL` per mode (Seedance 2.5 basic), `PREFERRED` options, `DEFAULT_PARAMS` (8s, 480p, 16:9, audio on), `rememberModelKinds` / `kindOfModelId`, `pickOption`, `audioForModel`, `imageToVideoVariant`, `maxReferenceImages` (9, or 7 for Grok and 4 for Kling models), reference audio (`supportsAudioInput`, `maxReferenceAudios` = 3, `MIN`/`MAX_AUDIO_CLIP_SECONDS` = 2/15, `MAX_REFERENCE_AUDIO_SECONDS` = 15, `referenceAudioWindow`, `sanitizeReferenceAudios`), `paramsForSubmit`, `durationSeconds`. |
| `prompt-refs.ts` | Pure `@ImageN` and `@AudioN` logic: finding tokens and near misses (`@Image 3`, `@img3`, `@Bild3`, `@audio 1`, `@Ljud1`, `@Voice1` …), validation with issue codes (`no-references`, `out-of-range`, `over-model-limit`, `malformed`, `unused-reference`, `not-reference-mode`, and for audio `audio-out-of-range`, `audio-over-limit`, `audio-not-supported`, `audio-length`, `audio-too-long`, `unused-audio`), `validationContext`, canonicalisation, and `blockingPromptError` / `blockingContinuationError`. The editor, the submit guard and the agent tools all use it, so they agree. |
| `generation-filter.ts` | The clip feed's filter and sort (`filterGenerations`, `sortGenerations`, `queryGenerations`, `summarizeGenerations`, `indexAssetPaths`), shared by the feed and the agents' `list_generations`, so both show the same clips. |
| `prompts.ts` | `titleFromBody`, the automatic title of an untitled prompt. |
