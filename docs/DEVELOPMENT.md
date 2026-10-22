# Development

How to run JIBES Studio (Studio for short) from source, test changes without spending money, build the app and change the database or the
IPC surface safely. For how the code is organised, see [ARCHITECTURE.md](ARCHITECTURE.md).

- [Setup](#setup)
- [Scripts](#scripts)
- [Profiles](#profiles)
- [Testing without spending money](#testing-without-spending-money) (test clips, voices, reviews, status rows,
  uploads, harnesses)
- [Typecheck and build](#typecheck-and-build)
- [Native helper](#native-helper) (voice separation)
- [Packaging](#packaging) (macOS, Windows)
- [Database migrations](#database-migrations)
- [Adding an asset kind](#adding-an-asset-kind)
- [Adding an IPC method](#adding-an-ipc-method)
- [Adding an agent tool](#adding-an-agent-tool)

## Setup

- macOS on Apple Silicon.
- Node.js from [`.nvmrc`](../.nvmrc) (24), at least 22.12.
- ffmpeg with ffprobe: `brew install ffmpeg`.
- Xcode Command Line Tools (`xcode-select --install`), in case `better-sqlite3` has to be compiled, and for the
  Swift compiler that builds the voice separation helper (optional: without it Studio runs without voice
  separation; see [Native helper](#native-helper)).

```bash
npm install
npm run dev
```

`npm install` runs `electron-rebuild -f -w better-sqlite3` afterwards, so the native SQLite module is built for
Electron's Node ABI. A consequence: plain `node` cannot load it — scripts that use the database run under Electron
(see [Electron-as-Node harnesses](#electron-as-node-harnesses)).

### On Windows

Studio also builds and runs on 64-bit Windows 10 or 11 (see [ARCHITECTURE.md](ARCHITECTURE.md#platforms) for what
differs):

- Node.js as above, and Visual Studio's C++ build tools ("Desktop development with C++") with Python, which
  `npm install`'s `electron-rebuild` uses.
- ffmpeg: `node scripts/fetch-ffmpeg-win.mjs` puts the same pinned build the Windows app ships into
  `build/ffmpeg-win/` (gitignored), where a development build finds it; otherwise `ffmpeg.exe` and `ffprobe.exe` on
  `PATH`.
- No Swift helper: `build:helpers` skips it (building only the Claude Desktop extension's parts), and voice
  separation is off (it is macOS only).
- The `dev` scripts set variables the POSIX way, which `cmd.exe` (npm's default shell on Windows) doesn't
  understand. In PowerShell run `$env:STUDIO_DEV_PROFILE = '1'; npx electron-vite dev -w` instead, or point npm at
  Git Bash once: `npm config set script-shell "C:\Program Files\Git\bin\bash.exe"`. `npm run typecheck`,
  `npm run build` and the scripts in `scripts/` work as they are.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Builds the native helper if needed, then the electron-vite dev server with watch (`-w`), as **Studio Dev** (`STUDIO_DEV_PROFILE=1`). The renderer hot-reloads; main and preload changes rebuild and restart Electron. |
| `npm run dev:real` | The same, with the real **Studio** profile. Quit Studio.app first. |
| `npm run build` | Builds the native helper if needed, then main, preload and renderer into `out/`. |
| `npm run build:helpers` | Builds the voice separation helper into `build/bin/` (see [Native helper](#native-helper)) and the Claude Desktop extension's parts into `build/mcpb/` (see [Claude Desktop extension](#claude-desktop-extension)). |
| `npm start` | Runs the built `out/` with electron-vite preview — **with the real profile**, like `dev:real`. |
| `npm run typecheck` | `tsc --noEmit` for the Node side (`tsconfig.node.json`) and the web side (`tsconfig.web.json`). |
| `npm run check` | `typecheck` + `build` — what CI runs, and what must pass before a pull request. |
| `npm run app` | Builds the native helper, then builds and packages `dist/mac-arm64/Studio.app` with electron-builder. |
| `npm run app:install` | `npm run app`, then replaces `/Applications/Studio.app` with the new build. |
| `npm run app:test` | Builds **Studio Test**, a variant with its own name, settings and library, into `dist/test/mac-arm64/` (`scripts/app-variant.mjs Test`). See [Profiles](#profiles). |
| `npm run app:install:test` | `npm run app:test`, then replaces `/Applications/Studio Test.app` with the new build. |
| `npm run screenshots` | Takes the README's screenshots into `docs/images/` from the built `out/` (run `npm run build` first), with a fresh, empty profile and library in a temporary folder. See [Screenshots](#screenshots). |

Because the dev app reloads on every save, keep the code compiling while you work: a broken save restarts a
broken main process.

## Profiles

A *profile* is Electron's `userData` folder (settings, API key, agent token, which base folder to open) plus the
suggested location of the library. Each library carries its own database inside its base folder.

| Run | Name | Settings | Suggested library |
| --- | --- | --- | --- |
| Studio.app, `npm run dev:real`, `npm start` | Studio | `~/Library/Application Support/Studio/` | `~/Movies/Studio` |
| `npm run dev` | Studio Dev | `~/Library/Application Support/Studio Dev/` | `~/Movies/Studio Dev` |
| Studio Test (`npm run app:install:test`) | Studio Test | `~/Library/Application Support/Studio Test/` | `~/Movies/Studio Test` |
| `STUDIO_PROFILE_DIR=<dir> npm run dev` | Studio Dev | `<dir>/userData/` | `<dir>/Movies/Studio Dev` |

- **Studio Dev** shows a yellow *Dev* badge under the wordmark and the window title "JIBES Studio Dev". It shares
  nothing with Studio.app, so both can run at the same time.
- **Studio Test** is a *variant* (`scripts/app-variant.mjs`, `src/main/variant.ts`): a separately built app with
  its own name, settings, library, place in the Dock and a pink *Test* badge – for a build of your own beside the installed app. It runs beside Studio.app and Studio Dev and never updates itself from
  GitHub (a release would replace it with Studio); `npm run app:install:test` rebuilds it from your checkout. macOS
  keeps each app's encryption key apart, so its Venice API key and agent token are its own. Another name works the
  same way: `node scripts/app-variant.mjs <Name> --install` (a capital letter, then letters and digits).
- **The single-instance lock is per profile.** A second launch of the same profile only brings the running one to
  the front (two instances would poll and download the same paid jobs). That is why `dev:real` needs Studio.app to
  be closed.
- **`dev:real` migrates the real library.** A build refuses a library whose database is newer than it knows
  (it says the library was saved by a newer version of Studio), but 0.1.0 predates that check and opens it anyway, then
  loses track of voices when it renames or deletes an asset. After running a branch with a new migration under
  `dev:real`, rebuild Studio.app (`npm run app:install`) before opening it again.
- **`STUDIO_PROFILE_DIR`** gives a throwaway profile: settings and the suggested library live under that folder.
  Use it for anything you want to delete afterwards, e.g. `STUDIO_PROFILE_DIR=/tmp/studio-test npm run dev`.
- Studio and Studio Test default to agent port 8770, Studio Dev to 8771, so the development copy can listen
  beside either. If Studio and Studio Test both have the agent connection on, give one of them another port.

On Windows the settings are in `%APPDATA%\Studio\` (`Studio Dev\`) and the suggested library is
`Videos\Studio` (`Videos\Studio Dev`).

**Never point development work at a library you care about.** Copy it into a throwaway profile instead.

## Testing without spending money

Every Venice generation costs real money, so development is set up to never need one. There is no automated test
suite yet; changes are verified with the techniques below (contributions of a proper test setup are welcome).

### Ground rules

- **Never trigger real generations while developing.** Don't press *Generate* (in the form or on a clip), *Generate
  missing*, the create button in *Create image…*, a priced button in the Editor, continue on a stopped edit job, the
  voice design button or approve an agent request in a profile that has a real API key, and never call Venice's paid endpoints from tests —
  `/video/queue`, `/image/generate`, `/image/multi-edit`, `/audio/speech`, `/audio/queue`, `/audio/voices`,
  `/audio/transcriptions`, `/video/transcriptions`, `/audio/voice-changer/queue`, `/augment/*`, and the retrieve and
  complete endpoints (they need a key too). Stub the `VeniceClient`, `VeniceAudio` or `fetch` instead. Free calls
  without a key are fine: `GET /models?type=…`, `/video/quote`, `/audio/quote` and `/audio/voice-changer/quote`
  (Topaz upscale quotes need a key, so without one plans ask for an API key under Settings).
- **Use a profile without an API key** for UI work. The model list and price quotes work without a key, but
  queueing a generation fails with a missing-API-key error before anything is sent.
- **Work in a throwaway profile and library** (`STUDIO_PROFILE_DIR`), not in `~/Movies/Studio*` or
  `~/Library/Application Support/Studio*`.
- **Never let a test reach the internet.** Agents' URL uploads are tried against a local HTTP server on
  `127.0.0.1` (the session's own machine, which Studio allows), and the public-address rules with a stubbed DNS
  lookup (`UploadStoreOptions.resolve`), never against real hosts.

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

**Own clips.** Import these through *Importera egna klipp…* (or a drop) to exercise the working copy: each needs one
for a different reason, and the copy must come out 8-bit BT.709, upright and at a constant frame rate.

```bash
cd /tmp/studio-clips
# HDR (HLG), 10-bit HEVC, rotated: a phone film held upright (the rotation is added by a remux)
ffmpeg -y -f lavfi -i "testsrc2=size=1920x1080:rate=30" -t 3 -c:v libx265 -pix_fmt yuv420p10le -tag:v hvc1 \
  -x265-params "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc" \
  -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc hlg-flat.mov
ffmpeg -y -display_rotation 90 -i hlg-flat.mov -c copy hlg.mov
# A variable frame rate without sound
ffmpeg -y -f lavfi -i "testsrc2=size=854x480:rate=30" -t 3 -vf "setpts='PTS+0.02*sin(N)/TB'" -fps_mode vfr \
  -c:v libx264 -pix_fmt yuv420p -an vfr.mp4
# ProRes, which Chromium can't play
ffmpeg -y -f lavfi -i "testsrc2=size=1280x720:rate=25" -t 3 -c:v prores_ks -profile:v 2 prores.mov
```

Importing the same file twice reuses the first import (same size and SHA-256).

**Editor.** Free operations (cuts, fades, volume, noise, loudness, added sound, and removing the voice or keeping
only the voice with the [native helper](#native-helper)) run entirely on the Mac and can be tried on any test clip. A tone
with pauses is enough to see where speech is found and how a waveform looks; the separation needs something
voice-like to separate, so use a recording of speech you are allowed to use. Paid operations are tried only with a
stubbed `fetch` (below), never by pressing a priced button with a key in the profile.

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

Add them to characters as voice clips in a throwaway library (`short.mp3` and `no-audio.m4a` must be refused with
their names). Two clips with the default 10 s windows add up to 20 s: the form won't take the second one, and
params that carry both anyway (an agent, a harness) are refused by the prompt check and by `prepareSubmission`
(the reference audio is 20 s, more than the 15 s allowed) before any call to Venice.

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
- Rows without `source` are Venice generations (`generated`). A fake own clip is a completed row with
  `source = 'import'`, empty `model` and `prompt`, a `title` and its file in `Egna klipp/<day>/`; its params need
  only `{"model":"","prompt":"","duration":"5s","resolution":"480p","aspectRatio":"16:9"}`.

### Fake reviews and learnings

The clip feed's rating filters, the detail drawer and the agents' review tools can be tried on the fake rows above.
Add a rating by the user, an agent's review and a pinned learning the same way (Studio quit):

```bash
sqlite3 "$LIB/.studio/studio.db" <<'SQL'
INSERT INTO generation_reviews (id, generation_id, author, rating, tags, note, created_at, updated_at)
VALUES ('fake-review-1', 'fake-1', 'user', 2, '["good-motion"]', 'Nice motion.', 1767268800000, 1767268800000),
       ('fake-review-2', 'fake-1', 'Test agent', -1, '["identity-drift"]', 'The face drifts after t = 3 s.',
        1767268900000, 1767268900000);
INSERT INTO learnings (id, title, insight, model, tags, evidence, author, pinned, created_at, updated_at)
VALUES ('fake-learning-1', 'Test learning', 'Short prompts drift less.', NULL, '["test"]', '["fake-1"]', 'user', 1,
  1767268800000, 1767268800000);
SQL
```

Author `user` is the user's own review (at most one per generation); any other author is an agent. A rating is
thumbs down (`-1`) or 1–3 stars; since migration 13 the table's `CHECK` allows nothing else. Tags and evidence are JSON
lists; evidence holds generation ids.

### Fake status rows

*Activity* reads finished work from the `unseen` table, so a fake completed row shows as seen until you add
one (Studio quit, as above). Ids only, never paths; `created_at` is when it finished:

```bash
sqlite3 "$LIB/.studio/studio.db" <<'SQL'
-- A finished video the user hasn't watched: New on its card, a dot on Generate, a row in the panel.
INSERT INTO unseen (id, generation_id, context, created_at) VALUES ('fake-unseen-1', 'fake-1', '{}', 1767268800000);
-- A picture that failed after its dialog closed (no row of its own: an error and a label, its owner in context).
INSERT INTO unseen (id, error, label, context, created_at)
VALUES ('fake-unseen-2', 'Venice svarade 500.', 'Bild', '{"failureOf":"still"}', 1767268900000);
SQL
```

A failed generation row (`status = 'failed'`, `error` set) with an `unseen` row is a new failure. Rows for a sequence's
or storyboard's run or export name it in `context` (`{"sequenceId": "…", "failureOf": "run"}`); such a row goes by
itself once that sequence is deleted. Things that *run* can't be faked with rows (only Venice generations have them,
and a pending row would be polled at Venice); start free work instead — an export, an import of a test clip, a free
operation in the Editor — or drive the services in a harness. Playing a test clip for a second marks it seen, which is
the quickest check of the playback rule.

### Test agent uploads

Uploads need a library and the agent connection (a throwaway profile). Serve test files from a local server and
let the agent (or a harness's MCP SDK client) fetch them; a loopback session may fetch from its own machine:

```bash
mkdir -p /tmp/studio-uploads && cd /tmp/studio-uploads
sips -s format heic photo.jpg --out photo.heic       # HEIC, converted back to JPEG by Studio
printf '<html></html>' > not-a-picture.jpg           # refused: the bytes are HTML, whatever the name says
python3 -m http.server 8787 --bind 127.0.0.1         # begin_upload({kind: "image", url: "http://127.0.0.1:8787/photo.heic"})
```

For a `PUT`, call `begin_upload({kind, file_name, bytes})` and send the file to the `put_url` it answers with
`curl -T <file> -H "Authorization: Bearer $STUDIO_MCP_TOKEN" <put_url>`. For a file over 1 MB curl sends `Expect:
100-continue`, and `curl -v` shows that a refused `PUT` (no token, a wrong length) gets its answer without a `100
Continue`, so the body is never sent. Uploads are staged in the
library's `.studio/tmp/agent-uploads/`. In harnesses, `UploadStoreOptions.limits` shortens the timeouts and
`resolve` stands in for DNS, so a rebinding answer (public first, private next) and the redirect rules can be tested
without leaving the Mac.

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
     // Empty: pictures are then sent as the file's bytes (input-image.ts decodes with createFromBuffer).
     nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createFromBuffer: () => ({ isEmpty: () => true }) },
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
  // Stills (images.ts): /image/generate answers with base64 images, /image/multi-edit with the picture's bytes.
  if (path === '/image/generate') return json({ images: [testPng.toString('base64')] })
  if (path === '/image/multi-edit') return new Response(testPng, { headers: { 'content-type': 'image/png' } })
  throw new Error(`blocked network call: ${url}`)
}) as typeof fetch
```

`prepareSubmission(params)` (`jobs.ts`) then applies the same guard as a real submit — tokens, measured audio
windows, the 15 s total — and `new VeniceClient(() => 'test-key').queue(await buildRequestBody(prepared))` puts the
body into `queued`: `reference_audio_urls` holds one `data:audio/mpeg;base64,…` per clip; decode one to a file and
`ffprobe` it to see the window that would be sent (mono, 44.1 kHz). The stub above leaves out `/models`; save
Venice's model lists once (`GET /models?type=video`, `?type=image` and `?type=inpaint` need no key) and serve those
files if a test needs them. `testPng` is any small PNG; `generateStill` then saves it as a still, and the recorded
bodies show what would be sent (`safe_mode`, the references as data URLs with the base first).

The prompt in a body built that way is the user's own. The References legend of the assets' descriptions is
appended by `JobManager.submit` (through `composeSubmission`, which reads the descriptions from the open library),
so submit through a `JobManager` to see the prompt exactly as it is sent, or call `composeSubmission(prepared)`
yourself. The job manager needs the models' prompt limits for that: pass a model loader as its second argument
(`new JobManager(venice, async () => models)`, as `index.ts` passes its cached list), or serve `/models` — without
either it composes without a limit.

For the Editor's paid operations stub `/audio/*` and `/video/*` the same way, keeping the real `VeniceAudio` and
`VeniceClient`: serve `/models?type=tts|music|asr` from saved lists (add a fake model with `voice_changer: true` and
a short `max_source_audio_duration_seconds` to force chunking), answer `/audio/quote` and
`/audio/voice-changer/quote` with a price, and parse multipart bodies (`/audio/voices`, `/audio/transcriptions`,
`/audio/voice-changer/queue`) with `await new Response(init.body, { headers }).formData()`. Return converted audio
at another sine frequency than the original, so a band-pass level shows where the voice was replaced. Useful
assertions: every `/video/quote` body for a video-input model stays under 1 MB (the stand-in, not the film);
voice-changer and audio quotes send whole seconds; the transcription form has `timestamps=true`; a step left
`sending` is failed at the next `resume()` and never sent again, and a job with `pending` steps sends nothing until
`resumeEditJob`.

To check frames exactly — the start and end image a clip sends, or which frames an export keeps at each cut — make
test videos whose every frame has its own colour (or two colour halves, for more than 64 frames), read the frames
back with `ffmpeg -vf scale=8:8:flags=area -f rawvideo -pix_fmt rgb24 -` and map each colour back to its number.
Trims come in 0.1 s steps, so test cuts that fall between frames too.

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
`generateAllSegments` and `resolveApproval(id, true)` spend money (or, for a removal, delete things). For the main process, `--inspect [port]` opens
the V8 inspector (attach from `chrome://inspect`). The renderer's DevTools are under *View → Toggle Developer
Tools* (⌥⌘I).

## Typecheck and build

```bash
npm run typecheck   # both TypeScript projects, strict mode
npm run build       # out/main, out/preload, out/renderer
npm run check       # both of the above
```

`npm run check` must pass before a pull request (see [CONTRIBUTING.md](../CONTRIBUTING.md)); CI
(`.github/workflows/ci.yml`) runs the same steps on macOS for every pull request and push to `main`, plus
`npm run build:helpers` and the helper's `--probe`, and typechecks and builds on Windows too, so code that only
works on a Mac shows up there (packaging and starting the Windows app are left to the release workflow).
`tsconfig.node.json` covers `src/main`, `src/preload` and `src/shared`; `tsconfig.web.json` covers
`src/renderer`, the preload's type declaration and `src/shared`.

## Native helper

Voice and background separation (removing the voice, keeping only the voice, keeping the background under a new voice) uses
macOS's own AUSoundIsolation audio unit through a small Swift command-line helper, `studio-voice-isolate`
(`native/voice-isolate/main.swift`). `npm run build:helpers` (`scripts/build-helpers.mjs`) compiles it:

- with `xcrun --sdk macosx swiftc -O -target arm64-apple-macos13` (the Xcode Command Line Tools; a bare toolchain
  `swiftc` can't find the standard library without the SDK), into `build/bin/studio-voice-isolate`, which is
  gitignored, then signs it ad hoc (Apple Silicon runs no unsigned code);
- `npm run dev`, `dev:real`, `build` and `app` run it first. A stamp file next to the binary (a hash of the source,
  the flags and the compiler version) skips an up-to-date helper in a fraction of a second; `--force` rebuilds
  (`npm run build:helpers -- --force`);
- without the Swift compiler, or off macOS, it prints a note and skips; `STUDIO_SKIP_HELPERS=1` skips it on purpose.
  Studio then runs without voice separation: *Settings → Tools* says that it isn't built and to run
  `npm run build:helpers`, and the Editor offers only what works without stems.

`src/main/voice-separation.ts` looks for the helper in `<app>/Contents/Resources/bin/` when packaged (electron-builder
copies it there through `extraResources`) and in `build/bin/` in development. Try it by hand:

```bash
build/bin/studio-voice-isolate --probe          # {"ok":true,"hq":true,"latency":0.1325} on macOS 15+
build/bin/studio-voice-isolate in.wav voice.wav background.wav   # 32-bit float WAVs, progress=… on stdout
```

Studio runs the helper with a watchdog: no `progress=` line for two minutes, or a run longer than the sound itself
(at least five minutes), kills it and fails the separation with a message. A new or changed helper must keep
printing progress every few percent. Before it starts, `separateStems` checks that the scratch WAVs (the sound three
times over as 32-bit float at 48 kHz) fit on the library's disk with 1 GB to spare.

## Claude Desktop extension

*Add to Claude Desktop* (Settings → Agent connection) zips the parts in `build/mcpb/` into a `.mcpb` with the address
and the token (see [ARCHITECTURE.md](ARCHITECTURE.md#claude-desktop)). `scripts/build-mcpb.mjs` builds them — the
bridge `src/mcpb/bridge.ts` bundled with the MCP SDK into `server/index.js` by esbuild, the manifest template
`src/mcpb/manifest.json` with the version from `package.json`, the licences and the icon — in well under a second;
`build:helpers` runs it every time, so `dev`, `build` and `app` always have it. Packaged, it is in
`Contents/Resources/mcpb/` (`resources\mcpb\` on Windows).

Try the bridge by hand against a running Studio Dev (the token from its Settings), and validate the manifest with
Anthropic's [MCPB CLI](https://github.com/modelcontextprotocol/mcpb):

```bash
STUDIO_URL=http://127.0.0.1:8770/mcp STUDIO_TOKEN=<token> STUDIO_BRIDGE_DEBUG=1 node build/mcpb/server/index.js
npx @anthropic-ai/mcpb validate build/mcpb
```

## Packaging

### macOS

`npm run app` runs `electron-vite build` and then electron-builder with `electron-builder.yml`:

- **Target:** a plain `.app` folder for `arm64` (`dist/mac-arm64/Studio.app`). The release workflow asks for a ZIP
  and a DMG instead (`--mac zip dmg`), named `Studio-mac-arm64.zip` / `.dmg` (`mac.artifactName`), so
  `releases/latest/download/Studio-mac-arm64.zip` always points at the newest release.
- **Signing:** ad hoc (`identity: '-'`), without hardened runtime or notarization. Apple Silicon refuses to run
  unsigned code, and ad-hoc signing is enough for the Mac that built the app. Distributing builds to other Macs
  would need a Developer ID and notarization (not set up). Because every build has a new ad-hoc signature, macOS
  may ask again whether Studio may use its Keychain entry; allow it, or the stored API key can't be read.
- **Native module:** `*.node` files are unpacked from the asar archive; `better-sqlite3`'s sources and prebuilt
  binaries for other platforms are left out.
- **Native helper:** `build/bin/studio-voice-isolate` is copied to `Contents/Resources/bin/` (`extraResources`). A
  build without it only gets a warning from electron-builder, and that app runs without voice separation.
- **Claude Desktop extension:** `build/mcpb/` is copied to `Contents/Resources/mcpb/` (both systems: `extraResources`);
  without it *Add to Claude Desktop* says the build has no extension. The release workflow checks it is there.
- **Info.plist:** the folder-access usage descriptions (Documents, Desktop, Downloads, removable and network
  volumes) are set in `electron-builder.yml`; `electronLanguages` keeps only `en`.
- **Node and `require(esm)`:** electron-builder 26 `require()`s ES-module-only dependencies. Node 22.12 and later
  allow that by default (hence `"engines": { "node": ">=22.12" }`); the `app` script also sets
  `NODE_OPTIONS=--experimental-require-module` so it works where the feature is still behind that flag. The
  `ExperimentalWarning` printed during packaging is expected.
- `npm run app:install` deletes `/Applications/Studio.app` and copies the new build there; quit Studio first.

### Windows

The release workflow builds the Windows app on a Windows runner; on Windows (or, for a look at the files, even on a
Mac) it is:

```bash
node scripts/fetch-ffmpeg-win.mjs        # the pinned ffmpeg into build/ffmpeg-win (--check also runs it, Windows only)
npx electron-vite build
npx electron-builder --win nsis zip --x64 --publish never -c.npmRebuild=false
node scripts/smoke-test.mjs dist/win-unpacked/Studio.exe --bundled-ffmpeg
```

- **Targets:** `Studio-win-x64-setup.exe` (NSIS, `nsis.artifactName`) and `Studio-win-x64.zip` (portable), x64
  only; `--dir` gives just `dist/win-unpacked/`.
- **Installer:** the assisted NSIS installer, per user by default (no administrator rights; installed under
  `%LOCALAPPDATA%\Programs\Studio`), where the folder can be changed; Start menu and desktop shortcuts; English only.
  Uninstalling keeps the settings, and never touches a library.
- **Signing:** none. SmartScreen warns the first time ("Windows protected your PC" → *More info* → *Run anyway*, as
  the README says); a code-signing certificate in the workflow would remove that.
- **Icon:** electron-builder turns `build/icon.png` (1024 × 1024) into a multi-size `.ico` itself; no `.ico` is kept
  in the repository.
- **ffmpeg:** comes with the app in `resources/ffmpeg/` (`win.extraResources` from `build/ffmpeg-win`), which
  `src/main/ffmpeg.ts` tries before `PATH`. `scripts/fetch-ffmpeg-win.mjs` downloads one pinned
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) GPL build of FFmpeg's release branch (the "shared"
  variant: `ffmpeg.exe` and `ffprobe.exe` share one set of FFmpeg DLLs, about half the size of two static
  programs), checks its SHA-256 before unpacking, and adds FFmpeg's licence and a `SOURCE.txt` with the source links
  (see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)). `--check` runs it and fails unless it has every encoder,
  muxer and filter Studio uses; the list is in the script. To move to a newer build, take a month's last
  `autobuild-…` release (BtbN keeps those for two years, daily ones for two weeks), its
  `…-win64-gpl-shared-<branch>.zip` and that file's SHA-256 from the release's `checksums.sha256`; the script's
  header says how.
- **Native module:** better-sqlite3's own Node-API binary for Windows (`prebuilds/win32-x64.node`) is kept and the
  other platforms' are left out (`win.files`); it loads in Electron as it is, so nothing is rebuilt
  (`-c.npmRebuild=false`, which also lets a Mac package the Windows app).
- **Languages:** Chromium's Windows locale files are named `en-US.pak` …, so `win.electronLanguages` keeps `en-US`.
- **Smoke test:** `scripts/smoke-test.mjs [app] [--bundled-ffmpeg] [--screenshot file.png]` starts a built app
  (default `dist/win-unpacked/Studio.exe` on Windows, `dist/mac-arm64/Studio.app` on a Mac) with a new temporary
  profile and a remote-debugging port, and checks over the DevTools protocol that the window shows Studio, that
  ffmpeg is found and reports its version (with `--bundled-ffmpeg`: the copy in the app's `resources/ffmpeg`),
  that a new, empty library opens (the SQLite database is created) and that Settings renders with ffmpeg in it;
  then it closes Studio and deletes the profile. It never reads your settings or library and uses no API key.

## Releasing

Releases are built on GitHub, not on a laptop (`.github/workflows/release.yml`):

1. Bump `version` in `package.json` (and `package-lock.json`: `npm version 0.2.0 --no-git-tag-version`), move the
   *Unreleased* entries in `CHANGELOG.md` under the new version, and commit.
2. Tag the commit and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

3. The workflow builds both platforms side by side, each checking that the tag matches `package.json` and
   typechecking first:
   - `mac` (an Apple Silicon runner): builds the native helper and packages `Studio-mac-arm64.zip` and `.dmg`;
   - `windows` (a Windows runner): fetches and checks the pinned ffmpeg, packages `Studio-win-x64-setup.exe` and
     `Studio-win-x64.zip`, and runs the smoke test on `dist/win-unpacked/Studio.exe` (its screenshot is kept as the
     `smoke-test-windows` artifact, also when it fails);
   - `publish` (tags only, once both have passed) writes `SHA256SUMS.txt` (the four files' SHA-256) and creates the
     GitHub release `v0.2.0` with all five files and generated notes.

   *Run workflow* on the Actions tab builds the same files as artifacts of the run without publishing anything.

The builds are signed ad hoc, not notarized. `install.sh` downloads the ZIP with `curl`, which sets no quarantine
flag, so the app opens without Gatekeeper's prompt; a DMG downloaded in a browser needs *Open Anyway* once (the
README says so). A Developer ID and notarization in the workflow would remove that step.

`install.sh` can be tried without touching `/Applications` or downloading anything:

```bash
STUDIO_ZIP=dist/Studio-mac-arm64.zip STUDIO_APPS_DIR=/tmp/apps STUDIO_NO_OPEN=1 bash install.sh
```

It only quits a running Studio when that is the copy it replaces.

Installed copies find the release by themselves (the daily check, or *Check for Updates…*) and install
`Studio-mac-arm64.zip` or `Studio-win-x64-setup.exe` after checking it against GitHub's digest of the file or
`SHA256SUMS.txt` (see [ARCHITECTURE.md](ARCHITECTURE.md#updates)); the release's tag must be the version in
`package.json`, and the files must keep their names. A development build never checks. To try the update UI without
GitHub, point a build at a stand-in for its API with `STUDIO_UPDATE_TEST_SERVER=http://127.0.0.1:<port>` (loopback
only; it serves `/repos/<owner>/<repo>/releases/latest` and the files): an unpackaged build then checks and downloads
like a release but refuses to install itself, and a packaged one in a throwaway folder (with `STUDIO_PROFILE_DIR`)
goes all the way, reopening with the same two variables.

## Screenshots

`npm run screenshots` (after `npm run build`) starts the built app with `STUDIO_PROFILE_DIR` pointing at a new
temporary folder, creates an empty library there, adds a little neutral structure (a sequence and a storyboard with
short notes, no media), opens Generate, the `/` menu, Sequences, Storyboards and the Editor at 1440 × 900 (2× pixels)
over the DevTools protocol and saves `docs/images/*.png`. It never reads your own settings or library, generates
nothing and uses no API key; the temporary folder is removed afterwards. Run it again when the UI changes.

## Database migrations

Migrations are the `migrations` array in `src/main/db.ts`; `PRAGMA user_version` counts how many have run. To
change the schema:

1. **Append** a new SQL string to the end of the array. Never edit, reorder or remove an existing entry — every
   existing library has already run them. Several statements in one entry are fine; each entry runs in its own
   transaction, together with the `user_version` bump.
2. Write SQL that works on every earlier state reachable by the previous migrations (SQLite's `ALTER TABLE` is
   limited; renames carry rows and foreign keys along, as migration 6 shows). A `CHECK` can't be changed in place:
   migration 13 rebuilds `generation_reviews` — a new table with the new `CHECK`, the rows copied and converted, the
   old one dropped, the new one renamed and its indexes created again.
3. If the new data holds **file paths**, store them relative to the base folder and teach every place that
   rewrites or looks for stored paths about it, or library moves, renames and *Tidy up* will break it (migration
   7 did this for `asset_audio.file_path` and `referenceAudios[].path`):
   - a new **column**: `mapStoredPaths`, `isStoredPathRecorded`, `isStoredPrefixRecorded`, `rewriteStoredPrefix`,
     `followRewrites` and `relativizeStoredPaths` in `db.ts`, and `trackedFilePaths` and *Tidy up* in
     `library-root.ts` (and the reorganize/rename code if the files belong to an asset). Migration 11 did this for
     `generations.original_path` (an import's original) and `edit_media.file_path`;
   - a new path **inside `params` JSON**: `mapParamPaths` (behind `toStoredParams` / `fromStoredParams`) in
     `paths.ts`, and
     `paramFilePaths`, `mapParamsJson` and `followRewrites` in `db.ts`, `referencedFiles` in `references.ts`, the
     file check before a submit in `venice.ts` (and `generationFilePaths` in `shared/generation-filter.ts` if the clip
     feed should find generations by it). Migration 11 did this for `sourceVideo` and `referenceVideos`;
   - other JSON columns (`recipe`, `details`, `request`, `segments`) hold ids only, never paths: a path there
     would not follow a rename or a library move;
   - a new kind of **file** also needs a home: `jobs.videoHome` decides the folder of every generation's video
     (the [file home rule](ARCHITECTURE.md#the-file-home-rule)), and sequences, imports, edits and *Tidy up*
     all go through it.
4. Update the row types and mappers (`GenerationRow`, `generationFromRow`, `sequence-store.ts` …), the shared types
   if the data reaches the renderer, and the data-model section of [ARCHITECTURE.md](ARCHITECTURE.md#data-model).
5. **Test on a copy.** Quit Studio (closing folds the WAL into `studio.db`), copy a library's folder into a
   throwaway profile (or copy just `.studio/studio.db` into a temp folder for a harness), and open the copy. Check
   that the migration runs once, that the app works afterwards, and that opening it again changes nothing.
6. **A new top-level folder** (as `Produkter` in migration 12) gets a `*_SCHEMA_VERSION` constant in `db.ts` and an
   entry in `library-root.ts`'s `ADDED_FOLDERS` (and `VISIBLE_FOLDERS`), so an older library whose base folder already
   holds a folder of the user's own by that name is refused until it is renamed, instead of the user's files being
   taken over.

Migration 12 is the latest example of bookkeeping without paths: `unseen.context`, `take_trims` and the `origin`
columns hold ids, names and hosts only, so none of the stored-path code had to learn about them.

There are no down-migrations: once a newer Studio has migrated a library, older builds should not open it.

## Adding an asset kind

`AssetKind` / `ASSET_KINDS` (`src/shared/types.ts`) and `ASSET_FOLDERS` (`src/main/paths.ts`) drive most of the code,
and the `Record<AssetKind, …>` maps make TypeScript point at most of the rest (wording, colours, the picker copy, the
agents' kind words). Products showed what the compiler doesn't catch:

- a migration that bumps the schema version for the new folder (step 6 above), and the folder in `library-root.ts`:
  `VISIBLE_FOLDERS`, `ADDED_FOLDERS`, `ASSET_LABELS`, `REVEAL_FOLDERS`, `ASSET_TARGETS`;
- the renderer's `LIBRARY_FOLDERS` and `SELECTED_ASSET_KEYS` (`lib/library.ts`), `ASSET_VIEW` and the views
  (`lib/navigation.ts`, `lib/assets.ts`), the folder tree's entries (`library/FolderTree.tsx`);
- `AssetIcon.tsx` (one explicit branch per kind), `KIND_TONE` and `PICKER_COPY` (`pickers/`), `AssetPicker`'s
  `counts` and its tab grid, `ParamsForm.tsx`'s `kindButtons` and `SINGLE_IMAGE_KINDS`, `AssetImages`' `LAYOUT`;
- the prompt grammar if the kind relates to others (`pickers/text.ts`, `prompt/promptText.ts`, `AssetChips.tsx`);
- every sentence that lists the kinds (`ReferenceImages.tsx`, `TokenMenu.tsx`, `LibrarySetup.tsx`,
  `assets.ts`'s `assetWorkBusy`, the start and end picker titles in `ParamsForm.tsx`, `agent/studio.ts`), the work
  summary's view of the kind (`work.ts`'s `assetView`, `WorkView`, `AssetViewId`) and the agent guide and tool
  descriptions (`guide.ts`, `tools/library.ts`, `tools/delete.ts`).

A grep for an existing kind's plural (`Poser`, `poses`) finds them.

## Adding an IPC method

1. **Contract** — add the method to `StudioApi` in `src/shared/types.ts`, with a doc comment that says what it
   resolves with and when it rejects. Shared request/response types go in the same file.
2. **Preload** — add one line to `src/preload/index.ts`:
   `doThing: (id) => ipcRenderer.invoke('area:doThing', id)`. For a main → renderer event, add an `on…` method
   using the `on()` helper, which returns an unsubscribe function.
3. **Main** — register `ipcMain.handle('area:doThing', …)` in the owning module's `register…` function. Treat the
   arguments as untrusted (they are untyped at runtime): validate them and reject with a user-facing
   message.
4. **Side effects** — broadcast the matching change event (`library:change`, `sequence:change`, `storyboard:change`,
   `generation:update` …) so open views refetch. Anything that moves files must respect the library-wide operation
   lock (`libraryOperationSettled`) and, for sequences, the service's file queue.
5. **Agents** — handlers are recorded automatically, so agent tools can reach the new method with
   `callService('area:doThing', …)`. If agents must be treated differently, check `isAgentCall(event)` (as the
   review and learning handlers do: an agent passes its name as the last argument and may only change what it
   wrote). What only the user may do (settings, delete edits or versions, clone consent, marking things seen …)
   refuses an agent's call in the handler too (an error saying only the user can do it), behind the tool list. A
   handler that takes file paths calls `assertAgentFiles(event, paths)` (`upload-paths.ts`), so an agent's call can
   only hand over uploads or files the library records. Anything paid takes the price the user saw and refuses when
   it rose (`expectedPriceUsd`, as `edits:run` does). A new user-facing capability also needs a tool (see below), and
   work that runs for a while needs a place in *Activity* (a registry `work.ts` reads, a `touch` when it starts
   or stops, an `unseen` row when its result is news).
6. **Check** — `npm run check`, then try it in the dev profile; update [ARCHITECTURE.md](ARCHITECTURE.md#ipc-surface).

## Adding an agent tool

**Agents keep up with the app**: every capability a user gets also gets matching agent tools and guide text in
`src/main/agent/`, in the same pull request. Voices and the clip feed show the pattern: voices became `audio` on
`list_assets` / `get_asset`, `update_asset_audio` and audio items in `set_references`; the clip feed's filters
became `list_generations`' parameters through the shared `generation-filter.ts`; ratings and learnings became the
review tools.

Tools live in `src/main/agent/tools/` (`library.ts`, `form.ts`, `sequences.ts`, `stills.ts`, `storyboards.ts`,
`paid.ts`, `editor.ts`, `editor-paid.ts` with `edit-input.ts`, `review.ts`, `uploads.ts`, `imports.ts`, `delete.ts`,
`work.ts`, with the shared upload and picture sources in `sources.ts`) and are registered with `defineTool` (`kit.ts`). The Editor shows the pattern for a new area: read and free tools in `editor.ts`, the paid requests in
`editor-paid.ts`, one snake_case input schema and converter for the operations (`edit-input.ts`), every check left
to the service's own plan (`edits:plan`), and an approval panel in `components/agent/EditApproval.tsx`:

- Give it a clear English `title` and `description` written for an LLM, a zod `input` schema with `.describe()`d
  fields, honest MCP `annotations` (`READ_ONLY`, `WRITE`, or destructive/open-world hints) and a short
  `summary` for the activity log.
- Reach Studio's services through `callService`, never by writing to the database or files directly, so the same
  validation and change notifications apply.
- **Never take a file path.** A file comes as an `{upload_id}` (or a `{url}`, fetched like `begin_upload`), resolved
  with `ctx.uploads.resolve(id, kind)` to its staged file (`sources.ts` does both), or as the id of something the library holds. A file that
  ends up in generation params is imported as a still first (`importAsStill` in `sources.ts`).
- **Never remove anything directly.** A removal is an item kind of `request_delete` (`tools/delete.ts`: planning with
  its refusals and effects, `verify`, and `execute` through `callApproved`), never a tool of its own; a change that
  would remove something as a side effect (a board put between two boards) refuses instead.
- Share filters and checks with the UI instead of re-implementing them (`shared/prompt-refs.ts`,
  `shared/generation-filter.ts`, `shared/prompt-compose.ts`, `shared/prompt-remap.ts`, `agent/studio.ts`), so an
  agent and the user always see the same result — a prompt an agent is shown is composed by main's
  `composeSubmission`, exactly as it will be sent.
- Return pictures as `images` and sound as `audio` (`LabeledImage` / `LabeledAudio`, each with a label that says
  what it is); `agent/images.ts` and `agent/media.ts` make them from files, frames and ffmpeg output. Only send
  sound when the agent asks for it (`include_audio`); `defineTool` already replaces it with a note for clients
  whose protocol version has no audio content.
- Anything that costs money must go through `ApprovalStore` with a `verify` step, as in `tools/paid.ts` and
  `tools/editor-paid.ts`, and should run the same checks the submit will (`prepareSubmission`, or the service's own
  plan) before the user is asked. `verify` must catch everything that changed since the request (files by identity,
  plans by fingerprint, the price). Never add a tool that spends money without the user's approval.
- Update the guide in `agent/guide.ts` (`studioGuide`, and `serverInstructions` if it changes how agents should
  work), the tool list and counts in [AGENTS.md](AGENTS.md#tools), and `CHANGELOG.md` under *Unreleased*. Grep the
  guide and the descriptions for sentences the change makes untrue ("only the user …", "you can't …").
