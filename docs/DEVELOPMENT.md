# Development

How to run Studio from source, test changes without spending money, build the app and change the database or the
IPC surface safely. For how the code is organised, see [ARCHITECTURE.md](ARCHITECTURE.md).

- [Setup](#setup)
- [Scripts](#scripts)
- [Profiles](#profiles)
- [Testing without spending money](#testing-without-spending-money) (test clips, voices, reviews, harnesses)
- [Typecheck and build](#typecheck-and-build)
- [Packaging](#packaging)
- [Database migrations](#database-migrations)
- [Adding an IPC method](#adding-an-ipc-method)
- [Adding an agent tool](#adding-an-agent-tool)

## Setup

- macOS on Apple Silicon.
- Node.js from [`.nvmrc`](../.nvmrc) (24), at least 22.12.
- ffmpeg with ffprobe: `brew install ffmpeg`.
- Xcode Command Line Tools (`xcode-select --install`), in case `better-sqlite3` has to be compiled.

```bash
npm install
npm run dev
```

`npm install` runs `electron-rebuild -f -w better-sqlite3` afterwards, so the native SQLite module is built for
Electron's Node ABI. A consequence: plain `node` cannot load it — scripts that use the database run under Electron
(see [Electron-as-Node harnesses](#electron-as-node-harnesses)).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | electron-vite dev server with watch (`-w`), as **Studio Dev** (`STUDIO_DEV_PROFILE=1`). The renderer hot-reloads; main and preload changes rebuild and restart Electron. |
| `npm run dev:real` | The same, with the real **Studio** profile. Quit Studio.app first. |
| `npm run build` | Builds main, preload and renderer into `out/`. |
| `npm start` | Runs the built `out/` with electron-vite preview — **with the real profile**, like `dev:real`. |
| `npm run typecheck` | `tsc --noEmit` for the Node side (`tsconfig.node.json`) and the web side (`tsconfig.web.json`). |
| `npm run check` | `typecheck` + `build` — what CI runs, and what must pass before a pull request. |
| `npm run app` | Builds and packages `dist/mac-arm64/Studio.app` with electron-builder. |
| `npm run app:install` | `npm run app`, then replaces `/Applications/Studio.app` with the new build. |

Because the dev app reloads on every save, keep the code compiling while you work: a broken save restarts a
broken main process.

## Profiles

A *profile* is Electron's `userData` folder (settings, API key, agent token, which base folder to open) plus the
suggested location of the library. Each library carries its own database inside its base folder.

| Run | Name | Settings | Suggested library |
| --- | --- | --- | --- |
| Studio.app, `npm run dev:real`, `npm start` | Studio | `~/Library/Application Support/Studio/` | `~/Movies/Studio` |
| `npm run dev` | Studio Dev | `~/Library/Application Support/Studio Dev/` | `~/Movies/Studio Dev` |
| `STUDIO_PROFILE_DIR=<dir> npm run dev` | Studio Dev | `<dir>/userData/` | `<dir>/Movies/Studio Dev` |

- **Studio Dev** shows a yellow *Dev* badge and the window title "Studio Dev". It shares nothing with Studio.app,
  so both can run at the same time.
- **The single-instance lock is per profile.** A second launch of the same profile only brings the running one to
  the front (two instances would poll and download the same paid jobs). That is why `dev:real` needs Studio.app to
  be closed.
- **`dev:real` migrates the real library.** A build refuses a library whose database is newer than it knows
  (*Biblioteket har sparats av en nyare version av Studio*), but 0.1.0 predates that check and opens it anyway, then
  loses track of voices when it renames or deletes an asset. After running a branch with a new migration under
  `dev:real`, rebuild Studio.app (`npm run app:install`) before opening it again.
- **`STUDIO_PROFILE_DIR`** gives a throwaway profile: settings and the suggested library live under that folder.
  Use it for anything you want to delete afterwards, e.g. `STUDIO_PROFILE_DIR=/tmp/studio-test npm run dev`.
- Both Studio and Studio Dev default to agent port 8770. If both have the agent connection on, give one of them
  another port.

**Never point development work at a library you care about.** Copy it into a throwaway profile instead.

## Testing without spending money

Every Venice generation costs real money, so development is set up to never need one. There is no automated test
suite yet; changes are verified with the techniques below (contributions of a proper test setup are welcome).

### Ground rules

- **Never trigger real generations while developing.** Don't press *Generera*, *Generera tagning*, *Generera
  saknade* or approve an agent request in a profile that has a real API key, and never call Venice's
  `/video/queue` from tests — stub the `VeniceClient` instead.
- **Use a profile without an API key** for UI work. The model list and price quotes work without a key, but
  queueing a generation fails with "Ingen API-nyckel är inställd" before anything is sent.
- **Work in a throwaway profile and library** (`STUDIO_PROFILE_DIR`), not in `~/Movies/Studio*` or
  `~/Library/Application Support/Studio*`.

### Test clips with ffmpeg

Generate stand-in videos instead of paying for them:

```bash
mkdir -p /tmp/studio-clips
for i in 1 2 3; do
  ffmpeg -y -f lavfi -i "testsrc2=size=854x480:rate=24" -f lavfi -i "sine=frequency=$((300 + i * 100)):sample_rate=48000" \
    -t 5 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "/tmp/studio-clips/clip$i.mp4"
done
```

Drop `-f lavfi -i "sine=…"` and `-c:a aac -shortest` for a clip without audio (exports must pad it with silence).

### Test voices and sounds

Voices and soundscapes need audio files, not people. Tones are enough to exercise importing, reference windows,
the 2–15 s and 15 s-in-all checks and the MP3s that would be sent:

```bash
mkdir -p /tmp/studio-audio && cd /tmp/studio-audio
# A 12 s "voice" whose pitch changes every 4 s, so you can hear where a window starts
ffmpeg -y -f lavfi -i "sine=frequency=220:duration=4" -f lavfi -i "sine=frequency=330:duration=4" \
  -f lavfi -i "sine=frequency=440:duration=4" -filter_complex "[0][1][2]concat=n=3:v=0:a=1" -ac 1 voice.mp3
# 4 s of silence, then 8 s of sound: a window starting at 4 s must be loud from its first frame
ffmpeg -y -f lavfi -i "anullsrc=r=44100:cl=mono:d=4" -f lavfi -i "sine=frequency=300:sample_rate=44100:duration=8" \
  -filter_complex "[0][1]concat=n=2:v=0:a=1" late-start.wav
# Files Studio must refuse: shorter than a second, and an .m4a without an audio stream
ffmpeg -y -f lavfi -i "sine=frequency=500:duration=0.5" short.mp3
ffmpeg -y -f lavfi -i "testsrc2=size=320x240:rate=24" -t 2 -an -c:v libx264 -pix_fmt yuv420p no-audio.m4a
```

Add them to characters under *Röst* in a throwaway library (`short.mp3` and `no-audio.m4a` must be refused with
their names). Two clips with the default 10 s windows add up to 20 s: the form won't take the second one, and
params that carry both anyway (an agent, a harness) are refused by the prompt check and by `prepareSubmission`
("Ljudreferenserna är 20 s – max 15 s totalt.") before any call to Venice.

### Fake generation rows

With the clips in place you can make Studio believe they are finished generations or sequence takes. Do this in a
throwaway library, **with Studio quit** (the database is in WAL mode and the app holds it open):

```bash
LIB="/tmp/studio-test/Movies/Studio Dev"            # the throwaway base folder
mkdir -p "$LIB/Genereringar/2026-01-01"
cp /tmp/studio-clips/clip1.mp4 "$LIB/Genereringar/2026-01-01/12.00 Test clip.mp4"
sqlite3 "$LIB/.studio/studio.db" <<'SQL'
INSERT INTO generations (id, created_at, model, prompt, params, status, file_path, completed_at)
VALUES ('fake-1', 1767268800000, 'seedance-2-5-text-to-video-basic', 'Test clip',
  '{"model":"seedance-2-5-text-to-video-basic","prompt":"Test clip","duration":"5s","resolution":"480p","aspectRatio":"16:9"}',
  'completed', 'Genereringar/2026-01-01/12.00 Test clip.mp4', 1767268800000);
SQL
```

- Paths inside the library are stored relative to the base folder (see
  [ARCHITECTURE.md](ARCHITECTURE.md#stored-paths)).
- Leave `thumb_path` and `video_duration` empty: the next time the library opens, Studio backfills the poster and
  duration with ffmpeg.
- To make a take, create the sequence and its clips in the UI first, then also set `segment_id` to a clip's id in
  `segments` (and, to select the take, that clip's `selected_generation_id`). Continuation frames, trims, the
  preview and export then work on the test clips.
- Only insert `completed` (or `failed`) rows. A `queued`/`processing` row with a `queue_id` would make Studio poll
  Venice for it.

### Fake reviews and learnings

The clip feed's rating filters, the detail drawer and the agents' review tools can be tried on the fake rows above.
Add a rating by the user, an agent's review and a pinned learning the same way (Studio quit):

```bash
sqlite3 "$LIB/.studio/studio.db" <<'SQL'
INSERT INTO generation_reviews (id, generation_id, author, rating, tags, note, created_at, updated_at)
VALUES ('fake-review-1', 'fake-1', 'user', 4, '["good-motion"]', 'Nice motion.', 1767268800000, 1767268800000),
       ('fake-review-2', 'fake-1', 'Test agent', 2, '["identity-drift"]', 'The face drifts after t = 3 s.',
        1767268900000, 1767268900000);
INSERT INTO learnings (id, title, insight, model, tags, evidence, author, pinned, created_at, updated_at)
VALUES ('fake-learning-1', 'Test learning', 'Short prompts drift less.', NULL, '["test"]', '["fake-1"]', 'user', 1,
  1767268800000, 1767268800000);
SQL
```

Author `user` is the user's own review (at most one per generation); any other author is an agent. Tags and
evidence are JSON lists; evidence holds generation ids.

### Electron-as-Node harnesses

To exercise main-process modules directly (the job manager, sequences, path rewrites, the MCP server), bundle a
small TypeScript test that imports the real `src/main` modules, replace the `electron` module with a stub, and run
the bundle with Electron in Node mode — which also loads the Electron build of `better-sqlite3`.

1. **A stub for `electron`**, with just what the modules under test touch, keeping every path inside a temp
   folder:

   ```js
   // electron-stub.cjs
   const path = require('node:path')
   const home = process.env.STUDIO_TEST_HOME // a fresh `mktemp -d` folder
   if (!home) throw new Error('Set STUDIO_TEST_HOME to a temp folder')
   const handlers = new Map()
   module.exports = {
     app: {
       getPath: (name) => path.join(home, name),
       getName: () => 'Studio Test',
       getVersion: () => '0.0.0-test',
       setName() {},
       setPath() {}
     },
     ipcMain: { handlers, handle: (channel, fn) => handlers.set(channel, fn), on() {}, removeListener() {} },
     safeStorage: { encryptString: (s) => Buffer.from(s), decryptString: (b) => Buffer.from(b).toString() },
     nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
     shell: { trashItem: async () => {}, showItemInFolder() {}, openExternal: async () => {} },
     BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null },
     dialog: {},
     protocol: { registerSchemesAsPrivileged() {}, handle() {} }
   }
   ```

   Extend it as needed — e.g. fake windows whose `webContents.send` answers `agent:command` to test the form
   bridge, or a `nativeImage` backed by macOS `sips` to test image handling.

2. **A test** that imports the real modules. Keep harness files outside the repository (here
   `/tmp/studio-harness/`) and import the modules by absolute path:

   ```ts
   // /tmp/studio-harness/my-test.ts
   import { mkdirSync } from 'node:fs'
   import { join } from 'node:path'
   import * as db from '/path/to/studio/src/main/db'
   import { dbFile, setActiveRoot } from '/path/to/studio/src/main/paths'

   const root = join(process.env.STUDIO_TEST_HOME!, 'Library')
   mkdirSync(join(root, '.studio'), { recursive: true })
   setActiveRoot(root)
   db.openDb(dbFile(root), { create: true })
   console.log('schema version', db.getDb().pragma('user_version', { simple: true }))
   db.closeDb()
   ```

3. **Bundle** it with esbuild (already installed as a Vite dependency), from the project folder:

   ```bash
   npx esbuild /tmp/studio-harness/my-test.ts --bundle --platform=node --format=cjs --target=node22 \
     --alias:electron=/tmp/studio-harness/electron-stub.cjs --alias:@shared=./src/shared \
     --external:better-sqlite3 --external:@modelcontextprotocol/sdk --external:zod \
     --outfile=/tmp/studio-harness/my-test.cjs
   ```

4. **Run** it with Electron in Node mode, also from the project folder, so the externals resolve from
   `node_modules`:

   ```bash
   STUDIO_TEST_HOME=$(mktemp -d) ELECTRON_RUN_AS_NODE=1 NODE_PATH="$PWD/node_modules" \
     ./node_modules/.bin/electron /tmp/studio-harness/my-test.cjs
   ```

The bundle is CommonJS, so wrap asynchronous test code in an `async` function instead of using top-level
`await`. Don't block the event loop (e.g. with `execFileSync`) while a server in the same process should answer.

To test generations, pass a **stub `VeniceClient`** to `JobManager` — an object whose `quote`, `queue`, `retrieve`
and `complete` return canned answers (for example `retrieve` resolving to
`{ state: 'video', data: <bytes of a test clip> }`). For the agent connection, the best test is a real MCP SDK
client (`@modelcontextprotocol/sdk/client/streamableHttp.js`) against `AgentService`/`AgentServer` bound to
`127.0.0.1` on a free port (`AgentServiceOptions.hosts` overrides the listen addresses for tests).

To check what would actually be sent — the request body with its image and audio data URLs — keep the real
`VeniceClient` and **replace `fetch`** at the top of the test instead. Answer Venice's paths from canned JSON,
record the queue body, and throw for anything else, so a mistake can never reach the network:

```ts
const queued: Record<string, unknown>[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init) // an MCP client talking to the agent server
  const path = /^https:\/\/api\.venice\.ai\/api\/v1(\/[^?]*)/.exec(url)?.[1]
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  if (path === '/video/quote') return json({ quote: 0.42 })
  if (path === '/video/queue') {
    queued.push(JSON.parse(String(init?.body)))
    return json({ queue_id: `stub-${queued.length}` })
  }
  throw new Error(`blocked network call: ${url}`)
}) as typeof fetch
```

`prepareSubmission(params)` (`jobs.ts`) then applies the same guard as a real submit — tokens, measured audio
windows, the 15 s total — and `new VeniceClient(() => 'test-key').queue(await buildRequestBody(prepared))` puts the
body into `queued`: `reference_audio_urls` holds one `data:audio/mpeg;base64,…` per clip; decode one to a file and
`ffprobe` it to see the window that would be sent (mono, 44.1 kHz). The stub above leaves out `/models`; save
Venice's model list once (`GET /models?type=video` needs no key) and serve that file if a test needs it.

The review tools work on the fake rows and test clips above. Whether tool results carry audio depends on the
protocol version the client asked for in `initialize`: the SDK client asks for the latest and gets MP3 blocks; a
session initialized with `"protocolVersion": "2024-11-05"` (the `curl` example in [AGENTS.md](AGENTS.md) with that
version) gets the note that the sound was left out instead.

### Driving the real UI over CDP

To inspect or script the running renderer, start the dev profile with Chromium's remote debugging port:

```bash
STUDIO_DEV_PROFILE=1 npx electron-vite dev -w --remoteDebuggingPort 9333
```

`http://127.0.0.1:9333/json` lists the debuggable targets; connect to the page's `webSocketDebuggerUrl` and send
Chrome DevTools Protocol commands such as `Runtime.evaluate`:

```js
// cdp.mjs — usage: node cdp.mjs 'window.studio.getSettings()'
const targets = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: { expression: `(async () => (${process.argv[2]}))()`, awaitPromise: true, returnByValue: true }
}))
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id !== 1) return
  console.log(JSON.stringify(msg.result.result?.value ?? msg.result, null, 2))
  process.exit(0)
})
```

`Page.captureScreenshot` gives screenshots the same way. Anyone who can reach the debugging port controls the app,
so only use it on a dev profile, and remember that `window.studio.generate`, `generateSegment`,
`generateAllSegments` and `resolveApproval(id, true)` spend money. For the main process, `--inspect [port]` opens
the V8 inspector (attach from `chrome://inspect`). The renderer's DevTools are under *View → Toggle Developer
Tools* (⌥⌘I).

## Typecheck and build

```bash
npm run typecheck   # both TypeScript projects, strict mode
npm run build       # out/main, out/preload, out/renderer
npm run check       # both of the above
```

`npm run check` must pass before a pull request (see [CONTRIBUTING.md](../CONTRIBUTING.md)); CI
(`.github/workflows/ci.yml`) runs the same steps on macOS for every pull request and push to `main`.
`tsconfig.node.json` covers `src/main`, `src/preload` and `src/shared`; `tsconfig.web.json` covers
`src/renderer`, the preload's type declaration and `src/shared`.

## Packaging

`npm run app` runs `electron-vite build` and then electron-builder with `electron-builder.yml`:

- **Target:** a plain `.app` folder for `arm64` (`dist/mac-arm64/Studio.app`), no DMG or ZIP.
- **Signing:** ad hoc (`identity: '-'`), without hardened runtime or notarization. Apple Silicon refuses to run
  unsigned code, and ad-hoc signing is enough for the Mac that built the app. Distributing builds to other Macs
  would need a Developer ID and notarization (not set up). Because every build has a new ad-hoc signature, macOS
  may ask again whether Studio may use its Keychain entry; allow it, or the stored API key can't be read.
- **Native module:** `*.node` files are unpacked from the asar archive; `better-sqlite3`'s sources and prebuilt
  binaries for other platforms are left out.
- **Info.plist:** the folder-access usage descriptions (Documents, Desktop, Downloads, removable and network
  volumes) are in Swedish, like the UI; `electronLanguages` keeps `sv` and `en`.
- **Node and `require(esm)`:** electron-builder 26 `require()`s ES-module-only dependencies. Node 22.12 and later
  allow that by default (hence `"engines": { "node": ">=22.12" }`); the `app` script also sets
  `NODE_OPTIONS=--experimental-require-module` so it works where the feature is still behind that flag. The
  `ExperimentalWarning` printed during packaging is expected.
- `npm run app:install` deletes `/Applications/Studio.app` and copies the new build there; quit Studio first.

## Database migrations

Migrations are the `migrations` array in `src/main/db.ts`; `PRAGMA user_version` counts how many have run. To
change the schema:

1. **Append** a new SQL string to the end of the array. Never edit, reorder or remove an existing entry — every
   existing library has already run them. Several statements in one entry are fine; each entry runs in its own
   transaction, together with the `user_version` bump.
2. Write SQL that works on every earlier state reachable by the previous migrations (SQLite's `ALTER TABLE` is
   limited; renames carry rows and foreign keys along, as migration 6 shows).
3. If the new data holds **file paths**, store them relative to the base folder and teach every place that
   rewrites or looks for stored paths about it, or library moves, renames and *Städa upp* will break it (migration
   7 did this for `asset_audio.file_path` and `referenceAudios[].path`):
   - a new **column**: `mapStoredPaths`, `isStoredPathRecorded` and `isStoredPrefixRecorded` in `db.ts`, and
     `trackedFilePaths` in `library-root.ts` (and the reorganize/rename code if the files belong to an asset);
   - a new path **inside `params` JSON**: `mapParamPaths` (behind `toStoredParams` / `fromStoredParams`) in
     `paths.ts`, and
     `paramFilePaths`, `mapParamsJson` and `followRewrites` in `db.ts` (and `generationFilePaths` in
     `shared/generation-filter.ts` if the clip feed should find generations by it).
4. Update the row types and mappers (`GenerationRow`, `generationFromRow`, `sequence-store.ts` …), the shared types
   if the data reaches the renderer, and the data-model section of [ARCHITECTURE.md](ARCHITECTURE.md#data-model).
5. **Test on a copy.** Quit Studio (closing folds the WAL into `studio.db`), copy a library's folder into a
   throwaway profile (or copy just `.studio/studio.db` into a temp folder for a harness), and open the copy. Check
   that the migration runs once, that the app works afterwards, and that opening it again changes nothing.

There are no down-migrations: once a newer Studio has migrated a library, older builds should not open it.

## Adding an IPC method

1. **Contract** — add the method to `StudioApi` in `src/shared/types.ts`, with a doc comment that says what it
   resolves with and when it rejects. Shared request/response types go in the same file.
2. **Preload** — add one line to `src/preload/index.ts`:
   `doThing: (id) => ipcRenderer.invoke('area:doThing', id)`. For a main → renderer event, add an `on…` method
   using the `on()` helper, which returns an unsubscribe function.
3. **Main** — register `ipcMain.handle('area:doThing', …)` in the owning module's `register…` function. Treat the
   arguments as untrusted (they are untyped at runtime): validate them and reject with a Swedish, user-facing
   message.
4. **Side effects** — broadcast the matching change event (`library:change`, `sequence:change`,
   `generation:update` …) so open views refetch. Anything that moves files must respect the library-wide
   operation lock (`libraryOperationSettled`) and, for sequences, the service's file queue.
5. **Agents** — handlers are recorded automatically, so agent tools can reach the new method with
   `callService('area:doThing', …)`. If agents must be treated differently, check `isAgentCall(event)` (as the
   review and learning handlers do: an agent passes its name as the last argument and may only change what it
   wrote). A new user-facing capability also needs a tool (see below).
6. **Check** — `npm run check`, then try it in the dev profile; update [ARCHITECTURE.md](ARCHITECTURE.md#ipc-surface).

## Adding an agent tool

**Agents keep up with the app**: every capability a user gets also gets matching agent tools and guide text in
`src/main/agent/`, in the same pull request. Voices and the clip feed show the pattern: voices became `audio` on
`list_assets` / `get_asset`, `update_asset_audio` and audio items in `set_references`; the clip feed's filters
became `list_generations`' parameters through the shared `generation-filter.ts`; ratings and learnings became the
review tools.

Tools live in `src/main/agent/tools/` (`library.ts`, `form.ts`, `sequences.ts`, `paid.ts`, `review.ts`) and are
registered with `defineTool` (`kit.ts`):

- Give it a clear English `title` and `description` written for an LLM, a zod `input` schema with `.describe()`d
  fields, honest MCP `annotations` (`READ_ONLY`, `WRITE`, or destructive/open-world hints) and a short Swedish
  `summary` for the activity log.
- Reach Studio's services through `callService`, never by writing to the database or files directly, so the same
  validation and change notifications apply.
- Share filters and checks with the UI instead of re-implementing them (`shared/prompt-refs.ts`,
  `shared/generation-filter.ts`, `agent/studio.ts`), so an agent and the user always see the same result.
- Return pictures as `images` and sound as `audio` (`LabeledImage` / `LabeledAudio`, each with a label that says
  what it is); `agent/images.ts` and `agent/media.ts` make them from files, frames and ffmpeg output. Only send
  sound when the agent asks for it (`include_audio`); `defineTool` already replaces it with a note for clients
  whose protocol version has no audio content.
- Anything that costs money must go through `ApprovalStore` with a `verify` step, as in `tools/paid.ts`, and should
  run the same checks the submit will (`prepareSubmission`) before the user is asked. Never add a tool that spends
  money without the user's approval.
- Update the guide in `agent/guide.ts` (`studioGuide`, and `serverInstructions` if it changes how agents should
  work), the tool list and counts in [AGENTS.md](AGENTS.md#tools), and `CHANGELOG.md` under *Unreleased*.
