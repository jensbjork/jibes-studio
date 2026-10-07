# Architecture

This document describes how Studio is put together: its processes, the modules in each, the data model, how
files are stored, how a generation travels from the form to a video on disk, how voices and sounds reach Venice,
how sequences are exported, storyboarded with keyframes and stills, and redone between their neighbours, how
reviews and learnings close the loop, and how the agent connection (MCP server) plugs into all of it. It reflects
the code in `src/`; when they disagree, the code wins — please fix the document.

- [Processes](#processes)
- [Module map](#module-map)
- [Data model](#data-model)
- [Stored paths](#stored-paths)
- [IPC surface](#ipc-surface)
- [Jobs: from submit to saved video](#jobs-from-submit-to-saved-video)
- [Reference audio: from a file to `@AudioN`](#reference-audio-from-a-file-to-audion)
- [Sequences and export](#sequences-and-export)
- [Storyboards, keyframes and stills](#storyboards-keyframes-and-stills)
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
| `index.ts` | App entry: profiles, single-instance lock, window creation, the core IPC handlers (settings — a change of *Säkert läge för bilder* is broadcast as `settings:change`, since Inställningar and the image dialogs each show it —, models, quote/generate, generations, files), wiring of the services (generations are sent with their review summary; the job manager and the sequence service get the cached video model list — the job manager for the models' prompt limits — and the sequence service the stills service's import and save-frame functions), shutdown. |
| `settings.ts` | `settings.json` in the profile's `userData`: base folder, prompt language, *Säkert läge för bilder* (image safe mode, on unless switched off), accepted Venice consents, agent port/on-off; the Venice API key and the agent token encrypted with `safeStorage`. |
| `images.ts` | Venice image client for stills: text-to-image models from `/models?type=image` (background removers and upscalers left out) and edit models that combine references from `/models?type=inpaint` (only those with `combineImages`; `maxInputImages` 3 when the list doesn't say), cached for 10 minutes; prices from `model_spec.pricing` (per quality, per resolution or flat, plus `inputImages.additional` per extra reference); the `/image/generate` and `/image/multi-edit` bodies (references as data URLs within Venice's input limits, decoded as Studio shows them by `input-image.ts`, base first; models without an aspect-ratio list get width/height), safe mode from settings, and Swedish errors (402 balance, 4xx detail, the `x-venice-is-content-violation` header, a 4-minute limit after which the picture may still have been charged). Paid requests are never retried. |
| `stills.ts` | Stills: rows, `planStill` (model, references, options and price checked before anything is paid for; also what an agent's image approval shows), generating (`images:generate`), saving the frame a paused player shows (`stills:saveFrame`), importing dropped files (deduplicated by content), placement in `Sekvenser/<sequence>/Storyboard/` or `Referensbilder/<day>/` (safe against a sequence folder renamed or deleted meanwhile), deleting (a still other rows use is kept in `Referensbilder`), the still-work busy state, and the `images:*` and `stills:*` handlers. A paid picture that can't be saved in the library is written to the user's Downloads folder instead (its path is in the error). |
| `venice.ts` | Venice API client (`/models` incl. `audio_input`, `/api_keys/rate_limits`, `/video/quote`, `/video/queue`, `/video/retrieve`, `/video/complete`; a fetched model list is remembered by the shared `rememberModelKinds` and `rememberPromptLimits`), request bodies (images become downscaled JPEG data URLs, decoded by `input-image.ts`; each reference audio window becomes an MP3 data URL of whole frames, 2–15 s each and 15 s in all), measuring reference audio (`resolveReferenceAudios`), `VeniceError` / `NetworkError`. |
| `jobs.ts` | `JobManager`: the guard in front of every paid submission (`prepareSubmission`: `@ImageN`/`@AudioN` checks, canonical tokens, audio clips measured), composing the prompt that is sent (`composeSubmission`: the References legend of the referenced assets' descriptions, read from the database at that moment and fitted into the model's prompt limit) and storing it as `sent_prompt`, queueing at Venice, polling with backoff, saving videos into the library, posters and durations, resuming pending jobs and backfilling missing posters. |
| `db.ts` | The SQLite connection (WAL, foreign keys), the migrations, generation rows, and stored-path maintenance: prefix rewrites, relativizing, "is this path recorded" checks. |
| `paths.ts` | Folder layout constants (`FOLDERS`, `APP_DATA`, `TAKES_FOLDER`, `STORYBOARD_FOLDER`), conversion between absolute and stored paths, Finder-safe names, unique names, verified moves and renames, the "base folder is still there" check and the library-wide operation lock. |
| `library-root.ts` | The base folder's lifecycle: opening it at startup, status, choosing/inspecting/switching (`move`, `open`, `new`), converting an earlier layout, refusing a library from before a folder existed whose base folder holds a folder of the user's own by that name (*Miljöer*, *Kläder* from schema 6, *Poser* from 7), *Städa upp* (reorganize, asset photos and audio clips, stills included), revealing folders in Finder. |
| `library.ts` | The prompt library (CRUD, tags, favourites, usage) and registration of the asset and prompt IPC handlers. |
| `assets.ts` | Characters, environments, outfits and poses: rows, one folder per asset with copies of its photos (and, for characters and environments, audio clips probed with ffprobe, each with a clamped reference window) and `Beskrivning.txt`, renames that move the folder, deletes to the Trash (a photo or clip that generations still use is kept in `Referensbilder`), default outfits, and `describedAssetsFor` (the described assets behind a set of params' files, straight from the database, for composing the prompt). |
| `input-image.ts` | Decodes a picture for Venice (and for agents) the way Studio's views show it: a JPEG turned upright by its EXIF orientation (`nativeImage` ignores it, so a portrait phone photo would be sent sideways and an image-to-video take come out rotated), a WebP (which `nativeImage` can't read) decoded by ffmpeg (`stillToPng`), so both get the usual size limits. |
| `references.ts` | Copies start/end/reference images and reference audio from outside the library into `Referensbilder/<day>/` (deduplicated by content hash) and the shared `placeFile` / `copyInto` helpers that write via the scratch folder. |
| `reviews.ts` | The user's and agents' reviews of generations (`attachReviewSummary` puts the user's rating and the review count on generations), learnings, the list of exported films, and their IPC handlers (an agent writes under its own name and may only change its own). |
| `sequences.ts` | `SequenceService`: sequences and clips (reference audio included; continuing clips drop it), the prompt a take sends (`composeClipPrompt`; a take composes it together with the clip read and the approval guard), keyframes (`setSegmentImage`), *Gör om mellan grannarna* (`bridgeSegment`), frame previews, takes, the neighbours' frames (continuation and end frames), *Generera saknade* runs in dependency order, keeping sequence folders (with their `Storyboard/`) in step with names, deleting a sequence with its stills, export, and the sequence IPC handlers. |
| `sequence-store.ts` | Row access and assembly for sequences, segments (notes, `endFromNext` and the description switches included) and stills, take selection (`seamTrims`: a side the new take was made to meet exactly starts untrimmed) and trim clamping, folder and file naming. |
| `sequence-export.ts` | Turns the selected, trimmed takes into ffmpeg concat clips (dropping the duplicated picture where a take was made from its neighbour's frame: `repeatsPreviousFrame`, `dropsLastFrame`) and reserves the export's file name. |
| `ffmpeg.ts` | Finds `ffmpeg`/`ffprobe`, probes videos and audio files (decoding when the header only estimates the length), extracts frames (the frame showing at a moment, and the first frame at or after a start trim: `extractFrameAtOrAfter`, `frameStartAtOrAfter`) and posters, decodes still pictures to PNG (`stillToPng`), cuts reference audio windows to mono MP3 (`encodeAudioClip`), JPEG frames and sound previews for agents' reviews (`extractFrames`, `extractAudioPreview`), renders the concat export, and kills/cleans up running processes on quit. |
| `media-protocol.ts` | The `media://` scheme (video, image and audio types). |
| `agent/index.ts` | Public entry of the agent connection. |
| `agent/service.ts` | `AgentService`: on/off, port, token, following the Tailscale address, status for the UI, one MCP server per client session. |
| `agent/server.ts` | The HTTP server: peer, `Origin` and bearer checks, body limits, MCP Streamable HTTP sessions and their lifecycle, and the protocol version each session speaks (audio content needs 2025-03-26). |
| `agent/network.ts` | Loopback and Tailscale address detection, the peer allow-list, MagicDNS lookup through Tailscale's resolver. |
| `agent/approvals.ts` | `ApprovalStore`: paid requests (generations and, kind `image`, stills) waiting for the user's decision. |
| `agent/activity.ts` | The activity log of tool calls shown in the app (ring of 200 entries). |
| `agent/bridge.ts` | `FormBridge`: main ↔ renderer commands for the Generate form. |
| `agent/local-ipc.ts` | Records the `ipcMain` handlers so agent tools call exactly the services the window calls (`callService`, `isAgentCall`). |
| `agent/ipc.ts` | IPC handlers for the agent settings, the activity drawer and the approval dialog. |
| `agent/guide.ts` | The MCP server instructions, the Studio guide and the prompt-writing guide for agents. |
| `agent/images.ts` | Photos and posters as MCP image content (JPEG, at most 768 px), with a small cache, and the MCP image and audio content blocks for the JPEG frames and MP3s ffmpeg makes. |
| `agent/media.ts` | Video frames, a clip's sound and reference audio windows as MCP image and audio content for the review tools (through `ffmpeg.ts`). |
| `agent/studio.ts` | Helpers shared by the tools: asset index (photos and audio clips), `@ImageN` and `@AudioN` token maps, model and option checks, prompt problems, and the composed prompt with its description entries (`descriptionInfo`, through main's `composeSubmission`). |
| `agent/reorder.ts` | `reorder_references`: reading the new order an agent names (tokens, photo or clip ids, asset ids), which tokens moved, and the pictures past the model's limit. |
| `agent/tools/*.ts` | The MCP tools (`library.ts`, `form.ts`, `sequences.ts` with keyframes and notes, `storyboard.ts` for stills, image models, frame previews and bridging, `paid.ts` with the image request, and `review.ts` for reviewing clips, films and sequences, reviews and learnings), the `defineTool` frame (`kit.ts`, image and audio content, older clients get a note instead of audio) and registration of the tools, the `write_video_prompt` prompt and the `studio://guide` resource (`index.ts`). |

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
| `lib/generateStore.ts` | The Generate form as an app-level store above the views, persisted to `localStorage`, so agents can read and fill it while another view is open. Follows library audio clips that move or get a new window; the description switches are cleaned with `sanitizeDescriptionFlags` when the form is loaded. |
| `lib/agentBridge.ts` | The renderer half of the form bridge: applies `get_form`, `set_form` (the description switches included), `set_references` (photos and audio clips, with the 3-clip and 15 s caps), `reorder_references` (the shared `reorderReferences`, prompt and negative prompt in the same change) and `open` to the form store and replies with the token maps and the pictures past the model's limit (`unsentReferences`). |
| `lib/agent.ts` | Live agent status, activity and approval requests for the indicator, the drawer, the dialog and Settings. |
| `lib/promptIssues.ts` | The `@ImageN` and `@AudioN` checks for a set of params, with the rules main applies. |
| `lib/hooks.ts` | Shared data hooks (model list, assets, prompts, price quote) and `ipcErrorMessage`. |
| `lib/library.ts` | `localStorage` keys that hold library data and how they are rewritten or forgotten after a library switch; `withImportedCopies`, which points the form at the copies in `Referensbilder` of images and audio picked from outside the library once a generation is submitted. |
| `lib/assets.ts`, `lib/media.ts`, `lib/navigation.ts`, `lib/workspace.ts` | Asset kind wording, `media://` URLs and formatting, cross-view navigation intents, where the user is in the sequence editor. |
| `components/GenerateView.tsx`, `ParamsForm.tsx`, `GenerationCard.tsx`, `ImageInput.tsx` | The Generate view: the form (references, voices and sounds, poses, the descriptions box), the clip feed's cards, image inputs (the reference strip reorders by drag and drop or ⌥← / ⌥→, showing the numbers each picture will get and which won't be sent). |
| `components/feed/` | The clip feed in Generera: toolbar with search, filters (the shared `generation-filter`), sort and summary; poster-only cards; a windowed table with sortable columns and keyboard navigation; the detail drawer with player, highlighted `@ImageN`/`@AudioN`, *Skickad prompt* (`SentPrompt.tsx`: the prompt as sent, its legend set apart, when it differs), the references and audio windows sent, settings, the user's rating, note and tags, and agents' reviews; kept live through `onGenerationUpdate`, `onGenerationDelete` and `onReviewChange`. |
| `components/prompt/` | The reference-aware prompt editor: `@ImageN` and `@AudioN` colouring, hover cards and players, the `@` menu, issue list and quick fixes; *Läggs till i prompten* (`DescriptionsBox.tsx`, with the pure `descriptions.ts` asking the shared composer what is sent): the legend's entries live, a switch per asset and *Ta med beskrivningar*, the composed length against the model's limit. |
| `components/prompts/` | The prompt library view (*Prompter*) and its *Lärdomar* tab (learnings: list, editor, evidence clips). |
| `components/assets/` | The *Karaktärer*, *Miljöer*, *Kläder* and *Poser* views: list, editor, photos, default outfit, and the sound section (voice or soundscape clips, a shared player, the reference window editor). |
| `components/pickers/` | Pickers and dialogs shared by the views (assets, audio clips, outfits, prompts, sequences, modal, popover), the form's asset and audio helpers (`assetRefs`, which re-exports the shared remap, `audioRefs`), and reordering: `reorder.ts` (gap arithmetic, live positions, the nearest gap on wrapped rows) and `useReorder.ts` (the HTML5 drag and drop and ⌥← / ⌥→ hook shared by the image strip and the audio chips, with focus restore and an `aria-live` announcement). |
| `components/sequences/` | The *Sekvenser* view: list, header with the *Tidslinje / Storyboard* switch (remembered per sequence in `viewMode.ts`), timeline (with *Gör om mellan grannarna* on the cards), clip editor (`KeyframeBox`: *Startbild från föregående klipp* / *Slutbild från nästa klipp* with live frame previews; `NotesField`: *Vad händer*), takes, trims, preview player, the shared clip checks (`clipChecks.ts`) and frame previews (`useFramePreview.ts`: cached, at most two at a time). |
| `components/sequences/storyboard/` | The Storyboard view: a responsive grid of panels (`StoryboardPanel`: number, take, start slot → end slot, notes, prompt, price, *Generera tagning*, *Gör om mellan grannarna*), drag to reorder, *+ Ny ruta*, keyframe slots (`ImageSlot`: upload or drop, library photo, still, a frame from a clip, *Skapa bild…*, the previous or next clip) and the stills strip (`StillsStrip`). |
| `components/images/` | *Skapa bild…* (`CreateImageDialog`: prompt, references with the base first, model, format, resolution and quality, the safe-mode note, live price, *Använd som startbild / slutbild*), the frame picker (`FramePickerDialog`: any finished take of the sequence, frame-exact stepping, *Använd den här bildrutan*), `StillThumb` (draggable as `application/x-studio-still`), `StillViewer`, and the image model and price helpers (`imageModels.ts`). |
| `components/library/` | Library setup screen, folder choice, switching overlay and *Inställningar → Bibliotek*. |
| `components/agent/` | Agent settings section, sidebar indicator, activity drawer, approval dialog (with the References legend a request appends, set apart under the prompt and marked when a description has changed since, the voices a request sends, the start and end frames of a clip that takes them from its neighbours, and image requests with their references and the finished picture) and their Swedish wording. |
| `components/SettingsView.tsx`, `Sidebar.tsx`, `ConsentDialog.tsx`, `DevBadge.tsx` | Settings (*Bilder → Säkert läge för bilder* among them), navigation, Venice's consent dialog, the *Dev* badge. |

## Data model

The database is `<base folder>/.studio/studio.db` (SQLite through `better-sqlite3`, WAL journal, foreign keys on).
Each library has its own database; nothing about the library lives in the profile's settings except where the
base folder is.

| Table | Holds |
| --- | --- |
| `generations` | Every generation: model, prompt, params (JSON), status (`queued`, `processing`, `completed`, `failed`), Venice queue id, price quote, timings, `file_path`, `thumb_path`, `video_duration`, `segment_id` when it is a take of a sequence clip, and `sent_prompt`: the prompt exactly as Venice got it (`prompt` and `params.prompt` stay the user's text, which *Använd igen* puts back; NULL before migration 9). |
| `assets` | Characters, environments, outfits and poses: `kind` (`character`, `environment`, `outfit`, `pose`), name, description, `folder`, `default_outfit_id` (characters only, a self-reference set to NULL when the outfit is deleted). |
| `asset_images` | An asset's photos: `file_path` and `position` (position 0 is the cover). |
| `asset_audio` | A character's voice or an environment's soundscape clips: `file_path`, `position` (position 0 comes along when the character is added to a form), `duration`, and the reference window `clip_start` / `clip_length` (NULL: the default, min(duration, 10 s)). Deleted with their asset. |
| `generation_reviews` | Reviews of a generation: `author` (`user`, at most one per generation by a partial unique index, or an agent's name), `rating` 1–5, `tags` (JSON), `note`. Deleted with their generation. |
| `learnings` | Insights about prompting: `title`, `insight`, `model` (NULL: every model), `tags` and `evidence` (generation ids, JSON), `author`, `pinned`. |
| `prompts` | The prompt library: title, body, negative prompt, tags (JSON), favourite, use count, last used. |
| `sequences` | Name, `defaults` (JSON params for new clips), `folder`. |
| `segments` | A sequence's clips: `position`, `params` (JSON template for new takes; its `startImage` / `endImage` are the clip's keyframes), `continue_from_previous`, `end_from_next` (take the end image from the next clip), `notes` (*Vad händer*), `selected_generation_id`, `trim_start`, `trim_end`. Deleted with their sequence. |
| `stills` | The pictures of a sequence's storyboard: `sequence_id` (set to NULL when the sequence is deleted and the still is kept), `file_path`, `source` (`generated`, `upload`, `frame`), `prompt`, `model`, `params` (JSON: negative prompt, reference images, aspect ratio, resolution, quality; a saved frame's take and time), `cost`. |
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
| 8 | Storyboards: added `end_from_next` and `notes` to `segments`; created `stills` (+ index by sequence and creation time). |
| 9 | Descriptions in the prompt: added `sent_prompt` to `generations` (the prompt with the References legend, as sent). |

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
  `asset_images.file_path`, `asset_audio.file_path`, `stills.file_path`, the `referenceImages` in `stills.params`
  and `exports.file_path`. `mapStoredPaths` visits all of them, and so do the "is this path recorded" checks
  (`isStoredPathRecorded` can leave one still's own row out: is anything *else* using its file?), the list of
  tracked files a library move carries and `followRewrites`; a new path column must be added there.
- **Renames rewrite in one transaction.** `renameLibraryFolder` moves the folder on disk, then
  `rewriteStoredPrefix` rewrites every stored path under it in a transaction (moving the folder back if that
  fails). A submit that was uploading meanwhile follows the rewrites (`followRewrites`). The generations a rewrite
  changed are sent to the windows again (`takeRewrittenGenerations`, broadcast as `generation:update` once the
  files have moved), since the clip feed loads its list only once; when stills changed (`takeRewrittenStills`)
  the windows get `stills:change`.
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
  sequence, still and delete work waits with `libraryOperationSettled`, and a switch is refused while generations,
  exports, asset or still work are running.

## IPC surface

`StudioApi` in `src/shared/types.ts` is the single contract between renderer and main; `src/preload/index.ts`
implements it one line per method. Requests use `ipcRenderer.invoke` on `<area>:<action>` channels; main rejects
with Swedish, user-facing messages.

| Group | Methods | Channels |
| --- | --- | --- |
| Settings | `getSettings`, `setApiKey`, `testApiKey`, `ffmpegStatus`, `setPromptLanguage`, `setImageSafeMode` | `settings:*`, `ffmpeg:status` |
| Generation | `listModels`, `quote`, `generate`, `acceptConsent`, `listGenerations` (with the user's rating and the review count), `deleteGeneration` | `models:list`, `video:quote`, `video:generate`, `consent:accept`, `generations:*` |
| Reviews and learnings | `listReviews`, `setUserReview`, `deleteReview`, `listLearnings`, `saveLearning`, `deleteLearning`, `listExports` | `reviews:*`, `learnings:*`, `exports:list` |
| Assets | `listAssets`, `saveAsset`, `deleteAsset`, `addAssetImages`, `removeAssetImage`, `reorderAssetImages`, `addAssetAudio`, `removeAssetAudio`, `updateAssetAudio`, `reorderAssetAudio` | `assets:*` |
| Prompt library | `listPrompts`, `savePrompt`, `deletePrompt`, `markPromptUsed` | `prompts:*` |
| Sequences | `listSequences`, `getSequence`, `createSequence`, `updateSequence`, `deleteSequence`, `addSegment`, `updateSegment`, `deleteSegment`, `moveSegment`, `setSegmentImage`, `previewSegmentFrames`, `bridgeSegment`, `generateSegment`, `generateAllSegments`, `stopGenerateAll`, `exportSequence` | `sequences:*`, `segments:*` (`segments:setImage`, `segments:previewFrames`, `segments:bridge`) |
| Images and stills | `listImageModels`, `quoteStill`, `generateStill`, `listStills`, `deleteStill`, `saveFrameAsStill` | `images:models`, `images:quote`, `images:generate`, `stills:list`, `stills:delete`, `stills:saveFrame` |
| Library folder | `libraryStatus`, `chooseLibraryFolder`, `inspectLibraryFolder`, `setLibraryRoot`, `reorganizeLibrary`, `revealLibraryFolder` | `library:*` |
| Agent connection | `getAgentStatus`, `setAgentEnabled`, `setAgentPort`, `restartAgent`, `getAgentToken`, `regenerateAgentToken`, `listAgentActivity`, `listApprovals`, `resolveApproval`, `replyAgentCommand` | `agent:*` |
| Files | `revealFile`, `pickImages`, `pickAudio`, `pathForFile` (local, via `webUtils`) | `file:*` |

Events from main to the window (subscribe with the `on…` methods, which return an unsubscribe function):
`generation:update` (with the review summary), `generation:delete`, `review:change` (the generation id),
`learnings:change`, `library:change`, `sequence:change`, `export:progress`, `stills:change` (a sequence id, or
none for "any"), `agent:status`, `agent:activity`, `agent:approval` and `agent:command`. The window answers
`agent:command` with `agent:reply` (`ipcRenderer.send`). After a library switch main reloads every window.

Two details matter when changing handlers:

- `sequences:missingClips`, `stills:get` and `reviews:add` are registered but not part of `StudioApi`; only the
  agent connection uses them. The review and learning handlers take the agent's name as a last argument (only
  from an agent's call, `isAgentCall`), refuse `reviews:setUser` for agents, and let an agent change or delete only
  what it wrote.
- `segments:generate` and `sequences:generateAll` accept an optional *submit guard* function. Only in-process
  calls from an approved agent request can pass one (an IPC message cannot carry a function).

## Jobs: from submit to saved video

Every paid video generation — the Generate button, a clip's *Generera tagning*, *Generera saknade*, an approved
agent request — ends in `JobManager.submit` (`src/main/jobs.ts`). (Stills are pictures, made in one request by
`stills.ts`; see [Storyboards, keyframes and stills](#storyboards-keyframes-and-stills).)

1. **Guard.** `prepareSubmission` checks the `@ImageN` and `@AudioN` references against what will actually be
   sent and refuses before anything is copied or paid for. Tokens are canonicalised and inputs the model does not
   use are dropped (`paramsForSubmit`: images outside their mode, reference audio unless the model is
   reference-to-video with `audio_input`, anything past the model's limits). Every reference audio clip is then
   measured with ffprobe and its window filled in, and the checks run again on the real lengths (each clip 2–15 s,
   15 s in all, at least one reference image). The `video:generate` handler (and a sequence take) runs this before
   it quotes the price and counts the submit as busy, so a library switch can't close the database under it.
   The prompt as it will be sent (below) is checked by the same rules.
2. **Compose.** `composeSubmission` appends the References legend (`composePrompt` in `src/shared/prompt-compose.ts`)
   to the user's prompt: one line per asset with a description that has a picture or clip among the references
   actually sent, with its tokens, its name and its description — read from the database at that moment
   (`describedAssetsFor`), so an edit in the library applies to the next generation — unless the params switch it
   off (`includeDescriptions: false`, `excludedDescriptionAssetIds`). The words follow the prompt language, and the
   descriptions are shortened (or the legend dropped) to fit the model's `promptCharacterLimit`, which the job
   manager reads from main's cached model list (`rememberPromptLimits`). A sequence take composes it when it reads
   the clip, together with its approval guard, and passes it as `sentPrompt`, so a description edited while the
   frames are taken doesn't change what was checked; an agent's approved form request passes the text the user
   approved the same way. The request body carries the composed prompt; the row keeps
   the user's prompt in `prompt` and `params` and the composed one in `sent_prompt`.
3. **Prepare.** The library must be open; every image and audio file must still exist. Images and audio from
   outside the library are copied into `Referensbilder/<day>/` so the stored params point at the library's copies.
   The request body carries the images as JPEG data URLs (at most 2048 px, turned upright by their EXIF orientation
   like every view shows them) and each audio window as a mono
   44.1 kHz MP3 data URL (`reference_audio_urls`, encoded to whole MP3 frames so the clips stay within Venice's
   limits), plus Venice's consent attestation for Seedance models once the user has accepted it.
4. **Queue.** `POST /video/queue`. A `409 needs_consent` comes back as a `NEEDS_CONSENT:` error that the window
   turns into the consent dialog. On success a `generations` row is written with status `queued` and the queue id,
   and `generation:update` is broadcast.
5. **Poll.** Every 5 seconds `POST /video/retrieve`: still processing (status `processing`, timings updated), the
   video itself, or a download URL. Network errors, 5xx and 429 are retried with backoff (up to 70 attempts, a bit
   over an hour, since the job is already paid for); other unexpected errors get 5 quick retries; other 4xx
   responses fail the job.
6. **Save.** The video is written to `.studio/tmp/<id>.mp4` and moved to its place: `Sekvenser/<name>/Tagningar/`
   for a take, `Genereringar/<day>/` otherwise, named after the submit time and the prompt's first line.
7. **Poster.** `ffprobe` reads the duration and `ffmpeg` writes a poster to `.studio/miniatyrer/<id>.jpg`. This is
   best effort: a missing ffmpeg never fails a generation.
8. **Settle.** The row becomes `completed` (or `failed` with the error), `settled` fires once (sequences use it to
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
   only block the form, so the chip's toggle and the pickers say why, and agents get it in `not_added_audio`.
   `lib/generateStore.ts` follows library clips that move or get a new window. Sequence clips carry their own
   reference audio with the windows they had when it was added; a clip that continues from the previous one, or
   has a start or end image, drops it with its reference images.
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
- **Ending on the next clip.** A clip with `end_from_next` (never the last) mirrors it: at submit time the next
  clip's selected take gives its first shown frame — the first frame at or after its start trim, the frame the
  export starts that clip on (`extractFrameAtOrAfter`) — cached as `.studio/bildrutor/<take id>-first-<ms>.png`
  (another take or start trim gets a file of its own), and it is sent as `end_image_url`. The clip needs a model
  that takes an end image (`supportsEndImage`); turning the flag on switches it to one (`endImageVariant`, with
  the options the new model offers). Both neighbours are checked before either frame is extracted or anything is
  paid for. Together with `continue_from_previous` this is *Gör om mellan grannarna* (see below).
- **Generera saknade.** `startGenerateAll` makes every clip without a finished selected take (and none
  rendering) in dependency order (`generationOrder`): a clip comes after the neighbours whose frames it takes, so
  a chain of continuations runs forward and a clip ending on the next clip waits for that clip; otherwise the
  sequence's order; the order is worked out again after every take, since the user may change the clips
  meanwhile. Before the first take, every missing clip is checked (`missingClips`), so a later clip that can't be
  sent as it stands stops the run before anything is paid for — and so do two clips that wait on each other (clip
  N ends on N+1, which continues from N, neither made), with a Swedish `runError` that says which switch to turn
  off (`missingClipProblem` words it the same for the run and for agents). Each take is submitted and waited for,
  so the clips after it get their frames. It can be stopped between clips; errors end up in `Sequence.runError`.
  `missingClips` (what an agent's *generate all* approval shows) lists the clips in the same order. While it runs,
  agents may not change the sequence's clips.
- **Files follow names.** Each sequence has a folder in `Sekvenser/` with `Tagningar/` and `Storyboard/`; renaming
  the sequence renames the folder (once nothing is being written into it), and every stored path below it — takes,
  stills, keyframes in clips — is rewritten. Deleting a clip or a sequence releases its takes to `Genereringar/` as
  ordinary generations; exports stay where they are. Deleting a sequence keeps the stills that generations, clips
  or other stills still use (moved to `Referensbilder/<today>/`, every row following) and moves the rest to the
  Trash (deleting them on a volume without one), including stills only other unused stills were made from; an
  emptied `Storyboard/` is removed. After either rewrite every sequence is told to refetch: a clip of another
  sequence may use a still of this one, and its open editor would otherwise save the old path back.
  Keyframe paths held across a wait (`setSegmentImage`, `bridgeSegment` fetching the model list) follow a rewrite
  made meanwhile.
- **Takes and trims.** Trims belong to the clip and carry over when another take is selected, except at a side the
  new take was made to meet exactly (`seamTrims`): a start made from the previous clip's last frame (or from a frame
  of the clip's own take, the opening *Gör om mellan grannarna* keeps for a first clip), an end made from the next
  clip's first frame. That side starts untrimmed, since a trim meant for another take would cut away the very frame
  the take was generated from. A cut counts as seamless when either side's take was made from the other's frame as
  it is now (`shared/seams.ts`), so a clip redone between its neighbours doesn't make the neighbour that continued
  from its old take look out of date.
- **Export.** Every clip needs a usable selected take. `buildConcatClips` turns them into `{path, start, end}`
  clips and drops one copy of every picture two clips share at a cut, judged from the takes themselves rather than
  the switches: the first frame of a continuation clip whose take was made from the previous clip's last frame
  (`repeatsPreviousFrame`; starting it half a frame in, unless a start trim already skips it), and the last frame
  of a clip whose take was made to end on the next clip's first frame (`dropsLastFrame`) unless that next clip
  already drops the picture as its own first frame; never both copies. A take made otherwise (the old take of a
  clip just set up to be redone between its neighbours) keeps its real first and last frames. `concatClips` builds one
  ffmpeg filter graph: each clip is trimmed, set to the first clip's frame rate, scaled and padded to its size,
  audio cut to exactly the frames the trim keeps (`frameSpan`: trims come in 0.1 s steps, so a cut usually falls
  between two frames, and sound running past the picture would pile up over the cuts until a frame shows twice),
  resampled to 48 kHz stereo (silence for clips without audio), then concatenated and encoded as H.264 (CRF 18) /
  AAC 192 kb/s with `+faststart`. Progress is read from `-progress pipe:1` and sent as `export:progress`. The film
  is rendered into `.studio/tmp`, moved to `Sekvenser/<name>/<name> <YYYY-MM-DD HH.MM>.mp4` and recorded in
  `exports`.

## Storyboards, keyframes and stills

The Storyboard view (`components/sequences/storyboard/`) is another way of looking at a sequence: one panel per
clip, with the clip's start and end image, its notes and its take. Nothing about it is stored apart from the
clips themselves and their stills.

- **Keyframes.** A clip's start and end image are `params.startImage` / `params.endImage`. `setSegmentImage`
  fills a slot from a picked or dropped file (copied into the sequence's `Storyboard/` as a still), a library
  photo (used where it is), a still, a frame of a take (saved as a still), or the neighbour (`previous` / `next`,
  which set the flags); `null` empties it. A clip with an image is generated image-to-video with its family's
  image-to-video model (one that takes an end image when it has one; `asKeyframed`), so its reference images and
  audio are dropped and their `@ImageN` / `@AudioN` tokens taken out of the prompt (`withoutReferenceTokens`;
  token legend lines such as "@Image1 – Anna …" go too). Duration, resolution and aspect ratio are fitted to the new
  model from the cached model list (unchanged without it); the audio setting is kept where the model allows it.
- **Gör om mellan grannarna.** `bridgeSegment` (free) sets `continue_from_previous` and `end_from_next` as the
  clip's position allows (a sequence needs at least two clips) and switches it as above, keeping its prompt (minus
  its `@` tokens), duration and audio setting. The first clip keeps its own start image, or gets the first frame
  its current take shows saved as a still; the last clip ends where it likes or on its own end image. The new take
  is generated like any other, but isn't selected automatically while the old one is usable (`autoSelect`): the
  old take stays selected until the user picks the new one (the panel offers *Använd den*), and stays among the
  takes.
- **Frame previews.** `previewSegmentFrames` returns the start and end image the clip would be generated from
  right now (the neighbours' frames, extracted and cached as above, or its own keyframes) and why it can't be
  generated as it stands, in Swedish. The panels, the clip editor's *Startbild från föregående klipp* /
  *Slutbild från nästa klipp* switches and the approval dialog all show them.
- **Stills** (`stills.ts`, table `stills`). Every picture a storyboard makes or takes in is a still with a file of
  its own (library photos are used where they are): generated (*Skapa bild…*, or an agent's approved image
  request), uploaded (a file put into a slot; the same content dropped again into the same sequence gives the same
  still) or a frame of a take (`saveFrameAsStill`: the frame a paused player shows at that moment; the same frame
  again gives the same still). A still of a sequence lives in
  `Sekvenser/<sequence>/Storyboard/`, one without a sequence (or of a sequence that has no folder yet) in
  `Referensbilder/<day>/`. Generated stills are named `<HH.MM> <prompt excerpt>.png`, frames
  `<HH.MM> Bildruta <t> s <prompt>.png`, uploads keep their own name. Placing a picture never creates a sequence
  folder that a rename just moved away: the file is linked into the folder the database names and recorded in the
  same tick as the last check of where that folder is; a paid-for picture that can't go there is kept in
  `Referensbilder/<day>/` rather than lost. Deleting a still that clips, generations or other stills
  still use moves it to `Referensbilder/<today>/` and those rows follow (`filesMoved`); otherwise it goes to the
  Trash. Still work (generating, saving, importing, deleting) counts as busy for a library switch or *Städa upp*.
  *Städa upp* puts every still back into its sequence's `Storyboard/` (or `Referensbilder/<day it was made>/`).
- **Generating a still** is paid (about $0.06 with the default Seedream models) and goes straight to Venice from
  `generateStill`: `planStill` first checks the request against the model (references only for edit models, at
  most `maxInputImages`, existing image files, the prompt length, the aspect ratio, resolution and quality the
  model has; the sequence's aspect ratio by default) and fills in what is sent, so the price shown is the price
  paid. References from outside the library are copied into `Referensbilder/<day>/` first. Without references
  `POST /image/generate` (default `seedream-v5-pro`), with them `POST /image/multi-edit` (default
  `seedream-v5-pro-edit`, the first reference is the base picture). `safe_mode` follows *Säkert läge för bilder*.
  The window shows the price on the button before anything is paid for; an agent's `request_image_generation`
  waits for the user's approval like a video.

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
  `destructiveHint`, `openWorldHint`). The 47 tools live in `tools/library.ts`, `form.ts`, `sequences.ts`,
  `storyboard.ts`, `paid.ts` and `review.ts`; [AGENTS.md](AGENTS.md#tools) lists them.
- **Same services as the window.** `recordIpcHandlers` wraps `ipcMain.handle` before any module registers its
  handlers, so `callService(channel, …args)` runs exactly the handler a window would, with every validation, busy
  check, folder move and change notification. Handlers can tell an agent's call apart with `isAgentCall(event)`
  (used to refuse clip changes during *Generera saknade*).
- **Form commands.** The Generate form lives in the renderer (`lib/generateStore.ts`), because it is what the user
  sees and edits. `FormBridge.send` posts `agent:command` (`get_form`, `set_form`, `set_references`,
  `reorder_references` or `open`, with a deadline) to the focused window, and `lib/agentBridge.ts` applies it with
  the form's own rules (mode switching, model options, the reference cap, the description switches, tokens
  following a reorder) and answers with `agent:reply`; the form state it reports includes the pictures past the
  model's limit (`unsentReferences`), which `reorder_references` can move forward (main names the references to move
  by path, so a form the user changed meanwhile still gets the pictures named, or refuses). Only the window that got the
  command may answer, and main gives up after 10 seconds ("is the window open?"). A clip's references are
  reordered in main with the same shared `reorderReferences`.
- **Approvals.** The paid tools (`tools/paid.ts`) validate the request (`request_generation` and
  `request_segment_generation` run `prepareSubmission`, so reference audio is measured before the user is asked;
  `request_generation` keeps the measured windows in the request; `request_segment_generation` and
  `request_generate_all` also refuse a clip whose neighbours' frames can't be had; `request_image_generation` runs
  `planStill`, the check and price the window's dialog uses), quote the price and create an `ApprovalPlan` in
  `ApprovalStore`: a fingerprint (an identical pending request is reused), a target (a newer request for the same
  clip replaces the older one), `verify` (refuses if the clip, the actual image and audio files or the composed
  prompt – the References legend main's `composeSubmission` appends from the assets' descriptions, which the request
  carries as `composedPrompt` / `descriptionLegend` for the dialog, or per clip as `clipLegends` for *generate all*
  – changed since)
  and `execute`. A pending request is listed with its params following files moved since (`paramsNow`:
  `followRewrites`), so the dialog shows the pictures and composes the legend from the files as they are. The window
  shows `ApprovalDialog` with the prompt, references and voices (the Dock icon bounces if Studio isn't focused); it
  composes each clip's legend as main would and disables *Godkänn* when one differs from the request's. Approving
  runs `verify`, then `execute`, which calls `video:generate` (passing the approved composed prompt, which an
  agent's call may give as its second argument), `segments:generate` or `sequences:generateAll` through
  `callService` — the latter two with a submit guard that re-checks the clip against what the user approved right
  before each take is sent. An image request (`ApprovalRequest.kind` `image`,
  with `image`: the still's params, references and target slot) runs `images:generate` and then, when it names a
  clip, `segments:setImage`; the approval records the `stillId` (and a `notice` when only the assignment failed),
  and the dialog waits for the picture (*Skapar bilden…*) and shows it. Requests expire after 30 minutes; at most
  10 can be pending; regenerating the token, switching the library or turning the connection off expires them
  all.
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
| `types.ts` | Every type that crosses the process boundary (segments with keyframes and notes, stills, image models, approval requests including image requests), the `StudioApi` interface, `NEEDS_CONSENT`. |
| `models.ts` | The three modes (`KINDS`), `DEFAULT_MODEL` per mode (Seedance 2.5 basic), `PREFERRED` options, `DEFAULT_PARAMS` (8s, 480p, 16:9, audio on), `rememberModelKinds` / `kindOfModelId`, `pickOption`, `audioForModel`, `imageToVideoVariant`, `supportsEndImage` (the models known to take an end image: ids with `first-last-frame` or `transition`, Seedance image-to-video, Kling V3/O3 image-to-video; Venice's list has no flag for it) and `endImageVariant`, `maxReferenceImages` (9, or 7 for Grok and 4 for Kling models), reference audio (`supportsAudioInput`, `maxReferenceAudios` = 3, `MIN`/`MAX_AUDIO_CLIP_SECONDS` = 2/15, `MAX_REFERENCE_AUDIO_SECONDS` = 15, `referenceAudioWindow`, `sanitizeReferenceAudios`), `paramsForSubmit` (an end image only for a model that takes one), `durationSeconds`. |
| `prompt-refs.ts` | Pure `@ImageN` and `@AudioN` logic: finding tokens and near misses (`@Image 3`, `@img3`, `@Bild3`, `@audio 1`, `@Ljud1`, `@Voice1` …), validation with issue codes (`no-references`, `out-of-range`, `over-model-limit`, `malformed`, `unused-reference`, `not-reference-mode`, and for audio `audio-out-of-range`, `audio-over-limit`, `audio-not-supported`, `audio-length`, `audio-too-long`, `unused-audio`), `validationContext`, canonicalisation, and `blockingPromptError` / `blockingContinuationError`. The editor, the submit guard and the agent tools all use it, so they agree. |
| `prompt-compose.ts` | The References legend: `composePrompt` (which described assets are among the sent references, their tokens in order, whitespace collapsed and `@` removed, proportional shortening at word boundaries within the model's limit, `truncated` / `dropped`), `composeOptionsFor`, `describedAssets`, `sanitizeDescriptionFlags` (the switches stored as absent while they have their defaults) and the remembered prompt limits (`rememberPromptLimits`, `promptLimitOf`). The editor's box, the submit, the approval dialog and the agent tools compose with it, so they show and send the same text. |
| `prompt-remap.ts` | Keeping tokens on their pictures and clips when the reference lists change: `remapPromptReferences` (any letter case, near misses including ranges and glued words, `(…)` groups, an outfit swap) and `reorderReferences` (a new order named by tokens or paths, the prompt and the negative prompt renumbered in one change), with `referenceOrder` and `referenceMoves`. The form, the bridge, the agents' clip tools, the clip editor's draft merge (an agent's reorder while the user types) and *Använd prompt* on an earlier take use it. |
| `seams.ts` | Whether a take was made from its neighbour's frame as it is now (`startsOnLastFrameOf`, `endsOnFirstFrameOf`), read from the names main gives the frames it extracts. The clip editor's and timeline's warnings and the export's dedupe both use it, so a cut the editor calls seamless is the one the export dedupes. |
| `generation-filter.ts` | The clip feed's filter and sort (`filterGenerations`, `sortGenerations`, `queryGenerations`, `summarizeGenerations`, `indexAssetPaths`), shared by the feed and the agents' `list_generations`, so both show the same clips. |
| `prompts.ts` | `titleFromBody`, the automatic title of an untitled prompt. |
