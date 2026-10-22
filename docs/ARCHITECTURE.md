# Architecture

This document describes how JIBES Studio (Studio for short) is put together: its processes, the modules in each, the data model, how files are
stored, how a generation travels from the form to a video on disk, how voices and sounds reach Venice, how sequences are
exported, given keyframes and stills, and redone between their neighbours, how storyboards turn milestone pictures into
the transitions between them, how the user's own films come in (*Own clips*), how the Editor turns a finished film into
versions with free and paid operations, how *Activity* follows what runs and what is new, how the whole library
is exported and imported, how reviews and learnings close the loop, and how the agent connection (MCP server) plugs into
all of it — with agents' uploads and their approved removals. It reflects the code in `src/`; when they disagree, the
code wins — please fix the document.

- [Processes](#processes)
- [Platforms](#platforms)
- [Module map](#module-map)
- [Data model](#data-model)
- [Stored paths](#stored-paths)
- [Export and import](#export-and-import)
- [IPC surface](#ipc-surface)
- [Jobs: from submit to saved video](#jobs-from-submit-to-saved-video)
- [Reference audio: from a file to `@AudioN`](#reference-audio-from-a-file-to-audion)
- [Sequences and export](#sequences-and-export)
- [Keyframes and stills](#keyframes-and-stills)
- [Storyboards: boards and transitions](#storyboards-boards-and-transitions)
- [Own clips](#own-clips)
- [Editor: edits and versions](#editor-edits-and-versions)
- [Status: Activity](#status-activity)
- [Voice separation helper](#voice-separation-helper)
- [Reviews and learnings](#reviews-and-learnings)
- [The agent bridge](#the-agent-bridge)
- [Claude Desktop](#claude-desktop)
- [Updates](#updates)
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

At startup (`src/main/index.ts`) main picks the profile (`STUDIO_DEV_PROFILE`, a variant's name from `variant.ts`,
`STUDIO_PROFILE_DIR`, see [DEVELOPMENT.md](DEVELOPMENT.md)), takes the single-instance lock (two instances would poll and download the same
paid jobs), registers the `media://` scheme and every IPC handler, opens the configured library
(`prepareLibrary`), creates the window and finally starts the agent connection if it is enabled. On quit it stops
the agent server, kills running ffmpeg processes (removing their partial files) and closes the database, which
folds the SQLite WAL back into `studio.db`.

## Platforms

Studio is built for macOS on Apple Silicon and for 64-bit Windows (`StudioApi.platform` tells the window which:
`'darwin' | 'win32' | 'linux'`, set by the preload from `process.platform`). Main keeps every difference behind a
platform check, so the Mac build behaves exactly as it always has; `src/main/platform.ts` holds the words and
`src/renderer/src/lib/platform.ts` the window's (shortcuts, Finder or File Explorer).

| | macOS | Windows |
| --- | --- | --- |
| ffmpeg | Homebrew's (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, then `PATH`) | Ships with the app in `resources/ffmpeg` (a pinned BtbN GPL build; `scripts/fetch-ffmpeg-win.mjs`), then a development build's `build/ffmpeg-win`, then `PATH` (`ffmpeg.exe`); spawned with `windowsHide` so no console window flashes |
| Hardware decoding | VideoToolbox for working copies and scene cuts | None: software decoding |
| Window | Hidden title bar with the traffic lights inset | The native frame, dark (`nativeTheme.themeSource = 'dark'`), no menu bar: a hidden menu (not auto-hidden, which Alt+click would bring up) keeps its shortcuts – Ctrl+0, Ctrl+Plus and Ctrl+- zoom, F11 full screen, and in development Ctrl+R and Ctrl+Shift+I |
| New and failed work | The Dock badge's number | A red dot over the taskbar button (its description has the number) |
| A new agent request | The Dock icon bounces once | The taskbar button flashes until Studio is in front |
| App identity | The bundle id | `app.setAppUserModelId` with `electron-builder.yml`'s `appId`, as the installer's shortcuts (Studio Dev: `<appId>.dev`; a variant: `<appId>.test`) |
| Voice separation | AUSoundIsolation through the Swift helper (macOS 13+) | Off, with the reason in *Settings → Tools* |
| Updates | `Studio-mac-arm64.zip`: the app bundle replaced in place, then reopened ([Updates](#updates)); *Check for Updates…* in the app menu | `Studio-win-x64-setup.exe` run silently over the installed copy; the portable zip can't update itself; *Settings → About Studio* only (the menu is hidden) |
| HEIC from agents | Converted to JPEG with `sips` | Refused with a reason; formats are said as JPG, PNG or WebP |
| Library export & import | `/usr/bin/zip`, `unzip`, `ditto` | Not available yet: both refuse with a reason (`ARCHIVE_UNAVAILABLE`) |
| Own clips on the same disk | APFS clones (from `mount`'s file system type) | Always copied |
| Tailscale | A `utun` with a /32 Tailscale IPv4 and Tailscale's IPv6 | The adapter named "Tailscale" with Tailscale's IPv6 and an IPv4 within Tailscale's range, its netmask /32 or up to /10 (`pickTailscaleInterfaces`) |
| File names | `safeName` as before | Also never a device name (`CON`, `NUL`, `COM1`, `LPT1` … — an underscore is added) and at most 80 characters, so paths stay within `MAX_PATH` |
| Words | Finder, the Trash, this Mac | File Explorer, the Recycle Bin, this PC |

Stored paths stay portable: inside the library they are relative and always written with `/` (see
[Stored paths](#stored-paths)), so a library folder can be opened on either system; `fromStoredPath` joins them with
the system's separator. `withoutLocalPaths` also strips `\`-separated folders on Windows, in either letter case. Media
reach the window as `media://local/<path>`, a Windows path written like a file URL (`/C:/…`).

## Module map

### `src/main`

| Module | Responsibility |
| --- | --- |
| `index.ts` | App entry: profiles, single-instance lock, window creation, the core IPC handlers (settings — a change of *Safe mode for images* is broadcast as `settings:change`, since Settings and the image dialogs each show it —, models, quote/generate, generations, files), wiring of the services (generations are sent with their review summary; the job manager, the sequence service and the storyboard service get the cached video model list — the job manager for the models' prompt limits — and the sequence and storyboard services the stills service's import and save-frame functions; the sequence service's change notifications go out as `sequence:change` or, for a storyboard, `storyboard:change`; storyboard runs, imports and edit jobs count as busy for a library switch; the import service and the edit service are registered with their events, `edits.resume()` runs when a library opens and both services stop on quit; `file:pickVideos` for own clips, refused for agents; deleting a generation first asks the edit service — nothing a running Editor job works on or a stopped one has paid parts for, no edit's original, no version the Editor itself would refuse to delete (its transcript goes to the versions that inherit it), and from a take list (a sequence clip's or a storyboard transition's) a version or an edit's original — or a take the list offered *Remove* for (`release`) — is only taken off the clip (`SequenceService.releaseTake`; a transition falls back on another take) —, then also trashes an import's original once no other row records it and tells the edit service, which moves an edit's current version to the parent), the background check of voice separation at start, shutdown. For *Activity* it records an `unseen` row when the job manager settles a video that isn't an edit's AI take, creates the `WorkStatus` after the services (with the agent connection's requests and uploads), lets every `broadcast` pass through `work.observe`, wires the services' change hooks (`jobs` `'sending'`, `setStillWorkListener`, the sequence and storyboard services' and the agent service's `workChanged`) to `work.touch`, resets it when a library opens and puts the number of new and failed results on the Dock icon. A library switch is also refused while an approved agent request is being carried out, and `beforeClose` stops agents' uploads (`agent.libraryClosing()`). A running library export (*Export & import*, `archiveBusyReason`) counts as busy for a switch or *Tidy up*, and `stopLibraryArchive()` runs on quit. |
| `settings.ts` | `settings.json` in the profile's `userData`: base folder, prompt language, *Safe mode for images* (on unless switched off), the spending budget (`getBudget`, `setBudget`: daily and monthly caps in USD, checked by the shared `normalizeBudget`), accepted Venice consents, agent port/on-off (default 8770, Studio Dev 8771), the daily update check (`autoUpdateCheck`, on unless switched off) and when Studio last checked (`lastUpdateCheck`), `isDevelopmentBuild` (Studio Dev, a variant or any unpackaged build: never checks) and `updateTestServer` (tests only); the Venice API key and the agent token encrypted with `safeStorage`. |
| `images.ts` | Venice image client for stills: text-to-image models from `/models?type=image` (background removers and upscalers left out) and edit models that combine references from `/models?type=inpaint` (only those with `combineImages`; `maxInputImages` 3 when the list doesn't say), cached for 10 minutes; prices from `model_spec.pricing` (per quality, per resolution or flat, plus `inputImages.additional` per extra reference); the `/image/generate` and `/image/multi-edit` bodies (references as data URLs within Venice's input limits, decoded as Studio shows them by `input-image.ts`, base first; models without an aspect-ratio list get width/height), safe mode from settings, and user-facing errors (402 balance, 4xx detail, the `x-venice-is-content-violation` header, a 4-minute limit after which the picture may still have been charged). Paid requests are never retried. |
| `stills.ts` | Stills: rows, `planStill` (model, references, options and price checked before anything is paid for; also what an agent's image approval shows; a storyboard's aspect ratio is the default format), generating (`images:generate`, checked against the budget with its price before anything is sent; the pictures in flight by their `workToken` — `activeStills`, `setStillWorkListener`, a per-model median of how long a picture takes — and an `unseen` row for a picture made or one that failed after its request went out, so a failure after its dialog closed isn't lost), `stills:import` (agents only: an uploaded or recorded file, `assertAgentFiles`), saving the frame a paused player shows (`stills:saveFrame`), importing dropped files (deduplicated by content), placement in `Sekvenser/<sequence>/Storyboard/`, `Storyboards/<storyboard>/Bilder/` or `Referensbilder/<day>/` (safe against a folder renamed or deleted meanwhile), deleting (a still other rows or boards use is kept in `Referensbilder`), the still-work busy state, and the `images:*` and `stills:*` handlers. A paid picture that can't be saved in the library is written to the user's Downloads folder instead (its path is in the error). |
| `venice.ts` | Venice API client (`/models` incl. `audio_input` and `video_input` — video-input models get kind `video-to-video` —, `/api_keys/rate_limits`, `/video/quote`, `/video/queue`, `/video/retrieve`, `/video/complete`; a fetched model list is remembered by the shared `rememberModelKinds` and `rememberPromptLimits`; `listRawModels(type)` for the audio lists), request bodies (images become downscaled JPEG data URLs, decoded by `input-image.ts`; each reference audio window becomes an MP3 data URL of whole frames, 2–15 s each and 15 s in all; for the Editor's picture operations the source clip as `video_url`, Seedance's video to edit as `reference_video_urls` with `omni_reference_task_type`; reference videos (Generate, clips) as the proxies of their windows from `reference-videos.ts`, with the prompts' `@VideoN` written `<Video N>` and `omni_reference_task_type: "reference"` on Seedance 2.5 only; the quote's `reference_video_total_duration` is the sent windows' total, Topaz upscales as `{model, video_url, upscale_factor, duration}` only, every video file read only from inside the library and refused above 22 MB of media per request), quotes for video-input models with a few-KB stand-in clip of the same length (cached 10 minutes; Topaz needs the key), measuring reference audio (`resolveReferenceAudios`), `VeniceError` / `NetworkError`. |
| `directors.ts` | Directors as main sends with them: `libraryDirector` (an id resolved against the open library or the ready-made ones), `directParams` (params directed by their `director`, shared `withDirection`), `checkedDirectorId`, `allDirectors` and `defaultsOnChoosing`. `prepareSubmission`, `composeSubmission`, `video:quote`, `takeParams`, stills and the agent tools all go through it. |
| `jobs.ts` | `JobManager`: the submits on their way to Venice (`sending()`, a `'sending'` event) and what a model's videos usually take (`typicalMs`, the median of its last 20, cached 10 minutes), for *Activity*; the guard in front of every paid submission (`prepareSubmission`: `@ImageN`/`@AudioN`/`@VideoN` checks, canonical tokens, audio clips and reference videos measured), composing the prompt that is sent (`composeSubmission`: the References legend of the referenced assets' descriptions, read from the database at that moment and fitted into the model's prompt limit) and storing it as `sent_prompt`, queueing at Venice, polling with backoff, saving videos into the library (a take into its sequence's `Tagningar/` or its storyboard's `Övergångar/`, an AI take of an edit into its `Redigeringar/<edit>/Tagningar/`), posters and durations, resuming pending jobs (only Venice generations, `source = 'generated'`) and backfilling missing posters. `videoHome` / `videoLocation` (and `originalHome` for an import's original) are the [file home rule](#the-file-home-rule) every service and *Tidy up* use. |
| `db.ts` | The SQLite connection (WAL, foreign keys), the migrations, generation rows (with `source`, `title`, `parent_id`, `edit_id`, `recipe` and `original_path`), `addUnseen` (a row of `unseen`: one item id, or an error and a label; never throws), and stored-path maintenance (board images, imports' originals, edit media, the source and reference videos in params and directors' style videos in `assets.direction` included): prefix rewrites, relativizing, "is this path recorded" checks. |
| `paths.ts` | Folder layout constants (`FOLDERS` with `Produkter`, `Regissörer`, `Egna klipp` and `Redigeringar`, `ASSET_FOLDERS` per kind, `agentUploadsDir` — `.studio/tmp/agent-uploads`, where agents' uploads are staged —, `APP_DATA` with the stem, edit-job and timeline caches, `TAKES_FOLDER`, `STORYBOARD_FOLDER`, `TRANSITIONS_FOLDER`, `BOARD_IMAGES_FOLDER`, `EDIT_FOLDERS` — an edit's `Tagningar`, `Ljud` and `Underlag` —, and `KIND_FOLDERS`: where a sequence and a storyboard keep their takes and stills), conversion between absolute and stored paths, Finder-safe names, unique names, verified moves and renames, the "base folder is still there" check and the library-wide operation lock. |
| `library-root.ts` | The base folder's lifecycle: opening it at startup, status, choosing/inspecting/switching (`move`, `open`, `new`), converting an earlier layout, refusing a library from before a folder existed whose base folder holds a folder of the user's own by that name (`Miljöer`, `Kläder` from schema 6, `Poser` from 7, `Storyboards` from 10, `Egna klipp` and `Redigeringar` from 11, `Produkter` from 12, `Regissörer` from 14), *Tidy up* (reorganize, asset photos and audio clips, directors' style videos, stills, storyboards' takes, pictures and exports, imports with their originals, edit versions, AI takes and edit media included, by the file home rule), revealing folders in Finder (a sequence's, a storyboard's or an edit's own folder by id). |
| `library-archive.ts` | *Export & import*, the whole library to one zip and back (see [Export and import](#export-and-import)). Export: a `db.backup()` copy of the database (made self-contained with a rollback journal), the library's own folders listed — the live database files, the `.studio` caches and Finder's files left out; a cached file a stored path uses besides a generation's own poster (a frame a take was started from) kept; links skipped — packed by `/usr/bin/zip -g -0 -nw -@` into `<name>.zip.part` with progress from its size, `studio-archive.json` last (format, versions, schema, counts, rows per table, files and bytes), renamed when complete. Import: the manifest and the listing checked (a Studio export, not from a newer Studio, no `..` or links), the destination new or empty and outside the open library's folders, `ditto -x -k` into `<name> (importeras)` beside it, the files counted against the zip, `integrity_check` and the rows per table, renamed into place and opened with `setLibraryRoot(…, 'open')`. One job at a time, `archive:cancel`, `stopLibraryArchive` on quit, `archiveBusyReason` for a running export; agents' calls are refused. |
| `library.ts` | The prompt library (CRUD, tags, favourites, usage) and registration of the asset and prompt IPC handlers (`assets:addImages` / `assets:addAudio` check an agent's files with `assertAgentFiles` and record its `origin`). |
| `upload-paths.ts` | `assertAgentFiles(e, paths)`: for an agent's call every path must be a regular file whose real path lies inside the real staging folder (`agentUploadsDir`), or a file the library records in its own folders with no symlink leading out; a window's call (and `callApproved`'s) passes. `isAgentFileAllowed`, `AGENT_FILES_REFUSED`. |
| `work.ts` | *Activity*: `WorkStatus` builds one `WorkSummary` from the services' registries and the `unseen` table and pushes it as `work:change` (see [Status](#status-activity)); `buildWorkSummary` is pure (the session's start is one of its inputs); `registerWorkIpc` (`work:summary`, and the user-only `work:markSeen`, `work:markAllSeen`, `work:undoSeen`). |
| `spending.ts` | *Spending*: what the library records as paid, per local day, kind, place and who asked (`spendingSummary`, `spending:get`), and `spentSoFar` (today, this month and what is on its way) for the budget check. Counts completed Venice generations at their quote (an Editor take is the edit's), generated stills at their cost and `media_jobs.cost` of the Editor's sound jobs, transcriptions and voice designs (never a picture operation's job, whose take is the generation); failed generations, edit media and transcripts (copies of their job's cost) count nothing. Pending: generations at Venice and the rest of a running job's quote. Registers `settings:setBudget` (user only). |
| `budget.ts` | The budget check every paid path calls before it sends anything: `assertWithinBudget(amount, {confirmed})` throws `OVER_BUDGET:<OverBudget JSON>` when today's or this month's spending plus what is on its way plus `amount` passes a cap (`overBudgetFor` in the shared `budget.ts`), unless confirmed or inside `runConfirmed`; `assertRunWithinBudget` (a *Generate missing* run, priced with `quoteTotal` only when there is a cap), `confirmedOf` (a call's `{confirmOverBudget}`), `overBudgetNow` (for an agent's request). |
| `requested-by.ts` | Paid work the user has already said yes to: `runConfirmed(fn, agent?)` runs `fn` in an `AsyncLocalStorage` context that the budget check honours, also for what it starts later (a run's loop, an Editor job); an approved agent request runs in one named after its agent. Paid rows made inside one (`db.insertGeneration` for Venice generations, `insertStill` for generated stills, `insertJob` for Editor jobs and voice designs) are noted in the library's ledger, `.studio/requested-by.json` (`noteRequestedBy`, `requestedByLedger`), which *Spending* reads for who asked. |
| `variants.ts` | Several variants of one generation (`GenerateOptions.count`): `sendOptionsOf` checks a call's options (and picks up an in-process `onSent` listener), `sendVariants` sends them one after another – the first alone, so a consent or refusal comes back with nothing sent – and `partlySentText` says how many were sent when a later one fails. Used by `video:generate`, the sequence takes and the storyboard transitions. |
| `session.ts` | This session: `SESSION_STARTED_AT`, taken when main starts (closing the window keeps it; quitting ends it), the Generate clips still on their way when a library opened in it (`noteCarriedOver`, from `JobManager.resume`), `currentSession()`, and the `app:session` handler that gives it to the window. Generate's list, the work summary and `list_generations({session: true})` read it with the shared `session.ts` rule. |
| `assets.ts` | Characters, environments, products, outfits, poses and directors (a director's `direction` JSON with its style videos copied into `Regissörer/<name>/` and fitted to 2–15 s windows, `copyDirectorPreset`, `addDirectorVideos`; a style video left out goes to the Trash unless something else records it; deleting a director clears the `director` of the sequences, storyboards and clips it directed) : rows, one folder per asset with copies of its photos (and, for characters and environments, audio clips probed with ffprobe, each with a clamped reference window) and `Beskrivning.txt`, renames that move the folder, deletes to the Trash (a photo or clip that generations still use is kept in `Referensbilder`), default outfits, `describedAssetsFor` (the described assets behind a set of params' files, straight from the database, for composing the prompt), a voice clip's clone consent (`setVoiceCloneConsent`, `AssetAudio.cloneConsent`; set only by the user), `addGeneratedAudio` (a designed voice saved as a new voice clip, recorded as unseen) and the `origin` of photos and clips an agent added (`{agent, host?, at}`, the host only, never a URL). |
| `input-image.ts` | Decodes a picture for Venice (and for agents) the way Studio's views show it: a JPEG turned upright by its EXIF orientation (`nativeImage` ignores it, so a portrait phone photo would be sent sideways and an image-to-video take come out rotated), a WebP (which `nativeImage` can't read) decoded by ffmpeg (`stillToPng`), so both get the usual size limits. |
| `reference-videos.ts` | Reference videos on their way to Venice (see [Reference videos](#reference-videos-from-a-file-to-videon)): `resolveReferenceVideos` (each file probed, its window filled in), `referenceVideoSeconds` (the quote's total), `referenceVideoProxy` (the window cut to a small H.264/AAC MP4 by `ffmpeg.makeReferenceVideoProxy`, cached in `.studio/tmp/referensvideor/` by the file's identity and the window, pruned to 400 MB) and `probeReferenceVideo` (`referenceVideos:probe`: length, size, sound and a poster for the window). |
| `references.ts` | Copies start/end/reference images, reference audio and reference videos from outside the library into `Referensbilder/<day>/` (deduplicated by content hash; a video cloned on the library's volume; `importReferenceFile` for an agent's video upload), `referencedFiles` (every file a set of params points at, the source and reference videos included) and the shared `placeFile` / `copyInto` / `cloneInto` helpers that write via the scratch folder (`cloneInto`: an APFS clone on the library's volume, else a streamed copy with progress that can be stopped). |
| `reviews.ts` | The user's and agents' reviews of generations (`attachReviewSummary` puts the user's rating — thumbs down or 1–3 stars — and the review count on generations), learnings, the list of exported films (with their recorded `cuts`, and `sequenceKind` — whether they came from a sequence or a storyboard), and their IPC handlers (an agent writes under its own name and may only change its own). |
| `sequences.ts` | `SequenceService`: sequences and clips (reference audio included), how a continuing clip's take is sent (`chainOf`, `takeParams`, `continuationAt` over the shared `continuation.ts`; the previous clip's last frame appended as the last reference image in reference mode), the prompt a take sends (`composeClipPrompt`, `composeTakePrompt` with a continuation's lead-in; a take composes it together with the clip read and the approval guard), keyframes (`setSegmentImage`), *Redo between neighbours* (`bridgeSegment`), frame previews, takes, the neighbours' frames (continuation and end frames), *Generate missing* runs in dependency order, keeping sequence and storyboard folders (with their `Storyboard/`, `Övergångar/` and `Bilder/`) in step with names, deleting a sequence with its stills, export, and the sequence IPC handlers, which refuse storyboards and their transitions. It also runs a storyboard's transitions, which are segments: `createRow` (a sequence or storyboard row with its folder), takes and their placement (by the file home rule, so own clips and versions never move into `Tagningar`), `freeTakes`, `copyTake` (for turning a storyboard into a sequence), a submit that can be called off (`cancelled`, `isCancelledSubmit`) and the export with the storyboard rule. For own clips and the Editor: `insertSegment` (a new clip from an existing finished video, with the previous clip's settings as its template), `addTakeFrom` (a video as a selected take of a clip; one that is another clip's take is copied as an APFS clone), the *Export format* (`export_height`) and the missing-own-film message. For *Activity*: `activeWork()` (takes on their way, runs with how far they are (clip 2 of 5), exports with their progress), `workChanged` when one starts or stops, and an `unseen` row for a placed export, an export that failed while rendering and a run that stopped on a problem (not one the user stopped). A keyframe file from an agent passes `assertAgentFiles`. |
| `storyboards.ts` | `StoryboardService`: storyboards, their boards (one picture each, from a library photo, a still, a file or a frame), the transitions between neighbouring boards kept in step by `syncTransitions`, the transitions' settings and problems, *Generate missing* for transitions (`activeRuns()`, a run's failure recorded as unseen), the export and the conversion to a sequence (both through the sequence service), picture sizes for the format warning (`imageSize`), `moveLoss` (what a board move would remove, read-only: `boards:moveLoss`), the refusal of an agent's board added in between or moved when a transition with a prompt, a negative prompt or takes would go (checked inside the change's transaction), and the `storyboards:*`, `boards:*` and `transitions:*` handlers (`registerStoryboardIpc`; a board picture file from an agent passes `assertAgentFiles`). |
| `inherited-swap.ts` | A swap in place in the clip a continuation carries its references from (`swappedInPlace`: as many pictures and clips, every changed one gone from the list): the inheriting clips keep their tokens, and only the name in front of a fully swapped group follows (`followSwap`, the shared `renameReferenceNames`). Used by `SequenceService.keepInheritedTokens`. |
| `sequence-store.ts` | Row access and assembly for sequences (with their `kind`), segments (notes, `endFromNext`, `continueMode`, the description switches and a transition's boards included) and stills, the refusals between kinds (`requirePlainSequence`, `requirePlainSegment`), take selection (`seamTrims`: a side the new take was made to meet exactly starts untrimmed; per-take trims in `take_trims`: `rememberTrims`, `trimsFor`, `forgetTrims`) and trim clamping, folder and file naming per kind, the *Export format* helpers and `recordExport` with the export's cut times (it returns the export's id). |
| `sequence-export.ts` | Turns the selected, trimmed takes into ffmpeg concat clips (dropping the duplicated picture where a take was made from its neighbour's frame: `repeatsPreviousFrame`, `dropsLastFrame`; for a storyboard `buildStoryboardClips` with `repeatsBoardImage`), the cut times of the film it makes (`exportCuts`, recorded in `exports.cuts` for the Editor's cut markers: worked out on the film's own frame grid, so clips of other frame rates land where concat puts them) and reserves the export's file name. |
| `song.ts` | `SongService` and the `songs:*` handlers but `songs:syncTake` (`registerSongIpc`): *New sequence from a song…* and a sequence's song — copied into `Sekvenser/<name>/Ljud/` through the sequence service's file queue (`placeSongFile`), its vocals separated, its lyrics transcribed (priced first, the budget applies, recorded as a `media_jobs` row), analysed and split into clips, one step after another per sequence in the background (`songWork`, `songError`, Activity's `song` items, busy for a library switch); lyric lines corrected by hand. See [Songs: data, analysis, lyrics](#songs-data-analysis-lyrics). |
| `song-analysis.ts` | A song's peaks, beat, bars and vocal activity (onset envelope, tempo by autocorrelation, Ellis's beat tracker, bar accents, a loudness threshold on the vocals), cached in `.studio/tidslinje` by the files' identity (`analyseSong`, `cachedSongAnalysis`). |
| `ffmpeg.ts` | Finds `ffmpeg`/`ffprobe`, probes videos and audio files (decoding when the header only estimates the length), extracts frames (the frame showing at a moment, and the first frame at or after a start trim: `extractFrameAtOrAfter`, `frameStartAtOrAfter`) and posters, decodes still pictures to PNG (`stillToPng`), cuts reference audio windows to mono MP3 (`encodeAudioClip`) and reference video windows to small MP4s (`makeReferenceVideoProxy`: ≤ 720 on the short side and 1280 on the long, ≤ 30 fps, H.264 CRF 23 capped at 1.6 Mb/s, AAC 128k, upright, square pixels, BT.709 with HDR tone-mapped, no metadata, never longer than the window; `REFERENCE_PROXY`), JPEG frames and sound previews for agents' reviews (`extractFrames`, `extractAudioPreview`), renders the concat export (at the sequence's *Export format* height), and kills/cleans up running processes on quit. For own clips and the Editor: `probeMedia` (HDR, bit depth, rotation, variable frame rate, every audio stream and whether it decodes), `normalizeVideo` (the working copy: tone-mapped H.264 SDR, ≤1080p, constant frame rate, upright, square pixels, picture and sound both from the file's time zero, mono at full level on both sides, metadata stripped), `makeProxy` and `makeStandIn` (what a picture operation sends, and the stand-in its free quote uses), sample-exact audio (`extractAudio`, `encodeUpload`, `silences`, `loudness`, `timeStretch`, `renderMix` — the layered mix with gain envelopes, ducking, noise reduction and loudness —, `assembleAt`, `replaceAudioTrack`) and pictures (`spliceVideo`, frame-exact, and the timeline's `waveform` — placed by time over the film's length —, `filmstrip` and `sceneCuts`). The concat export upmixes mono at full level too. Partial files of every kind (`.part.mp4`, `.part.wav` …) are cleaned up. |
| `media-protocol.ts` | The `media://` scheme (video — `.mp4`, `.mov`, `.m4v`, `.webm`, `.mkv` —, image and audio types). A Windows path arrives the way a file URL writes it (`/C:/…`, `//server/share/…`) and `mediaFilePath` turns it back. |
| `variant.ts` | Which variant this build is (`VARIANT`: "Test" for Studio Test, put in at build time as `__STUDIO_VARIANT__` from `STUDIO_VARIANT`, which `scripts/app-variant.mjs` sets; '' for Studio) and the name people see (`PUBLIC_NAME`: "JIBES Studio", "JIBES Studio Test") in the macOS menu, the About panel and the agent connection. A variant gets its own app name and `userData` (index.ts), never checks for updates (settings.ts), and its Claude Desktop extension its own name (`studio-test`). |
| `platform.ts` | What differs by operating system in main's words: `IS_MAC`, `IS_WINDOWS`, `FILE_MANAGER` (Finder / File Explorer), `TRASH` (the Trash / the Recycle Bin), `THIS_COMPUTER` and `USERS_COMPUTER` (this Mac / this PC), used in messages, approval effects and the agent guide. See [Platforms](#platforms). |
| `taskbar.ts` | Windows' stand-ins for the Dock: the count of new and failed work as a red dot over the taskbar button (`setTaskbarBadge`, drawn as a PNG in code), and a flashing taskbar button for a new agent request (`flashTaskbar`). |
| `updates.ts` | Updates from GitHub Releases (see [Updates](#updates)): semver (`parseVersion`, `compareVersions`, `isNewer`), the release as the API gives it, checked (`parseRelease`, `githubSource`'s URL rules), this computer's file (`assetNameFor`, `pickAsset`), the download (`downloadFile`, redirects only to GitHub's asset host), the checksum (`expectedSha256`: the asset's `digest`, else `SHA256SUMS.txt`; `verifyChecksum`), macOS' bundle swap (`installMacUpdate`, `relaunchWhenQuit`, `macInstallBlocked`), Windows' installer, the daily check (`startUpdateChecks`, `dailyCheckDue`), *Check for Updates…* (`checkForUpdatesFromMenu`) and the window's calls (`registerUpdateIpc`: `updates:check`, `updates:install`, `settings:setAutoUpdateCheck`, never an agent's). |
| `imports.ts` | Own clips, from the window or an agent's video uploads (both handlers check an agent's files with `assertAgentFiles`), with `active()` for *Activity*: `imports:inspect` (probes every file, says whether it can be cloned — on the library's volume and that volume APFS, read from `mount` — and why a working copy is needed, finds an earlier import of the same file by size and SHA-256), `imports:import` (copy or APFS clone through the scratch folder into `Egna klipp/<day>/`, a working copy when needed or when cropping to the sequence's shape, poster, a completed `source = 'import'` row; into the feed, as new clips of a sequence or as a take of a clip; a disk-space check; *Cancel* leaves nothing behind) and `imports:cancel` (one file by path — its card's *Cancel*, the others go on — or every import), with `import:progress` events. |
| `edits.ts` | The Editor's service and its `edits:*`, `audio:*` and `voices:*` handlers (`registerEditIpc`): edits (from a generation used where it is, or an export cloned in as v1), renaming (folder and version titles follow), versions (current, delete, prune with a dry run), the timeline (filmstrip, waveform and cut markers, cached in `.studio/tidslinje` up to 512 MB), transcripts (inherited along versions with the same timing, SRT through a save dialog), added audio, sending a version to a sequence, deleting an edit by the rules below (`deleteRefusal`, the side-effect-free check, is also `edits:deleteRefusal` for agents' removal plans), the busy state, `resume()` at library open and `onGenerationDeleted`. The user-only handlers refuse agents; an agent may run `edits:prune` as a dry run and add audio files it uploaded (`assertAgentFiles`). `EditSummary.running` covers free renders too. |
| `edit-ops.ts` | The Editor's operations: the plan (the single check for the window and agents: snapped range, defaults, price from Venice's free quotes or the published prices, notes, warnings, problems, a fingerprint), free renders (one at a time), paid audio jobs made of steps (written before they are sent, at most three in flight, polled with backoff, never resent; continuing a stopped job quotes again), picture operations through the job manager (frames, proxies in `Underlag/` sized to leave room for the pictures sent with them, the take spliced in when it settles, a failed finish done again for free when the job is continued) and voice design; a paid run, a continued job and a voice design are checked against the budget with their price first (`OVER_BUDGET` unless `confirmOverBudget`) and run inside `runConfirmed`; `activeWork()` (paid jobs and free renders, `liveRenders`) and an `unseen` row for a version a paid job made. |
| `edit-store.ts` | Persistence for the Editor: `edits`, versions (generations with `source = 'edit'`), `edit_media`, `media_jobs` and `media_job_steps`, `transcripts` and `voice_clones`; a paid job or voice design that fails is recorded as unseen. |
| `edit-mix.ts` | The layered sound of a version (`AudioMix`: a bed — v1's sound or a rendered bake —, optional voice and background stems, gain spans and layers of edit media) resolved to files for `renderMix`, and the stem cache in `.studio/stammar` (4 GB, least recently used first, pruned when a library opens). |
| `venice-audio.ts` | `VeniceAudio`: the audio model lists (`/models?type=` `tts`, `music` and `asr`, classified into speech, music, effects, transcription, voice changers and voice design), free quotes (`/audio/quote`, `/audio/voice-changer/quote`, whole seconds, cached), and the paid endpoints — voice changer (multipart), `/audio/speech`, `/audio/voices` (cloning), `/audio/transcriptions` (with `timestamps=true`), `/audio/queue` — sent once and never retried, with optional fields only where the model allows them and errors that keep the HTTP status. |
| `voice-separation.ts` | Finds and probes the `studio-voice-isolate` helper (`separationStatus`, with the reason when it is missing) and separates a film's sound into voice and background stems (`separateStems`: refused when its scratch WAVs won't fit on the disk, the helper stopped by a watchdog when its progress stalls or it runs far past the sound's length). |
| `audio-align.ts` | Puts a converted voice chunk back on the exact sample it came from (`estimateOffsetSamples` from loudness envelopes, `alignTo` with crossfades at cuts inside speech). |
| `agent/index.ts` | Public entry of the agent connection. |
| `agent/service.ts` | `AgentService`: on/off, port, token, following the Tailscale address, status for the UI, one MCP server per client session, the shared `UploadStore` (`uploads`, expired on a token change, a library switch or move — `libraryClosing()`, `libraryOpened()` — and when the connection stops), and the `workChanged` option the approval and upload stores report to. |
| `agent/server.ts` | The HTTP server: peer, `Origin` and bearer checks, body limits (an `/mcp` body must arrive within 60 s; no server-wide request timeout), MCP Streamable HTTP sessions and their lifecycle, the protocol version each session speaks (audio content needs 2025-03-26), the address each session reached Studio at (`baseUrl`, for an upload's `put_url`) and `PUT /uploads/<id>` (see [the agent bridge](#the-agent-bridge)). |
| `agent/uploads.ts` | `UploadStore`: agents' uploads by URL, `PUT` or inline base64, staged in `.studio/tmp/agent-uploads/<id>/` under the agent's file name with the sniffed extension; limits (16 live, 8 GB staged, 2 GB free on the disk — what transfers still have to write counted, a `PUT`'s size only while it is sent or for five minutes after its begin, checked again before a `PUT` is read and as a URL download arrives —, 2 h once ready, 30 min without bytes, not counting a URL upload's wait for a fetch slot), `assertRoom`, `resolve(id, kind)`, `expireAll`, `active()` for *Activity*. |
| `agent/upload-check.ts` | What an upload is, from its bytes (JPEG, PNG, WebP, HEIC; MP3, WAV, AIFF, FLAC, OGG, AAC, MP4 audio; MP4/MOV, WebM, MKV), the caps, picture dimensions before any decoder runs, HEIC → JPEG with `sips`, and the checks (a picture decodes, a sound has sound, a video passes the own-clip inspection). |
| `agent/fetch-url.ts` | Fetching an upload's URL with Node `http`/`https`: DNS resolved once and the checked address connected to, public addresses only plus the agent's own machine (not Studio's port), at most 3 redirects each checked again, no https → http, status 200 only, size and time caps. |
| `agent/network.ts` | Loopback and Tailscale address detection, the peer allow-list, MagicDNS lookup through Tailscale's resolver. |
| `agent/approvals.ts` | `ApprovalStore`: requests waiting for the user's decision — paid ones (generations — clips, transitions, *generate all* of a sequence or a storyboard —, kind `image` for stills, `edit` for the Editor's paid operations or resuming a stopped job, `voice-design` for a designed voice) and `delete` (removals, with each item's outcome once approved); `executing()` and `onExecuting` (requests being carried out, for the status summary and the library-switch refusal), `check(id)` (the delete dialog's live check) and `findPending`. An approved request is carried out inside `runConfirmed` with its agent's name: the user's OK is their yes to the budget too, and what it pays for is noted as that agent's. |
| `agent/activity.ts` | The activity log of tool calls shown in the app (ring of 200 entries). |
| `agent/bridge.ts` | `FormBridge`: main ↔ renderer commands for the Generate form (`WindowCommand`: the shared `AgentFormCommand` and `swap_reference`). |
| `agent/local-ipc.ts` | Records the `ipcMain` handlers so agent tools call exactly the services the window calls (`callService`, `isAgentCall`), and `callApproved`: the same handlers with the user's authority, used only by an approved removal. |
| `agent/ipc.ts` | IPC handlers for the agent settings, the activity drawer and the approval dialog (`agent:verifyApproval` among them); all of them refuse an agent's call. |
| `agent/guide.ts` | The MCP server instructions, the Studio guide and the prompt-writing guide for agents. |
| `agent/images.ts` | Photos and posters as MCP image content (JPEG, at most 768 px), with a small cache, and the MCP image and audio content blocks for the JPEG frames and MP3s ffmpeg makes. |
| `agent/media.ts` | Video frames, a clip's sound and reference audio windows as MCP image and audio content for the review tools (through `ffmpeg.ts`). |
| `agent/studio.ts` | Helpers shared by the tools: asset index (photos and audio clips), still index, `@ImageN` and `@AudioN` token maps, model and option checks, prompt problems, and the composed prompt with its description entries (`descriptionInfo`, through main's `composeSubmission`). |
| `agent/storyboard-rows.ts` | Synchronous answers about storyboards for the tools and the submit guards: which kind an id is, a board's storyboard and place, the two boards a transition joins, and the pointer from a sequence tool to the storyboard tools. |
| `agent/reorder.ts` | `reorder_references`: reading the new order an agent names (tokens, photo or clip ids, asset ids), which tokens moved, and the pictures past the model's limit; `referencesAnswer`, the answer `reorder_references` and `swap_reference` share. |
| `agent/swap.ts` | `swap_reference`: reading the place and the new picture an agent names (`planSwap`; an upload is made a still last), the shared swap applied (`applySwap`), what the window is sent (`swapArgs`), which tokens show something else now (`swappedTokens`), and the notes and activity-log summary. |
| `agent/tools/*.ts` | The MCP tools (`library.ts` with photos and sound for assets and prompt updates, `form.ts`, `sequences.ts` with keyframes, notes, trims, the sequence's settings, export and stopping a run, `stills.ts` for stills, image models, frame previews, bridging and importing pictures, `storyboards.ts` for storyboards, boards and transitions, `paid.ts` with the image, transition and storyboard requests, `editor.ts` for the Editor's read and free tools, `editor-paid.ts` for `request_edit_operation` (also resuming a stopped job) and `request_voice_design`, `song.ts` for a sequence cut to a song (`create_sequence_from_song`, `suggest_song_sections`, `set_song_sections`, `edit_song_lyrics`, `request_song_lyrics`), `edit-input.ts` for the operation input and its one converter, `review.ts` for reviewing clips, films and sequences, reviews and learnings, `uploads.ts` for uploads, `imports.ts` for importing own clips, `delete.ts` for `request_delete` — planning, verify and execute —, `work.ts` for `get_work_status`, `spending.ts` for `get_spending` and `overBudgetAnswer` — the `over_budget` and `budget_note` of a paid request's answer —, and `sources.ts`, the shared upload, URL and picture sources), the `defineTool` frame (`kit.ts`, image and audio content, older clients get a note instead of audio; `ToolContext` with the uploads and the session's peer and address) and registration of the tools, the `write_video_prompt` prompt and the `studio://guide` resource (`index.ts`). |
| `claude-desktop.ts` | Studio in Claude Desktop (see [Claude Desktop](#claude-desktop)): `claude:status` (`findClaudeDesktop`: `Claude.app` in `/Applications` or `~/Applications`; on Windows `%LOCALAPPDATA%\AnthropicClaude\claude.exe` or the Microsoft Store package's `%LOCALAPPDATA%\Packages\Claude_<publisher>` folder; only looks) and `claude:addExtension` (`addToClaudeDesktop`: the agent URL for an address Studio listens on — `agentUrl` —, the extension made by `makeExtension` from the app's `mcpb` resources with the address and the current token as the settings' defaults (a variant's with its own name, `personalizedManifest`), zipped by `zipFiles` (deflate with `zlib`, Unix modes, no external zip), then opened with Claude Desktop — `open -a` on macOS, `shell.openPath` on Windows — from a private temp folder deleted after 15 minutes or on quit, or saved where the user chooses). Both handlers refuse an agent's call. |

### `native/`, `src/mcpb/` and `scripts/`

| Module | Responsibility |
| --- | --- |
| `native/voice-isolate/main.swift` | `studio-voice-isolate`, a small command-line helper around macOS's AUSoundIsolation audio unit: `--probe` answers `{ok, hq, latency}`; `<in.wav> <voice.wav> <background.wav>` writes both stems at the input's rate and length, latency-compensated, with background = input − voice, and prints `progress=…` lines. See [Voice separation helper](#voice-separation-helper). |
| `scripts/fetch-ffmpeg-win.mjs` | The ffmpeg the Windows app ships: one pinned BtbN GPL build of FFmpeg's release branch (shared libraries), checked against its SHA-256, unpacked into `build/ffmpeg-win/` with FFmpeg's licence and `SOURCE.txt`; `--check` runs it on Windows and fails unless it has every encoder, muxer and filter Studio uses. See [DEVELOPMENT.md](DEVELOPMENT.md#windows). |
| `scripts/smoke-test.mjs` | Starts a built app with a throwaway profile and checks over the DevTools protocol that it shows Studio, finds ffmpeg (with `--bundled-ffmpeg` the app's own), opens a new library and renders Settings; the release workflow runs it on the Windows build. |
| `scripts/build-helpers.mjs` | `npm run build:helpers` (also run first by `dev`, `dev:real`, `build` and `app`): builds the Claude Desktop extension's parts (`build-mcpb.mjs`, every time, on every system), then compiles the Swift helper with `xcrun --sdk macosx swiftc` into `build/bin/` (gitignored), signs it ad hoc, and skips it when a stamp says it is up to date, when `STUDIO_SKIP_HELPERS=1`, or with a note when there is no Swift compiler (`--force` rebuilds). |
| `scripts/build-mcpb.mjs` | The Claude Desktop extension's parts in `build/mcpb/` (gitignored; shipped as the app's `mcpb` resources on both systems): `src/mcpb/bridge.ts` bundled by esbuild with the MCP SDK into one CommonJS file for Node 18+ (`server/index.js`, Studio's version put in), the licences of the bundled packages (`server/LICENSES.txt`), the manifest template with Studio's version and author (and its links when `package.json` names the repository) and `build/icon.png`. Run by `build:helpers` and by the release workflow's Windows job. |
| `src/mcpb/bridge.ts` | The extension's stdio → Streamable HTTP bridge, run by Claude Desktop's Node (see [Claude Desktop](#claude-desktop)). |
| `src/mcpb/manifest.json` | The extension's manifest template ([MCPB](https://github.com/modelcontextprotocol/mcpb) manifest version 0.3): a `node` server started as `node ${__dirname}/server/index.js`, `STUDIO_URL` and `STUDIO_TOKEN` from the two `user_config` settings, a few of Studio's tools with `tools_generated`, macOS and Windows. |

### `src/preload`

| Module | Responsibility |
| --- | --- |
| `index.ts` | Implements `StudioApi` on top of `ipcRenderer` and exposes it as `window.studio`. |
| `index.d.ts` | Declares `window.studio` for the renderer's type checking. |

### `src/renderer/src`

| Module | Responsibility |
| --- | --- |
| `main.tsx`, `App.tsx` | Entry and root component: the library gate (setup screen until a base folder is open), the views, the agent feed, bridge and approval dialog, the work feed (`startWorkFeed`) and its *Undo* toast, the sidebar's collapsed state (`--sidebar-w`, ⌃⌘S caught on the window in the capture phase, remembered in `sidebar:collapsed:v1`), one panel at a time (the agent drawer or *Activity*; the agent pill hides while either is open), the ⌘K palette (`CommandPalette`) and `@container/main` on `<main>`. |
| `styles.css` | Tailwind CSS v4 import and theme tokens (`bg`, `panel`, `raised`, `line`, `muted`, `text`, `accent`). |
| `lib/generateStore.ts` | The Generate form as an app-level store above the views, persisted to `localStorage`, so agents can read and fill it while another view is open. Follows library audio clips that move or get a new window; the description switches are cleaned with `sanitizeDescriptionFlags` when the form is loaded. |
| `lib/agentBridge.ts` | The renderer half of the form bridge: applies `get_form`, `set_form` (the description switches and an end image included), `set_references` (photos and audio clips, with the 3-clip and 15 s caps), `reorder_references` (the shared `reorderReferences`, prompt and negative prompt in the same change), `swap_reference` (the shared `swapReferenceImage` / `swapReferenceAsset`; the picture to swap named by path, its place as a hint) and `open` (the Generate view or a clip's drawer, Media on a tab — set with `setMediaTab` before the view opens — or with a clip, picture or film in it (`open-media`), a sequence and clip, a storyboard or a transition, an edit or a version in the Editor, an asset's view, the prompt library — every intent marked `source: 'agent'`, so opening nothing counts as seen) to the form store and the views, and replies with the token maps, the pictures past the model's limit (`unsentReferences`) and where the user is (the open sequence and clip, the open storyboard, or the open edit). |
| `lib/mediaTab.ts` | The Media tab on screen (*Videos*, *Images*, *Films*: `videos`, `pictures`, `films`), remembered in `localStorage` (`studio.media.tab`): `getMediaTab` (also what `get_workspace` reports as `media_tab`), `setMediaTab`, `useMediaTab`. |
| `lib/agent.ts` | Live agent status, activity and approval requests for the indicator, the drawer, the dialog and Settings. |
| `lib/promptIssues.ts` | The `@ImageN` and `@AudioN` checks for a set of params, with the rules main applies. |
| `lib/hooks.ts` | Shared data hooks (model list — shared by all views, fetched again once it is 10 minutes old, when a view opens or the window gets focus, and kept as it was when Venice can't be reached; the image model list in `images/imageModels.ts` likewise —, assets, prompts, price quote, the audio model catalog `useAudioCatalog` — refreshed after 10 minutes, when the user checks again and when the API key changes —, `useSeparationStatus`) and `ipcErrorMessage`. |
| `lib/library.ts` | `localStorage` keys that hold library data (the open sequence, storyboard and edit — `LAST_EDIT_KEY` — among them) and how they are rewritten or forgotten after a library switch; `withImportedCopies`, which points the form at the copies in `Referensbilder` of images and audio picked from outside the library once a generation is submitted. |
| `lib/assets.ts`, `lib/media.ts`, `lib/navigation.ts`, `lib/createRequest.ts`, `lib/workspace.ts`, `lib/takes.ts` | Asset kind wording (products included), `media://` URLs and formatting (`mediaPathOf` turns a `media://` URL back into its path, fragments and queries stripped), cross-view navigation intents (`open-sequence` with a take to focus, `open-storyboard` with a transition or a board, `open-editor` with an edit, a version, a generation or an export, `open-generation` (a clip in Generate's list), `open-media` (a Media tab, or a clip, picture or film in it), `use-generation` (*Use again* from Media), `open-asset` with a voice clip …; each may carry `source: 'agent'`), a request for the open view's *＋ New …* (`requestCreate`, ⌘K's actions), where the user is in the sequence editor, which storyboard and which edit is open (`openEditInEditor`, for agents), and which sequence clip or storyboard transition a take belongs to (found through the work summary first; the clip feed's badge and drawer open it there). |
| `lib/updates.ts`, `components/updates/UpdateNotice.tsx`, `components/settings/AboutSettings.tsx` | Updates in the window: the notice's store (started in `main.tsx` before the first render, so the daily check's answer is never missed; *Later* keeps the version in `localStorage` and only a check the user asks for brings it back), the notice in the bottom right corner (*Update now* / *Release notes* / *Later*, the install's stages and progress, its failure, and the answers of *Check for Updates…*), and *Settings → About Studio* (the version, *Check for updates*, the daily check's switch, when Studio last checked; a development build says updates come from git). |
| `lib/work.ts` | The window's store of the work summary (*Activity*): merged by revision, selectors that re-render only what changed (`useViewWork`, `useOwnerWork`, `useIsUnseen`, `useUnseen`, `useRunning`), `markSeen` (optimistic; a key not listed yet is remembered for 10 s), `markAllSeen` with the *Undo* toast, the playback rule (one capture-phase listener on the document, `watchMediaElement` for players outside it), the visibility rule (`useSeenWhenVisible`: 60 % on screen for 1.5 s with the window focused; `useSeenPictureWhenVisible` for a picture shown by its file), the unseen items past the listed 200 (`more`: keys, files and pictures, and `useFreshGenerationIds` for the feed's *New*), `jumpTo` (a picture with no place of its own opens in `WorkStillViewer` through `showWorkStill`) and `useNow`. |
| `lib/budget.ts`, `components/BudgetDialog.tsx`, `components/settings/SpendingSettings.tsx` | The budget in the window: `withBudgetConfirm(attempt)` runs a paid call and, when main refuses it with `OVER_BUDGET`, asks in `BudgetDialog` (mounted once in `App`, above every view and dialog; questions queue; Cancel has the focus and no key reaches what is underneath) and calls again confirmed — *Create image…*, the Editor's paid cards and *Continue*, *Design a voice with AI…*, both *Generate missing* buttons and Generate's, a clip's and a transition's buttons go through it. `BudgetMeter` shows how full a cap is (also in the approval dialog's over-budget warning). *Settings → Spending*: today, this month and the last 30 days (tiles and a column chart in plain CSS, with a table view), this month by kind, place and who asked, and the two caps. |
| `components/GenerateView.tsx`, `ParamsForm.tsx`, `GenerationCard.tsx`, `ImageInput.tsx` | The Generate view: the form (references, voices and sounds, poses, the descriptions box) and, on the right, this session's clips (`ClipFeed` in session mode; `use-generation` fills the form from a clip in Media), the clip feed's cards, image inputs (the reference strip reorders by drag and drop or ⌥← / ⌥→, showing the numbers each picture will get and which won't be sent; hovering a thumbnail shows it larger in `pickers/ReferenceCard.tsx`'s card (`useTokenCard().hover`, hidden while a drag runs or a picker is open); a click – not a drag – or Enter opens `pickers/SwapPicker.tsx` in a `Popover` anchored to the thumbnail: for a library photo `SwapAssetPicker` (the assets, its kind first; the whole asset is swapped, a character's outfit, voice, *applies to* and *held by* following) with *Pick a single image instead…*, else `SwapImagePicker` (the library photos by kind, saved pictures and a file); ParamsForm applies `shared/reference-swap.ts` in one update, never as a removal and an addition, and says what it did under the references; `images/ReferenceImages.tsx` swaps one picture in place in *Create image…* the same way; a picture in several places is renumbered place by place, `placeKeys` in `shared/prompt-remap.ts`). |
| `components/feed/` | The clip feed: in Media's *Videos* (`mode: 'library'`, every generation) and in Generate (`mode: 'session'`: only `inGenerateSession` clips, newest first, without filters or sort, *This session · n clips* and *All videos in Media →*; `useSession.ts` caches `getSession()`; an `open-generation` for a clip outside the session goes to Media). Toolbar with search, filters (the shared `generation-filter`, with the source — generated, own clips or versions — and *New*), the chip with the number running, sort and summary, *New* on unseen cards and a dot in the table (`open-generation` opens a clip's drawer, lifting a filter that hides it; opened by the user it marks the clip seen, opened by an agent it neither plays nor marks it), *Import own clips…* and a drop target; the own-clip import flow shared with Sequences and the Editor (`ownClips.tsx`: refusals, the large-copy question, the shape question, progress cards with *Cancel*); `GenerationPickerDialog` (any finished video, with search and a tab per source); badges for own clips (*Own*), versions and edits, and a button that opens a clip in the Editor; poster-only cards; a windowed table with sortable columns and keyboard navigation; the detail drawer with player, highlighted `@ImageN`/`@AudioN`, the sent prompt (`SentPrompt.tsx`: the prompt as sent, its legend set apart, when it differs), the references and audio windows sent, settings, the user's rating, note and tags, and agents' reviews; `RatingControl.tsx`, the grade on cards, in the table and the drawer (👎 and one to three stars; clicking the set grade clears it; arrow keys, Home / End, 1–3, − and Delete or Backspace) and the *Rating* filter (★★★, ★★ or more, ★ or more, *Thumbs down*, *Not rated*); kept live through `onGenerationUpdate`, `onGenerationDelete` and `onReviewChange`. |
| `components/media/` | Media (`MediaView.tsx`): the tabs *Videos*, *Images* and *Films* (`lib/mediaTab.ts`; a dot on a tab with something new in it) and the `open-media` intent, which switches tab and opens a clip, picture or film (an agent's opens it without marking it seen). *Videos* is the clip feed. `PicturesTab.tsx`: every still, newest first, with filters for source and place and a search, *New* on unseen ones, and `StillViewer` (browse, delete, go to the sequence or storyboard, *Show in Finder*). `FilmsTab.tsx`: exported films (`listExports`, `sequenceKind`) as cards with poster, length and number of clips, a player, opening it in the Editor and going to the sequence or storyboard; reloaded when an export finishes. `ui.tsx`: the shared toolbar, search field and count line. |
| `components/prompt/` | `PromptField.tsx`, the field every plain prompt uses (larger text, grows with the text, ⌘⇧F focus mode in `FocusDialog.tsx`), and the building blocks (`useBlockMenu.tsx`, `BlockMenu.tsx`, `blocks.ts` over the shared `prompt-blocks.ts`: "/" at the caret and the chips under the field). The reference-aware prompt editor (same look and tools): `@ImageN` and `@AudioN` colouring, hover cards and players, the `@` menu, issue list and quick fixes; *Added to the prompt* (`DescriptionsBox.tsx`, with the pure `descriptions.ts` asking the shared composer what is sent): the legend's entries live (an outfit with who wears it), a switch per asset and *Include descriptions*, the composed length against the model's limit, and which references the sent legend explains — the form passes those to the checks, so the issue list and the reference strip don't call them unmentioned (*described*). |
| `components/prompts/` | The prompt library view (*Prompts*) and its *Learnings* tab (learnings: list, editor, evidence clips). |
| `components/assets/` | The *Characters*, *Environments*, *Products*, *Outfits* and *Poses* views: list (`AssetList` on the shared `SideList`, with each asset's status mark, Finder files dropped on a row and ✕ with the editor's own delete wording from `deleteText.ts` — who loses an outfit as default, where the files go), editor, photos (square tiles for products; who added it on what an agent added), default outfit, and the sound section (voice or soundscape clips, a shared player that the playback rule watches, the reference window editor, *May be cloned for new lines* per voice clip, and *Design a voice with AI…* — `VoiceDesignDialog` — with a spinner while it is made, *New* on a designed clip until it is played and a row with the error for a design that failed, seen by the visibility rule and listed until its ✕). |
| `components/pickers/` | Pickers and dialogs shared by the views (assets in five kind tabs, audio clips, outfits, prompts, sequences, modal, popover), the product chip's *Held by* (form state only) and the outfit chip's *Worn by* (stored in the params as `outfitWearers`; `resolvePairings` asks the shared `resolveOutfitWearers`), the form's asset and audio helpers (`assetRefs`, which re-exports the shared remap, `audioRefs`), and reordering: `reorder.ts` (gap arithmetic, live positions, the nearest gap on wrapped rows) and `useReorder.ts` (the HTML5 drag and drop and ⌥← / ⌥→ hook shared by the image strip and the audio chips, with focus restore and an `aria-live` announcement). |
| `components/takes/` | The take strip shared by Sequences and the transition editor (`TakeStrip`: a listbox of thumbnails under the player — click makes a take the chosen one and plays it with sound, ←/→ choose at once and tell main after 200 ms of quiet, ⌥-click previews without choosing, hover scrubs silently —, `TakeMenu`, `useTakeSelection`, `takeText`) and `MarkViewSeen`. |
| `components/sequences/` | The *Sequences* view: list (`SequenceList` on the shared `SideList`; every row with its status mark; *Mark all as seen*; its empty state points to Storyboards), header (with *Export format* and opening the latest export in the Editor under ⋯; the run's spinner and how far it is (clip 2 of 5); the export bar and the done banner from the store, `useExportStatus`, so they survive leaving the view), timeline (with *Redo between neighbours* on the cards, the add-clip split button and the `+` menu — own clips from a file, the clip feed or the Editor —, video files dropped between clips, *Own* cards with the clip's title), clip editor (`KeyframeBox`: *Start on the previous clip's last frame* / *End on the next clip's first frame* with live frame previews, and under the first *With references* / *Exact start frame* with the line saying what goes along and the note when the choice doesn't apply; `NotesField`: what happens), the chosen take's player with the take strip under it and the trims (an open trim draft is saved before another take is chosen; a preview offers to choose it or show the chosen one), the timeline cards' status chip, preview player (also used by Storyboards), the shared clip checks (`clipChecks.ts`), price hooks (`useTotalQuote.ts`), drafts (`useDraft.ts`) and frame previews (`useFramePreview.ts`: cached, at most two at a time). |
| `components/storyboards/` | The *Storyboards* view (`StoryboardsView`): the list with covers and progress (`StoryboardList` on the shared `SideList`), *＋ New …* (name and format, `CreateStoryboardForm`), the header (`StoryboardHeader`: rename, format, *Generate missing* with the total price or a stop button, *Preview*, *Export* with progress, and under ⋯ making a sequence of it, opening its folder in Finder and deleting it), one row of large board pictures (`BoardRow`, `BoardCard`: drag or ⌥← / ⌥→ to reorder through the shared `useReorder`, **+** before, between and after, pictures dropped on the new-board button become boards; notes on what the picture shows), each board's picture menu (`BoardImage`: *Create image…*, a library photo, the storyboard's pictures, an upload, a frame of a clip, removing the picture, drops, the other-format mark), the transitions between them (`TransitionConnector`: status, progress, a finished new take, prompt excerpt, length, price, *Generate*) and the transition editor beside the boards (`TransitionEditor`: both pictures, the selected take's player and the take strip under it, the prompt (what happens) with its suggestion, length, resolution, sound, models that take an end image, price, the earlier-picture note), *New* and failures on board pictures, status marks on the list rows, and the `transitionId` / `boardId` intents. `useStoryboard` keeps the open storyboard live (`onStoryboardChange`, take updates); `storyboardUtils.ts` holds the pure helpers (labels, status, run plan, the suggestion's template, local reorders). |
| `components/images/` | *Create image…* (`CreateImageDialog`: prompt, references with the base first, model, format, resolution and quality, the safe-mode note, live price; a `workToken` and target, so its result or failure lands in *Activity* also after it closed; for a sequence clip, using it as the start or end image; for a storyboard board (`assign: {boardId}`) the picture goes onto the board, never over a picture put there meanwhile, and the switch to use the previous board's picture as a reference puts it first), the frame picker (`FramePickerDialog`: a sequence's takes, or with `anyGeneration` every finished video in the library with a search over the prompts — `frameChoices.ts` shapes the lists —, frame-exact stepping, using the frame shown), `StillThumb` (draggable as `application/x-studio-still`), `StillViewer`, and the image model and price helpers (`imageModels.ts`). |
| `components/editor/` | The *Editor*: the list of edits on the left (`EditSideList` on the shared `SideList`: *＋ New …* with an own film, a clip from the feed or an export, *Mark all as seen*, ✕), the overview of all edits beside it while no edit is open (`EditList`, cards or a table with a spinner and the job's label for paid jobs and free renders and a mark on a new version; it lays out by its own width, `@container/edits`, and drops columns when narrow; `EditorView` with the `open-editor` intent and its `versionId`, which selects the edit in the list), and an edit (`EditWorkspace`, its right column 320 px in a narrow window): the header (`EditHeader`, `SendMenu`), the player with in/out marks, comparing (⇄) and keyboard control (`Player`, `playerController`; `focusOrigin` hands Space and ← → to a button or tab only when it was reached with the keyboard, not after a click), the timeline lanes for picture, sound, layers and text (`Timeline`), the action tabs *Picture*, *Sound*, *Voice*, *Music & effects* and *Text* (`ActionsPanel`, `PictureTab`, `SoundTab`, `VoiceTab`, `MusicTab`, `TextTab`, `AddAudioDialog`) with plan-driven price buttons (`useEditOps`: debounced plans, the extra question above $5 or for an unknown or partial price, Venice's consent dialog with the confirmed price kept as the ceiling), and the version tree with jobs, continuing a stopped job, *Clean up versions…* and *New* on versions a paid job made (`VersionsPanel`). Container queries on `@container/main` replace viewport breakpoints in the header, the timeline and the workspace. |
| `components/library/` | `SideList` (with `SideListRow`, `SideListThumb`): the list on the left of the five library kinds, Sequences, Storyboards and the Editor — header with *＋ New …* (a click, or a popover with a form or a menu; ⌘K's *New …* presses it through `lib/createRequest.ts` once the list has loaded), a search that is always there (⌘F unless a modal dialog is open; name plus a view's own text), rows of one height, ↑ / ↓ / Home / End and Enter, and ✕ that turns the row into the question (*Delete* / *Cancel*, closes after 8 s or on Esc, shows the view's error and offers to try again), then hands the view the row that takes its place. Library setup screen (with *Import a library…* for a zip from *Export & import*, `LibrarySetup.tsx`), folder choice, switching overlay and *Settings → Library* (the folder tree shows `Produkter`, `Egna klipp` and `Redigeringar`). |
| `components/search/` | ⌘K, the command palette (`CommandPalette.tsx`; `openCommandPalette` for the sidebar's search button): ⌘K caught on the window in the capture phase (also in text fields; not over an `aria-modal` dialog), a combobox over a grouped listbox (↑ / ↓, Page Up / Down, Enter, Esc, the mouse; the focus goes back on Esc). `entries.tsx` turns the places (views, Media's tabs, every Settings section — a section added to `SETTINGS_SECTION` must be named there —, the two panels), the actions (*New …* through `lib/createRequest.ts`, the sidebar toggle) and the library into entries that open through the navigation intents; `usePaletteData.ts` loads the lists with the views' own calls (`listAssets`, `listPrompts`, `listSequences` + `getSequence` and `listStoryboards` + `getStoryboard` for the newest 100 — clip notes and prompts, board notes, transition prompts —, `listEdits`, `listGenerations`, `listStills`, `listExports`) each time it opens and keeps them while open; `match.ts` folds case and accents and finds word prefixes (with a map back to the original text for the highlights and excerpts); `rank.ts` scores where each word matched and groups the hits (best group first; Clips, Images and Films newest first, every group capped). Renderer only: agents search with their list and get tools. |
| `components/settings/` | *Settings*' parts: `SettingsLayout` (a section per subject with its heading and intro, settings inside it, a link to read more, and the in-page navigation that follows the scroll; `showSettingsSection` opens Settings at a section), `Switch`, `VeniceSettings` (the API key), `GenerationSettings` (*Prompt language*, *Images → Safe mode for images*), `ToolsSettings` (ffmpeg and *Voice separation*), `AboutSettings` (the version and profile) and `LibraryArchiveSection` (*Export & import*: *Export library…* and *Import a library…*, progress with *Cancel*, a result line with *Show in Finder*; its state lives outside the component, so a long export is still shown after leaving the view; after an import it behaves like a library switch, with `SwitchingOverlay`). |
| `components/work/` | *Activity*: `StatusMark` (`Spinner`, the inline and badge marks, `NewChip`, `StatusDot`), `StatusRow` (the sidebar's slim status row, 28 px, shared by *Activity* and the agent; in the rail its icon with badges and a `RailTooltip`), the sidebar row (`WorkIndicator`), the panel (`WorkPanel`: running work grouped by place, new results, failures, a review button for waiting agent requests, *Mark all as seen*), the *Undo* toast (`SeenToast`), Generate's row of new pictures with no board, clip or sequence (`NewPictures`, under the feed's toolbar), the viewer such a picture opens in (`WorkStillViewer`) and the status texts (`workText.ts`). |
| `components/agent/` | Agent settings section, sidebar indicator (a `StatusRow`: *Agent connected*, *The agent is working* or the agent's own name; a generic MCP client name reads *The agent* through `shared/agent-name.ts`, here and in the drawer, the dialogs, notifications, reviews and *Activity*, with the technical name in the drawer), the *Claude Desktop* card in the settings section (`ClaudeDesktopCard`: *Add to Claude Desktop*, the download link when it isn't installed, saving for another computer with an address choice, *Connected* while a client named *Claude* is), the presence pill (`AgentPresence`), activity drawer (beside the sidebar at `--sidebar-w`), approval dialog (with the References legend a request appends, set apart under the prompt and marked when a description has changed since, the voices a request sends, the start and end frames of a clip that takes them from its neighbours, image requests with their references and the finished picture, and — `StoryboardApproval.tsx` — a transition as its two board pictures side by side, the board a picture is for and the picture it replaces; `EditApproval.tsx` — an edit request with the version's poster, the frames it works from (captioned by operation), old → new lines or the lines a change of voice changes, the parts and the price note, planned again live, with the required clone-consent checkbox, a resumed job, and a designed voice; `DeleteApproval.tsx` — a removal's items grouped by kind with pictures, effects and the Trash note, checked again every 2 s and on focus, the second step for containers or more than 5 items, and the outcomes; `PromptText.tsx` — a read-only prompt whose tokens open `pickers/ReferenceCard.tsx`'s hover card (`useTokenCard`, shared with the clip drawer's `feed/HighlightedPrompt.tsx` and the reference thumbnails: the picture, or the voice's window with a play button, loaded only when a card opens) and light up with the tiles naming them; `ApprovalPictures.tsx` — those tiles, and `PictureHover`, which gives a tile, a frame or a board the same card on hover or keyboard focus; nothing opens on a click) and their wording. |
| `components/SettingsView.tsx`, `Sidebar.tsx`, `RailTooltip.tsx`, `icons.tsx`, `ConsentDialog.tsx`, `DevBadge.tsx` | Settings (sections Venice, Spending, Generation, Library, Export & import, Agent connection, Tools and About Studio, with a navigation that follows the scroll; the parts are in `components/settings/`), navigation (two groups, *Create* — Generate, Sequences, Storyboards, Editor — and *Library* — Media, the five asset kinds and Prompts —, each row with what runs there and what is new; at the bottom two slim status rows, *Activity* and the agent, above a divider, and *Settings* last; by the wordmark the search button (⌘K) and the toggle; collapsible to a 72 px icon rail whose rows show their status as badges and explain themselves in `RailTooltip`s), the 16 px icon set (`icons.tsx`), Venice's consent dialog, the *Dev* badge and a variant's (*Test*), in a row of their own under the wordmark. |

## Data model

The database is `<base folder>/.studio/studio.db` (SQLite through `better-sqlite3`, WAL journal, foreign keys on).
Each library has its own database; nothing about the library lives in the profile's settings except where the
base folder is.

| Table | Holds |
| --- | --- |
| `generations` | Every generation: model, prompt, params (JSON), status (`queued`, `processing`, `completed`, `failed`), Venice queue id, price quote, timings, `file_path`, `thumb_path`, `video_duration`, `segment_id` when it is a take of a sequence clip, and `sent_prompt`: the prompt exactly as Venice got it (`prompt` and `params.prompt` stay the user's text, which *Use again* puts back; NULL before migration 9). `source` says what made it: `generated` (Venice; every row before migration 11), `import` (the user's own film) or `edit` (a version made in the Editor); imports and versions are inserted completed, with `model` and `prompt` empty, and named by `title` (the file's name, "<edit> v3"). `parent_id` is a version's base version, `edit_id` the edit a version or an AI take belongs to, `recipe` (JSON, ids only, never paths) how a version was made — the operation, its base, its cost, how its sound is built (`mix`), its cut markers, an import's file name, size, SHA-256 and working-copy reasons — and `original_path` an import's untouched original when `file_path` is a working copy. |
| `assets` | Characters, environments, products, outfits and poses: `kind` (`character`, `environment`, `product`, `outfit`, `pose`), name, description, `folder`, `default_outfit_id` (characters only, a self-reference set to NULL when the outfit is deleted). |
| `asset_images` | An asset's photos: `file_path`, `position` (position 0 is the cover) and `origin` (JSON `{agent, host?, at}` when an agent added it; NULL = the user). |
| `asset_audio` | A character's voice or an environment's soundscape clips: `file_path`, `position` (position 0 comes along when the character is added to a form), `duration`, the reference window `clip_start` / `clip_length` (NULL: the default, min(duration, 10 s)) `clone_consent_at` (when the user allowed the clip to be cloned for new lines; set only from the window) and `origin` (as for photos). Deleted with their asset. |
| `generation_reviews` | Reviews of a generation: `author` (`user`, at most one per generation by a partial unique index, or an agent's name), `rating` -1 (thumbs down) or 1–3 stars, `tags` (JSON), `note`. Deleted with their generation. |
| `learnings` | Insights about prompting: `title`, `insight`, `model` (NULL: every model), `tags` and `evidence` (generation ids, JSON), `author`, `pinned`. |
| `prompts` | The prompt library: title, body, negative prompt, tags (JSON), favourite, use count, last used. |
| `sequences` | Sequences and storyboards: name, `kind` (`sequence` or `storyboard`), `defaults` (JSON params for new clips; a storyboard's for new transitions; a sequence's cast is the references in it: `referenceImages`, `referenceAudios`, `outfitWearers` — see `shared/cast.ts`; a song sequence's song is its `song` key — see [Songs](#songs-data-analysis-lyrics)), `aspect_ratio` (a storyboard's format; NULL for sequences), `folder` (in `Sekvenser/` or `Storyboards/`), `export_height` (the *Export format*: 480, 720 or 1080; NULL = the first clip's size). |
| `segments` | A sequence's clips, or a storyboard's transitions: `position`, `params` (JSON template for new takes; its `startImage` / `endImage` are the clip's keyframes, a transition's two board pictures), `continue_from_previous`, `continue_mode` (how a continuing clip starts on the previous clip's last frame: `references`, the default, or `exact`), `end_from_next` (take the end image from the next clip; always 0 for transitions), `notes` (what happens), `selected_generation_id`, `trim_start`, `trim_end`, and for a transition `from_board_id` / `to_board_id` (the boards it goes between; set to NULL if a board row goes). Deleted with their sequence. |
| `storyboard_boards` | A storyboard's boards: `sequence_id` (the storyboard; deleted with it), `position`, `image_path` (the picture, a stored path; NULL for an empty board), `still_id` (the still it is, when it is one; set to NULL if the still row goes), `note` (what the picture shows). |
| `stills` | The pictures of a sequence or a storyboard: `sequence_id` (set to NULL when it is deleted and the still is kept), `file_path`, `source` (`generated`, `upload`, `frame`), `prompt`, `model`, `params` (JSON: negative prompt, reference images, aspect ratio, resolution, quality; a saved frame's take and time), `cost`. |
| `exports` | Exported films of sequences and storyboards (`file_path`, `sequence_id`), so they follow folder renames and library moves, and `cuts` (JSON seconds where the clips meet in the film, recorded at export; NULL for older films). |
| `edits` | The Editor's edits: `name`, `folder` (in `Redigeringar/`), `origin_kind` (`generation`, `export` or `import`), `origin_generation_id` (v1), `origin_export_id`, `current_generation_id` (the version shown and built on); the foreign keys are set to NULL when their row goes. |
| `edit_media` | An edit's own audio in its `Ljud/`: `kind` (`voice`, `speech`, `music`, `effect`, `audio` — an added file or library clip — or `bake`, a rendered bed), `file_path`, `label`, `model`, `cost`, `duration`, `details` (JSON, no paths). Deleted with the edit. |
| `media_jobs` | Paid work of the Editor that takes several requests (and a picture operation's bookkeeping): `edit_id` (or `asset_id` for a designed voice; neither for a song's lyrics, a finished `transcribe` row whose `request` names the sequence), `base_generation_id`, `op`, `request` (the normalized operation, no paths), `status` (`running`, `completed`, `failed`, `cancelled`), `quote`, `cost` (what was sent so far), `take_generation_id` (the AI take of a picture operation), `result_generation_id` (the version it made), `error`. |
| `media_job_steps` | The requests of a job, in `position` order: `endpoint` (`voice-changer`, `audio-queue`, `speech`, `transcription`, `voice-clone`), `model`, `request` (JSON: range, text, voice …; no paths, no media), `status` (`pending`, `sending`, `queued`, `completed`, `failed`, `cancelled`), Venice's `queue_id`, `quote`, `error`. |
| `transcripts` | One transcript per generation: `segments` (JSON lines with start, end, text and optional words), `model`, `language`, `source` (`venice`, `remapped` — carried across a cut — or `edited`), `cost`. |
| `voice_clones` | Handles of a voice clip cloned at Venice (`audio_id`, `model`, `handle`, the sample window, `expires_at`; valid 7 days), reused while they last. |
| `unseen` | Finished work the user hasn't looked at yet (*Activity*): at most one of `generation_id`, `still_id`, `export_id`, `audio_id`, `job_id` (each unique, deleted with its item), or none and then `error` and `label` (a picture that wasn't made, a failed export or run), `context` (JSON ids only: the sequence, storyboard, board, clip, asset or edit it belongs to, `failureOf`, a picture's `workToken`) and `created_at` (when it finished). Empty after the migration, so an existing library starts with everything seen. |
| `take_trims` | The trims each take of a clip last had (`segment_id`, `generation_id`, `trim_start`, `trim_end`), so choosing another take and back never erodes them; deleted with the clip or the take. |

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
| 6 | Assets: renamed `characters` → `assets` and `character_images` → `asset_images` (`character_id` → `asset_id`), added `kind` (existing rows become `character`) and `default_outfit_id`, rebuilt the indexes. `ASSETS_SCHEMA_VERSION = 6` marks libraries that own `Miljöer` and `Kläder`. |
| 7 | Voices, reviews and learnings: created `asset_audio` (+ index by asset and position), `generation_reviews` (+ index by generation, unique user review per generation) and `learnings`. Poses need no schema change (`assets.kind` is text); `POSES_SCHEMA_VERSION = 7` marks libraries that own `Poser`. |
| 8 | Storyboards: added `end_from_next` and `notes` to `segments`; created `stills` (+ index by sequence and creation time). |
| 9 | Descriptions in the prompt: added `sent_prompt` to `generations` (the prompt with the References legend, as sent). |
| 10 | Storyboards as their own workflow: added `kind` (existing rows become `sequence`) and `aspect_ratio` to `sequences`, created `storyboard_boards` (+ index by storyboard and position), added `from_board_id` and `to_board_id` to `segments`. `STORYBOARDS_SCHEMA_VERSION = 10` marks libraries that own *Storyboards*. |
| 11 | Own clips and the Editor: created `edits`, `edit_media`, `media_jobs`, `media_job_steps`, `transcripts` and `voice_clones` (+ indexes); added `source` (existing rows become `generated`), `title`, `parent_id`, `edit_id`, `recipe` and `original_path` to `generations` (+ indexes by parent and edit), `clone_consent_at` to `asset_audio`, `cuts` to `exports` and `export_height` to `sequences`. `EDITS_SCHEMA_VERSION = 11` marks libraries that own `Egna klipp` and `Redigeringar`. |
| 12 | Products, status and take trims: created `unseen` (+ partial unique indexes) and `take_trims` (+ index by generation); added `origin` to `asset_images` and `asset_audio`. `PRODUCTS_SCHEMA_VERSION = 12` marks libraries that own `Produkter`. |
| 13 | Grades and continuation mode: rebuilt `generation_reviews` with `rating` CHECK (-1, 1, 2, 3), old stars mapped 1–2 → -1, 3 → 1, 4 → 2, 5 → 3, both indexes recreated, reviews of missing generations left out; added `continue_mode` (`references` by default, or `exact`) to `segments`. |
| 14 | Directors: added `direction` (JSON `Direction`, a director's only; style video paths stored like every other) to `assets`. Directors are `assets.kind = 'director'`; a sequence's or storyboard's director is the `director` key of its `defaults`, a clip's that of its params. `DIRECTORS_SCHEMA_VERSION = 14` marks libraries that own `Regissörer`. |

A library from before the base folder could be chosen (`studio.db`, `generations/`, `thumbs/`, `characters/`,
`exports/`, `frames/` directly in the folder) is converted to the current layout by `library-root.ts` when it is
opened; an interrupted conversion resumes on the next open.

## Stored paths

The rules live in `src/main/paths.ts` and `src/main/db.ts`:

- **Relative inside the library's own folders.** A path inside one of the library's top-level folders (`Karaktärer`,
  `Miljöer`, `Produkter`, `Kläder`, `Poser`, `Regissörer`, `Referensbilder`, `Genereringar`, `Sekvenser`, `Storyboards`,
  `Egna klipp`, `Redigeringar`, `.studio`, and the old layout's folders until they are converted) is stored relative to the base
  folder, POSIX-style and NFC-normalised. Anything else — including files of the user's own elsewhere in the base
  folder — keeps its absolute path, because moving the library only takes its own folders along.
- **Converted at the database boundary.** Code outside `db.ts` works with absolute paths. `toStoredPath` /
  `fromStoredPath` and `toStoredParams` / `fromStoredParams` convert on the way in and out.
- **Every path column is known.** `generations.file_path`, `generations.thumb_path`, `generations.original_path`, the
  `startImage`, `endImage`, `referenceImages`, `referenceAudios[].path`, `sourceVideo` and `referenceVideos` in
  `generations.params` and `segments.params`, `asset_images.file_path`, `asset_audio.file_path`, `stills.file_path`,
  the `referenceImages` in `stills.params`, `storyboard_boards.image_path`, `exports.file_path`,
  `edit_media.file_path`, and in `sequences.defaults` the cast's references and the song's `song.path` and
  `song.vocalsPath`. The JSON of `recipe`, `details`, `request`, `segments` and `unseen.context`, `origin` and
  `take_trims` hold ids only, never paths.
  `mapStoredPaths` visits all of them, and so do the "is this path recorded" checks (`isStoredPathRecorded` can leave
  one still's own row out: is anything *else* using its file?), the list of tracked files a library move carries and
  `followRewrites`; a new path column must be added there.
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
- **Library-wide operations are exclusive.** A switch, move or *Tidy up* holds `beginLibraryOperation`; asset,
  sequence, still, import, edit and delete work waits with `libraryOperationSettled`, and a switch is refused while
  generations, exports, asset or still work, imports, edit jobs or a library export (*Export & import*) are
  running.

## Export and import

*Settings → Export & import* (`library-archive.ts`, `components/settings/LibraryArchiveSection.tsx`) moves a
whole library to another Mac as one zip. Only the user does it: no agent tool reaches it, and the `archive:*`
handlers refuse an agent's call or one without a window. One export or import runs at a time; `archive:cancel` stops
the tool it runs and removes its partial zip or unpacked folder, and `stopLibraryArchive` does the same on quit.

- **Export.** Refused while anything a library switch waits for runs (`libraryBusyReason`); while it runs,
  `archiveBusyReason` makes a switch, a move or *Tidy up* wait in turn. The database is copied with SQLite's online
  backup (`db.backup()`), made one self-contained file (rollback journal) and described for the manifest (rows per
  table). The files are those of the library's own top-level folders (and an earlier layout's not converted yet),
  walked without following links (links and special files are skipped and named in the result). In `.studio` the live
  database files and the caches Studio rebuilds (`miniatyrer`, `bildrutor`, `stammar`, `tidslinje`, `tmp`) stay
  out, except a cached file a stored path uses besides a generation's own poster (`cacheFilesInUse`: a frame a take
  was started from may be the only copy of that picture). `/usr/bin/zip -g -0 -nw -@` packs the list into
  `<name>.zip.part` beside the target — stored, not compressed (media doesn't shrink), Zip64 past 4 GB, streamed from
  disk — with the part's size as the progress; `studio-archive.json` goes in last (format and its version, app and
  schema versions, time, counts, rows per table, files and bytes) and the part is renamed to the target, so a zip by
  that name is always whole. The target (by default `~/Downloads/Studio-bibliotek <date>.zip`) may not lie in the
  library's folders, and the disk must hold it with a margin. Files that vanished while it ran are named in the
  result's note.
- **Import.** The manifest is read first (`unzip -p`): a zip that isn't a Studio export, or one from a newer format
  or schema (`db.isNewerSchema`), is refused before the destination is even asked for. Then the listing (`unzip
  -Z`): no `..`, absolute paths or links, the database there, files and bytes as the manifest says. The destination
  (suggested `~/Movies/<zip name>`) must be new or empty, not a library, writable and outside the open library's
  folders, and its disk must hold the library. `ditto -x -k` unpacks into `<name> (importeras)` beside it (the same
  disk), the files are counted against the listing, and the database must pass `integrity_check` and hold the
  manifest's rows per table. Then the manifest is removed, the folder renamed into place and opened with
  `setLibraryRoot(…, 'open')`, exactly as when the user picks a library folder, and the windows reload; the library
  open before stays where it is. Missing posters are made again by the job manager's backfill when it opens.

## IPC surface

`StudioApi` in `src/shared/types.ts` is the single contract between renderer and main; `src/preload/index.ts`
implements it one line per method. Requests use `ipcRenderer.invoke` on `<area>:<action>` channels; main rejects
with user-facing messages.

| Group | Methods | Channels |
| --- | --- | --- |
| Settings | `getSettings`, `setApiKey`, `testApiKey`, `ffmpegStatus`, `setPromptLanguage`, `setImageSafeMode`, `setBudget`, `getSpending` | `settings:*` (`settings:setBudget`), `spending:get`, `ffmpeg:status` |
| Generation | `listModels`, `quote`, `generate`, `acceptConsent`, `listGenerations` (with the user's rating and the review count), `deleteGeneration` | `models:list`, `video:quote`, `video:generate`, `consent:accept`, `generations:*` |
| Reviews and learnings | `listReviews`, `setUserReview`, `deleteReview`, `listLearnings`, `saveLearning`, `deleteLearning`, `listExports` | `reviews:*`, `learnings:*`, `exports:list` |
| Session | `getSession` (`startedAt`, when this session began, and `carriedOver`: Generate lists what was made since and what was still being made then) | `app:session` |
| Assets | `listAssets`, `saveAsset`, `deleteAsset`, `addAssetImages`, `removeAssetImage`, `reorderAssetImages`, `addAssetAudio`, `removeAssetAudio`, `updateAssetAudio`, `reorderAssetAudio` | `assets:*` |
| Directors | `copyDirectorPreset`, `addDirectorVideos` (a director's own: `saveAsset` with `direction`, style frames with `addAssetImages`) | `directors:copyPreset`, `directors:addVideos` |
| Prompt library | `listPrompts`, `savePrompt`, `deletePrompt`, `markPromptUsed` | `prompts:*` |
| Sequences | `listSequences`, `getSequence`, `createSequence`, `updateSequence`, `deleteSequence`, `addSegment`, `updateSegment`, `deleteSegment`, `moveSegment`, `setSegmentImage`, `previewSegmentFrames`, `bridgeSegment`, `generateSegment`, `generateAllSegments`, `stopGenerateAll`, `exportSequence` | `sequences:*`, `segments:*` (`segments:setImage`, `segments:previewFrames`, `segments:bridge`) |
| Songs | `createSequenceFromSong`, `setSequenceSong`, `songOverview`, `suggestSongSections`, `setSongSections`, `quoteSongLyrics`, `transcribeSong`, `editSongLyricLine`, `separateSongVocals`, `syncSongTake` (progress and results arrive as `sequence:change`) | `songs:*` |
| Storyboards | `listStoryboards`, `getStoryboard`, `createStoryboard`, `updateStoryboard`, `deleteStoryboard`, `addBoard`, `updateBoard`, `moveBoard`, `deleteBoard`, `updateTransition`, `generateTransition`, `generateStoryboard`, `stopStoryboard`, `exportStoryboard`, `convertStoryboardToSequence` | `storyboards:*` (`storyboards:generateAll`, `storyboards:stop`, `storyboards:export`, `storyboards:toSequence`), `boards:*`, `transitions:update`, `transitions:generate` |
| Images and stills | `listImageModels`, `quoteStill`, `generateStill`, `listStills`, `deleteStill`, `saveFrameAsStill` | `images:models`, `images:quote`, `images:generate`, `stills:list`, `stills:delete`, `stills:saveFrame` |
| Library folder | `libraryStatus`, `chooseLibraryFolder`, `inspectLibraryFolder`, `setLibraryRoot`, `reorganizeLibrary`, `revealLibraryFolder` | `library:*` |
| Library archive | `exportLibraryArchive`, `importLibraryArchive`, `cancelLibraryArchive`, `onArchiveProgress` | `archive:export`, `archive:import`, `archive:cancel`, event `archive:progress` |
| Agent connection | `getAgentStatus`, `setAgentEnabled`, `setAgentPort`, `restartAgent`, `getAgentToken`, `regenerateAgentToken`, `listAgentActivity`, `listApprovals`, `resolveApproval`, `verifyApproval`, `replyAgentCommand` | `agent:*` (`agent:verifyApproval`) |
| Claude Desktop | `claudeDesktopStatus`, `addToClaudeDesktop` (window only) | `claude:status`, `claude:addExtension` |
| Updates | `checkForUpdates`, `installUpdate`, `setAutoUpdateCheck` (window only), `onUpdateAvailable`, `onUpdateProgress` | `updates:check`, `updates:install`, `settings:setAutoUpdateCheck`, events `updates:available`, `updates:progress` |
| Status (*Activity*) | `getWorkSummary`, `markSeen`, `markAllSeen`, `undoMarkAllSeen`, `onWorkChange` | `work:summary`, `work:markSeen`, `work:markAllSeen`, `work:undoSeen`, event `work:change` |
| Own clips | `pickVideos`, `inspectVideoFiles`, `importVideoFiles`, `cancelImports` | `file:pickVideos`, `imports:inspect`, `imports:import`, `imports:cancel` |
| Editor | `listEdits`, `getEdit`, `createEdit`, `renameEdit`, `deleteEdit`, `setCurrentVersion`, `deleteVersion`, `pruneVersions`, `editTimeline`, `planEditOperation`, `runEditOperation`, `cancelEditJob`, `resumeEditJob`, `getTranscript`, `updateTranscript`, `saveSubtitles`, `addEditAudio`, `sendEditToSequence` | `edits:*` (`edits:setCurrent`, `edits:deleteVersion`, `edits:prune`, `edits:timeline`, `edits:plan`, `edits:run`, `edits:cancel`, `edits:resume`, `edits:transcript`, `edits:updateTranscript`, `edits:srt`, `edits:addAudio`, `edits:send`) |
| Audio and voices | `listAudioModels`, `separationStatus`, `planVoiceDesign`, `designVoice`, `setVoiceCloneConsent` | `audio:models`, `audio:separation`, `voices:plan`, `voices:design`, `voices:consent` |
| Files | `revealFile`, `pickImages`, `pickAudio`, `pathForFile` (local, via `webUtils`) | `file:*` |

Events from main to the window (subscribe with the `on…` methods, which return an unsubscribe function):
`generation:update` (with the review summary), `generation:delete`, `review:change` (the generation id),
`learnings:change`, `library:change` (also after a designed voice was added or a clip's clone consent changed),
`sequence:change`, `storyboard:change` (a storyboard, its boards, transitions or their takes), `export:progress` (with
the sequence's or storyboard's id), `stills:change` (a sequence or storyboard id, or none for "any"),
`import:progress` (a file being imported, with the clip it goes to), `edit:change` (an edit id: its versions, jobs or
media changed), `edit:progress` (a render or a paid job's progress, by edit or — for a designed voice — by asset),
`agent:status`, `agent:activity`, `agent:approval`, `agent:command`, `work:change` (the whole work summary) and
`archive:progress` (a library export or import: its phase, bytes done and in all, a message; `done`,
`failed` or `cancelled` at the end). The
window answers `agent:command` with
`agent:reply` (`ipcRenderer.send`). After a library switch main reloads every window.

Two details matter when changing handlers:

- `sequences:missingClips`, `storyboards:missing`, `stills:get`, `reviews:add`, `stills:import`, `edits:deleteRefusal`
  and `boards:moveLoss` are registered but not part of `StudioApi`; only the agent connection uses them. The review and learning handlers take the agent's name as a last
  argument (only from an agent's call, `isAgentCall`), refuse `reviews:setUser` for agents, and let an agent change
  or delete only what it wrote.
- What only the user may do refuses an agent's call (`isAgentCall`) with an error saying only the user can do it, as
  a second line of defence behind the tool list: `file:pickVideos`, `edits:delete`, `edits:deleteVersion`,
  `edits:prune` (unless it is a dry run), `edits:srt`, `voices:consent`, `work:markSeen`, `work:markAllSeen`,
  `work:undoSeen`, `archive:export`, `archive:import` and `archive:cancel` (also refused without a window) and every
  `agent:*` handler that changes the connection, reveals the token or answers a request
  (`agent:verifyApproval` and `agent:approvals:resolve` among them). An approved removal reaches the delete handlers
  through `callApproved`, for which `isAgentCall` is false.
- **The agent file rule.** Handlers that take file paths check an agent's call with `assertAgentFiles`
  (`upload-paths.ts`): every path must be a file staged in `.studio/tmp/agent-uploads` or one the library records,
  never anything else on the Mac: `assets:addImages`, `assets:addAudio`, `imports:inspect`, `imports:import`,
  `edits:addAudio`, `stills:import`, `songs:createSequence`, `songs:set`, and the `{kind: 'file'}` pictures of
  `segments:setImage`, `boards:add` and `boards:update`. An agent's call never starts a paid transcription itself:
  `songs:transcribe` (and lyrics asked for at import) only run inside an approved request (`isConfirmedHere`).
- Paid Editor calls (`edits:run` of a paid operation, `edits:resume`, `voices:design`) need the price the user
  saw (`expectedPriceUsd`; 0 when Venice gives none) and refuse when the price rose by more than $0.01. `edits:run`
  and `edits:resume` also take whether that price was unknown or partial (`expectedPartial`); when it wasn't, a part
  without a price that came in since (a clone handle that ran out) is refused the same way, so the window asks the
  extra question first.
- **The budget.** Every paid path checks its whole amount against the budget before anything is sent
  (`budget.ts`): `video:generate`, `segments:generate` and `transitions:generate` with all their variants,
  `images:generate`, a paid `edits:run`, `edits:resume`, `voices:design`, and `sequences:generateAll` /
  `storyboards:generateAll` once, with the run's total, before the run starts. Past a cap they reject with
  `OVER_BUDGET:` and an `OverBudget` JSON; the window asks (`withBudgetConfirm`, `BudgetDialog`) and calls again with
  `confirmOverBudget: true` — in `GenerateOptions`, `EditRunOptions`, or a last options argument (for the two
  *Generate missing* handlers after the guard). An approved agent request runs inside `runConfirmed` and isn't
  asked about. `settings:setBudget` refuses an agent's call.
- `segments:generate`, `sequences:generateAll`, `transitions:generate` and `storyboards:generateAll` accept an
  optional *submit guard* function. Only in-process calls from an approved agent request can pass one (an IPC message
  cannot carry a function).
- Sequences and storyboards share a table but not their handlers: the sequence handlers refuse a storyboard's id or
  one of its transitions, and the storyboard handlers a sequence's, each with a message that says where it
  is. The read-only `segments:previewFrames` and `sequences:missingClips`, and `segments:generate`, accept either.

## Jobs: from submit to saved video

Every paid video generation — the Generate button, a clip's new take, *Generate missing*, an approved
agent request — ends in `JobManager.submit` (`src/main/jobs.ts`). (Stills are pictures, made in one request by
`stills.ts`; see [Keyframes and stills](#keyframes-and-stills).)

**Variants.** `video:generate`, `segments:generate` and `transitions:generate` take `GenerateOptions` (`count` 1–4,
`confirmOverBudget`), read by `sendOptionsOf` (`src/main/variants.ts`), which refuses any other count. The handler
prepares and quotes once, checks the price × count against the budget (`assertWithinBudget`, `budget.ts`) before
anything is sent, and then `sendVariants` calls `JobManager.submit` once per variant with the same params, one after
another: the first alone, so a refusal (a consent Venice asks for, `NEEDS_CONSENT`) comes back with nothing sent,
and a failure after that stops the rest with an error that says how many were sent. A sequence take builds every
variant from the same reads (one guard check, the same frames and composed prompt) while the clip counts as being
sent; each variant is a take, and the usual rule picks the first one to finish only when the clip has no usable
take. The handlers resolve with the first take; the others reach the window as generation updates. An in-process
caller (an approval) can put an `onSent` listener in the options to collect every take's id.

1. **Guard.** `prepareSubmission` checks the `@ImageN`, `@AudioN` and `@VideoN` references against what will
   actually be sent and refuses before anything is copied or paid for. Tokens are canonicalised and inputs the model does not
   use are dropped (`paramsForSubmit`: images outside their mode, reference audio unless the model is
   reference-to-video with `audio_input`, anything past the model's limits). Every reference audio clip is then
   measured with ffprobe and its window filled in, and so is every reference video (`resolveReferenceVideos`), and
   the checks run again on the real lengths (each audio clip 2–15 s, 15 s in all, at least one reference image or
   video; reference videos within their family's count and seconds). The `video:generate` handler (and a sequence take) runs this before
   it quotes the price and counts the submit as busy, so a library switch can't close the database under it.
   The prompt as it will be sent (below) is checked by the same rules.
2. **Compose.** A director (`params.director`) first directs the params (`withDirection`: its `avoid` merged into the
   negative prompt, its style frames and videos after the references — also in `prepareSubmission`, idempotent), and its
   Direction section follows the legend in the room the limit leaves (`shared/direction.ts`).
   `composeSubmission` appends the References legend (`composePrompt` in `src/shared/prompt-compose.ts`)
   to the user's prompt: one line per asset with a description that has a picture or clip among the references
   actually sent, with its tokens, its name and its description — read from the database at that moment
   (`describedAssetsFor`, which also reads the characters and outfits without one), so an edit in the library
   applies to the next generation — unless the params switch it off (`includeDescriptions: false`,
   `excludedDescriptionAssetIds`). An outfit's line names the character wearing it (`worn by Anna (@Image1)`, also
   for an outfit without a description), as `resolveOutfitWearers` decides from the params' `outfitWearers`. The words follow the prompt language, and the
   descriptions are shortened (or the legend dropped) to fit the model's `promptCharacterLimit`, which the job
   manager reads from main's cached model list (`rememberPromptLimits`). A sequence clip that continues in reference
   mode also gets `continuationLeadIn` in front of the prompt — the instruction to start exactly on @Image{N+1}, the
   previous clip's last frame, in the prompt language — counted against the limit like the prompt
   (`composeSubmission({continuationFrame})`, `SubmitOptions.continuationFrame`). A sequence take composes it when it
   reads the clip, together with its approval guard, and passes it as `sentPrompt`, so a description edited while the
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
6. **Save.** The video is written to `.studio/tmp/<id>.mp4` and moved to its place (`videoLocation`, the
   [file home rule](#the-file-home-rule)): `Sekvenser/<name>/Tagningar/` for a take of a clip,
   `Storyboards/<name>/Övergångar/` for a take of a transition, `Redigeringar/<edit>/Tagningar/` for an AI take of
   an edit (`SubmitOptions.editId`), `Genereringar/<day>/` otherwise, named after the submit time and the prompt's
   first line.
7. **Poster.** `ffprobe` reads the duration and `ffmpeg` writes a poster to `.studio/miniatyrer/<id>.jpg`. This is
   best effort: a missing ffmpeg never fails a generation.
8. **Settle.** The row becomes `completed` (or `failed` with the error), `settled` fires once (sequences use it to
   select a fresh take automatically, and `index.ts` records the video as unseen unless it is an edit's AI take) and
   `POST /video/complete` asks Venice to delete its copy.

When a library is opened, `resume()` picks up jobs that were still pending (a job that never got a queue id is
failed) and backfills missing posters and durations in the background. Only Venice generations are ever pending:
imports and versions are inserted completed.

**Video-input models** (`constraints.video_input`: the Editor's prompt edits and Topaz upscaling) are never offered
in the Generate form; only the Editor submits them. `paramsForSubmit` keeps `sourceVideo` (and `upscaleFactor`) for
them and `referenceVideos` / `referenceTask` for Seedance's reference-to-video models (reference videos of Generate
and clips too: see [Reference videos](#reference-videos-from-a-file-to-videon)), and drops all four elsewhere.
The video goes in the body as a data URL (Venice has no upload endpoint), so one request carries at most 22 MB of
media; the Editor sends a short H.264 proxy from the edit's `Underlag/`, never the film itself, and quotes with a
few-KB stand-in of the same length, since the price depends only on the length and resolution.

## Reference videos: from a file to `@VideoN`

Seedance 2.x reference-to-video models (`supportsReferenceVideos` in `shared/models.ts`) take `reference_video_urls`.
In Generate and sequence clips a reference video is a **reference only** — its action, camera movement and style —
never footage to edit or extend (the Editor's prompt-edit sends its own proxy as the video to edit, with
`referenceTask: 'edit'` and `<Video 1>` written into the prompt; none of the rules below apply to it,
`videosAreReferences` tells them apart).

1. **Data.** `GenerationParams.referenceVideos` is `ReferenceVideo[]`: `{ path, start?, length? }`, a window of a file
   like `ReferenceAudio` (absolute over IPC, stored relative like images; `db.ts` / `paths.ts` map the paths,
   `isStoredPathRecorded` and `mapStoredPaths` see them). Rows from before windows existed (the Editor's) hold plain
   path strings: `referenceVideosOf` / `sanitizeReferenceVideos` read both, `fromStoredParams` turns them into
   `{ path }` on the way out, and a path rewrite (`mapParamsJson`) keeps a string a string. `referenceVideoWindow`
   gives the window: from `start` (0) for `length` (5 s, `DEFAULT_VIDEO_CLIP_SECONDS`), cut at the file's end, never
   clamped to the limits (the checks report them). A sequence clip keeps its videos (`sequence-store.sanitizeParams`);
   the cast never holds any.
2. **Limits.** `referenceVideoLimits`: Seedance 2.0 at most 3 videos of 2–15 s, 15 s together; 2.5 at most 10 of
   2–30 s, 30 s together (another 2.x family gets 2.0's). `paramsForSubmit` keeps the videos only for those models,
   within the count; `referenceVideoModelFor` names the model to offer instead (the family's reference model, else
   Seedance 2.5's).
3. **Tokens and checks.** `prompt-refs.ts` reads `@Video1 … @VideoN` (any letter case; near misses `@Video 1`,
   `@Vid1`, `@Film2`, `@Videoklipp1`, `@Video`; "@Clip1" stays text), and checks them like images and audio: `video-out-of-range`,
   `video-over-limit`, `video-not-supported` (a mode or model without videos; the fix is `referenceVideoModelFor`),
   `video-length`, `video-too-long` and `unused-video` (issues carry `ref: 'video'`). A video counts as a reference,
   so a clip needs no picture and audio may go with a video alone. `prompt-remap.ts` renumbers `@VideoN` when videos
   are removed or reordered (followed by path, so a moved window keeps its token; `reorderReferences(params, 'video',
   …)`); `continuation.ts` carries a clip's videos into the clips that continue from it in reference mode, like its
   pictures (its own videos replace what it carries; within the reference model's count).
4. **Legend.** `composePrompt` ends the References legend with a line per video in Venice's reference wording —
   `Refer to the action, camera movement and style in @Video1 – a reference only: don't edit or extend it.` (Swedish
   `Utgå från handlingen, kamerarörelsen och stilen i @Video1 – bara som referens: redigera eller förläng den
   inte.`) — also with descriptions off, never shortened (`ComposedPrompt.videos`).
5. **Measuring.** `prepareSubmission` (every submit, `video:generate`, sequence takes, `request_generation` and
   `request_segment_generation` before the user is asked) probes every file with ffprobe (`resolveReferenceVideos`:
   a file that is no video, or a window after its end, is refused in plain words), fills in the windows and checks
   again. The quote (`venice.quote`) sends `reference_video_total_duration`, the windows' total (lengths cached by the
   file's identity, since the form asks on every change).
6. **Sending.** A file from outside the library is copied into `Referensbilder/<day>/` first, whole (an APFS clone
   on the library's volume), so "Use again" can still move the window. `buildRequestBody` cuts each window to a proxy
   (`referenceVideoProxy` → `ffmpeg.makeReferenceVideoProxy`; 30 s come to about 6.5 MB, so ten videos and the
   pictures stay inside the 22 MB of media one request takes and far under Venice's 50 MB per video), cached in
   `.studio/tmp/referensvideor/<sha1 of file identity, window and settings>.mp4` — "×4", a take made again or the same
   video in several clips is cut once; the cache lives while the library is open (`tmp` is cleared at open) and is
   pruned to 400 MB, least recently used first. The prompts' `@VideoN` become `<Video N>` (`toVeniceVideoTokens`)
   only in the body: `sent_prompt` keeps `@VideoN`. Seedance 2.5 gets `omni_reference_task_type: "reference"`, 2.0
   nothing.
7. **Window and agents.** `probeReferenceVideo` (`StudioApi.probeReferenceVideo`) gives the window a file's length,
   size, sound and a poster JPEG of a frame (cached next to the proxies). The agent tools take
   `{video: {generation_id | export_id | upload_id}, start?, length?}` items (`agent/tools/sources.ts` resolves them,
   copying an upload into `Referensbilder`), report `video_references` token maps (`agent/studio.ts
   videoTokenMap`), reorder with `videos`, and `review_generation` shows a frame of each window.

## Reference audio: from a file to `@AudioN`

Venice's reference-to-video models whose model list says `constraints.audio_input` (`VideoModel.audioInput`;
`supportsAudioInput` in `shared/models.ts`) accept `reference_audio_urls`: clips that steer a voice's timbre, tone
and pacing, or a place's ambience. Venice takes 2–15 s per clip and 15 s in all, and only together with at least
one reference image. Studio keeps the whole path inside those limits:

1. **Library.** Only characters (voices) and environments (soundscapes) have audio (`assets.ts`). `addAssetAudio`
   probes every file with `probeAudio` before anything is copied — a file without an audio stream or under a
   second refuses the whole batch — then copies the files into the asset's folder under their original names (made
   Finder-safe and unique) and records them in `asset_audio`. Each clip has a **reference window**:
   `resolveAudioWindow` defaults it to min(duration, 10 s) from the start and keeps it 2–15 s and inside the file
   (`clip_length` NULL in the database means the default). A removed clip goes to the Trash, or to
   `Referensbilder/<today>/` while generations or sequence clips still use it.
2. **Form and clips.** In `GenerationParams.referenceAudios` a clip is `{ path, start, length }` (absolute path
   over IPC, stored relative like images); `@Audio1` is the first. Adding a character to a form whose model takes
   audio also adds its first voice clip with the asset's window (`pickers/audioRefs.ts`; a switch on the
   chip turns it off, or on for an environment's soundscape), up to `maxReferenceAudios` (3) clips and
   `MAX_REFERENCE_AUDIO_SECONDS` (15) together. A clip whose window is under 2 s (`isAudioClipTooShort`; only a
   recording that short has one) is never added on the user's or an agent's behalf: it could never be sent and would
   only block the form, so the chip's toggle and the pickers say why, and agents get it in `not_added_audio`.
   `lib/generateStore.ts` follows library clips that move or get a new window. Sequence clips carry their own
   reference audio with the windows they had when it was added; a clip that continues exactly, ends on the next clip
   or has a start or end image of its own drops it with its reference images, and one that continues in reference
   mode sends the audio it carries (its own, or that of the clip it continues from).
3. **Checks.** `prompt-refs.ts` checks `@AudioN` like `@ImageN` — near misses (`@audio 1`, `@Ljud1`, `@Voice1`,
   `@Röst1`), tokens past the clips or the model, a model without audio input, a window outside 2–15 s, more than
   15 s in all, audio without a reference image, clips the prompt never names — in the editor, in the agent tools
   and in `prepareSubmission`. Main does not trust the windows the renderer sent: `resolveReferenceAudios`
   (`venice.ts`) measures every file with ffprobe, fills in missing windows (start 0, min(rest of the file, 10 s)),
   cuts them at the end of the file, refuses a window that starts past it, and the checks run again on the real
   lengths. `video:generate` and every sequence take (also in *Generate missing*) do this before the price is
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

- **Continuation.** A clip with `continue_from_previous` (never the first) starts on the previous clip's last frame: at
  submit time the previous clip's selected take is cut where its end trim cuts it and that frame is extracted with
  ffmpeg into `.studio/bildrutor/` (cached per take and timestamp), so the previous clip needs a finished selected take
  first. `segments.continue_mode` (schema 13; `shared/continuation.ts`) decides how it is sent. `references` (the
  default): the family's reference-to-video model (`referenceToVideoVariant`), the references the clip carries
  (`carriedReferences`: its own, else those of the clip it continues from, up the chain) with the frame appended as the
  last reference image (`withContinuationFrame`; the pictures get every place but the last, and what doesn't fit is
  `droppedImages`) and `continuationLeadIn` in front of the prompt (`composeSubmission({continuationFrame})`,
  `SubmitOptions.continuationFrame`). `exact`: image-to-video from the frame as the start image, no references or audio.
  Ending on the next clip, an end image of its own, a family without a reference-to-video model, or nothing to carry →
  exact (`continuationPlan` says which and why). When a clip's references change, `SequenceService.updateSegment`
  (`keepInheritedTokens`) remaps the prompts of the clips that inherit them (`inheritedTokensAt`,
  `remapInheritedTokens`: the sent pictures, then the frame), so their tokens stay on the same pictures, voices and
  frame; a clip whose source clip changed is left alone. A swap in place (as many pictures and clips, every changed one
  gone from the list: a click on its thumbnail, `swap_reference`) changes no number, so `main/inherited-swap.ts`
  (`swappedInPlace`, `followSwap`) keeps their tokens and changes only the name in front of a fully swapped group, by
  the rule the clip's own prompt follows. An older continuation stored image-to-video has no format:
  `sendParams` gives it the source clip's. A take's params record which way it was made (`continuationFrameOf` in
  `seams.ts`: the frame as its start image, or as its last reference image). Choosing *Exact start frame* drops the clip's
  own references and their tokens; *Redo between neighbours* sets `exact`.
- **Ending on the next clip.** A clip with `end_from_next` (never the last) mirrors it: at submit time the next
  clip's selected take gives its first shown frame — the first frame at or after its start trim, the frame the
  export starts that clip on (`extractFrameAtOrAfter`) — cached as `.studio/bildrutor/<take id>-first-<ms>.png`
  (another take or start trim gets a file of its own), and it is sent as `end_image_url`. The clip needs a model
  that takes an end image (`supportsEndImage`); turning the flag on switches it to one (`endImageVariant`, with
  the options the new model offers). Both neighbours are checked before either frame is extracted or anything is
  paid for. Together with `continue_from_previous` this is *Redo between neighbours* (see below).
- **Generate missing.** `startGenerateAll` makes every clip without a finished selected take (and none
  rendering) in dependency order (`generationOrder`): a clip comes after the neighbours whose frames it takes, so
  a chain of continuations runs forward and a clip ending on the next clip waits for that clip; otherwise the
  sequence's order; the order is worked out again after every take, since the user may change the clips
  meanwhile. Before the first take, every missing clip is checked (`missingClips`), so a later clip that can't be
  sent as it stands stops the run before anything is paid for — and so do two clips that wait on each other (clip
  N ends on N+1, which continues from N, neither made), with a `runError` that says which switch to turn
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
- **Takes and trims.** The trims in `segments.trim_*` are the selected take's. When another take is selected (a click in
  the take strip, an agent's `selected_take_id`, `autoSelect`), the old take's trims are remembered in `take_trims`
  (`rememberTrims`) and the new take gets the trims it last had (`trimsFor`); trims passed in the same change win, and
  the window saves an open trim draft before the selection reaches main. A take that never had any gets the clip's
  trims, except at a side it was made to meet exactly (`seamTrims`): a start made from the previous clip's last frame
  (as its start image or, in reference mode, its last reference image; or from a frame of the clip's own take, the
  opening *Redo between neighbours* keeps for a first clip), an end made from the next clip's first frame. That side
  starts untrimmed, since a trim meant for another take would cut away the very frame the take was generated from.
  Either way the result is clamped to the take (`clampTrims`). Storyboard transitions have no trims and write nothing
  there; a take taken off its clip forgets its row (`releaseTake`), and the export reads only `segments.trim_*`. A cut
  counts as seamless when either side's take was made from the other's frame as it is now (`shared/seams.ts`; a
  continuation's frame counts whether it was the take's start image or its last reference image), so a clip redone
  between its neighbours doesn't make the neighbour that continued from its old take look out of date.
- **Export.** Every clip needs a usable selected take. `buildConcatClips` turns them into `{path, start, end}`
  clips and drops one copy of every picture two clips share at a cut, judged from the takes themselves rather than
  the switches: the first frame of a continuation clip whose take was made from the previous clip's last frame
  (`repeatsPreviousFrame`, also for a take that had the frame as its last reference image, which starts close to it;
  starting it half a frame in, unless a start trim already skips it), and the last frame
  of a clip whose take was made to end on the next clip's first frame (`dropsLastFrame`) unless that next clip
  already drops the picture as its own first frame; never both copies. A take made otherwise (the old take of a
  clip just set up to be redone between its neighbours) keeps its real first and last frames. `concatClips` builds one
  ffmpeg filter graph: each clip is trimmed, set to the first clip's frame rate, scaled and padded to its size,
  audio cut to exactly the frames the trim keeps (`frameSpan`: trims come in 0.1 s steps, so a cut usually falls
  between two frames, and sound running past the picture would pile up over the cuts until a frame shows twice),
  resampled to 48 kHz stereo (silence for clips without audio), then concatenated and encoded as H.264 (CRF 18) /
  AAC 192 kb/s with `+faststart`. Progress is read from `-progress pipe:1` and sent as `export:progress`. The film
  is rendered into `.studio/tmp`, moved to `Sekvenser/<name>/<name> <YYYY-MM-DD HH.MM>.mp4` and recorded in
  `exports`, with the times where the clips meet (`exportCuts`, measured the way the export cuts) in `cuts`.
  The film's size is the first clip's, unless the sequence has an *Export format* (`export_height` 480, 720 or
  1080: the first clip's aspect at that height, even pixels) — useful when own footage and AI clips are mixed.
- **Own clips in a sequence.** A clip's take may be an import or a version from the Editor (see
  [Own clips](#own-clips)); continuation, *End on the next clip's first frame*, *Redo between neighbours* and the
  export work unchanged, since they read the selected take's file. A new clip made from such a video
  (`insertSegment`) gets the previous clip's settings with prompt and keyframes cleared (or the defaults), never
  the video's empty params, and doesn't continue from the previous clip. When its file is missing, `clipProblem`
  and `missingClips` say that clip N's own video is missing instead of asking for a prompt.

## Songs: data, analysis, lyrics

*New sequence from a song…* makes a sequence cut to the user's own song, for a music video: every clip has its place
in the song, the clips cover it end to end, and the film plays the song instead of the clips' own sound.

- **Data, without a migration.** The song is `Sequence.song` (`SequenceSong`: the file, its name as imported, its
  length, the separated vocals, the lyrics), stored under the key `song` of the sequence's defaults JSON with relative
  paths (`sequence-store.parseSong` / `writeSequenceSong` / `updateStoredSong`; `serializeDefaults` keeps it as stored,
  and keys of it that main doesn't read are kept while the file stays the same). The takes' sync measurements are not
  in it: they live in `.studio/song-sync.json` (see [Songs: sending, sync, export](#songs-sending-sync-export)). A clip's
  place is `params.song` (`SongWindow`: start, end, what it hears — `vocals`, `mix` or `none` — and who sings), kept and
  cleaned by `sanitizeParams`. What the song service is doing (`songWork`) and why its last step failed (`songError`)
  live in memory and are merged in by `loadSequence`.
- **Files.** The song is copied into `Sekvenser/<name>/Ljud/` and the vocals are written next to it as
  `<name> (sång).flac`, through the sequence service's file queue, which also holds the folder while song work reads
  or writes it (`holdSongFolder`: no rename meanwhile); a renamed sequence's folder carries them, and their stored
  paths are rewritten like every other. Taking the song off leaves the files where they are.
- **Background work** (`song.ts`), one step at a time per sequence: separate the vocals (`separateStems`, free), then
  transcribe (if asked), analyse, and split the song into clips while its places haven't been chosen (no clips yet, one
  empty clip, or empty clips Studio placed itself when the song was put on them). When the lyrics come, or the vocals'
  analysis, the empty clips whose part Studio decided hear what their places now suggest (`redecideSongParts`: a part
  other than the one Studio would have chosen was chosen by hand and stays). A step that fails sets `songError` and the
  next goes on without it; progress is announced at most twice a second, and a step that can't tell (a transcription)
  shows none.
- **Lyrics.** Transcribed from the vocals when there are any (the mix otherwise) as 64 kb/s mono MP3, with a model that
  times every word (Scribe by default, `lyricsModelOf`). The price (`transcriptionPriceUsd`) is checked against the
  budget before anything is made (`OVER_BUDGET` unless confirmed); the paid call is recorded as a finished `media_jobs`
  row (op `transcribe`, no edit, `request.sequenceId`, its cost) that Spending places on the sequence as a transcript,
  noted as the agent's when an approved request ran it. Lines come from the ASR's segments, or are split at pauses over
  0.6 s, at punctuation and at 10 words (`shared/song.ts lyricLines`). A corrected line keeps each word's time when it has
  as many words, else its words share the line's span by length (`retimeLine`); an empty one is removed.
- **Analysis** (`song-analysis.ts`, cached by the files' size, time and inode in `.studio/tidslinje/song-*.json`):
  peaks of the song and the vocals (`ffmpeg.waveform`); the onset strength (log-magnitude spectral flux, 11.6 ms
  frames at 11 025 Hz), its tempo by autocorrelation in 60–180 BPM leaning towards 120, the beats by dynamic
  programming (a steady beat only: none for speech); bars when one beat of every three or four is clearly the loudest in
  the low end; and where the vocals sing (28 dB under their loud parts, pauses under 0.3 s bridged).
- **Places** (`shared/song.ts`). `suggestSections` chooses all cut points at once by dynamic programming over the
  candidates — every beat, the middle of every pause between lines, a grid where nothing else is — so that every place
  is 2–15 s and close to the target, and the cuts fall between lines (or vocal pauses) on a bar or beat rather than in a
  word. `checkSongBoundaries` refuses cut points outside the song, out of order or making a place under 2 s, in words
  the user can act on.
- **The clips' rules** (`sequences.ts`). `setSongSections` gives the clips their places in order (a take's duration
  follows: `songClipDuration` with the model's durations), adds clips at the end (empty, with the cast, not continuing)
  or removes untouched ones there, and refuses — changing nothing — when a clip that would go has takes, a prompt or
  notes. A new place hears the vocals where words are sung (or, without lyrics, where the vocals are active), else the
  mix. In a song sequence clips can't be moved, a clip added splits the place of the clip before it on the beat nearest
  its middle, a deleted clip's place goes to the clip before it (the next for the first), new params keep a clip's
  place, and `removeSong` takes the song off, the clips keeping everything but their places.

## Songs: sending, sync, export

How a song sequence's clip is sent, where its takes sing, and how the film is cut to the song.

- **Sending** (`shared/song-send.ts`). `takeParams` (main) and `asSent` (the agent tools) run the clip through
  `withSong`: a clip that hears the song (`part` `vocals` or `mix`) sends exactly its window of the song as its only
  reference audio (`songAudioReference`: the vocals file for `vocals`, the mix otherwise, at most 15 s), so the cast's
  voices give way; `params.song.lyrics` is filled with the words sung in the window (`lyricsInWindow`), and a `vocals`
  clip is made with sound (`audio: true`: the take's own sound is what the sync measures; the film never plays it). A
  `none` clip sends what it has. The take's stored params keep the window and the words, so a moved place can still
  place it. `songClipProblem` refuses, before anything is paid, a clip that hears the song with a model that takes no
  reference audio, a place outside the song or under 2 s (`clipProblemAt`, the agents' `sendProblem`).
- **The legend line** (`prompt-compose.ts`). The song's clip is found among the sent audio by its window
  (`songAudioNumber`; no asset owns it) and explained by the References legend's last line, in the prompt language:
  "@Audio1 is the lead vocal of this moment of the song: Anna (@Image1) sings exactly these words, on the beat, lips in
  sync with every syllable: “…”." (the singer: `song.singer` among the pictures sent, else the first character, nobody
  for null), or the music line for `mix`. It is not a description: it is appended with *Include descriptions* off too and
  is never shortened (`ComposedPrompt.song`). The checks (`prompt-refs.ts`) count it as explained, refuse a place under
  2 s as a place (`song-place`), note one over 15 s, and note a chosen singer who isn't among the pictures
  (`song-singer`, from `explainedReferences().singerFallback`).
- **Sync** (`song-sync.ts`, free). When a take of a `vocals` clip finishes (the job manager's `settled`, after the
  sequence service has selected it), it is measured one at a time: its sound on its own time line (`extractAudio`), its
  voice separated when the Mac can (`separateStems`), and the song's vocals over the place the take was made for (at
  most the 15 s that were sent) are turned into log-RMS envelopes (5 ms steps at 16 kHz, floored 40 dB under their
  loudest moment); the lag with the best Pearson correlation in [−0.25 s, the take's length − the place's] (refined
  between steps on a parabola) is where the place begins in the take. `matched` when the correlation is at least
  `SYNC_THRESHOLD` (0.5; tuned on the fixtures: the vocals however late ≥ 0.99, the mix sung over ≈ 0.87, another voice
  0.77–0.97, the drums, noise, a tone, silence ≤ 0.37); else the offset is 0. It measures timing, not words. `mix` and
  `none` clips get `measured: 'none'`. `songs:syncTake` measures a take again.
- **The cut** (`reconcileSongTrims`, `shared/song-trims.ts`). Each clip with a place and a finished selected take starts
  it at `songTrimBase` — the offset plus how far the clip's place starts after the place the take was made for — plus
  the take's nudge there, and keeps exactly the place's length (`songCut`: the end trim follows, at least 0.2 s left; a
  take too short keeps its end and says by how much, and the film holds its last frame). It runs whenever the sequence
  service announces a change (`changed`: a place moved, a take selected, a trim changed), when a take settles or is
  measured, and before an export. A start trim that differs from the one it last wrote is the user's nudge and is kept,
  per take (a take selected again gets its own back). The measurements and that bookkeeping live in the library's
  `.studio/song-sync.json` (`song-sync-store.ts`: per take its TakeSongSync and the place measured; per clip the take,
  the trim written and the nudges), written through a temp file and pruned of takes and clips that are gone; no schema
  change. `loadSequence` adds them as `Segment.songSyncs`.
- **Export.** A song sequence's clips must cover the song end to end without gaps (`songPlacesProblem`, before
  rendering, as is a missing song file). `buildSongClips` gives every clip its place on the film (`ConcatClip.at`):
  `concatClips` makes each exactly round(end · fps) − round(start · fps) frames from its start trim (counted from the
  song's start, so nothing drifts over many clips; `tpad` holds the last frame of a short take), and the song, from 0,
  cut or padded to the picture, is the film's only sound (`soundtrack`); the cut points recorded are the places' first
  frames (`songExportCuts`). The preview (the renderer) plays the takes muted under the song: song time = place start +
  (time in the take − trim start).

## Keyframes and stills

A sequence's clips can start and end on chosen pictures (keyframes); they are set in the clip editor (a file or a
library photo) or by agents, and nothing about them is stored apart from the clips themselves and their stills.

- **Keyframes.** A clip's start and end image are `params.startImage` / `params.endImage`. `setSegmentImage`
  fills a slot from a picked or dropped file (copied into the sequence's `Storyboard/` as a still), a library
  photo (used where it is), a still, a frame of a take (saved as a still), or the neighbour (`previous` / `next`,
  which set the flags); `null` empties it. A clip with an image is generated image-to-video with its family's
  image-to-video model (one that takes an end image when it has one; `asKeyframed`), so its reference images and
  audio are dropped and their `@ImageN` / `@AudioN` tokens taken out of the prompt (`withoutReferenceTokens`;
  token legend lines such as "@Image1 – Anna …" go too). Duration, resolution and aspect ratio are fitted to the new
  model from the cached model list (unchanged without it); the audio setting is kept where the model allows it.
- **Redo between neighbours.** `bridgeSegment` (free) sets `continue_from_previous` (with `continue_mode` `exact`) and
  `end_from_next` as the clip's position allows (a sequence needs at least two clips) and switches it as above, keeping
  its prompt (minus its `@` tokens), duration and audio setting. The first clip keeps its own start image, or gets the
  first frame its current take shows saved as a still; the last clip ends where it likes or on its own end image. The
  new take is generated like any other, but isn't selected automatically while the old one is usable (`autoSelect`): the
  old take stays selected until the user clicks the new one in the take strip, and stays among the takes.
- **Frame previews.** `previewSegmentFrames` returns the start and end image the clip would be generated from
  right now (the neighbours' frames, extracted and cached as above, or its own keyframes) and why it can't be
  generated as it stands. The clip editor's *Start on the previous clip's last frame* / *End on the next clip's
  first frame* switches and the approval dialog show them.
- **Stills** (`stills.ts`, table `stills`). Every picture made or taken in for a sequence's keyframes or a
  storyboard's boards is a still with a file of its own (library photos are used where they are): generated
  (*Create image…*, or an agent's approved image request), uploaded (a file put onto a board or into a slot; the same
  content dropped again into the same sequence or storyboard gives the same still) or a frame of a take
  (`saveFrameAsStill`: the frame a paused player shows at that moment; the same frame again gives the same still).
  A still of a sequence lives in `Sekvenser/<sequence>/Storyboard/`, a still of a storyboard in
  `Storyboards/<storyboard>/Bilder/`, one without either (or of one that has no folder yet) in
  `Referensbilder/<day>/`. Generated stills are named `<HH.MM> <prompt excerpt>.png`, frames
  `<HH.MM> Bildruta <t> s <prompt>.png`, uploads keep their own name. Placing a picture never creates a sequence
  folder that a rename just moved away: the file is linked into the folder the database names and recorded in the
  same tick as the last check of where that folder is; a paid-for picture that can't go there is kept in
  `Referensbilder/<day>/` rather than lost. Deleting a still that clips, boards, generations or other stills
  still use moves it to `Referensbilder/<today>/` and those rows follow (`filesMoved`); otherwise it goes to the
  Trash. A storyboard's stills open full size from a board's list of the storyboard's pictures (`StillViewer`), where they can be
  put onto that board or deleted. Still work (generating, saving, importing, deleting) counts as busy for a library
  switch or *Tidy up*.
  *Tidy up* puts every still back into its sequence's `Storyboard/` or its storyboard's `Bilder/` (or
  `Referensbilder/<day it was made>/`).
- **Generating a still** is paid (about $0.06 with the default Seedream models) and goes straight to Venice from
  `generateStill`: `planStill` first checks the request against the model (references only for edit models, at most
  `maxInputImages`, existing image files, the prompt length, the aspect ratio, resolution and quality the model has;
  the storyboard's or the sequence's aspect ratio by default) and fills in what is sent, so the price shown is the
  price paid. References from outside the library are copied into `Referensbilder/<day>/` first. Without references
  `POST /image/generate` (default `seedream-v5-pro`), with them `POST /image/multi-edit` (default
  `seedream-v5-pro-edit`, the first reference is the base picture). `safe_mode` follows *Safe mode for images*.
  The window shows the price on the button before anything is paid for; an agent's `request_image_generation` waits
  for the user's approval like a video.

## Storyboards: boards and transitions

A storyboard (`storyboards.ts`, the *Storyboards* view in `components/storyboards/`) plans a film as its
milestones: an ordered row of **boards**, one picture each, and between every two neighbouring boards a
**transition** — the clip generated image-to-video from the first board's picture (`image_url`) to the second's
(`end_image_url`). Underneath it is a row of `sequences` of kind `storyboard` whose segments are its transitions, so
takes, folders, approvals, previews and the export are the sequence service's; what is its own lives in
`StoryboardService`.

- **Kept apart from sequences.** `listSequences` lists only kind `sequence`, `listStoryboards` only storyboards, and
  each side's handlers refuse the other's ids with a pointer to the right tools (`requirePlainSequence`,
  `requirePlainSegment`, `requireStoryboardRow`, `requireTransitionRow`). The sequence service's change
  notifications are routed by kind in `index.ts`, so the Storyboards view hears `storyboard:change`.
- **Boards** (`storyboard_boards`). A board's picture is a library photo or a still used where it is, or a picked
  or dropped file or a frame of any finished clip, which become stills of the storyboard (`importStillFile`,
  `saveFrameAsStill`) in `Storyboards/<name>/Bilder/`. A path held across that wait follows a folder rename made
  meanwhile (`followRewrites`). A board can be empty. `aspectMismatch` compares the picture's size (read from its
  PNG, JPEG — turned by its EXIF orientation — or WebP header by `imageSize`, cached by size and change time) with
  the storyboard's aspect ratio, 3 % tolerance; the view marks it as another format.
- **Transitions follow the boards.** `syncTransitions` runs after every change to the boards (create, add, picture,
  move, delete), in the same transaction: for every adjacent pair (bᵢ, bᵢ₊₁) the segment with exactly that
  `from_board_id` / `to_board_id` is kept — with its prompt, settings and takes — or a new one is made from the
  storyboard's `defaults` (Seedance image-to-video, 5 s, 480p, sound; the settings last chosen for a transition
  there); positions follow the boards; `params.startImage` / `params.endImage` are the two boards' pictures, the
  model one that takes an end image, no reference images or audio, `continue_from_previous` and `end_from_next`
  0. Segments whose boards are no longer neighbours are deleted and their takes freed afterwards
  (`SequenceService.freeTakes`: the videos go back to `Genereringar/<day>/` like the takes of a deleted clip;
  generations are never deleted). The view asks before an insert or a move that would remove a transition with a
  prompt or takes (`transitionsLost`); a board's delete confirmation says the same. An agent's insert or move that
  would remove one with a prompt, a negative prompt or takes is refused inside the change's transaction (the tools
  check first, `boards:moveLoss` for a move); such a move is something the user approves (`request_delete` with a
  `board_move`, carried out through `callApproved`). A new picture on a board updates
  its two transitions' params; their takes stay, and a selected take whose start or end image differs from the
  boards' pictures now is `staleTake` (marked as made from an earlier picture). A finished take made from the pictures there now replaces
  such a selection (`autoSelect`, `madeFromEarlierBoards`), and when a transition's selected take is deleted it gets
  its newest finished take, one made from the current pictures first (`reselectTransitionTake`), so it isn't shown
  as not generated or paid for again by *Generate missing*.
- **A transition** (`Storyboard.transitions`) carries `ready` (both boards have pictures) and `problems` (a board
  without a picture or whose file is gone, no prompt, a model that can't end on a picture, a prompt with
  `@` tokens). `updateTransition` changes the prompt, negative prompt, duration, resolution, sound, model (only an
  image-to-video model that takes an end image, checked against the model list when it can be had; the other
  options are fitted to it) and the selected take; a model with formats of its own gets the storyboard's aspect
  ratio, the others take the pictures' shape. `generateTransition` refuses while a problem stands or a take is
  already on its way, then submits the segment like a clip's take (`generateSegment`). Every take of a transition,
  from the window, *Generate missing* or an approval, goes with a submit guard (`transitionGuard`: an approval's
  guard, then the transition's problems) that runs on the very database state the take is built from, so a board
  emptied while the take waited for the file queue or the model list is never paid for without its picture.
- **Generate missing** (`start`, `missingTransitions`). Every transition without a usable selected take and with
  none on its way is sent, one after another; each waits only until Venice has the job, since transitions don't
  depend on each other's takes. If any of them can't be made as it stands the run stops before anything is paid
  for (`runError` naming the transition; a consent request stays raw as `NEEDS_CONSENT:` so the view can ask). Stopping
  calls the take on its way off right before Venice is paid (`cancelled`, `isCancelledSubmit`). While it runs,
  agents may not change the boards or transitions, and the run counts as busy for a library switch.
- **Export.** `exportStoryboard` goes through the sequence service's export into `Storyboards/<name>/` with
  `buildStoryboardClips`: neighbouring transitions share their board's picture — the earlier ends on it, the later
  starts on it — so a later transition whose take started on exactly the picture the previous take ended on
  (`repeatsBoardImage`, judged from the takes' own start and end images) starts half a frame in and the board is
  shown once. A take made from another picture keeps its first frame.
- **Making a sequence of it** (`convertToSequence`) creates "<name> (sekvens)" in `Sekvenser/` with one clip per
  transition (its params — the two pictures as start and end image — and the boards' notes as its notes) and a
  copy of each selected take (`copyTake`: its own video in `Tagningar/` and poster, no price, so the clip feed
  doesn't count it twice), selected, starting half a frame in where the storyboard's export drops a frame — so the
  sequence's film cuts the same way. If a copy fails the clip selects the original take. The storyboard is left as
  it is.
- **Files.** `Storyboards/<name>/` holds `Övergångar/` (the transitions' takes), `Bilder/` (its stills) and its
  exports; renaming the storyboard renames the folder and rewrites every stored path below it, board pictures
  included. Deleting it releases its takes to `Genereringar/`, keeps the stills generations, clips or other boards
  still use (in `Referensbilder/<today>/`) and trashes the rest; exports stay. *Tidy up*, a library move and the
  "is this path recorded" checks know `storyboard_boards.image_path`. A library from before schema 10 whose base
  folder already holds a non-empty `Storyboards` folder of the user's own is refused, like `Miljöer`, `Kläder` and
  `Poser`.

## Own clips

The user's own video files come into the library as `generations` rows with `source = 'import'`, so they can be
used wherever a finished generation can: in the clip feed, as a clip or a take in a sequence that AI clips continue
from, and as the starting point of an edit. `src/main/imports.ts` does the work; the window's flow (file dialog,
drops on the feed, a sequence's timeline or a clip's takes, the questions before, progress cards) is
`components/feed/ownClips.tsx`. Agents import video files they uploaded (`import_own_clips`): `imports:inspect` and
`imports:import` take only files that pass `assertAgentFiles`, and `file:pickVideos` refuses them.

1. **Inspect (free).** `probeMedia` reads every file: video stream, size, length, frame rate, HDR (HLG/PQ), bit
   depth, rotation, variable frame rate and every audio stream with whether ffmpeg decodes it. A file without a
   video stream, or one that can't be read, is refused by name. `cloneable` says whether the file is on
   the library's volume and that volume is APFS (an APFS clone then takes no extra space; on exFAT, FAT or HFS+
   `COPYFILE_FICLONE` would silently copy, so those count as copies; above 2 GB without a clone the window asks
   first). A
   file is hashed (SHA-256) only when an earlier import has the same size, and `duplicateOf` names that import while
   its file still exists — so a multi-GB phone film isn't read twice just to open the dialog.
2. **A working copy only when needed.** HDR, more than 8 bits, larger than 1080p, a variable frame rate, rotation
   metadata, ProRes or another codec Chromium can't play, a first audio track ffmpeg can't decode (newer phones
   put a spatial-audio track first), pixels that aren't square (HDV, DV, anamorphic modes) or sound and picture that
   start more than half a frame (at least 25 ms) apart each give a reason, and `normalizeVideo` then makes
   `<name> (arbetskopia).mp4`: H.264 SDR (HLG and PQ tone-mapped), ≤1080p, at most 30 fps, constant frame rate,
   upright, square pixels, both streams from the file's time zero, the first decodable audio track as AAC (mono on
   both sides at full level), metadata (GPS included) stripped. The export and the Editor's cuts start each stream at
   its own first frame or sample, which is why such files get a working copy. The original stays untouched
   next to it (`original_path`). Without a working copy the file is used as it is; nothing sent to Venice carries its
   metadata anyway (proxies strip it, frames are PNGs).
3. **Import.** Every file is probed before anything is copied, and one bad file never stops the others. Then, one
   file at a time: a disk-space check (2 GB must stay free), an APFS clone (`COPYFILE_FICLONE`) or a streamed copy
   with progress into `.studio/tmp`, the SHA-256 on the way, the working copy (also when the user chose to fill
   the picture, cropping it to a sequence's shape), the poster and length, then a rename into `Egna klipp/<day>/` and a
   completed row (`model` and `prompt` empty, no price, `title` = the file's name, `recipe.import` with name, size,
   hash and the working-copy reasons). A file already imported is reused instead. A file card's *Cancel* stops that file's copy or
   working copy (or skips it when it hasn't started) and removes what was half made; nothing visible is left behind,
   and the other files go on.
4. **Targets.** The feed; a sequence (one new clip per file, in name order, each after the previous, through
   `SequenceService.insertSegment`); or a clip (a new, selected take through `addTakeFrom`). When the film's shape
   differs from the sequence's, the window asks whether to fit it with borders (padded at export) or fill the picture (cropped).
   Into a sequence whose only clips are untouched empty ones (the first clip a new sequence starts with) there is no
   question: the films take the empty clips' place. They are deleted with `deleteSegment(id, { onlyIfUntouched })`,
   which main checks in its file queue right before the delete, so a clip filled while the import ran (a prompt, a
   picture, a take on its way) stays.

While an import runs, a library switch or *Tidy up* is refused (an own-clip import is running).

### The file home rule

A file's folder follows from its row, and `jobs.videoHome` / `videoLocation` is the one place that says where; the
job manager, the sequence service, the import and edit services and *Tidy up* all ask it:

| Row | Home folder |
| --- | --- |
| `source = 'import'` with `edit_id` (an exported film cloned in as an edit's v1) | `Redigeringar/<edit folder>/` |
| `source = 'import'` | `Egna klipp/<day it was imported>/` — also when it is a take of a clip |
| `source = 'edit'` with `edit_id` (a version) | `Redigeringar/<edit folder>/` |
| `source = 'generated'` with `edit_id` (an AI take of an edit) | `Redigeringar/<edit folder>/Tagningar/` |
| anything else (and versions whose edit was deleted) | the sequence's or storyboard's takes folder, else `Genereringar/<day>/` |

An import's original sits next to its working copy (`originalHome`). Imports and versions are named by their title,
so they are never renamed "… Utan prompt"; an import never moves into a `Tagningar/` folder, and a version only once
its edit is gone and it is a clip's take. Copying a take into another clip (`copyTake`,
`addTakeFrom`, making a sequence of a storyboard) keeps `source`, `title`, `recipe` and `original_path` — the original is then
shared, and deleting a generation trashes it only once no row records it — and drops `edit_id` and `parent_id`, so a
copy never shows up as another version of the edit.

## Editor: edits and versions

The Editor (`components/editor/`, `edits.ts`, `edit-ops.ts`, `edit-store.ts`, `edit-mix.ts`) changes one finished,
continuous film. An **edit** starts from a generation used where it is — a feed clip, a take, an own film, another
edit's version — or from an exported film, which is cloned into the edit's folder as an import row with `edit_id`
(its cut markers from `exports.cuts`, else from scene detection). That film is **v1**. Every change is a new
**version**: a completed generations row with `source = 'edit'`, `edit_id`, `parent_id` (its base), `title`
"<edit> vN", and a `recipe`, in `Redigeringar/<edit>/<edit> vN – <change>.mp4` (times in the name written `0m41.5s`). The original is never touched.
`edits.current_generation_id` is the version shown and built on; a finished result becomes current when the current
version is still its base, otherwise it is a branch in the tree.

- **One plan for everything.** `planEditOperation` (free) is the single check for the window and for agents: it
  normalizes the operation (the range snapped to frames, cut markers, transcript lines and what the model allows;
  defaults filled), works out what will be sent and what it costs — Venice's free quotes where they exist, the
  published per-character prices for `/audio/speech` (shown with ≈), per-line quotes for queued TTS (Venice has a
  per-request minimum), per-chunk voice-changer quotes in whole seconds — and returns notes, warnings and
  problems with a fingerprint of the base file, the operation and the price inputs. `runEditOperation` plans again
  and refuses when a paid price rose above what the user (or the approval) saw by more than $0.01. Prices are written
  `$0.51` as everywhere in Studio; a click asks once more above $5, for an unknown price or for one that leaves a part
  out (a voice clone), and a retry after Venice's consent dialog keeps the confirmed price as its ceiling.
- **The sound is layers, not mixdowns.** A version's `recipe.mix` (`AudioMix`) says how its sound is built: a bed
  (v1's own sound, or a rendered `bake` after a cut), optionally split into voice and background stems, gain spans
  (volume, mute, ducking under a new line) and layers of edit media (lines, converted voice, music, effects, added
  files) placed on the time line. Every audio operation copies the base's mix, changes it and renders it again from
  the sources (`renderMix`), so a later volume change or a removed music layer never stacks on an earlier mixdown.
  Layers only point at the edit's own media in `Ljud/`; a library clip added to a film is copied there first.
- **Free operations** (trim, cut, fade, volume, mute, denoise, loudness, add audio, layer changes) render on the
  Mac, one at a time, with `edit:progress`, and insert the version at once. Trims and cuts are frame-exact
  (`spliceVideo`) and carry the transcript and cut markers along (`timing: 'changed'`, with the spans).
- **Paid audio jobs** (transcribe, change voice, speak lines, music, effect, voice design) are `media_jobs` with
  one step per request. Each step is stored before it is sent and set `sending` right before the request; queue
  endpoints are polled with the job manager's backoff and fetched into `.studio/redigering/<job>/`; at most three
  steps run at once, and a voice clone runs first, alone. When every step is done the parts are put together
  (converted voice chunks aligned to the sample and anchored at their absolute positions; spoken lines fitted with
  up to 15 % tempo), saved as edit media and rendered into a version. *Cancel* stops only unsent parts.
  **Nothing paid is ever sent by itself after a restart:** a step found `sending` is failed with an error saying Venice's answer never
  arrived and it may have been charged (never resent), queued steps are fetched (they are paid), and a
  job with unsent parts waits as failed (Studio was closed before every part was sent) to be continued, which
  quotes those parts again and needs the user's click (or an agent's new approval). The button shows what the
  priced parts cost (`resumePriceUsd`, with `resumePartialPrice` when a part such as a voice clone has no price, and
  `resumePriceNote` when every such part is a clone); when Venice's price rose meanwhile the click is refused and the
  parts' stored quotes are refreshed, so the button shows the price that is checked. A quote that fails during the
  click keeps the part's stored one (what the job's cost adds when it is sent). Change voice on chosen lines lays in only those lines' stretches of the converted
  sound (a part may run across the gap between them, billed once, but whoever speaks there keeps their own voice).
- **Picture operations** (regenerate a range between the frame before and after it, edit a range with a prompt,
  extend after the end, upscale) are AI takes submitted through `JobManager.submit` with `editId`: the frames or a
  short H.264 proxy (≤720p, ≤22 MB) go into `Underlag/`, the take lands in `Tagningar/`, and when it settles the take
  is spliced into the film (scaled to the range's length; more than ±8 % is refused as a failed take) with the sound
  kept or taken from the model, and the job becomes a version. A finish that fails locally (a full disk) leaves the job failed, to be continued for
  free, which splices the paid take in again; one that would fail the same way again (a take of the wrong length,
  or one that can't be read) can't be continued (`noRefinish`), and a picture job's row can always be hidden, since its
  paid take stays among the edit's takes. Seedance edits send the proxy as a reference video
  with the canonical `Strictly edit <Video 1>, …` prompt; Venice's consent request reaches the window's consent
  dialog as for any generation.
- **Transcripts** are stored per generation; a version with the same timing inherits its parent's
  (`inheritedFrom`), a cut carries a remapped copy, and an edited line stores a copy first. Deleting or pruning a version, or deleting
  an edit, hands its own transcript to the versions that inherit it (kept ones too), so a paid (and corrected) transcript isn't lost with it. SRT goes through a save
  dialog (`saveSubtitles`), never next to the video.
- **Voices.** A character's voice clip is cloned (`tts-chatterbox-hd`, a handle valid 7 days, reused from
  `voice_clones`) only when the user ticked *May be cloned for new lines* (`clone_consent_at`). Every line in a cloned voice checks
  that consent again right before it is sent; withdrawing it forgets the clip's handles, and continuing the job is refused. *Design a voice with AI*
  (`designVoice`) is a one-step job whose result is added to the character as a new voice clip.
- **Deleting.** Deleting a version is refused for v1, for versions a sequence uses and for another edit's original;
  its children move up to its parent; its confirm names a stopped job that builds on it and has already paid for
  parts. *Clean up versions…* trashes every version that is neither v1, the current one nor one of its ancestors, and
  that no sequence uses, no other edit started from and no stopped, partly paid audio job builds on (a dry run first
  says how many and how big). Deleting the edit (refused while a job runs) keeps versions that sequences or other edits use (moved
  to their home, without `edit_id`), turns AI takes into ordinary generations in `Genereringar/` (their inputs to
  `Referensbilder/`), and trashes the rest with `Ljud/`, `Underlag/` and the folder — after moving out any file in it that a row still
  records (a take's start image a sequence clip was seeded from goes to `Referensbilder/`; the folder stays if one
  can't be moved). A feed clip an edit started from is never touched; deleting one from the feed is refused while the
  edit exists, as is deleting what a running job works on or a stopped one has paid parts for. Takes the Editor keeps
  are flagged `keptByEdit` when a sequence or storyboard is loaded, so the take strip's menu offers to remove the
  take from the clip (or the transition) rather than to delete it, and the click sends `release` so main never
  does more than the menu said.
- **Sending.** `sendEditToSequence` adds a version to a sequence as a new clip or as a selected take of a clip
  (`addTakeFrom` / `insertSegment`); never to a storyboard, and not while *Generate missing* runs there.

While a render, a separation or a paid job of this session runs, a library switch is refused (an edit is
running), so a half-sent job's runner is never carried into another library.

## Status: Activity

*Activity* shows what Studio is doing and what has finished that the user hasn't looked at yet, wherever it
was started. Main builds one summary and the window keeps one store of it, which the sidebar, the lists, the cards,
the take strip and the panel all read.

- **Running** (`src/main/work.ts`). Videos at Venice are the pending `generations` rows; everything else lives only in
  memory and is read through small registries: the submits on their way (`JobManager.sending()`, and the sequence
  service's takes by clip), *Generate missing* runs (`SequenceService.activeWork()`, `StoryboardService.activeRuns()`),
  pictures being made (`activeStills()`, by the dialog's `workToken`), the Editor's paid jobs and free renders
  (`activeWork()`), exports, imports (`ImportService.active()`), approved agent requests being carried out
  (`ApprovalStore.executing()`) and agents' uploads (`UploadStore.active()`). Each item gets a label (the clip, board or edit and
  where it belongs, such as *Clip 3 in “Sommar”*), a phase (generating with a percentage, queued at Venice, clip 2 of
  5 …), an estimate (Venice's average minus the elapsed time; for a queued video what
  the model's last 20 videos took; ffmpeg work from its progress) and `via` when an approved agent request started it.
  A run counts only while none of its takes shows, so a run with one clip at Venice reads 1, not 2.
- **Finished, not seen** is the `unseen` table. A row is added where work finishes: a video settling (not an edit's AI
  take), a picture saved or failing after its request went out, an export placed or failing while rendering, a run
  that stopped on a problem, a version a paid job made, a paid job or voice design failing, a designed voice. Not
  imports, copies of takes, the export cloned into an edit, free renders, saved frames, uploaded stills or what agents
  add to the library. Rows leave only through the user's `work:markSeen` / `work:markAllSeen` (kept 10 s for
  *Undo*) or with their item (the foreign keys); an error-only row goes when its sequence, storyboard, asset or edit
  is deleted, and a failed job's row when the job runs again.
- **Views and owners.** Every item counts under one sidebar view and its owner (a sequence, storyboard, edit or asset)
  and clip: a take under Sequences or Storyboards rather than Generate, a version or a job under the Editor, a designed
  voice under its character's view. What was made in Generate counts there while it is in Generate's list (this
  session, `inGenerateSession` in `shared/session.ts`, with `Registries.session`; a video still at Venice, or one that
  was when the session began, stays) and under Media (`media`) after that, as does a picture that belongs to no sequence or storyboard. `byView`, `byOwner` and `total` are exact; the list holds the newest 200, and
  `more` every older one as a small reference (key, failed, the file that marks it seen), so the window's *New*
  marks and seen rules cover them too. An error is stored without the folders of the paths it quotes
  (`withoutLocalPaths`: ffmpeg names files by their full paths). When the library closes (`onClosed`, also when its
  folder goes missing) the summary is reset, so the Dock badge doesn't outlive it.
- **Pushing.** `index.ts`'s `broadcast` passes every event through `observe`: anything structural (started, settled,
  deleted, seen) is pushed 120 ms after a burst ends and at most 500 ms after it began; progress alone (a poll's
  timings, export and import percentages) at most once a second; a summary identical to the last one isn't sent.
  Work that starts without a broadcast of its own (a take uploading to Venice, a picture, an approval being carried
  out, an upload) calls `touch` through the services' change hooks. `revision` only grows, so the window never lets
  an older summary replace a newer one. The Dock badge is the number of new and failed results.
- **Seen** (`lib/work.ts`). Playing a video or a sound for a second (or half of a shorter one) marks it seen: one
  capture-phase `timeupdate` / `ended` listener on the document maps the element's `media://` source back to a path and
  looks it up among the unseen items' `mediaPath`s; elements outside the document (the shared `new Audio()` of the voice
  clips, off-page players) are watched with `watchMediaElement`. Seeking adds nothing, so hover scrubbing doesn't count.
  Pictures, failures and the run-error banner are seen after 1.5 s at least 60 % on screen with the window focused — a
  picture also wherever it is shown by its file (a clip's start or end image, `useSeenPictureWhenVisible` in
  `ImageInput`), and one with no board or clip to be shown in opens in its own viewer from the panel
  (`WorkStillViewer`); one made for nothing is also listed in Generate (`NewPictures`), and a voice design that failed
  in its character's voices, until closed. Explicit choices mark seen too: opening a clip's drawer, clicking a take,
  rating, opening it in the Editor, choosing a version as the current one, the export banner's actions. A place an agent opened (`source: 'agent'`) marks nothing,
  and neither does a keyboard sweep through takes. `markSeen` hides the item at once and tells main; agents can read the
  state (`get_work_status`, `seen_by_user`) but every `work:mark*` handler refuses them.

## Voice separation helper

Venice has no stem separation, so Studio separates voice and background on the Mac with Apple's AUSoundIsolation
audio unit (macOS 13+, the high-quality model on 15+), through `studio-voice-isolate`
(`native/voice-isolate/main.swift`). It runs offline at about 28× real time and costs nothing. `voice-separation.ts`
finds it in `Contents/Resources/bin` of the packaged app or `build/bin/` in development, asks it `--probe` once
(only a success is cached) and runs it on 48 kHz float WAV extracted from the film; the stems are cached in
`.studio/stammar/` by the file's path, size and modification time (4 GB, least recently used first). A separation
first checks that its scratch files (the sound three times over as float WAV) fit with 1 GB to spare, and a watchdog
stops the helper with a message when no progress comes for two minutes or it runs longer than the sound
itself (at least five minutes). The helper is
optional: without it — another OS, an older macOS, a build without the Swift compiler — `separationStatus()` gives a
reason, *Settings → Tools* shows it, and the Editor offers only what works without stems (lowering the
original under a new voice instead of keeping its background). See [DEVELOPMENT.md](DEVELOPMENT.md#native-helper) for
the build.

## Reviews and learnings

The review loop exists so prompts get better from what earlier prompts actually produced. The user rates clips in
the feed; agents look at finished clips and films, review them and distil *learnings* that every later session
reads first. `src/main/reviews.ts` owns the data and its IPC handlers; the agent side is `agent/tools/review.ts`
with `agent/media.ts`.

- **Reviews** (`generation_reviews`). The user has at most one review per generation (author `user`, enforced by a
  partial unique index): a grade (thumbs down or 1–3 stars), a note and tags, set field by field with `reviews:setUser`
  from the feed's cards, table and detail drawer, and removed once all three are empty. Both handlers take a grade only
  as `isRatingValue` (`shared/rating.ts`) allows: -1, 1, 2 or 3. Agents add any number with `reviews:add`, each under
  the agent's client name (`agentAuthor`: one line, never `user`). Reviews are deleted with their generation.
- **Learnings** (`learnings`). A title, the insight, an optional model (NULL: every model), tags, evidence
  (generation ids, which must exist when added) and `pinned`. They are written in *Prompts → Learnings* (author
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
switched on under *Settings → Agent connection*. See [AGENTS.md](AGENTS.md) for the user-facing side and
[SECURITY.md](../SECURITY.md) for the threat model.

```
agent ──HTTP──▶ AgentServer (/mcp) ──▶ McpServer per session ──▶ tools
      │                                                           │
      └─PUT /uploads/<id>─▶ UploadStore ◀── begin_upload ─────────┤  (or a URL fetched by fetch-url.ts)
                              │ staged files                      │
            ┌──────────────── callService('assets:addImages', …) ◀┤  library, sequences, models…
            │                 (the same ipcMain handlers the window uses; files pass assertAgentFiles)
            │                                                     │
            │    FormBridge ── 'agent:command' ──▶ renderer agentBridge ──▶ Generate form store
            │               ◀── 'agent:reply' ───┘                │
            │                                                     │
            └── ApprovalStore ◀── request_* tools, request_delete ┘
                     │  'agent:approval' ──▶ ApprovalDialog ── resolveApproval ──▶ verify ──▶ execute
                     ▼
               JobManager.submit (same guard as every other generation) · callApproved (removals)
```

- **Server.** `AgentService` listens on `127.0.0.1` and on each Tailscale IPv4 address of this Mac (never
  `0.0.0.0`), port 8770 by default, re-checking the Tailscale address every 30 seconds. `AgentServer` serves MCP
  over Streamable HTTP at `/mcp`, one transport and one `McpServer` per client session (sessions idle for 12 hours
  are dropped, at most 24 are kept). Each request passes the peer check, the `Origin` check and a constant-time
  bearer token check before it reaches MCP; `/mcp` bodies over 1 MB, or not in within 60 s, are refused. The server
  itself has no overall request timeout (an upload of a large video takes long); headers must arrive within 20 s. The `X-Studio-Agent-Name` header, or
  else the client's MCP `clientInfo`, names the agent in the activity log and on approval requests.
- **Tools.** `defineTool` (`tools/kit.ts`) validates input with zod, answers with compact JSON plus labelled
  images and audio (each block after a text label; audio is replaced by a one-line note for a session whose
  protocol version predates audio content, 2025-03-26), turns exceptions into tool errors the agent can read
  (worded like the UI's) and records every call in the activity log. Tools carry MCP annotations (`readOnlyHint`,
  `destructiveHint`, `openWorldHint`). The 99 tools live in `tools/library.ts`, `directors.ts`, `form.ts`, `sequences.ts`, `song.ts`,
  `stills.ts`, `storyboards.ts`, `paid.ts`, `editor.ts`, `editor-paid.ts`, `review.ts`, `uploads.ts`, `imports.ts`,
  `delete.ts`, `work.ts` and `spending.ts`; [AGENTS.md](AGENTS.md#tools) lists them. No tool takes a file path.
- **Same services as the window.** `recordIpcHandlers` wraps `ipcMain.handle` before any module registers its
  handlers, so `callService(channel, …args)` runs exactly the handler a window would, with every validation, busy
  check, folder move and change notification. Handlers can tell an agent's call apart with `isAgentCall(event)`
  (used to refuse clip, board and transition changes during *Generate missing*, a board change that would drop a
  transition with a prompt or takes, what only the user may do, and files that aren't uploads or library files).
- **Uploads.** `UploadStore` (`agent/uploads.ts`, one per `AgentService`) takes a file three ways. *URL*:
  `fetch-url.ts` fetches it with Node's `http`/`https` (never Electron's network stack or a system proxy), resolving
  DNS itself and connecting to the address it checked, so a name can't be re-pointed between the check and the
  connection; only public addresses (private, loopback, link-local, CGNAT and Tailscale, documentation, multicast and
  reserved ranges are refused, IPv4 embedded in IPv6 is checked as IPv4, and IPv6 must be global unicast), plus the
  session's own peer (any loopback address for a local agent) on any port but Studio's; at most 3 redirects, each
  checked again, never https → http; status 200 only; the kind's size cap before and while reading; connect 10 s,
  idle 30 s, at most 2 minutes (30 for a video); two fetches at a time. *PUT*: `begin_upload {bytes}` answers a
  `put_url` on the address the session reached Studio at (`baseUrl`, only an address Studio listens on or its
  MagicDNS name; otherwise just `put_path`), and `PUT /uploads/<id>` passes the peer, `Origin` and token checks, then
  PUT only, a `Content-Length` equal to the declared size (no chunked bodies) and an upload waiting for its bytes from
  the same peer that began it — all before `100 Continue` is sent (the server listens for `checkContinue`, so Node
  doesn't answer it by itself); a refused PUT is answered with `Connection: close` and the socket destroyed, so a
  refused body is never read; the body is piped by hand (not through `pipeline`, which would destroy the socket) to
  a `.part` file with a byte count and SHA-256, 60 s idle and 30 min at most — a transfer stopped there is answered
  `408` before its connection closes (`lingerClose`), and the upload stays `receiving` with the reason in `error`.
  *Inline*: `data_base64` up to 700 000 bytes. The limits (16 live, 8 GB staged, 2 GB free) count what transfers
  under way have declared but not written yet; a URL's size is only known as it arrives, so a download checks the
  staged total on every chunk and the free disk when it starts, when a size is announced and every second or 64 MB.
  Every file is staged in `.studio/tmp/agent-uploads/<id>/` (on the library's volume, so a video can be cloned into
  place), its type sniffed from its bytes and checked (`upload-check.ts`; HEIC converted with `sips`). Tools hand
  staged files to the window's handlers, which copy or clone them; a file used as a form image or reference is
  imported as a still first, so no scratch path ever enters generation params. A content tool's `{url}` sources
  (`stageFiles` in `tools/sources.ts`) are checked and given room before the first fetch, and thrown away once the
  call has answered (`afterCall` in `kit.ts`) unless its error names them. The activity log and an asset file's
  `origin` name the host a URL came from, never the URL, and a fetched file takes the URL's last segment as its name
  only when that looks like a file name.
- **Form commands.** The Generate form lives in the renderer (`lib/generateStore.ts`), because it is what the user
  sees and edits. `FormBridge.send` posts `agent:command` (`get_form`, `set_form`, `set_references`,
  `reorder_references`, `swap_reference` or `open` — the Generate view, a sequence and clip, a storyboard or an edit —, with a deadline)
  to the focused window, and `lib/agentBridge.ts` applies it with the form's own rules (mode switching, model options,
  the reference cap, the description switches, tokens following a reorder) and answers with `agent:reply`; the form
  state it reports includes the pictures past the model's limit (`unsentReferences`), which `reorder_references` can
  move forward (main names the references to move by path, so a form the user changed meanwhile still gets the
  pictures named, or refuses). Only the window that got the command may answer, and main gives up after 10 seconds
  ("is the window open?"). A clip's references are reordered in main with the same shared `reorderReferences`, and
  swapped with the same `swapReferenceImage` / `swapReferenceAsset` (`swap_reference`; the form's swap names the
  picture by path, so one the user moved meanwhile is still the one swapped, and one removed refuses it).
- **Approvals.** The paid tools (`tools/paid.ts`, `tools/editor-paid.ts`) and `request_delete` (`tools/delete.ts`)
  create requests the user approves. The paid tools validate the request (`request_generation` and
  `request_segment_generation` run `prepareSubmission`, so reference audio is measured before the user is asked;
  `request_generation` keeps the measured windows in the request; `request_segment_generation` and
  `request_generate_all` also refuse a clip whose neighbours' frames can't be had; `request_image_generation` runs
  `planStill`, the check and price the window's dialog uses), quote the price and create an `ApprovalPlan` in
  `ApprovalStore`: a fingerprint (an identical pending request is reused), a target (a newer request for the same
  clip replaces the older one), `verify` (refuses if the clip, the actual image and audio files or the composed
  prompt – the References legend main's `composeSubmission` appends from the assets' descriptions, which the request
  carries as `composedPrompt` / `descriptionLegend` for the dialog, or per clip as `clipLegends` for *generate all*
  – changed since) and `execute`. A pending request is listed with its params following files moved since
  (`paramsNow`: `followRewrites`), so the dialog shows the pictures and composes the legend from the files as they
  are. The window shows `ApprovalDialog` with the prompt, references and voices (the Dock icon bounces if Studio
  isn't focused); it composes each clip's legend as main would and disables approving when one differs from the
  request's. Approving runs `verify`, then `execute`, which calls `video:generate` (passing the approved composed
  prompt, which an agent's call may give after the options), `segments:generate`, `sequences:generateAll`,
  `transitions:generate` or `storyboards:generateAll` through `callService` — all but the first with a submit guard
  that re-checks the clip or transition against what the user approved right before each take is sent. A request
  with `count` 2–4 (`request_generation`, `request_segment_generation`, `request_transition_generation`) carries
  `variants` and the total as `priceUsd`, and its `execute` passes `GenerateOptions` with an `onSent` listener (and
  `confirmOverBudget`: the user approved the total they were shown), so `generationIds` lists every variant sent and a
  later one that failed becomes the approval's `notice`. A
  storyboard's requests are kind `segment` (one transition) and `generate-all` with `sequenceKind: 'storyboard'`;
  they pin both board pictures by file identity, the pair of boards and the transition's settings, and lapse when
  any of them changes. An image request (`ApprovalRequest.kind` `image`, with `image`: the still's params,
  references and target — a clip's slot, or a board in `assignToBoard`) runs `images:generate` and then, when it
  names a clip, `segments:setImage`, or for a board `boards:update` (`verify` refuses once the board has moved or
  got another picture since the agent asked, and `execute` checks the picture again once the still is made, keeping
  one the user put in meanwhile); the approval records the `stillId` (and a `notice` when only the assignment failed
  or was left out), and the dialog waits for the picture and shows it. An edit request
  (`request_edit_operation`, kind `edit`, with `edit`: the edit, base version, normalized operation, summary, frames,
  old → new lines or the lines a change of voice changes, parts, price note and `partialPrice`) is planned by the same `edits:plan` the window uses; `verify` refuses when
  the base version's file identity (device, inode, size, modification time), the plan's fingerprint, the transcript
  lines it uses or the clone consent changed, or the price rose by more than $0.01, and `execute` runs `edits:run`
  with the approved price as its ceiling. The request's identity includes its price: asked again at another price it
  replaces the pending one rather than being handed back. The dialog shows a partial price as `≈ $X +` and asks once
  more for it, as for an unknown price or one above $5. When the plan's only problem is a missing clone consent, the request is
  still made with `needsCloneConsent`, and the dialog's required checkbox gives that consent (`voices:consent`, the
  user's own call) before approving. A voice design (`request_voice_design`, kind `voice-design`) runs
  `voices:design`; its dialog asks once more for an unknown price or one above $5, as the user's own voice design does. `request_edit_operation` with `resume_job_id` makes an `edit` request with `resumeJobId` at the job's fresh price for continuing, verified (the job can still continue, the price at most $0.01 higher) and run with `edits:resume`. `get_approval` follows both jobs until the version or the new clip is there.
- **Removals.** `request_delete` plans every item read-only: its label, group, picture or text excerpt, what else
  changes and what goes to the Trash; it refuses what the window or the services would refuse (a running *Generate
  missing*, a busy or partly paid edit job, `edits:deleteRefusal` for videos and versions) and what stays the user's
  (their own review; a learning they wrote, edited or pinned), folds items another item removes anyway, and refuses an
  item already in another pending request. The request's fingerprint is each item's key and a hash of its snapshot,
  so an identical request is reused. The dialog calls `verifyApproval` (`ApprovalStore.check`, the plan's `verify`
  without executing) every 2 s and on focus; `get_approval` and a new `request_delete` run the same check on pending
  removals. A changed item makes `verify` throw `ApprovalLapsed`, and the request ends `expired` wherever that is
  found (a refusal that may pass, such as a run going on, keeps it pending). Takes and videos of a clip in a running
  *Generate missing* (or selected there) are refused, since the run would generate the clip again. On approval
  `verify` re-reads every item and the whole request lapses if anything changed; then `execute` removes the items in
  dependency order through the window's handlers with
  `callApproved` — the user's authority, so `edits:delete` or another agent's review goes through as the user's own
  click would, which is why the authorship rules live in the planner and in `verify` — and records each item's
  outcome (`deleted`, `gone`, `failed`); a request where nothing could be removed ends `failed` with the outcomes
  kept. While any request is being carried out (`executing()`), a library switch or move is refused.
- **Expiry.** Requests expire after 30 minutes; at most 10 can be pending; regenerating the token, switching the
  library or turning the connection off expires them all, and uploads with them.
- **Guidance.** `guide.ts` provides the server instructions sent at `initialize`, the `get_studio_guide` tool, the
  `studio://guide` resource and the `write_video_prompt` prompt. Prompt-writing advice follows the user's prompt
  language setting; the guide covers voices (`@AudioN`, designed voices and clone consent), poses, products, sending
  files, own clips, editing films in the Editor (always plan first; which operation for which problem), deleting, what
  runs and what is new, and the review loop, and ends with the pinned and ten most recent learnings.
- **Looking back.** The review tools (`tools/review.ts`) give agents what a generation, a sequence or an exported
  film actually became: frames as JPEG images captioned with their time, the reference images next to them, and —
  when asked, for clients on MCP 2025-03-26 or later — the clip's sound and the voice windows as MP3 audio content.
  Reviews and learnings are written through the same IPC handlers as the window, under the agent's name (see
  [Reviews and learnings](#reviews-and-learnings)). None of them spends money.

## Claude Desktop

Claude Desktop runs local MCP servers as *Desktop Extensions*: a `.mcpb` file is a zip with a `manifest.json`
([MCP Bundle](https://github.com/modelcontextprotocol/mcpb), manifest version 0.3) and the server, which Claude Desktop
unpacks and starts over stdio with its own Node.js. Its custom remote connectors need a public HTTPS address, so they
can't reach a Studio on loopback or the tailnet; the extension carries a small bridge instead.

```
Claude Desktop ──stdio──▶ node server/index.js (bridge.ts) ──HTTP /mcp, Bearer token, X-Studio-Agent-Name: Claude──▶ AgentServer
                          env STUDIO_URL, STUDIO_TOKEN ◀── manifest user_config (defaults filled in by Studio)
```

- **Making it.** `scripts/build-mcpb.mjs` builds the parts into `build/mcpb/` (the bundled bridge, its licences, the
  manifest template, the icon); electron-builder ships them as `Resources/mcpb` (macOS) and `resources\mcpb`
  (Windows). *Add to Claude Desktop* (`claude:addExtension`, window only) asks `AgentService` for the status and the
  token, builds the URL for an address Studio listens on now (127.0.0.1 by default; the Tailscale address or MagicDNS
  name for another computer) and zips manifest, bridge, licences and a 512 × 512 icon with the URL and the token as the
  defaults of the manifest's `studio_url` and `studio_token` settings (not `required`, so Claude Desktop uses the
  defaults as they are; the token `sensitive`). The file is opened with Claude Desktop (`open -a <Claude.app>` /
  `shell.openPath`) from a private temp folder (0600) that is deleted after 15 minutes, on quit, or at the next start;
  saved for another computer, it goes where the user chooses. Nothing of Claude Desktop's own is read or written.
- **The bridge** (`src/mcpb/bridge.ts`) forwards JSON-RPC between the SDK's stdio server transport and its Streamable
  HTTP client transport, so Studio's `initialize` result (instructions, capabilities), tools, prompt and resource reach
  Claude Desktop unchanged. Each session with Studio is opened with Claude Desktop's own `initialize` parameters (the
  bridge's own request id) and its `initialized` notification; Claude Desktop's `ping` is answered locally. On top of
  forwarding:
  - *Studio away at start:* `initialize` waits up to 8 s, then is answered without Studio (the capabilities Studio has,
    instructions naming `studio_status`); `tools/list` then holds only `studio_status`, which explains, and the other
    lists are empty. The bridge retries (2 s, doubling to 30 s) until Studio answers, then sends
    `notifications/{tools,prompts,resources}/list_changed`. A refused token or a wrong address stops the retries
    (only the user can fix it).
  - *Studio restarted:* a request that gets `404 Session not found`, or whose connection was refused before anything
    was sent, is sent once more on a new session (with `list_changed`, as Studio may have been updated); nothing that
    may already have run is sent twice.
  - *Studio closing mid-call:* the transport's `fetch` watches each POST's event stream; one that ends without its
    answer has the request answered with an error at once instead of leaving Claude Desktop waiting.
  - *Errors* are JSON-RPC errors (−32000) worded for the user: not reachable (Studio not running, the connection off,
    or the tailnet), the token refused (401: add Studio again), the address not Studio's (403/404). The log (stderr,
    `[studio]`) never holds the token; `STUDIO_BRIDGE_DEBUG=1` also logs each retry.
  - Closing (stdin ends or a signal) ends the session with `DELETE`, so Studio stops listing *Claude* at once.

## Updates

Studio updates itself from the repository's GitHub Releases (`src/main/updates.ts`). The repository (`owner/name`) is
read at build time from `install.sh`'s `REPO`, the one place it is written (`__STUDIO_REPO__`, `electron.vite.config.ts`).

```
start (+8 s, then hourly) ─ due? ─┐                         ┌─▶ updates:available ─▶ notice (Update now / Release notes / Later)
Check for Updates… (macOS menu) ──┼─▶ GET api.github.com/repos/<repo>/releases/latest ─┤
Settings → Check for updates ─────┘          semver vs app.getVersion(), asset for this computer, installBlocked
Update now ─▶ busy? ─▶ check again ─▶ download (github.com ─302─▶ *.githubusercontent.com, https) ─▶ SHA-256
            ─▶ macOS: ditto next to the app, check, swap, relaunch helper, quit │ Windows: installer --updated /S --force-run, quit
```

- **The check** is one GET, with `User-Agent: Studio/<version>`, nothing else: never in a development build (Studio
  Dev, any unpackaged build: `isDevelopmentBuild`), which answers *Development build – updates come from git.* without
  asking. It runs 8 s after start and then hourly, each time only when a day has passed since the last answer
  (`lastUpdateCheck`) and *Check for updates automatically* is on (`autoUpdateCheck`), and whenever the user asks:
  *Check for Updates…* in the macOS app menu (`setMacMenu` in `index.ts`: Electron's default menu with the item under
  *About Studio*; it brings the window forward and sends every answer, `requested`, also *up to date*, a development
  build or the error) or *Check for updates* in Settings. A release is used only if its tag is a version and it is no
  draft or pre-release; its files only if they are the repository's own `releases/download/` URLs on github.com; its
  page only on github.com. The newer release last found is sent again to a window that (re)loads (a library switch
  reloads it). The asset is `Studio-mac-<arch>.zip` or `Studio-win-<arch>-setup.exe` (electron-builder's names);
  `installBlocked` says why this copy can't install it: no file for this computer, an app bundle Studio can't write
  (its folder or itself; a read-only disk), macOS' App Translocation (opened straight from Downloads), the portable
  Windows zip (no `Uninstall Studio.exe` next to `Studio.exe`). The window then offers the release page instead.
- **Install** (`updates:install`, refused for agents) is refused while `libraryBusyReason()` gives a reason or a library
  archive (export or import) runs – asked first and again right before the swap or the installer –, one at a time, and
  re-checks the release. It downloads with manual redirects, each hop https on github.com or `*.githubusercontent.com`,
  exactly the release's size, given up after 60 s without data; then the SHA-256 of the file on disk must equal the
  asset's `digest` from the API (`sha256:<hex>`) or, without one, its line in the release's `SHA256SUMS.txt` (written
  by the release workflow's publish job); neither → refused. Progress goes to the window as `updates:progress`
  (`downloading` with a fraction, `verifying`, `installing`, `restarting`, `failed` with the reason). Every failure
  removes the work folder and leaves the running Studio as it was.
- **macOS** (`installMacUpdate`): the zip is downloaded into and unpacked with `ditto -x -k` into a work folder
  `.Studio-update-*` next to the app (same volume, so the swap is two renames). The unpacked folder must hold one
  `.app` with this bundle's `CFBundleIdentifier`, the release's `CFBundleShortVersionString` (newer than this one), its
  executable, an `LSMinimumSystemVersion` this Mac meets and an intact signature (`codesign --verify --deep --strict`).
  Then: this app renamed into the work folder, the new one renamed into its place (put back if that fails), the
  relaunch helper started (both undone if it can't be), the old app trashed (`shell.trashItem`) and the work folder
  removed, then `app.quit()` with the usual `will-quit` duties. The helper is a detached `/bin/sh` that waits (at most
  two minutes) until Studio's process has ended – the single-instance lock is free – and runs `open -n <app>` through
  Launch Services, carrying `STUDIO_PROFILE_DIR` and `STUDIO_UPDATE_TEST_SERVER` with `--env` when set (a test
  instance). Downloads by Node carry no quarantine flag, so the new app opens as `install.sh`'s does. At the next start
  `startUpdateChecks` trashes any app left in a `.Studio-update-*/old` folder and removes the work folders.
- **Windows**: the installer is downloaded to `%TEMP%\Studio-update-*` and started detached with `--updated /S
  --force-run`, as electron-updater does: electron-builder's NSIS installer, silent, installs over the installed copy in
  its folder and install mode (it waits for Studio to close, or closes it), then opens Studio. The next start removes
  the folder.
- **Tests only**: `STUDIO_UPDATE_TEST_SERVER=http://127.0.0.1:<port>` (loopback http only) points the check and the
  download at a stand-in with GitHub's paths (`testSource`); an unpackaged build then checks and downloads like a release
  but refuses at the install step: it never replaces itself.

## Shared modules

`src/shared/` is imported by main, preload and renderer and must stay free of Node and DOM dependencies.

| Module | Contents |
| --- | --- |
| `types.ts` | Every type that crosses the process boundary (segments with keyframes and notes, storyboards with their boards and transitions, stills, image models, own-clip imports, edits with their versions, jobs, media, timeline, transcripts and operations, the audio model catalog, approval requests including image, transition, storyboard, edit, voice-design and delete requests, the five asset kinds and an asset file's `origin`, the work summary — `WorkSummary`, `RunningWork`, `FinishedWork`, `WorkTarget`, `workKey` —, grades — `RatingValue`, `THUMBS_DOWN`, `RATING_VALUES`, `MAX_STARS` —, a clip's `ContinueMode`, the library archive's `ArchiveProgress` and `ArchiveResult`), the `StudioApi` interface, `NEEDS_CONSENT`, the storyboard formats (`STORYBOARD_ASPECT_RATIOS`). |
| `models.ts` | The three modes (`KINDS`), `DEFAULT_MODEL` per mode (Seedance 2.5 basic), `PREFERRED` options, `DEFAULT_PARAMS` (8s, 480p, 16:9, audio on), `rememberModelKinds` / `kindOfModelId`, `pickOption`, `audioForModel`, `imageToVideoVariant`, `referenceToVideoVariant` (a family's reference-to-video model, for a continuation in reference mode), `supportsEndImage` (the models known to take an end image: ids with `first-last-frame` or `transition`, Seedance image-to-video, Kling V3/O3 image-to-video; Venice's list has no flag for it) and `endImageVariant`, `maxReferenceImages` (9, or 7 for Grok and 4 for Kling models), reference audio (`supportsAudioInput`, `maxReferenceAudios` = 3, `MIN`/`MAX_AUDIO_CLIP_SECONDS` = 2/15, `MAX_REFERENCE_AUDIO_SECONDS` = 15, `referenceAudioWindow`, `sanitizeReferenceAudios`), `paramsForSubmit` (an end image only for a model that takes one; the source video and upscale factor only for video-input models, reference videos only for Seedance's reference-to-video models, within the family's count), `durationSeconds`, reference videos (`supportsReferenceVideos`, `referenceVideoLimits` per family, `takesReferenceTask` (2.5), `videosAreReferences`, `referenceVideosOf` / `sanitizeReferenceVideos` (plain path strings of old rows read as `{ path }`), `referenceVideoWindow`, `referenceVideoModelFor`, `DEFAULT_VIDEO_CLIP_SECONDS`, `MAX_REFERENCE_VIDEO_BYTES`), and for the Editor `isVideoInputModel`, `isUpscaleModel` and `MAX_REQUEST_MEDIA_BYTES` (22 MB of media per request). |
| `prompt-refs.ts` | Pure `@ImageN`, `@AudioN` and `@VideoN` logic: finding tokens and near misses (`@Image 3`, `@img3`, `@Bild3`, `@audio 1`, `@Ljud1`, `@Voice1`, `@Video 1`, `@Vid1`, `@Film2` …), validation with issue codes (`no-references`, `out-of-range`, `over-model-limit`, `malformed`, `unused-reference`, `not-reference-mode`, for audio `audio-out-of-range`, `audio-over-limit`, `audio-not-supported`, `audio-length`, `audio-too-long`, `unused-audio` — neither for a number in `explained`, one the References legend explains —, and for reference videos `video-out-of-range`, `video-over-limit`, `video-not-supported`, `video-length`, `video-too-long`, `unused-video`), `validationContext` (videos count as references, so a Seedance edit or a clip with reference videos needs no reference image; only reference videos get the window checks), `toVeniceVideoTokens` (`@VideoN` → `<Video N>`, only in the body sent), canonicalisation, `blockingPromptError` / `blockingContinuationError`, the `continuationFrame` option (a continuation in reference mode: its prompt is checked against every carried picture with the frame after those that fit, and a token naming one that gives way is an error) and `droppedForFrameMessage` (reference image 9 isn't sent, to make room for the start frame). The editor, the submit guard and the agent tools all use it, so they agree. |
| `prompt-blocks.ts` | The building blocks for prompts: groups (scene template, framing, camera, light, style, motion, sound, things to avoid, music, sound effects) of labels with the English text they insert, and which kinds of field offer each group (`video`, `image`, `negative`, `music`, `sound`). The prompt fields and `get_prompt_blocks` read the same list. |
| `direction.ts`, `directors.ts` | Directors: the ready-made ones (`DIRECTOR_PRESETS`, English texts), `resolveDirector` (an id → `ResolvedDirector`: name, direction, style frames = its photos, style videos), `effectiveDirectorId` (a clip's own, else the sequence's, none for null), `sanitizeDirection`, `withDirection` (what is sent: avoid in the negative prompt, style frames after the reference images in reference mode within the model's cap and never after a continuation's frame, style videos within the Seedance family's count and seconds; idempotent) and `withoutDirection`, `composeDirection` (the Direction section per prompt language, parts dropped from the end to fit, the style lines' tokens, notes), `imageDirection` / `withImageDirection` (stills: look, light, framing as text), `directorDefaults`, `shotDuration` and `continuesByDefault`. Main, the window and the agent tools all send and show with it. |
| `prompt-compose.ts` | The References legend: `composePrompt` (which described assets are among the sent references, their tokens in order, who wears each outfit — an outfit somebody wears gets a line without a description too —, whitespace collapsed and `@` removed, proportional shortening at word boundaries within the model's limit, `truncated` / `dropped`), `explainedReferences` (the `@ImageN` / `@AudioN` numbers a sent legend explains, which the prompt checks don't call unmentioned), a reference line per reference video (`ComposedPrompt.videos`, also with descriptions off), `composeOptionsFor`, `describedAssets`, `sanitizeDescriptionFlags` (the switches stored as absent while they have their defaults), `continuationLeadIn` (the instruction in front of a reference-mode continuation's prompt, per prompt language, counted against the limit), a director's Direction section after the legend (`ComposeExtras.director`, `ComposedPrompt.direction`, in `legend` too; a director's own photos are never described as references; its style videos get no reference line) and the remembered prompt limits (`rememberPromptLimits`, `promptLimitOf`). The editor's box, the submit, the approval dialog and the agent tools compose with it, so they show and send the same text. |
| `outfits.ts` | Who wears each outfit in a generation (*Worn by*): `resolveOutfitWearers` (a choice stored in `outfitWearers` while that character is among the references, else the character whose default outfit it is, else the only character; `null` = nobody), `sanitizeOutfitWearers`, `withOutfitWearer` and `outfitWearersAmong` (choices kept to the outfits and characters still among the references). The form's chips, the legend and the agents' `outfit_wearers` all use it. |
| `prompt-remap.ts` | Keeping tokens on their pictures, clips and videos when the reference lists change: `remapPromptReferences` (any letter case, near misses including ranges and glued words, `(…)` groups, an outfit swap; reference videos as its fifth argument, followed by path) and `reorderReferences` (`'image'`, `'audio'` or `'video'`) (a new order named by tokens or paths, the prompt and the negative prompt renumbered in one change), with `referenceOrder` and `referenceMoves`; `renameReferenceNames` changes the name written right before a `(…)` group whose tokens all belong to swapped places (whole words, any letter case, numbers untouched). The form, the bridge, the agents' clip tools, the clip editor's draft merge (an agent's reorder while the user types) and using an earlier take's prompt use it. |
| `reference-swap.ts` | Swapping a reference in place (a click on a reference thumbnail, `swap_reference`): `swapReferenceImage` (one place; the name in front follows when it was its asset's only place) and `swapReferenceAsset` (every place of one asset, its photos reused from the first when it has fewer, and its voice or sound clips the old one's `@Audio` places — kept, with a note, when it has none; given the library, one character for another also hands over the outfit it wore — the new character's default outfit takes its places, or it stays and the new character wears it), both with the description switch and the wearers following, and no number changed. The form, the clip editor, *Create image…*, the bridge and `swap_reference` use it. |
| `seams.ts` | Whether a take was made from its neighbour's frame as it is now (`startsOnLastFrameOf`, `endsOnFirstFrameOf`), read from the names main gives the frames it extracts; `continuationFrameOf` finds a continuation's frame in a take's params, as its start image (`exact`) or its last reference image (`references`). The clip editor's and timeline's warnings and the export's dedupe both use it, so a cut the editor calls seamless is the one the export dedupes. |
| `generation-filter.ts` | The clip feed's filter and sort (`filterGenerations`, `sortGenerations`, `queryGenerations`, `summarizeGenerations`, `indexAssetPaths`; the source filter = `source`, the title searched too; *New* = `unseen`, which the caller fills from the work summary or the `unseen` table; `minRating` counts stars, so thumbs down never passes it, and `thumbsDown` keeps only thumbs down; sorting by rating puts thumbs down after one star), shared by the feed and the agents' `list_generations`, so both show the same clips. |
| `generation-label.ts` | How a generation is named and marked: `generationTitle` (the title of an import or a version, else the prompt), `sourceBadge` (*Own*, and the badges of versions and edits), `canUseAgain` (*Use again* only for Venice generations without video inputs). The feed, takes, frame pickers, file names and the agents' summaries all use it. |
| `edit-plan.ts` | Pure planning helpers for the Editor, shared by main, the window and the agent tools: `snapRange`, `speechRegions`, `planVoiceChunks` (cutting long speech into chunks Venice bills as few started minutes as possible for, in short pauses, with a safety margin), `segmentsFromWords`, `snapSegments`, `remapTranscript`, `toSrt`, `fitLine`, `isPaidOperation`, `operationLabel`, `formatTimecode`, `formatPrice`, `PICTURE_EDIT_MODELS` and the price arithmetic. |
| `cast.ts` | A sequence's cast (`SequenceCast`: the photos, voices and "worn by" choices chosen once for the whole sequence – never reference videos: a clip's own videos stay its own, and whether it follows the cast is decided by its pictures and audio; stored as the references of `sequences.defaults`, no schema change, so `db.mapStoredPaths` rewrites its paths with every other params path): `castFollowAt` (whether a clip follows the cast — its own references are exactly the cast's —, carries it from the clip it continues from, differs, or sends no references), `followCastChange` (the params of every following clip after a cast change: the shared remap for additions, removals and reorders, `swapReferenceAsset` for a swap, a continuation's frame token kept), `castAppliedAt` (*Use the cast*), `swapCastAsset`, `followTokensToCast` (a negative prompt a new shot copies) and `sanitizeCast`. `SequenceService.update` applies a cast change to the following clips in one transaction (then `keepInheritedTokens` for the clips that carry them), `insertSegment` starts a new clip Studio makes empty with the cast, and `applyCastToSegment` is *Use the cast*; the Cast panel (`components/sequences/CastPanel.tsx`, edits in `castEdits.ts`), the clip editor's `CastLine.tsx` and the agent tools (`update_sequence` `cast` / `swap_cast_asset`, `get_sequence` `cast` / `follows_cast`, `add_segment`, `update_segment` `use_cast`) use it. |
| `continuation.ts` | How a sequence clip that continues from the previous one is sent (`ContinueMode`: `references`, the default, or `exact`): `continuationPlan` (the mode it is actually sent in, with the model, the carried references, the pictures that give way and the frame's token, and a note when the choice doesn't apply), `carriedReferences` (its own references – pictures, voices and reference videos –, else those of the clip it continues from, up the chain; the plan's `videos` are the carried reference videos within the model's count), `sendParams`, `withContinuationFrame`, `continuationProblem`, `droppedImagesNote`, and `inheritedTokensAt` /
`remapInheritedTokens` / `inheritedTokensChanged` for keeping an inheriting clip's tokens in place. The clip editor, main's takes, *Generate missing* and the agent tools decide it the same way. |
| `session.ts` | Generate's list is this session's: `isGenerateOrigin` (made in Generate — its form, an agent's `request_generation` or an own film imported into the feed; not a take, a version or an export's copy) and `inGenerateSession(g, session)` (made there since the session started, still queued or processing, or carried over: on its way when the session began, `GenerateSession.carriedOver`). The window, main's work summary and `list_generations({session: true})` share it. `MediaTab`, `MEDIA_TABS`, `isMediaTab`. |
| `variants.ts` | Variants: `VARIANT_COUNTS` (1–4), `variantCountOf` (a call's count, checked), `variantsPrice` (one take's price × count) and `variantsText` (*3 variants*), for main, the window's ×N picker and the agent tools. |
| `budget.ts` | The budget rule for main, the window and the agent tools: `normalizeBudget` / `capOf` (caps from 0 to $100,000 in cents), `overBudgetFor` (the cap — the day's before the month's — that spending plus what is on its way plus an amount would pass; an unknown price only when the spending is already at the cap), `roomLeft`, `usdText` and `overBudgetText` (*This costs $0.56 and takes today’s spending past your budget of $5.00 ($4.80 spent).*). |
| `rating.ts` | Grades — thumbs down (-1) or one to three stars — for the user's rating and agents' reviews: `isRatingValue`, `starCount`, `ratingLabel` (*Thumbs down*, *2 stars*, *Not rated*). |
| `agent-name.ts` | What a connected agent is called in UI text: `agentDisplayName` / `agentInSentence` read *The agent* / *the agent* for a generic MCP client name such as "mcp", "mcp-remote" or "client", and keep a real one (an `X-Studio-Agent-Name` header, "Hermes"); `isGenericAgentName`. |
| `prompts.ts` | `titleFromBody`, the automatic title of an untitled prompt. |
