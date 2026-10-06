import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, rmSync } from 'node:fs'
import { access, constants, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path'
import type { FfmpegStatus } from '@shared/types'

// Thin wrappers around the ffmpeg/ffprobe binaries (from Homebrew; nothing is bundled).

const NOT_FOUND = 'ffmpeg hittades inte. Installera med: brew install ffmpeg'
/** Checked before PATH: an app started from Finder doesn't inherit the shell's Homebrew PATH. */
const KNOWN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
const MAX_STDERR = 16 * 1024
const PROBE_TIMEOUT_MS = 30_000
const IMAGE_TIMEOUT_MS = 60_000
/** Trimmed clips shorter than this can end up without a single video frame. */
const MIN_CLIP_SECONDS = 0.1

interface Binaries {
  ffmpeg: string
  ffprobe: string
  version: string
}

let located: Promise<Binaries> | undefined

function binaries(): Promise<Binaries> {
  // Only success is cached, so installing ffmpeg while the app runs is picked up on the next call.
  located ??= locate().catch((err: unknown) => {
    located = undefined
    throw err
  })
  return located
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findIn(dirs: string[], name: string): Promise<string | undefined> {
  for (const dir of dirs) {
    const path = join(dir, name)
    if (await isExecutable(path)) return path
  }
  return undefined
}

async function locate(): Promise<Binaries> {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const dirs = [...new Set([...KNOWN_DIRS, ...pathDirs])]
  const ffmpeg = await findIn(dirs, 'ffmpeg')
  if (!ffmpeg) throw new Error(NOT_FOUND)
  // Prefer the ffprobe installed next to this ffmpeg so the two versions match.
  const ffprobe = await findIn([dirname(ffmpeg), ...dirs], 'ffprobe')
  if (!ffprobe) throw new Error('ffprobe hittades inte (ingår i ffmpeg). Installera med: brew install ffmpeg')
  let stdout: string
  try {
    ;({ stdout } = await run(ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 10_000 }))
  } catch (err) {
    throw new Error(`ffmpeg kunde inte startas: ${errorMessage(err)}`)
  }
  const version = /ffmpeg version (\S+)/.exec(stdout)?.[1] ?? 'okänd'
  return { ffmpeg, ffprobe, version }
}

export async function ffmpegStatus(): Promise<FfmpegStatus> {
  try {
    const { ffmpeg, version } = await binaries()
    return { ok: true, path: ffmpeg, version }
  } catch (err) {
    return { ok: false, message: errorMessage(err) }
  }
}

// ── Process runner ───────────────────────────────────────────────────────────

interface RunOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Receives stdout as it arrives; stdout is then not collected. */
  onStdout?: (text: string) => void
}

interface RunResult {
  stdout: string
  stderr: string
}

const running = new Set<ChildProcess>()
/** Temp files ffmpeg is writing right now; they are only renamed into place once complete. */
const partialFiles = new Set<string>()
let exitHookInstalled = false

/** Long exports shouldn't outlive the app. */
function killOnExit(child: ChildProcess): void {
  running.add(child)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', stopAllFfmpeg)
}

/**
 * Kills every running ffmpeg/ffprobe and deletes the files they were writing. Synchronous, so it can run
 * while the app quits, when the async cleanup after a failed run never gets to happen; otherwise a quit
 * mid-export would leave an unplayable `<name>.part.mp4` next to the real exports.
 */
export function stopAllFfmpeg(): void {
  for (const c of running) c.kill('SIGKILL')
  for (const file of partialFiles) {
    try {
      rmSync(file, { force: true })
    } catch {
      // Best effort while quitting.
    }
  }
  partialFiles.clear()
}

/** Temp outputs: `<name>.part.mp4` from concatClips, `.<name>.<8 hex>.part.<ext>` from tempSibling. */
const PARTIAL_FILE = /(\.part\.mp4|^\..+\.[0-9a-f]{8}\.part\.(png|jpe?g))$/i

/**
 * Deletes temp files a crash or force quit left in the given folders. Files this process is still writing
 * are kept, so it is safe to call while thumbnails are being made.
 */
export function removeLeftoverPartialFiles(dirs: string[]): void {
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(dir, name)
      if (!PARTIAL_FILE.test(name) || partialFiles.has(path)) continue
      try {
        rmSync(path, { force: true })
      } catch (err) {
        console.warn(`Could not remove leftover temp file ${path}: ${errorMessage(err)}`)
      }
    }
  }
}

function abortError(): Error {
  const err = new Error('Avbrutet.')
  err.name = 'AbortError'
  return err
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The last few meaningful stderr lines, without ffmpeg's "[component @ 0x…]" prefixes. */
function stderrTail(stderr: string, lines = 4): string {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]*@ 0x[0-9a-f]+\]\s*/i, '').trim())
    .filter(Boolean)
    .slice(-lines)
    .join('\n')
}

function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    if (opts.signal?.aborted) return reject(abortError())
    const name = basename(bin)
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    killOnExit(child)

    let stdout = ''
    let stderr = ''
    let aborted = false
    let timedOut = false
    let done = false

    const onAbort = (): void => {
      aborted = true
      child.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, opts.timeoutMs)
      : undefined

    const finish = (err?: Error): void => {
      if (done) return
      done = true
      running.delete(child)
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolvePromise({ stdout, stderr })
    }

    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      if (opts.onStdout) opts.onStdout(chunk)
      else stdout += chunk
    })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR)
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        // Uninstalled while the app was running; look again next time.
        located = undefined
        finish(new Error(NOT_FOUND))
      } else {
        finish(new Error(`${name} kunde inte startas: ${err.message}`))
      }
    })
    child.on('close', (code, signal) => {
      if (aborted) return finish(abortError())
      if (timedOut) return finish(new Error(`${name} svarade inte inom ${Math.round(opts.timeoutMs! / 1000)} s.`))
      if (code === 0) return finish()
      finish(new Error(stderrTail(stderr) || `${name} avslutades oväntat (${code ?? signal}).`))
    })
  })
}

// ── Probe ────────────────────────────────────────────────────────────────────

export interface ProbeResult {
  /** Seconds; the video stream's length when known, else the container's. */
  duration: number
  /** Display size, i.e. swapped for rotated (portrait phone) videos. */
  width: number
  height: number
  /** Frames per second; 24 when the file doesn't say. */
  fps: number
  hasAudio: boolean
}

interface FfprobeStream {
  codec_type?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  duration?: string
  disposition?: { attached_pic?: number }
  tags?: { rotate?: string }
  side_data_list?: { rotation?: number }[]
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { duration?: string }
}

function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined
  const [num, den = '1'] = rate.split('/')
  const value = Number(num) / Number(den)
  // r_frame_rate can be a timebase-like 90000/1 for variable frame rate files.
  return Number.isFinite(value) && value > 0 && value <= 240 ? value : undefined
}

function positive(value: string | undefined): number | undefined {
  const n = Number(value)
  return value !== undefined && Number.isFinite(n) && n > 0 ? n : undefined
}

export async function probe(path: string): Promise<ProbeResult> {
  const { ffprobe } = await binaries()
  let stdout: string
  try {
    ;({ stdout } = await run(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', resolve(path)],
      { timeoutMs: PROBE_TIMEOUT_MS }
    ))
  } catch (err) {
    throw new Error(`Kunde inte läsa videofilen: ${errorMessage(err)}`)
  }

  let info: FfprobeOutput
  try {
    info = JSON.parse(stdout) as FfprobeOutput
  } catch {
    throw new Error('Kunde inte läsa videofilen: oväntat svar från ffprobe.')
  }
  const streams = info.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  if (!video || !video.width || !video.height) throw new Error('Filen innehåller inget videospår.')

  const duration = positive(video.duration) ?? positive(info.format?.duration)
  if (duration === undefined) throw new Error('Kunde inte avgöra videons längd.')

  const rotation =
    video.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? Number(video.tags?.rotate ?? 0)
  const sideways = Math.abs(Math.round(rotation / 90)) % 2 === 1
  return {
    duration,
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    fps: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate) ?? 24,
    hasAudio: streams.some((s) => s.codec_type === 'audio')
  }
}

// ── Still images ─────────────────────────────────────────────────────────────

/** ffmpeg takes seconds with a dot regardless of locale; fixed precision avoids exponent notation. */
function secs(value: number): string {
  return Math.max(0, value).toFixed(6)
}

/** A unique sibling with the same extension, so ffmpeg still infers the format and readers never see half a file. */
function tempSibling(outPath: string): string {
  const ext = extname(outPath)
  return join(dirname(outPath), `.${basename(outPath, ext)}.${randomUUID().slice(0, 8)}.part${ext}`)
}

async function nonEmpty(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

/**
 * Writes one image from the first video stream. Resolves false when ffmpeg exited cleanly but produced
 * nothing (e.g. a seek past the last frame); rejects when ffmpeg failed.
 */
async function writeImage(videoPath: string, outPath: string, input: string[], output: string[]): Promise<boolean> {
  const { ffmpeg } = await binaries()
  // Only the image's own folder: its parents are the library's (created when outPath was decided), and if
  // the library has moved away since, recreating them would bring back an empty base folder at the old path.
  await mkdir(dirname(outPath)).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  })
  const tmp = tempSibling(outPath)
  partialFiles.add(tmp)
  try {
    await run(
      ffmpeg,
      [
        '-nostdin', '-hide_banner', '-v', 'error',
        ...input,
        '-i', resolve(videoPath),
        '-map', '0:V:0', '-an', '-sn',
        ...output,
        '-f', 'image2', '-y', tmp
      ],
      { timeoutMs: IMAGE_TIMEOUT_MS }
    )
    if (!(await nonEmpty(tmp))) return false
    await rename(tmp, outPath)
    return true
  } finally {
    await rm(tmp, { force: true })
    partialFiles.delete(tmp)
  }
}

/** Frame at atSeconds as PNG; when atSeconds is undefined, the very last decodable frame. Returns outPath. */
export async function extractFrame(videoPath: string, outPath: string, atSeconds?: number): Promise<string> {
  // -update 1 overwrites the image with every decoded frame, so the file ends up holding the last one.
  const lastFrame = (): Promise<boolean> =>
    writeImage(videoPath, outPath, ['-sseof', '-3'], ['-update', '1', '-q:v', '1'])

  let ok: boolean
  if (atSeconds === undefined || !Number.isFinite(atSeconds)) {
    ok = await lastFrame()
  } else if (atSeconds <= 0) {
    ok = await writeImage(videoPath, outPath, [], ['-frames:v', '1', '-q:v', '1'])
  } else {
    // Decode from up to 3 s before atSeconds and keep the last frame that `trim=end=atSeconds` lets through:
    // the frame concatClips ends a clip trimmed there on, since it uses the same filter on the same
    // timestamps (-copyts -start_at_zero undo the seek's shift, and the export doesn't seek). An output `-t`
    // instead cuts after rounding to the frame grid and could land one frame early or late.
    const from = Math.max(0, atSeconds - 3)
    ok = await writeImage(
      videoPath,
      outPath,
      ['-ss', secs(from), '-copyts', '-start_at_zero'],
      ['-vf', `trim=end=${secs(atSeconds)}`, '-update', '1', '-q:v', '1']
    ).catch(() => false)
    // Past the end of the video: the last frame there is.
    if (!ok) ok = await lastFrame()
  }
  if (!ok) throw new Error('Kunde inte ta ut en bildruta ur videon.')
  return outPath
}

/** JPEG poster ~480px wide, taken ~0.5 s in (or the middle for very short clips). Returns outPath. */
export async function extractThumbnail(videoPath: string, outPath: string): Promise<string> {
  const duration = await probe(videoPath).then(
    (p) => p.duration,
    () => undefined
  )
  const at = duration !== undefined && duration < 1 ? duration / 2 : 0.5
  // Quoted so the comma inside min() isn't read as a filter separator.
  const output = ['-frames:v', '1', '-vf', "scale='min(480,iw)':-2", '-q:v', '3']
  let ok = await writeImage(videoPath, outPath, ['-ss', secs(at)], output).catch(() => false)
  // Seeking can miss on odd files; the first frame beats no poster.
  if (!ok) ok = await writeImage(videoPath, outPath, [], output)
  if (!ok) throw new Error('Kunde inte skapa en miniatyrbild.')
  return outPath
}

// ── Concatenation ────────────────────────────────────────────────────────────

/** Seconds within the source. */
export interface ConcatClip {
  path: string
  start: number
  end: number
}

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

/**
 * Renders the clips back to back into one H.264/AAC mp4, normalised to the first clip's size and frame
 * rate. Clips without audio get silence so every cut has a soundtrack.
 */
export async function concatClips(
  clips: ConcatClip[],
  outPath: string,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
): Promise<void> {
  if (!clips.length) throw new Error('Det finns inga klipp att exportera.')
  const { ffmpeg } = await binaries()
  const probes = await Promise.all(
    clips.map((clip, i) =>
      probe(clip.path).catch((err: unknown) => {
        throw new Error(`Klipp ${i + 1}: ${errorMessage(err)}`)
      })
    )
  )
  if (opts.signal?.aborted) throw abortedExport()

  const first = probes[0]
  const w = even(first.width)
  const h = even(first.height)
  const fps = Math.round(first.fps) || 24

  const graph: string[] = []
  const pairs: string[] = []
  let total = 0
  clips.forEach((clip, i) => {
    const p = probes[i]
    const start = clamp(clip.start, 0, p.duration)
    const end = clamp(clip.end, start, p.duration)
    const length = end - start
    if (length < MIN_CLIP_SECONDS) throw new Error(`Klipp ${i + 1} blir för kort efter trimningen.`)
    total += length

    // fps must come before scale: after scale (ffmpeg 7.1) it can't tell how long the last frame lasts
    // and drops it, which showed up as a missing frame at every cut.
    graph.push(
      `[${i}:V:0]trim=start=${secs(start)}:end=${secs(end)},setpts=PTS-STARTPTS,fps=${fps},` +
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`
    )
    // Audio is padded to exactly the clip's length so sound stays in sync across cuts.
    graph.push(
      p.hasAudio
        ? `[${i}:a:0]atrim=start=${secs(start)}:end=${secs(end)},asetpts=PTS-STARTPTS,aresample=48000,` +
            `aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${secs(length)}[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${secs(length)},` +
            `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`
    )
    pairs.push(`[v${i}][a${i}]`)
  })
  graph.push(`${pairs.join('')}concat=n=${clips.length}:v=1:a=1[v][a]`)

  const args = ['-nostdin', '-hide_banner', '-v', 'error']
  for (const clip of clips) args.push('-i', resolve(clip.path))
  const out = resolve(outPath)
  const tmp = `${out.replace(/\.mp4$/i, '')}.part.mp4`
  args.push(
    '-filter_complex', graph.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    '-f', 'mp4', '-y', tmp
  )

  let reported = 0
  const report = (fraction: number): void => {
    const f = Math.min(1, Math.max(0, fraction))
    if (f <= reported || !opts.onProgress) return
    reported = f
    try {
      opts.onProgress(f)
    } catch (err) {
      console.warn('Export progress callback failed:', err)
    }
  }
  let pending = ''
  const onStdout = (chunk: string): void => {
    pending += chunk
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim()
      pending = pending.slice(nl + 1)
      // out_time_ms is (despite its name) also microseconds; either may be "N/A" before the first frame.
      const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line)
      if (m) report(Number(m[1]) / 1e6 / total)
      else if (line === 'progress=end') report(1)
    }
  }

  await mkdir(dirname(out), { recursive: true })
  partialFiles.add(tmp)
  try {
    await run(ffmpeg, args, { signal: opts.signal, onStdout })
    if (!(await nonEmpty(tmp))) throw new Error('ffmpeg skrev ingen fil.')
    await rename(tmp, out)
  } catch (err) {
    await rm(tmp, { force: true })
    if (isAbortError(err)) throw abortedExport()
    throw new Error(`Exporten misslyckades: ${errorMessage(err)}`)
  } finally {
    partialFiles.delete(tmp)
  }
}

function abortedExport(): Error {
  const err = new Error('Exporten avbröts.')
  err.name = 'AbortError'
  return err
}
