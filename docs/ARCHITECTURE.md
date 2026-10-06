# Architecture

This document describes how Studio is put together: its processes, the modules in each, the data model, how
files are stored, how a generation travels from the form to a video on disk, how sequences are exported, and how
the agent connection (MCP server) plugs into all of it. It reflects the code in `src/`; when they disagree, the
code wins — please fix the document.

- [Processes](#processes)
- [Module map](#module-map)
- [Data model](#data-model)
- [Stored paths](#stored-paths)
- [IPC surface](#ipc-surface)
- [Jobs: from submit to saved video](#jobs-from-submit-to-saved-video)
- [Sequences and export](#sequences-and-export)
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
can seek.

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
| `index.ts` | App entry: profiles, single-instance lock, window creation, the core IPC handlers (settings, models, quote/generate, generations, files), wiring of the services, shutdown. |
| `settings.ts` | `settings.json` in the profile's `userData`: base folder, prompt language, accepted Venice consents, agent port/on-off; the Venice API key and the agent token encrypted with `safeStorage`. |
| `venice.ts` | Venice API client (`/models`, `/api_keys/rate_limits`, `/video/quote`, `/video/queue`, `/video/retrieve`, `/video/complete`), request bodies (images become downscaled JPEG data URLs), `VeniceError` / `NetworkError`. |
| `jobs.ts` | `JobManager`: the guard in front of every paid submission, queueing at Venice, polling with backoff, saving videos into the library, posters and durations, resuming pending jobs and backfilling missing posters. |
| `db.ts` | The SQLite connection (WAL, foreign keys), the migrations, generation rows, and stored-path maintenance: prefix rewrites, relativizing, "is this path recorded" checks. |
| `paths.ts` | Folder layout constants (`FOLDERS`, `APP_DATA`, `TAKES_FOLDER`), conversion between absolute and stored paths, Finder-safe names, unique names, verified moves and renames, the "base folder is still there" check and the library-wide operation lock. |
| `library-root.ts` | The base folder's lifecycle: opening it at startup, status, choosing/inspecting/switching (`move`, `open`, `new`), converting an earlier layout, *Städa upp* (reorganize), revealing folders in Finder. |
| `library.ts` | The prompt library (CRUD, tags, favourites, usage) and registration of the asset and prompt IPC handlers. |
| `assets.ts` | Characters, environments and outfits: rows, one folder per asset with copies of its photos and `Beskrivning.txt`, renames that move the folder, deletes to the Trash, default outfits. |
| `references.ts` | Copies start/end/reference images from outside the library into `Referensbilder/<day>/` (deduplicated by content hash) and the shared `placeFile` / `copyInto` helpers that write via the scratch folder. |
| `sequences.ts` | `SequenceService`: sequences and clips, takes, continuation frames, *Generera saknade* runs, keeping sequence folders in step with names, export, and the sequence IPC handlers. |
| `sequence-store.ts` | Row access and assembly for sequences and segments, take selection and trim clamping, folder and file naming. |
| `sequence-export.ts` | Turns the selected, trimmed takes into ffmpeg concat clips and reserves the export's file name. |
| `ffmpeg.ts` | Finds `ffmpeg`/`ffprobe`, probes videos, extracts frames and posters, renders the concat export, and kills/cleans up running processes on quit. |
| `media-protocol.ts` | The `media://` scheme. |
| `agent/index.ts` | Public entry of the agent connection. |
| `agent/service.ts` | `AgentService`: on/off, port, token, following the Tailscale address, status for the UI, one MCP server per client session. |
| `agent/server.ts` | The HTTP server: peer, `Origin` and bearer checks, body limits, MCP Streamable HTTP sessions and their lifecycle. |
| `agent/network.ts` | Loopback and Tailscale address detection, the peer allow-list, MagicDNS lookup through Tailscale's resolver. |
| `agent/approvals.ts` | `ApprovalStore`: paid requests waiting for the user's decision. |
| `agent/activity.ts` | The activity log of tool calls shown in the app (ring of 200 entries). |
| `agent/bridge.ts` | `FormBridge`: main ↔ renderer commands for the Generate form. |
| `agent/local-ipc.ts` | Records the `ipcMain` handlers so agent tools call exactly the services the window calls (`callService`, `isAgentCall`). |
| `agent/ipc.ts` | IPC handlers for the agent settings, the activity drawer and the approval dialog. |
| `agent/guide.ts` | The MCP server instructions, the Studio guide and the prompt-writing guide for agents. |
| `agent/images.ts` | Photos and posters as MCP image content (JPEG, at most 768 px), with a small cache. |
| `agent/studio.ts` | Helpers shared by the tools: asset index, `@ImageN` token maps, model and option checks, prompt problems. |
| `agent/tools/*.ts` | The MCP tools (`library.ts`, `form.ts`, `sequences.ts`, `paid.ts`), the `defineTool` frame (`kit.ts`) and registration of the tools, the `write_video_prompt` prompt and the `studio://guide` resource (`index.ts`). |

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
| `lib/generateStore.ts` | The Generate form as an app-level store above the views, persisted to `localStorage`, so agents can read and fill it while another view is open. |
| `lib/agentBridge.ts` | The renderer half of the form bridge: applies `get_form`, `set_form`, `set_references` and `open` to the form store and replies. |
| `lib/agent.ts` | Live agent status, activity and approval requests for the indicator, the drawer, the dialog and Settings. |
| `lib/promptIssues.ts` | The `@ImageN` checks for a set of params, with the rules main applies. |
| `lib/hooks.ts` | Shared data hooks (model list, assets, prompts, price quote) and `ipcErrorMessage`. |
| `lib/library.ts` | `localStorage` keys that hold library data and how they are rewritten or forgotten after a library switch. |
| `lib/assets.ts`, `lib/media.ts`, `lib/navigation.ts`, `lib/workspace.ts` | Asset kind wording, `media://` URLs and formatting, cross-view navigation intents, where the user is in the sequence editor. |
| `components/GenerateView.tsx`, `ParamsForm.tsx`, `GenerationCard.tsx`, `ImageInput.tsx` | The Generate view: the form, the feed of generations, image inputs. |
| `components/prompt/` | The reference-aware prompt editor: token colouring, hover cards, the `@` menu, issue list and quick fixes. |
| `components/prompts/` | The prompt library view (*Prompter*). |
| `components/assets/` | The *Karaktärer*, *Miljöer* and *Kläder* views: list, editor, photos, default outfit. |
| `components/pickers/` | Pickers and dialogs shared by the views (assets, outfits, prompts, sequences, modal, popover). |
| `components/sequences/` | The *Sekvenser* view: list, header, timeline, clip editor, takes, trims, preview player. |
| `components/library/` | Library setup screen, folder choice, switching overlay and *Inställningar → Bibliotek*. |
| `components/agent/` | Agent settings section, sidebar indicator, activity drawer, approval dialog and their Swedish wording. |
| `components/SettingsView.tsx`, `Sidebar.tsx`, `ConsentDialog.tsx`, `DevBadge.tsx` | Settings, navigation, Venice's consent dialog, the *Dev* badge. |

## Data model

The database is `<base folder>/.studio/studio.db` (SQLite through `better-sqlite3`, WAL journal, foreign keys on).
Each library has its own database; nothing about the library lives in the profile's settings except where the
base folder is.

| Table | Holds |
| --- | --- |
| `generations` | Every generation: model, prompt, params (JSON), status (`queued`, `processing`, `completed`, `failed`), Venice queue id, price quote, timings, `file_path`, `thumb_path`, `video_duration`, and `segment_id` when it is a take of a sequence clip. |
| `assets` | Characters, environments and outfits: `kind`, name, description, `folder`, `default_outfit_id` (characters only, a self-reference set to NULL when the outfit is deleted). |
| `asset_images` | An asset's photos: `file_path` and `position` (position 0 is the cover). |
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

A library from before the base folder could be chosen (`studio.db`, `generations/`, `thumbs/`, `characters/`,
`exports/`, `frames/` directly in the folder) is converted to the current layout by `library-root.ts` when it is
opened; an interrupted conversion resumes on the next open.

## Stored paths

The rules live in `src/main/paths.ts` and `src/main/db.ts`:

- **Relative inside the library's own folders.** A path inside one of the library's top-level folders
  (`Karaktärer`, `Miljöer`, `Kläder`, `Referensbilder`, `Genereringar`, `Sekvenser`, `.studio`, and the old
  layout's folders until they are converted) is stored relative to the base folder, POSIX-style and
  NFC-normalised. Anything else — including files of the user's own elsewhere in the base folder — keeps its
  absolute path, because moving the library only takes its own folders along.
- **Converted at the database boundary.** Code outside `db.ts` works with absolute paths. `toStoredPath` /
  `fromStoredPath` and `toStoredParams` / `fromStoredParams` convert on the way in and out.
- **Every path column is known.** `generations.file_path`, `generations.thumb_path`, the `startImage`, `endImage`
  and `referenceImages` in `generations.params` and `segments.params`, `asset_images.file_path` and
  `exports.file_path`. `mapStoredPaths` visits all of them; a new path column must be added there.
- **Renames rewrite in one transaction.** `renameLibraryFolder` moves the folder on disk, then
  `rewriteStoredPrefix` rewrites every stored path under it in a transaction (moving the folder back if that
  fails). A submit that was uploading meanwhile follows the rewrites (`followRewrites`).
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
| Generation | `listModels`, `quote`, `generate`, `acceptConsent`, `listGenerations`, `deleteGeneration` | `models:list`, `video:quote`, `video:generate`, `consent:accept`, `generations:*` |
| Assets | `listAssets`, `saveAsset`, `deleteAsset`, `addAssetImages`, `removeAssetImage`, `reorderAssetImages` | `assets:*` |
| Prompt library | `listPrompts`, `savePrompt`, `deletePrompt`, `markPromptUsed` | `prompts:*` |
| Sequences | `listSequences`, `getSequence`, `createSequence`, `updateSequence`, `deleteSequence`, `addSegment`, `updateSegment`, `deleteSegment`, `moveSegment`, `generateSegment`, `generateAllSegments`, `stopGenerateAll`, `exportSequence` | `sequences:*`, `segments:*` |
| Library folder | `libraryStatus`, `chooseLibraryFolder`, `inspectLibraryFolder`, `setLibraryRoot`, `reorganizeLibrary`, `revealLibraryFolder` | `library:*` |
| Agent connection | `getAgentStatus`, `setAgentEnabled`, `setAgentPort`, `restartAgent`, `getAgentToken`, `regenerateAgentToken`, `listAgentActivity`, `listApprovals`, `resolveApproval`, `replyAgentCommand` | `agent:*` |
| Files | `revealFile`, `pickImages`, `pathForFile` (local, via `webUtils`) | `file:*` |

Events from main to the window (subscribe with the `on…` methods, which return an unsubscribe function):
`generation:update`, `library:change`, `sequence:change`, `export:progress`, `agent:status`, `agent:activity`,
`agent:approval` and `agent:command`. The window answers `agent:command` with `agent:reply` (`ipcRenderer.send`).
After a library switch main reloads every window.

Two details matter when changing handlers:

- `sequences:missingClips` is registered but not part of `StudioApi`; only the agent connection uses it.
- `segments:generate` and `sequences:generateAll` accept an optional *submit guard* function. Only in-process
  calls from an approved agent request can pass one (an IPC message cannot carry a function).

## Jobs: from submit to saved video

Every paid generation — the Generate button, a clip's *Generera tagning*, *Generera saknade*, an approved agent
request — ends in `JobManager.submit` (`src/main/jobs.ts`):

1. **Guard.** `blockingPromptError` checks the `@ImageN` references against what will actually be sent and
   refuses before anything is copied or paid for. Tokens are canonicalised and image inputs the model's mode does
   not use are dropped (`paramsForSubmit`). The IPC handler quotes the price first and counts the submit as busy,
   so a library switch can't close the database under it.
2. **Prepare.** The library must be open; every image must still exist. Images from outside the library are
   copied into `Referensbilder/<day>/` so the stored params point at the library's copies. The request body
   carries the images as JPEG data URLs (at most 2048 px), plus Venice's consent attestation for Seedance models
   once the user has accepted it.
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

## Sequences and export

A sequence (`sequences.ts`, `sequence-store.ts`) is an ordered list of segments (*clips*). Each segment's `params`
are the template for new takes; its takes are `generations` rows with its `segment_id`; one take is selected and
trimmed for the cut.

- **Continuation.** A clip with `continue_from_previous` (never the first) is generated with the image-to-video
  sibling of its model and no reference images. At submit time the previous clip's selected take is cut where its
  end trim cuts it and that frame is extracted with ffmpeg into `.studio/bildrutor/` (cached per take and
  timestamp) to become the start image. The previous clip therefore needs a finished selected take first.
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
  images, turns exceptions into tool errors the agent can read (Swedish, like the UI) and records every call in
  the activity log. Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`).
- **Same services as the window.** `recordIpcHandlers` wraps `ipcMain.handle` before any module registers its
  handlers, so `callService(channel, …args)` runs exactly the handler a window would, with every validation, busy
  check, folder move and change notification. Handlers can tell an agent's call apart with `isAgentCall(event)`
  (used to refuse clip changes during *Generera saknade*).
- **Form commands.** The Generate form lives in the renderer (`lib/generateStore.ts`), because it is what the user
  sees and edits. `FormBridge.send` posts `agent:command` (`get_form`, `set_form`, `set_references` or `open`, with
  a deadline) to the focused window, and `lib/agentBridge.ts` applies it with the form's own rules (mode switching,
  model options, the reference cap) and answers with `agent:reply`. Only the window that got the command may
  answer, and main gives up after 10 seconds ("is the window open?").
- **Approvals.** The paid tools (`tools/paid.ts`) validate the request, quote the price and create an
  `ApprovalPlan` in `ApprovalStore`: a fingerprint (an identical pending request is reused), a target (a newer
  request for the same clip replaces the older one), `verify` (refuses if the clip or the actual image files
  changed since) and `execute`. The window shows `ApprovalDialog` (the Dock icon bounces if Studio isn't
  focused). Approving runs `verify`, then `execute`, which calls `video:generate`, `segments:generate` or
  `sequences:generateAll` through `callService` — the latter two with a submit guard that re-checks the clip
  against what the user approved right before each take is sent. Requests expire after 30 minutes; at most 10 can
  be pending; regenerating the token, switching the library or turning the connection off expires them all.
- **Guidance.** `guide.ts` provides the server instructions sent at `initialize`, the `get_studio_guide` tool, the
  `studio://guide` resource and the `write_video_prompt` prompt. Prompt-writing advice follows the user's prompt
  language setting.

## Shared modules

`src/shared/` is imported by main, preload and renderer and must stay free of Node and DOM dependencies.

| Module | Contents |
| --- | --- |
| `types.ts` | Every type that crosses the process boundary, the `StudioApi` interface, `NEEDS_CONSENT`. |
| `models.ts` | The three modes (`KINDS`), `DEFAULT_MODEL` per mode (Seedance 2.5 basic), `PREFERRED` options, `DEFAULT_PARAMS` (8s, 480p, 16:9, audio on), `rememberModelKinds` / `kindOfModelId`, `pickOption`, `audioForModel`, `imageToVideoVariant`, `maxReferenceImages` (9, or 7 for Grok and 4 for Kling models), `paramsForSubmit`, `durationSeconds`. |
| `prompt-refs.ts` | Pure `@ImageN` logic: finding tokens and near misses (`@Image 3`, `@img3`, `@Bild3` …), validation with issue codes (`no-references`, `out-of-range`, `over-model-limit`, `malformed`, `unused-reference`, `not-reference-mode`), canonicalisation, and `blockingPromptError` / `blockingContinuationError`. The editor, the submit guard and the agent tools all use it, so they agree. |
| `prompts.ts` | `titleFromBody`, the automatic title of an untitled prompt. |
