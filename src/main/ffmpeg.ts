import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, rmSync } from 'node:fs'
import { access, constants, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path'
import type { AudioLayer, EditRange, FfmpegStatus, GainSpan } from '@shared/types'

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
  /**
   * Collects stdout as raw bytes (RunResult.bytes) instead of text, for output piped to `pipe:1` (MP3, JPEG).
   * More than maxBytes kills the process and fails the run, so a runaway command can't fill memory.
   */
  binaryStdout?: { maxBytes: number }
  /** Receives stdout as raw bytes as they arrive (decoded samples of a long film); nothing is collected. */
  onStdoutData?: (chunk: Buffer) => void
  /**
   * Receives stderr as it arrives, for what ffmpeg reports there (silencedetect, scdet) over a whole film; only the
   * last few KB are kept for the error message.
   */
  onStderr?: (text: string) => void
}

interface RunResult {
  stdout: string
  stderr: string
  /** Set when binaryStdout was asked for. */
  bytes?: Buffer
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

/**
 * Temp outputs: `<name>.part.mp4` from concatClips, `.<name>.<8 hex>.part.<ext>` from tempSibling (stills, posters,
 * working copies, renders, mixes and audio cut for Venice).
 */
const PARTIAL_FILE =
  /(\.part\.(mp4|wav|flac|m4a|mp3)|^\..+\.[0-9a-f]{8}\.part\.(png|jpe?g|mp4|wav|flac|m4a|mp3|aac))$/i

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
    const chunks: Buffer[] = []
    let byteCount = 0
    let aborted = false
    let timedOut = false
    let tooMuchOutput = false
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
      else if (opts.binaryStdout) resolvePromise({ stdout, stderr, bytes: Buffer.concat(chunks, byteCount) })
      else resolvePromise({ stdout, stderr })
    }

    const binary = opts.binaryStdout
    const onData = opts.onStdoutData
    if (onData) {
      child.stdout!.on('data', (chunk: Buffer) => {
        if (done) return
        try {
          onData(chunk)
        } catch (err) {
          // A consumer that can't take the data ends the run with its error.
          child.kill('SIGKILL')
          finish(err instanceof Error ? err : new Error(String(err)))
        }
      })
    } else if (binary) {
      child.stdout!.on('data', (chunk: Buffer) => {
        if (tooMuchOutput) return
        byteCount += chunk.length
        if (byteCount > binary.maxBytes) {
          tooMuchOutput = true
          chunks.length = 0
          child.kill('SIGKILL')
          return
        }
        chunks.push(chunk)
      })
    } else {
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
        if (opts.onStdout) opts.onStdout(chunk)
        else stdout += chunk
      })
    }
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR)
      opts.onStderr?.(chunk)
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
      if (tooMuchOutput) return finish(new Error(`${name} gav mer data än väntat.`))
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
  /** Channels of the first audio stream (the one a:0 picks), when the file says. */
  audioChannels?: number
}

interface FfprobeStream {
  index?: number
  /** Seconds from the file's start where the stream's first frame or sample is (a recorder's late sound, say). */
  start_time?: string
  codec_type?: string
  codec_name?: string
  codec_tag_string?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  duration?: string
  pix_fmt?: string
  bits_per_raw_sample?: string
  color_transfer?: string
  color_space?: string
  sample_aspect_ratio?: string
  channels?: number
  sample_rate?: string
  disposition?: { attached_pic?: number }
  tags?: { rotate?: string }
  side_data_list?: { rotation?: number }[]
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { duration?: string; format_name?: string; size?: string; bit_rate?: string; tags?: { major_brand?: string } }
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

/**
 * ffprobe's streams and format, plus what it logged at `loglevel`; failures become "<failure>: <why>" (e.g.
 * "Kunde inte läsa videofilen: …").
 */
async function ffprobeJson(
  path: string,
  failure: string,
  loglevel: 'error' | 'warning' = 'error'
): Promise<{ info: FfprobeOutput; log: string }> {
  const { ffprobe } = await binaries()
  let result: RunResult
  try {
    result = await run(
      ffprobe,
      ['-v', loglevel, '-print_format', 'json', '-show_format', '-show_streams', resolve(path)],
      { timeoutMs: PROBE_TIMEOUT_MS }
    )
  } catch (err) {
    throw new Error(`${failure}: ${errorMessage(err)}`)
  }
  try {
    return { info: JSON.parse(result.stdout) as FfprobeOutput, log: result.stderr }
  } catch {
    throw new Error(`${failure}: oväntat svar från ffprobe.`)
  }
}

/** The display rotation of a video stream in degrees, as the file states it (a portrait phone clip: -90). */
function rotationOf(video: FfprobeStream): number {
  const r = video.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? Number(video.tags?.rotate ?? 0)
  return Number.isFinite(r) ? r : 0
}

function probeResultOf(info: FfprobeOutput): ProbeResult & { video: FfprobeStream } {
  const streams = info.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  if (!video || !video.width || !video.height) throw new Error('Filen innehåller inget videospår.')

  const duration = positive(video.duration) ?? positive(info.format?.duration)
  if (duration === undefined) throw new Error('Kunde inte avgöra videons längd.')

  const sideways = Math.abs(Math.round(rotationOf(video) / 90)) % 2 === 1
  const audio = streams.find((s) => s.codec_type === 'audio')
  return {
    video,
    duration,
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    fps: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate) ?? 24,
    hasAudio: !!audio,
    ...(audio?.channels ? { audioChannels: audio.channels } : {})
  }
}

export async function probe(path: string): Promise<ProbeResult> {
  const { info } = await ffprobeJson(path, 'Kunde inte läsa videofilen')
  const { video: _video, ...result } = probeResultOf(info)
  return result
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

/**
 * When the first frame that starts at or after `time` starts, in seconds: the frame an export trimmed at `time`
 * starts on (extractFrameAtOrAfter), and the one input seeking gives (extractFrames, the frames agents look at).
 * Asking stills' saveFrame (the frame a paused player shows) for this moment saves that very frame. 0 stays 0;
 * without a frame rate (the file can't be probed), `time` itself.
 */
export async function frameStartAtOrAfter(videoPath: string, time: number): Promise<number> {
  if (!(time > 0)) return 0
  const fps = await probe(videoPath).then(
    (p) => p.fps,
    () => undefined
  )
  if (!fps) return time
  // The small margin keeps a time that sits exactly on a frame (to rounding) on that frame.
  return Math.ceil(time * fps - 1e-6) / fps
}

/** Longest side of a picture decoded with stillToPng: more than any input Venice gets (they are scaled to 2048). */
const STILL_DECODE_MAX_SIDE = 4096
const MAX_STILL_PNG_BYTES = 96 * 1024 * 1024

/**
 * A still picture (WebP, which Electron's nativeImage can't decode, say) decoded by ffmpeg and returned as PNG
 * bytes, at most STILL_DECODE_MAX_SIDE on its long side (never upscaled); the first frame of an animated one.
 * Rejects when ffmpeg is missing or can't read it.
 */
export async function stillToPng(path: string): Promise<Buffer> {
  const { ffmpeg } = await binaries()
  const max = STILL_DECODE_MAX_SIDE
  const { bytes } = await run(
    ffmpeg,
    [
      '-nostdin', '-hide_banner', '-v', 'error',
      '-i', resolve(path),
      '-map', '0:v:0', '-frames:v', '1',
      // Quoted so the commas inside min() aren't read as filter separators.
      '-vf', `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`,
      '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'
    ],
    { timeoutMs: IMAGE_TIMEOUT_MS, binaryStdout: { maxBytes: MAX_STILL_PNG_BYTES } }
  )
  if (!bytes?.length) throw new Error('Kunde inte läsa bilden.')
  return bytes
}

/**
 * The first frame shown from atSeconds on, as PNG: the first frame whose timestamp is at or after atSeconds.
 * That is the frame concatClips starts a clip trimmed at atSeconds on (the same `trim` filter on the same
 * timestamps; -copyts -start_at_zero undo the seek's shift), so a clip generated to end on it meets the next
 * clip exactly where the cut does. At or before 0 the very first frame; past the end the last one. Returns
 * outPath.
 */
export async function extractFrameAtOrAfter(videoPath: string, outPath: string, atSeconds: number): Promise<string> {
  const firstFrame = (): Promise<boolean> => writeImage(videoPath, outPath, [], ['-frames:v', '1', '-q:v', '1'])
  let ok: boolean
  if (!Number.isFinite(atSeconds) || atSeconds <= 0) {
    ok = await firstFrame()
  } else {
    // Decoding from up to 3 s before keeps the seek fast without depending on where the keyframes are.
    const from = Math.max(0, atSeconds - 3)
    ok = await writeImage(
      videoPath,
      outPath,
      ['-ss', secs(from), '-copyts', '-start_at_zero'],
      ['-vf', `trim=start=${secs(atSeconds)}`, '-frames:v', '1', '-q:v', '1']
    ).catch(() => false)
    // Nothing from there on (past the last frame): the last frame is the one showing then.
    if (!ok) ok = await writeImage(videoPath, outPath, ['-sseof', '-3'], ['-update', '1', '-q:v', '1'])
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
 * The time covered by the frames that `trim=start:end` keeps: from the first frame that starts at or after
 * `start` to the end of the last one that starts before `end`, on the clip's own frame grid. A clip's sound is
 * cut to exactly this rather than to start–end. Trims come in 0.1 s steps and a frame lasts 1/24 s, so a cut
 * usually falls between two frames; cut there, the sound would run up to a frame longer than the picture,
 * concat starts the next clip after the longer of the two, and over a few cuts the gaps add up until a picture
 * is shown twice (a stutter right where a clip was made to fit seamlessly). Frame starts are compared with a
 * thousandth of a frame to spare, since ffmpeg rounds the cut to the stream's time base.
 */
export function frameSpan(
  start: number,
  end: number,
  fps: number,
  duration: number
): { start: number; end: number; length: number } {
  const frames = Math.max(1, Math.ceil(duration * fps - 1e-3))
  const first = Math.min(frames - 1, Math.max(0, Math.ceil(start * fps - 1e-3)))
  const stop = Math.min(frames, Math.max(first + 1, Math.ceil(end * fps - 1e-3)))
  return { start: first / fps, end: stop / fps, length: (stop - first) / fps }
}

/**
 * Turns ffmpeg's `-progress pipe:1` lines into fractions of `totalSeconds` (mapped through `scale`, so one stage
 * of a longer task can report its share), never going backwards. A failing callback is logged, not thrown.
 */
function progressReader(
  totalSeconds: number,
  onProgress: ((fraction: number) => void) | undefined,
  scale: (fraction: number) => number = (f) => f
): (chunk: string) => void {
  let reported = 0
  let pending = ''
  const report = (fraction: number): void => {
    const f = Math.min(1, Math.max(0, scale(Math.min(1, Math.max(0, fraction)))))
    if (f <= reported || !onProgress) return
    reported = f
    try {
      onProgress(f)
    } catch (err) {
      console.warn('Progress callback failed:', err)
    }
  }
  return (chunk: string): void => {
    pending += chunk
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim()
      pending = pending.slice(nl + 1)
      // out_time_ms is (despite its name) also microseconds; either may be "N/A" before the first frame.
      const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line)
      if (m && totalSeconds > 0) report(Number(m[1]) / 1e6 / totalSeconds)
      else if (line === 'progress=end') report(1)
    }
  }
}

/**
 * Renders the clips back to back into one H.264/AAC mp4, normalised to the first clip's size and frame
 * rate. Clips without audio get silence so every cut has a soundtrack. `height` (the sequence's Exportformat)
 * makes the film that tall instead, in the first clip's shape (even pixels).
 */
export async function concatClips(
  clips: ConcatClip[],
  outPath: string,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal; height?: number } = {}
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
  const height = opts.height && Number.isFinite(opts.height) && opts.height >= 2 ? opts.height : undefined
  const h = even(height ?? first.height)
  const w = height ? even(Math.round((h * first.width) / first.height)) : even(first.width)
  const fps = Math.round(first.fps) || 24

  const graph: string[] = []
  const pairs: string[] = []
  let total = 0
  clips.forEach((clip, i) => {
    const p = probes[i]
    const start = clamp(clip.start, 0, p.duration)
    const end = clamp(clip.end, start, p.duration)
    if (end - start < MIN_CLIP_SECONDS) throw new Error(`Klipp ${i + 1} blir för kort efter trimningen.`)
    // The sound covers exactly the frames the picture keeps (see frameSpan).
    const span = frameSpan(start, end, p.fps > 0 ? p.fps : fps, p.duration)
    total += span.length

    // fps must come before scale: after scale (ffmpeg 7.1) it can't tell how long the last frame lasts
    // and drops it, which showed up as a missing frame at every cut.
    graph.push(
      `[${i}:V:0]trim=start=${secs(start)}:end=${secs(end)},setpts=PTS-STARTPTS,fps=${fps},` +
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`
    )
    // Audio is padded to exactly the clip's picture so sound stays in sync across cuts.
    graph.push(
      p.hasAudio
        ? `[${i}:a:0]atrim=start=${secs(span.start)}:end=${secs(span.end)},asetpts=PTS-STARTPTS,aresample=48000,` +
            // Mono at full level on both sides (ffmpeg's own upmix lowers it 3 dB), as Redigera plays it.
            `${p.audioChannels === 1 ? 'pan=stereo|c0=c0|c1=c0,' : ''}` +
            `aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${secs(span.length)}[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${secs(span.length)},` +
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

  const onStdout = progressReader(total, opts.onProgress)

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

// ── Audio ────────────────────────────────────────────────────────────────────

const AUDIO_TIMEOUT_MS = 60_000
/** Far above anything these helpers make (300 s at 128 kb/s is under 5 MB); a guard, not a format limit. */
const MAX_AUDIO_BYTES = 16 * 1024 * 1024
/** Less than this may not hold a single MP3 frame. */
const MIN_AUDIO_SECONDS = 0.05
/** The longest stretch of a video's sound extractAudioPreview returns (base64 in an MCP reply grows fast). */
export const MAX_AUDIO_PREVIEW_SECONDS = 300

const NO_AUDIO = 'Filen innehåller inget ljud.'

/** A failure as the user should read it: "no audio" and "ffmpeg is missing" as they are, the rest prefixed. */
function audioFailure(err: unknown, prefix: string): Error {
  const message = errorMessage(err)
  // "Stream map '' matches no streams" may fall outside the stderr tail; the line after it names the map.
  if (/matches no streams|value '0:a:0' for option 'map'/i.test(message)) return new Error(NO_AUDIO)
  if (message === NOT_FOUND || message.startsWith('ffprobe hittades inte')) return new Error(message)
  return new Error(`${prefix}: ${message}`)
}

/**
 * `length` seconds of the file's first audio stream from `start`, as mono 44.1 kHz MP3 bytes. Rejects (from ffmpeg)
 * when there is no audio stream; resolves with an empty buffer when the stretch lies past the end.
 */
async function encodeMp3(path: string, start: number, length: number, bitrate: string): Promise<Buffer> {
  const { ffmpeg } = await binaries()
  const { bytes } = await run(
    ffmpeg,
    [
      '-nostdin', '-hide_banner', '-v', 'error',
      '-ss', secs(start),
      '-i', resolve(path),
      '-t', secs(length),
      '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-ac', '1', '-ar', '44100',
      '-c:a', 'libmp3lame', '-b:a', bitrate,
      // A bare MP3 stream: the file's own tags (title, artist, cover art…) are nobody's business at Venice or an
      // agent, and leading MPEG frames are what every audio sniffer recognizes.
      '-map_metadata', '-1', '-map_chapters', '-1', '-id3v2_version', '0', '-write_xing', '0',
      '-f', 'mp3', 'pipe:1'
    ],
    { timeoutMs: AUDIO_TIMEOUT_MS, binaryStdout: { maxBytes: MAX_AUDIO_BYTES } }
  )
  return bytes ?? Buffer.alloc(0)
}

/**
 * The reference window of an audio clip as Venice gets it: `length` seconds from `start`, mono 44.1 kHz MP3 at
 * 128 kb/s, without the file's tags. The caller keeps the window inside the file (and within Venice's 2–15 s);
 * a window past the end of the file rejects rather than sending silence.
 */
export async function encodeAudioClip(path: string, start: number, length: number): Promise<Buffer> {
  if (!Number.isFinite(start) || !Number.isFinite(length) || length < MIN_AUDIO_SECONDS) {
    throw new Error('Ogiltigt ljudutdrag: start och längd måste vara sekunder.')
  }
  let mp3: Buffer
  try {
    mp3 = await encodeMp3(path, Math.max(0, start), length, '128k')
  } catch (err) {
    throw audioFailure(err, 'Kunde inte förbereda ljudklippet')
  }
  if (!mp3.length) throw new Error('Ljudutdraget är tomt: det börjar efter ljudfilens slut.')
  return mp3
}

/** Decodes the whole audio stream to find its length, for files whose headers don't say (some OGG and AAC). */
async function decodedAudioDuration(path: string): Promise<number | undefined> {
  const { ffmpeg } = await binaries()
  let seconds: number | undefined
  let pending = ''
  const onStdout = (chunk: string): void => {
    pending += chunk
    let nl: number
    // Whole lines only: a chunk may end in the middle of "out_time_us=12000000".
    while ((nl = pending.indexOf('\n')) >= 0) {
      const m = /^out_time_(?:us|ms)=(\d+)$/.exec(pending.slice(0, nl).trim())
      pending = pending.slice(nl + 1)
      if (m) seconds = Number(m[1]) / 1e6
    }
  }
  try {
    await run(
      ffmpeg,
      ['-nostdin', '-hide_banner', '-v', 'error', '-i', resolve(path), '-map', '0:a:0', '-progress', 'pipe:1',
        '-nostats', '-f', 'null', '-'],
      { timeoutMs: AUDIO_TIMEOUT_MS, onStdout }
    )
  } catch {
    return undefined
  }
  return seconds !== undefined && seconds > 0 ? seconds : undefined
}

/**
 * The length of an audio file (or of a video's sound) in seconds. Rejects when the file has no audio stream.
 * Where the headers don't tell (a streamed Matroska file) or ffprobe only guesses from the bitrate (raw AAC,
 * VBR MP3 without a Xing header: off by a factor of two or ten), the audio is decoded to measure it.
 */
export async function probeAudio(path: string): Promise<{ duration: number }> {
  const { info, log } = await ffprobeJson(path, 'Kunde inte läsa ljudfilen', 'warning')
  const audio = info.streams?.find((s) => s.codec_type === 'audio')
  if (!audio) throw new Error(NO_AUDIO)
  const guessed = /Estimating duration from bitrate/i.test(log)
  const stated = guessed ? undefined : (positive(audio.duration) ?? positive(info.format?.duration))
  const duration = stated ?? (await decodedAudioDuration(path)) ?? positive(info.format?.duration)
  if (duration === undefined) throw new Error('Kunde inte avgöra hur långt ljudet är.')
  return { duration }
}

/**
 * Up to `length` seconds of a video's sound from `start` (kept inside the video, at most
 * MAX_AUDIO_PREVIEW_SECONDS), as mono MP3 at 96 kb/s: enough to judge a voice, music or effects, small enough to
 * hand an agent. Null when the video has no sound (or none in that stretch).
 */
export async function extractAudioPreview(videoPath: string, start: number, length: number): Promise<Buffer | null> {
  if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) {
    throw new Error('Ogiltigt ljudutdrag: start och längd måste vara sekunder.')
  }
  const info = await probe(videoPath)
  if (!info.hasAudio) return null
  const from = clamp(start, 0, Math.max(0, info.duration - MIN_AUDIO_SECONDS))
  const span = Math.min(length, info.duration - from, MAX_AUDIO_PREVIEW_SECONDS)
  if (span < MIN_AUDIO_SECONDS) return null
  let mp3: Buffer
  try {
    mp3 = await encodeMp3(videoPath, from, span, '96k')
  } catch (err) {
    const failure = audioFailure(err, 'Kunde inte ta ut ljudet ur videon')
    if (failure.message === NO_AUDIO) return null
    throw failure
  }
  return mp3.length ? mp3 : null
}

// ── Frames for reviews ───────────────────────────────────────────────────────

/** One still of a video: `time` is the moment it shows (the asked-for time, kept inside the video). */
export interface VideoFrame {
  time: number
  jpeg: Buffer
}

/** Per call; a review of a long film asks for a few per clip, never hundreds. */
const MAX_FRAMES_PER_CALL = 200
/** Small JPEGs; the guard only stops a runaway process. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024
/** Frames are grabbed a few at a time: each is its own short ffmpeg run. */
const FRAME_CONCURRENCY = 3

/** Runs fn over items with at most `limit` running at once. */
async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** One JPEG from the first video stream (input/output options around `-i`); undefined when ffmpeg wrote none. */
async function grabJpeg(
  videoPath: string,
  input: string[],
  filters: string,
  output: string[] = []
): Promise<Buffer | undefined> {
  const { ffmpeg } = await binaries()
  const { bytes } = await run(
    ffmpeg,
    [
      '-nostdin', '-hide_banner', '-v', 'error',
      ...input,
      '-i', resolve(videoPath),
      ...output,
      '-map', '0:V:0', '-an', '-sn', '-dn',
      '-vf', filters,
      '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '3',
      '-f', 'image2pipe', 'pipe:1'
    ],
    { timeoutMs: IMAGE_TIMEOUT_MS, binaryStdout: { maxBytes: MAX_FRAME_BYTES } }
  )
  return bytes?.length ? bytes : undefined
}

/**
 * The very last frame: the last two seconds are decoded and played backwards, so the first frame out is the
 * last one in (scaled first, so only small frames are buffered). From the end of the container as a fallback,
 * for files whose video stream doesn't say how long it is.
 */
async function lastFrameJpeg(videoPath: string, duration: number, scale: string): Promise<Buffer | undefined> {
  const reversed = `${scale},reverse`
  const fromStart = await grabJpeg(videoPath, ['-ss', secs(Math.max(0, duration - 2))], reversed).catch(() => undefined)
  return fromStart ?? (await grabJpeg(videoPath, ['-sseof', '-3'], reversed).catch(() => undefined))
}

/** The first frame at or after `time` (seconds, already inside the video); at the very end, the last frame. */
async function frameJpeg(
  videoPath: string,
  time: number,
  info: ProbeResult,
  scale: string
): Promise<Buffer | undefined> {
  // The last frame starts one frame before the end; from there on a seek finds no frame to show.
  const frame = 1 / (info.fps || 24)
  if (time >= info.duration - frame / 2) return lastFrameJpeg(videoPath, info.duration, scale)
  // Input seeking is fast and, since ffmpeg decodes from the keyframe before it, frame accurate.
  let jpeg = await grabJpeg(videoPath, ['-ss', secs(time)], scale).catch(() => undefined)
  // A timestamp inside the last frame (a variable frame rate fooling the check above) finds nothing: that
  // frame is the one showing then.
  if (!jpeg && time > info.duration - 1) jpeg = await lastFrameJpeg(videoPath, info.duration, scale)
  // Odd files can make input seeking miss; decoding from the start is slow but finds it.
  if (!jpeg) jpeg = await grabJpeg(videoPath, [], scale, ['-ss', secs(time)]).catch(() => undefined)
  return jpeg
}

/**
 * Stills of a video as JPEG (at most `width` px wide, never upscaled, rotation applied) at the given times in
 * seconds, in the order asked for. Times are kept inside the video: anything at or past the end gives the very
 * last frame, which is what a continuation clip starts from. A frame that can't be extracted is left out (and
 * logged); rejects when the video can't be read or not a single frame could be extracted.
 */
export async function extractFrames(videoPath: string, times: number[], width = 512): Promise<VideoFrame[]> {
  if (!Array.isArray(times) || !times.length) return []
  if (times.length > MAX_FRAMES_PER_CALL) throw new Error(`Högst ${MAX_FRAMES_PER_CALL} bildrutor åt gången.`)
  if (times.some((t) => typeof t !== 'number' || !Number.isFinite(t))) {
    throw new Error('Ogiltig tidpunkt för en bildruta: ange sekunder.')
  }
  const w = typeof width === 'number' && Number.isFinite(width) ? Math.round(clamp(width, 16, 4096)) : 512
  // Quoted so the comma inside min() isn't read as a filter separator.
  const scale = `scale='min(${w},iw)':-2`
  const info = await probe(videoPath)
  // Millisecond precision: finer than any frame, and the same request twice shares one grab.
  const at = (t: number): number => Math.round(clamp(t, 0, info.duration) * 1000) / 1000
  const grabbed = new Map<number, Buffer>()
  await forEachLimited([...new Set(times.map(at))], FRAME_CONCURRENCY, async (time) => {
    try {
      const jpeg = await frameJpeg(videoPath, time, info, scale)
      if (jpeg) grabbed.set(time, jpeg)
      else console.warn(`No frame at ${time} s in ${videoPath}`)
    } catch (err) {
      console.warn(`Extracting the frame at ${time} s from ${videoPath} failed: ${errorMessage(err)}`)
    }
  })
  const frames = times.map(at).flatMap((time) => {
    const jpeg = grabbed.get(time)
    return jpeg ? [{ time, jpeg }] : []
  })
  if (!frames.length) throw new Error('Kunde inte ta ut några bildrutor ur videon.')
  return frames
}

// ── Media for own clips and Redigera ─────────────────────────────────────────
// Everything below writes files rather than returning Buffers (a film's sound can be an hour long), takes an
// AbortSignal, reports progress from `-progress` where the work is long, and has no fixed timeout: a long film just
// takes longer. Outputs are written to a temp sibling and renamed into place, so nobody ever sees half a file.

/** Every sound Redigera renders is 48 kHz: sample positions in mixes and chunk plans count at this rate. */
export const MIX_RATE = 48_000
/**
 * The largest upload Studio sends the voice changer in one request. Venice publishes no size limit (a 413 is free,
 * before any charge); 300 s of 16-bit mono WAV is 28.8 MB, so long chunks go as MP3 (encodeUpload).
 */
export const VOICE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024
/** Ramp of a gain change unless the span says otherwise, seconds. */
const DEFAULT_GAIN_FADE = 0.02
/** Height of the filmstrip pictures on the timeline. */
const FILMSTRIP_HEIGHT = 120
/** A proxy below this many bits per pixel and frame looks too broken to edit from; Studio refuses instead. */
const MIN_PROXY_BITS_PER_PIXEL = 0.05

const samplesAt = (seconds: number, rate = MIX_RATE): number => Math.max(0, Math.round(seconds * rate))

/** "22 MB", "300 kB": a size limit as the user reads it. */
const sizeSv = (bytes: number): string =>
  bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`

/** Marks frames as BT.709 limited range, so the encoder tags the stream so (it reads the frames' properties). */
const BT709_FRAMES = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv'

/** A frame rate as ffmpeg takes it: NTSC rates as exact fractions (29.97 → 30000/1001), so frames never drift. */
function rationalFps(fps: number): string {
  for (const base of [24, 30, 48, 60, 120]) {
    if (Math.abs(fps - (base * 1000) / 1001) < 0.005) return `${base * 1000}/1001`
  }
  if (Math.abs(fps - Math.round(fps)) < 0.001) return String(Math.round(fps))
  return `${Math.round(fps * 1000)}/1000`
}

function rationalValue(rate: string): number {
  const [num, den = '1'] = rate.split('/')
  return Number(num) / Number(den)
}

/**
 * Runs ffmpeg into `out` through a temp sibling: the folder is made (one level, like writeImage), the arguments
 * get the temp path, the result must be non-empty, and only then is it renamed into place. A failure says
 * `failure: <ffmpeg's reason>`; an abort is an AbortError ("Avbrutet.").
 */
async function ffmpegToFile(
  out: string,
  args: (tmp: string) => string[],
  o: { failure: string; signal?: AbortSignal; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void }
): Promise<void> {
  const { ffmpeg } = await binaries()
  const target = resolve(out)
  await mkdir(dirname(target)).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  })
  const tmp = tempSibling(target)
  partialFiles.add(tmp)
  try {
    await run(ffmpeg, args(tmp), { signal: o.signal, onStdout: o.onStdout, onStderr: o.onStderr })
    if (!(await nonEmpty(tmp))) throw new Error('ffmpeg skrev ingen fil.')
    await rename(tmp, target)
  } catch (err) {
    if (isAbortError(err)) throw abortError()
    const message = errorMessage(err)
    if (message === NOT_FOUND) throw err
    throw new Error(`${o.failure}: ${message}`, { cause: err })
  } finally {
    await rm(tmp, { force: true })
    partialFiles.delete(tmp)
  }
}

// ── Helpers next to ffmpeg (voice-separation.ts) ─────────────────────────────

/**
 * Runs another command-line tool the way ffmpeg is run: killed when Studio quits, aborted by the signal, stdout
 * streamed to `onStdout`, and a failure reported with the tail of what it wrote to stderr.
 */
export function runHelper(
  bin: string,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number; onStdout?: (text: string) => void } = {}
): Promise<{ stdout: string; stderr: string }> {
  return run(bin, args, opts)
}

/**
 * Writes `out` through a temp sibling that `write` fills (removed again when Studio quits mid-way, like ffmpeg's
 * own temp files), then renames it into place. The temp file has `out`'s extension.
 */
export async function writeThroughTemp(out: string, write: (tmp: string) => Promise<void>): Promise<void> {
  const target = resolve(out)
  const tmp = tempSibling(target)
  partialFiles.add(tmp)
  try {
    await write(tmp)
    if (!(await nonEmpty(tmp))) throw new Error('Ingen fil skrevs.')
    await rename(tmp, target)
  } finally {
    await rm(tmp, { force: true })
    partialFiles.delete(tmp)
  }
}

// ── What ffmpeg can do here ──────────────────────────────────────────────────

let decoderNames: Promise<Set<string>> | undefined
let filterNames: Promise<Set<string>> | undefined
let soxr: Promise<boolean> | undefined

/** Names listed by `ffmpeg -decoders` or `-filters` (first column after the flags). Only success is cached. */
function listed(kind: '-decoders' | '-filters', pattern: RegExp): Promise<Set<string>> {
  return (async () => {
    const { ffmpeg } = await binaries()
    const { stdout } = await run(ffmpeg, ['-hide_banner', kind], { timeoutMs: 15_000 })
    const names = new Set<string>()
    for (const line of stdout.split('\n')) {
      const m = pattern.exec(line)
      if (m) names.add(m[1])
    }
    return names
  })()
}

function audioDecoders(): Promise<Set<string>> {
  decoderNames ??= listed('-decoders', /^\s*A[A-Z.]{5}\s+(\S+)/).catch((err: unknown) => {
    decoderNames = undefined
    throw err
  })
  return decoderNames
}

function hasFilter(name: string): Promise<boolean> {
  filterNames ??= listed('-filters', /^\s*[T.][S.][C.]\s+(\S+)/).catch((err: unknown) => {
    filterNames = undefined
    throw err
  })
  return filterNames.then(
    (names) => names.has(name),
    () => false
  )
}

/** `:resampler=soxr` when this ffmpeg has libsoxr (Homebrew's does): cleaner resampling of 44.1 kHz sources. */
async function resamplerOption(): Promise<string> {
  soxr ??= (async () => {
    const { ffmpeg } = await binaries()
    const { stdout } = await run(ffmpeg, ['-hide_banner', '-buildconf'], { timeoutMs: 15_000 })
    return stdout.includes('--enable-libsoxr')
  })().catch(() => {
    soxr = undefined
    return false
  })
  return (await soxr) ? ':resampler=soxr' : ''
}

/** Codecs ffmpeg 7.1 decodes for sure, for when the decoder list can't be read. */
const KNOWN_AUDIO_DECODERS = /^(aac|alac|mp3|mp2|opus|vorbis|flac|ac3|eac3|pcm_\w+)$/

async function isDecodable(codec: string | undefined): Promise<boolean> {
  if (!codec || codec === 'none' || codec === 'unknown') return false
  try {
    const names = await audioDecoders()
    return names.has(codec) || (codec === 'mp3' && names.has('mp3float'))
  } catch {
    return KNOWN_AUDIO_DECODERS.test(codec)
  }
}

// ── Probing media for import and editing ─────────────────────────────────────

export interface MediaAudioStream {
  /** The stream's index in the file (ffmpeg's `-map 0:<index>`). */
  index: number
  codec: string
  channels: number
  rate: number
  /** This ffmpeg can decode it (a spatial-audio APAC track from a newer iPhone can't be). */
  decodable: boolean
}

export interface MediaInfo extends ProbeResult {
  /** The video codec ("h264", "hevc", "prores"…). */
  codec: string
  pixFmt?: string
  bitDepth: number
  hdr: false | 'hlg' | 'pq'
  /** Display rotation in degrees, 0, 90, 180 or 270 (a portrait phone clip stored sideways: 270). */
  rotation: number
  variableFrameRate: boolean
  /** "mp4", "mov", "webm", "matroska"… */
  container: string
  bytes: number
  /** Bits per second of the whole file. */
  bitrate?: number
  audioStreams: MediaAudioStream[]
  /** The pixel shape (sample aspect ratio, width/height of one pixel): 1 is square; 4:3 for an anamorphic HDV file. */
  sar?: number
  /**
   * Seconds the first decodable audio stream starts after the video (negative: before it), when the file says. Studio
   * cuts each stream from its own first frame or sample, so a file whose streams start apart gets a working copy.
   */
  audioOffset?: number
}

function bitDepthOf(video: FfprobeStream): number {
  const raw = Number(video.bits_per_raw_sample)
  if (Number.isInteger(raw) && raw >= 8 && raw <= 16) return raw
  const pf = video.pix_fmt ?? ''
  if (/p010|p210|p410|y210|x2rgb10|x2bgr10/.test(pf)) return 10
  if (/p012|p212|p412/.test(pf)) return 12
  if (/p016|p216|p416|rgb48|bgr48|rgba64|bgra64|gray16|ya16/.test(pf)) return 16
  const m = /(9|10|12|14|16)(le|be)$/.exec(pf)
  return m ? Number(m[1]) : 8
}

function containerOf(path: string, info: FfprobeOutput): string {
  const names = (info.format?.format_name ?? '').split(',').filter(Boolean)
  const ext = extname(path).toLowerCase()
  if (names.includes('mov') || names.includes('mp4')) {
    return /^qt/i.test(info.format?.tags?.major_brand?.trim() ?? '') || ext === '.mov' ? 'mov' : 'mp4'
  }
  if (names.includes('matroska') || names.includes('webm')) return ext === '.webm' ? 'webm' : 'matroska'
  return names[0] ?? (ext.slice(1) || 'okänd')
}

/** A frame rate as ffprobe states it, without probe()'s sanity cap (a VFR file can say 90000/1). */
function rawRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined
  const value = rationalValue(rate)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

async function mediaInfoOf(path: string, info: FfprobeOutput): Promise<MediaInfo & { sar: number; colorSpace?: string }> {
  const { video, ...base } = probeResultOf(info)
  const r = rawRate(video.r_frame_rate)
  const avg = rawRate(video.avg_frame_rate)
  // The nominal rate and the average disagree when frames come irregularly (a phone in low light).
  const variableFrameRate = (r !== undefined && r > 240) || (r !== undefined && avg !== undefined && Math.abs(r - avg) / r > 0.005)
  const transfer = video.color_transfer ?? ''
  const audioStreams: MediaAudioStream[] = []
  for (const s of info.streams ?? []) {
    if (s.codec_type !== 'audio') continue
    audioStreams.push({
      index: s.index ?? audioStreams.length,
      codec: s.codec_name ?? s.codec_tag_string ?? 'okänd',
      channels: s.channels ?? 0,
      rate: Number(s.sample_rate) || 0,
      decodable: await isDecodable(s.codec_name)
    })
  }
  const firstAudio = (info.streams ?? []).find(
    (s) => s.codec_type === 'audio' && audioStreams.some((a) => a.index === s.index && a.decodable)
  )
  const videoStart = Number(video.start_time)
  const audioStart = Number(firstAudio?.start_time)
  const audioOffset =
    firstAudio && Number.isFinite(videoStart) && Number.isFinite(audioStart) ? audioStart - videoStart : undefined
  const sarMatch = /^(\d+):(\d+)$/.exec(video.sample_aspect_ratio ?? '')
  const sar = sarMatch && Number(sarMatch[1]) > 0 && Number(sarMatch[2]) > 0 ? Number(sarMatch[1]) / Number(sarMatch[2]) : 1
  const size = Number(info.format?.size)
  const bitrate = Number(info.format?.bit_rate)
  return {
    ...base,
    codec: video.codec_name ?? 'okänd',
    pixFmt: video.pix_fmt,
    bitDepth: bitDepthOf(video),
    hdr: transfer === 'arib-std-b67' ? 'hlg' : transfer === 'smpte2084' ? 'pq' : false,
    rotation: ((Math.round(rotationOf(video)) % 360) + 360) % 360,
    variableFrameRate,
    container: containerOf(path, info),
    bytes: Number.isFinite(size) && size > 0 ? size : (await stat(path)).size,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : undefined,
    audioStreams,
    sar,
    ...(audioOffset !== undefined ? { audioOffset: Math.round(audioOffset * 1e6) / 1e6 } : {}),
    colorSpace: video.color_space
  }
}

/**
 * Everything import and the editor need to know about a video: probe()'s display size, length and frame rate, plus
 * codec, bit depth, HDR transfer, rotation, variable frame rate, container, size and the audio streams (with
 * whether this ffmpeg can decode each). Rejects in Swedish ("Filen innehåller inget videospår.").
 */
export async function probeMedia(path: string): Promise<MediaInfo> {
  const { info } = await ffprobeJson(path, 'Kunde inte läsa videofilen')
  const { colorSpace: _colorSpace, ...media } = await mediaInfoOf(path, info)
  return media
}

/** The first audio stream of a file (video or audio) ffmpeg can decode, with its length; undefined when none. */
async function audioInput(path: string): Promise<{ index: number; channels: number; duration?: number } | undefined> {
  const { info, log } = await ffprobeJson(path, 'Kunde inte läsa ljudfilen', 'warning')
  for (const s of info.streams ?? []) {
    if (s.codec_type !== 'audio' || !(await isDecodable(s.codec_name))) continue
    // An MP3 without a header (what a provider may send) only has a length guessed from its bitrate: decoded then.
    const guessed = /Estimating duration from bitrate/i.test(log)
    const stated = guessed ? undefined : (positive(s.duration) ?? positive(info.format?.duration))
    return {
      index: s.index ?? 0,
      channels: s.channels ?? 0,
      duration: stated ?? (await decodedAudioDuration(path)) ?? positive(info.format?.duration)
    }
  }
  return undefined
}

async function requireAudio(path: string): Promise<{ index: number; channels: number; duration?: number }> {
  const input = await audioInput(path)
  if (!input) throw new Error(NO_AUDIO)
  return input
}

/**
 * A filter turning `from` channels into `to`. Mono becomes stereo at full level on both sides (ffmpeg's own upmix
 * lowers it 3 dB, which would make a mono line quieter than the same line in stereo); stereo becomes mono as the
 * average of the two.
 */
function channelFilter(from: number, to: 1 | 2): string | undefined {
  if (from === to) return undefined
  if (to === 2 && from === 1) return 'pan=stereo|c0=c0|c1=c0'
  if (to === 1 && from === 2) return 'pan=mono|c0=0.5*c0+0.5*c1'
  return `aformat=channel_layouts=${to === 1 ? 'mono' : 'stereo'}`
}

// ── Working copies of imported films ─────────────────────────────────────────

export interface NormalizeOptions {
  hdr: MediaInfo['hdr']
  /** Longest side of the result; default 1920 (4K becomes 1080p). Never upscales. */
  maxLongSide?: number
  /** Highest frame rate; default 30 (60 becomes 30, 59.94 becomes 29.97). */
  maxFps?: number
  /** The audio stream to keep (MediaAudioStream.index); default the first one ffmpeg can decode. */
  audioStream?: number
  /** Crop (centred) to this width/height ratio, for "Fyll bilden" in a sequence of another shape. */
  crop?: { aspect: number }
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

/** The frame rate of a working copy: the source's (rounded when it varies), halved until it is within the cap. */
function workingFps(info: MediaInfo, maxFps: number): string {
  let fps = info.fps > 0 ? info.fps : 24
  if (info.variableFrameRate) fps = Math.max(1, Math.round(fps))
  while (fps > maxFps + 0.01 && fps / 2 >= 12) fps /= 2
  if (fps > maxFps + 0.01) fps = maxFps
  return rationalFps(fps)
}

/**
 * The working copy of an imported film: upright, at most `maxLongSide` and `maxFps`, constant frame rate, 8-bit
 * yuv420p BT.709 (HDR tone-mapped with mobius, which keeps midtones and grades highlights), H.264 + AAC 48 kHz, and
 * no metadata (GPS stays with the original). This makes a phone clip behave like a generated take: its last frame is
 * a normal 8-bit PNG with normal colours, and it exports and continues like any clip. VideoToolbox decodes (twice as
 * fast for 4K HEVC); a source it can't decode falls back to software.
 */
export async function normalizeVideo(input: string, out: string, o: NormalizeOptions): Promise<void> {
  const { info: raw } = await ffprobeJson(input, 'Kunde inte läsa videofilen')
  const info = await mediaInfoOf(input, raw)
  const maxLongSide = o.maxLongSide && o.maxLongSide >= 16 ? o.maxLongSide : 1920
  const fps = workingFps(info, o.maxFps && o.maxFps > 0 ? o.maxFps : 30)

  // From the file's time zero (start_time=0): a video stream that starts after the sound is padded with its first
  // frame, as the sound is padded with silence (first_pts=0), so both streams of the copy start together.
  const filters = [`fps=${fps}:start_time=0`]
  // Display size: rotation is applied by ffmpeg before the filters; a non-square pixel shape is squared here.
  let w = info.width
  let h = info.height
  if (Math.abs(info.sar - 1) > 0.001) {
    const sideways = info.rotation === 90 || info.rotation === 270
    if (sideways) h = even(Math.round(h * info.sar))
    else w = even(Math.round(w * info.sar))
    filters.push(`scale=${even(w)}:${even(h)}`, 'setsar=1')
  }
  if (o.crop && Number.isFinite(o.crop.aspect) && o.crop.aspect > 0) {
    const a = o.crop.aspect
    if (w / h > a + 1e-3) w = Math.min(w, even(Math.round(h * a)))
    else if (w / h < a - 1e-3) h = Math.min(h, even(Math.round(w / a)))
    filters.push(`crop=${even(w)}:${even(h)}`)
  }
  const scale = Math.min(1, maxLongSide / Math.max(w, h))
  const outW = even(Math.round(w * scale))
  const outH = even(Math.round(h * scale))
  if (o.hdr) {
    const transfer = o.hdr === 'pq' ? 'smpte2084' : 'arib-std-b67'
    filters.push(
      `scale=${outW}:${outH}`,
      `zscale=tin=${transfer}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100`,
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=mobius:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
      'format=yuv420p'
    )
  } else {
    // A source tagged BT.601 (standard definition) is converted; untagged HD is BT.709 in practice and left alone.
    const sd = ['smpte170m', 'bt470bg'].includes(info.colorSpace ?? '')
    filters.push(`scale=${outW}:${outH}:out_range=tv${sd ? ':in_color_matrix=bt601:out_color_matrix=bt709' : ''}`, 'format=yuv420p')
  }
  // ffmpeg 7.1 tags the stream from the frames' colour properties, which only zscale sets: tag every frame BT.709.
  filters.push('setsar=1', BT709_FRAMES)

  if (o.hdr && !((await hasFilter('zscale')) && (await hasFilter('tonemap')))) {
    throw new Error(
      'Den här ffmpeg-versionen kan inte göra om HDR-film till vanliga färger (zscale saknas). Installera ffmpeg med: brew install ffmpeg'
    )
  }
  const audio =
    o.audioStream !== undefined
      ? info.audioStreams.find((s) => s.index === o.audioStream)
      : info.audioStreams.find((s) => s.decodable)
  const resampler = await resamplerOption()
  const encode = (tmp: string, hwaccel: boolean): string[] => [
    '-nostdin', '-hide_banner', '-v', 'error',
    ...(hwaccel ? ['-hwaccel', 'videotoolbox'] : []),
    '-i', resolve(input),
    '-map', '0:V:0',
    ...(audio ? ['-map', `0:${audio.index}`] : []),
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    ...(audio
      ? [
          '-af',
          // Mono goes to both sides at full level (ffmpeg's own upmix would lower it 3 dB), as everywhere in Redigera.
          [channelFilter(audio.channels, 2) ?? '', `aresample=48000${resampler}:first_pts=0`].filter(Boolean).join(','),
          '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'
        ]
      : ['-an']),
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    '-f', 'mp4', '-y', tmp
  ]
  const failure = 'Arbetskopian kunde inte göras'
  // One reader for both attempts, so the progress shown never goes backwards.
  const onStdout = progressReader(info.duration, o.onProgress)
  try {
    await ffmpegToFile(out, (tmp) => encode(tmp, true), { failure, signal: o.signal, onStdout })
  } catch (err) {
    if (isAbortError(err) || errorMessage(err) === NOT_FOUND) throw err
    // VideoToolbox can refuse an unusual stream mid-way; software decoding is slower but takes anything.
    await ffmpegToFile(out, (tmp) => encode(tmp, false), { failure, signal: o.signal, onStdout })
  }
}

// ── What is sent to Venice for picture edits ─────────────────────────────────

/**
 * [start, end) of a film as an H.264 file small enough to send to Venice inside a JSON body: CRF 23, but capped to a
 * bitrate that keeps the file under `maxBytes`; its shorter side at most `maxHeight` (720 = "720p", also for a
 * portrait film); AAC 128k when `audio`; no metadata (an import without a working copy still has its GPS position,
 * which never leaves the machine); +faststart. Refuses (Swedish) when the stretch can't fit at a picture quality
 * worth editing (0.05 bits per pixel and frame).
 */
export async function makeProxy(
  input: string,
  out: string,
  o: { start: number; end: number; maxBytes: number; maxHeight: number; audio: boolean; signal?: AbortSignal }
): Promise<{ bytes: number; seconds: number }> {
  const info = await probeMedia(input)
  const start = clamp(o.start, 0, info.duration)
  const end = clamp(o.end, start, info.duration)
  const length = end - start
  if (length < MIN_CLIP_SECONDS) throw new Error('Avsnittet är för kort för att skickas till Venice.')
  const short = Math.min(info.width, info.height)
  const scale = o.maxHeight > 0 && short > o.maxHeight ? o.maxHeight / short : 1
  const w = even(Math.round(info.width * scale))
  const h = even(Math.round(info.height * scale))
  const audio = o.audio ? info.audioStreams.find((s) => s.decodable) : undefined
  const audioBps = audio ? 128_000 : 0
  // A few percent of the file is the container (index, headers).
  const budget = (o.maxBytes * 8 * 0.96) / length - audioBps
  const minimum = MIN_PROXY_BITS_PER_PIXEL * w * h * info.fps
  const tooBig = (): Error =>
    new Error(`Avsnittet blir för stort för Venice (högst ~${sizeSv(o.maxBytes)}). Välj en kortare markering.`)
  if (budget < minimum) throw tooBig()

  let rate = budget
  for (let attempt = 0; attempt < 3; attempt++) {
    const maxrate = String(Math.floor(rate))
    await ffmpegToFile(
      out,
      (tmp) => [
        '-nostdin', '-hide_banner', '-v', 'error',
        '-ss', secs(start), '-t', secs(length),
        '-i', resolve(input),
        '-map', '0:V:0',
        ...(audio ? ['-map', `0:${audio.index}`] : []),
        '-vf', `scale=${w}:${h},setsar=1,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-maxrate', maxrate, '-bufsize', maxrate,
        '-pix_fmt', 'yuv420p',
        ...(audio ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'] : ['-an']),
        '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
        '-movflags', '+faststart',
        '-f', 'mp4', '-y', tmp
      ],
      { failure: 'Underlaget till Venice kunde inte göras', signal: o.signal }
    )
    const bytes = (await stat(out)).size
    if (bytes <= o.maxBytes) {
      const seconds = (await probe(out)).duration
      return { bytes, seconds }
    }
    // The rate cap is an average; a few hard seconds can still push the file over. Ask for less and try again.
    rate *= 0.8
    if (rate < minimum) break
  }
  await rm(out, { force: true })
  throw tooBig()
}

/**
 * A solid-grey H.264 clip of exactly round(seconds · fps) frames at width × height: a few KB, for free /video/quote
 * calls only. Venice prices an edit by the source's length and the requested resolution, not its content (Topaz
 * also by its size and frame rate), so a plan quotes with this instead of uploading the real proxy. Never sent to
 * the queue.
 */
export async function makeStandIn(out: string, o: { seconds: number; width: number; height: number; fps: number }): Promise<void> {
  const fps = Number.isFinite(o.fps) && o.fps > 0 ? o.fps : 24
  const frames = Math.max(1, Math.round(o.seconds * fps))
  const size = `${even(o.width)}x${even(o.height)}`
  await ffmpegToFile(
    out,
    (tmp) => [
      '-nostdin', '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', `color=c=0x808080:s=${size}:r=${rationalFps(fps)}`,
      '-frames:v', String(frames),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '51', '-g', '100000', '-pix_fmt', 'yuv420p',
      '-an', '-map_metadata', '-1', '-movflags', '+faststart',
      '-f', 'mp4', '-y', tmp
    ],
    { failure: 'Kunde inte förbereda prisförfrågan' }
  )
}

// ── Sound out of files ───────────────────────────────────────────────────────

export interface ExtractAudioOptions {
  /** Seconds; the cut is sample-exact at `rate` (round(start · rate) to round(end · rate)). */
  start?: number
  end?: number
  /** Default 48 000. */
  rate?: number
  /** Default: as the source, at most stereo. */
  channels?: 1 | 2
  /** Default from the file name: .wav → pcm_f32le, .flac → flac (24-bit), .mp3 → mp3, .m4a → AAC. */
  codec?: 'pcm_f32le' | 'pcm_s16le' | 'flac' | 'mp3'
  /** For mp3 and AAC, e.g. "64k" (default 192k). */
  bitrate?: string | number
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

type AudioCodec = NonNullable<ExtractAudioOptions['codec']> | 'aac'

function codecFor(out: string, codec?: ExtractAudioOptions['codec']): AudioCodec {
  if (codec) return codec
  const ext = extname(out).toLowerCase()
  if (ext === '.flac') return 'flac'
  if (ext === '.mp3') return 'mp3'
  if (ext === '.m4a' || ext === '.aac') return 'aac'
  return 'pcm_f32le'
}

/** Encoder and muxer arguments of a sound file. FLAC is 24-bit: float sound loses nothing audible there. */
function audioOutputArgs(codec: AudioCodec, bitrate: string | number | undefined, aacMuxer: 'ipod' | 'adts' = 'ipod'): string[] {
  const rate = typeof bitrate === 'number' ? String(bitrate) : (bitrate ?? '192k')
  switch (codec) {
    case 'flac':
      return ['-c:a', 'flac', '-sample_fmt', 's32', '-f', 'flac']
    case 'mp3':
      return ['-c:a', 'libmp3lame', '-b:a', rate, '-f', 'mp3']
    case 'aac':
      return ['-c:a', 'aac', '-b:a', rate, ...(aacMuxer === 'ipod' ? ['-movflags', '+faststart'] : []), '-f', aacMuxer]
    case 'pcm_s16le':
      return ['-c:a', 'pcm_s16le', '-f', 'wav']
    default:
      return ['-c:a', 'pcm_f32le', '-f', 'wav']
  }
}

/** The filter that resamples a decoded stream onto the time line (a late-starting track is padded at the start). */
async function onTimeline(rate: number): Promise<string> {
  return `aresample=${rate}${await resamplerOption()}:first_pts=0`
}

/**
 * The sound of a file (its first audio stream ffmpeg can decode, from a video or an audio file) as an audio file,
 * cut sample-exactly at `rate`: the decoded stream is resampled onto the film's time line from 0 and trimmed by
 * sample number, so a chunk cut from 41.3 s starts on sample round(41.3 · rate) of the whole. Rejects with "Filen
 * innehåller inget ljud." when there is none.
 */
export async function extractAudio(input: string, out: string, o: ExtractAudioOptions = {}): Promise<void> {
  const source = await requireAudio(input)
  const rate = o.rate && o.rate > 0 ? Math.round(o.rate) : MIX_RATE
  const filters = [await onTimeline(rate)]
  const hasRange = o.start !== undefined || o.end !== undefined
  if (hasRange) {
    const from = samplesAt(o.start ?? 0, rate)
    const to = o.end !== undefined ? samplesAt(o.end, rate) : undefined
    if (to !== undefined && to <= from) throw new Error('Ogiltigt ljudutdrag: slutet ligger före början.')
    filters.push(`atrim=start_sample=${from}${to !== undefined ? `:end_sample=${to}` : ''}`, 'asetpts=PTS-STARTPTS')
  }
  const channels = o.channels ?? (source.channels > 2 || source.channels === 0 ? 2 : (source.channels as 1 | 2))
  const mix = channelFilter(source.channels, channels)
  if (mix) filters.push(mix)
  const total = (o.end ?? source.duration ?? 0) - (o.start ?? 0)
  await ffmpegToFile(
    out,
    (tmp) => [
      '-nostdin', '-hide_banner', '-v', 'error',
      '-i', resolve(input),
      '-map', `0:${source.index}`, '-vn', '-sn', '-dn',
      '-af', filters.join(','),
      '-ar', String(rate),
      ...audioOutputArgs(codecFor(out, o.codec), o.bitrate),
      '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
      '-progress', 'pipe:1', '-nostats',
      '-y', tmp
    ],
    { failure: 'Ljudet kunde inte tas ut', signal: o.signal, onStdout: progressReader(total, o.onProgress) }
  )
}

/** Which upload formats a model's accepted_audio_formats allows. */
function uploadFormats(formats: readonly string[]): { wav: boolean; mp3: boolean; m4a: boolean; aac: boolean } {
  const f = new Set(formats.map((s) => s.toLowerCase().trim()))
  return {
    wav: f.has('wav') || f.has('wave') || f.has('x-wav'),
    mp3: f.has('mp3') || f.has('mpeg') || f.has('mpga'),
    m4a: f.has('mp4') || f.has('m4a'),
    aac: f.has('aac')
  }
}

/**
 * [start, end) of a file's sound as an upload Venice accepts (the voice changer's accepted_audio_formats), written to
 * `out` whatever its extension: mono 48 kHz 16-bit WAV when WAV is accepted and fits `maxBytes` (lossless, and exact
 * to the sample), else MP3 at 192 kb/s, else AAC (128 kb/s, in .m4a when 'mp4' is accepted, else ADTS for 'aac').
 * Rejects (Swedish) when no accepted format fits. The format decides the file name Venice gets.
 */
export async function encodeUpload(
  input: string,
  out: string,
  o: { start: number; end: number; formats: string[]; maxBytes: number; signal?: AbortSignal }
): Promise<{ format: 'wav' | 'mp3' | 'm4a' | 'aac'; bytes: number }> {
  const allowed = uploadFormats(o.formats)
  if (!allowed.wav && !allowed.mp3 && !allowed.m4a && !allowed.aac) {
    throw new Error('Modellen tar inte emot något ljudformat som Studio kan skicka (wav, mp3 eller m4a).')
  }
  const samples = samplesAt(o.end) - samplesAt(o.start)
  if (samples <= 0) throw new Error('Ogiltigt ljudutdrag: slutet ligger före början.')
  const seconds = samples / MIX_RATE
  const source = await requireAudio(input)
  const filters = [
    await onTimeline(MIX_RATE),
    `atrim=start_sample=${samplesAt(o.start)}:end_sample=${samplesAt(o.end)}`,
    'asetpts=PTS-STARTPTS',
    channelFilter(source.channels, 1) ?? 'anull'
  ].join(',')
  const write = async (format: 'wav' | 'mp3' | 'm4a' | 'aac'): Promise<number> => {
    const output =
      format === 'wav'
        ? audioOutputArgs('pcm_s16le', undefined)
        : format === 'mp3'
          ? audioOutputArgs('mp3', '192k')
          : audioOutputArgs('aac', '128k', format === 'm4a' ? 'ipod' : 'adts')
    await ffmpegToFile(
      out,
      (tmp) => [
        '-nostdin', '-hide_banner', '-v', 'error',
        '-i', resolve(input),
        '-map', `0:${source.index}`, '-vn', '-sn', '-dn',
        '-af', filters, '-ar', String(MIX_RATE), '-ac', '1',
        ...output,
        '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
        '-y', tmp
      ],
      { failure: 'Ljudet kunde inte förberedas för Venice', signal: o.signal }
    )
    return (await stat(out)).size
  }
  // WAV's size is known before encoding; the compressed ones are checked after.
  if (allowed.wav && 44 + samples * 2 <= o.maxBytes) {
    const bytes = await write('wav')
    if (bytes <= o.maxBytes) return { format: 'wav', bytes }
  }
  if (allowed.mp3 && seconds * 24_000 * 1.01 <= o.maxBytes) {
    const bytes = await write('mp3')
    if (bytes <= o.maxBytes) return { format: 'mp3', bytes }
  }
  if (allowed.m4a || allowed.aac) {
    const format = allowed.m4a ? 'm4a' : 'aac'
    const bytes = await write(format)
    if (bytes <= o.maxBytes) return { format, bytes }
  }
  await rm(out, { force: true })
  throw new Error(`Ljudet är för stort för Venice (högst ~${sizeSv(o.maxBytes)} per del). Välj en kortare del.`)
}

// ── Analysing sound ──────────────────────────────────────────────────────────

/** Splits a stream of text into whole lines for `onLine`. */
function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let pending = ''
  return (chunk: string): void => {
    pending += chunk
    let nl: number
    while ((nl = pending.search(/\r?\n|\r/)) >= 0) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + (pending[nl] === '\r' && pending[nl + 1] === '\n' ? 2 : 1))
      onLine(line)
    }
  }
}

/**
 * The silent stretches of a file's sound (silencedetect on its mono mix): quieter than `noiseDb` for at least
 * `minSeconds`, in seconds. Run on an isolated voice stem it finds the pauses between lines (on a mix, music hides
 * them). Rejects with "Filen innehåller inget ljud." when there is none.
 */
export async function silences(
  path: string,
  o: { noiseDb?: number; minSeconds?: number; signal?: AbortSignal } = {}
): Promise<EditRange[]> {
  const source = await requireAudio(path)
  const { ffmpeg } = await binaries()
  const noise = Number.isFinite(o.noiseDb) ? o.noiseDb! : -45
  const min = o.minSeconds && o.minSeconds > 0 ? o.minSeconds : 0.4
  const found: EditRange[] = []
  let open: number | undefined
  const onStderr = lineReader((line) => {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (start) open = Math.max(0, Number(start[1]))
    const stop = /silence_end:\s*([\d.]+)/.exec(line)
    if (stop) {
      found.push({ start: open ?? 0, end: Number(stop[1]) })
      open = undefined
    }
  })
  try {
    await run(
      ffmpeg,
      [
        '-nostdin', '-hide_banner', '-nostats', '-v', 'info',
        '-i', resolve(path),
        '-map', `0:${source.index}`, '-vn', '-sn', '-dn',
        '-af', `${await onTimeline(MIX_RATE)},${channelFilter(source.channels, 1) ?? 'anull'},silencedetect=noise=${noise}dB:d=${min}`,
        '-f', 'null', '-'
      ],
      { signal: o.signal, onStderr }
    )
  } catch (err) {
    throw audioFailure(err, 'Pauserna i ljudet kunde inte hittas')
  }
  // A silence running to the end of the file has no end line.
  if (open !== undefined) found.push({ start: open, end: Math.max(open, source.duration ?? open) })
  return found.filter((s) => s.end > s.start)
}

/**
 * Integrated loudness (LUFS) and true peak (dBTP) of a file's sound, or of `range` of it; -Infinity for silence.
 * Measured as loudnorm's first pass measures it (EBU R128).
 */
export async function loudness(path: string, range?: EditRange): Promise<{ lufs: number; truePeak: number }> {
  const source = await requireAudio(path)
  const { ffmpeg } = await binaries()
  const seek = range ? ['-ss', secs(range.start), '-t', secs(Math.max(MIN_AUDIO_SECONDS, range.end - range.start))] : []
  let stderr: string
  try {
    ;({ stderr } = await run(ffmpeg, [
      '-nostdin', '-hide_banner', '-nostats', '-v', 'info',
      ...seek,
      '-i', resolve(path),
      '-map', `0:${source.index}`, '-vn', '-sn', '-dn',
      '-af', 'loudnorm=print_format=json',
      '-f', 'null', '-'
    ]))
  } catch (err) {
    throw audioFailure(err, 'Ljudnivån kunde inte mätas')
  }
  return parseLoudnorm(stderr)
}

function parseLoudnorm(stderr: string): { lufs: number; truePeak: number } {
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr)?.[0]
  if (!json) throw new Error('Ljudnivån kunde inte mätas: ffmpeg gav inget mätvärde.')
  const values = JSON.parse(json) as { input_i?: string; input_tp?: string }
  const num = (v: string | undefined): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : -Infinity
  }
  return { lufs: num(values.input_i), truePeak: num(values.input_tp) }
}

/**
 * The sound of `input` sped up (tempo > 1) or slowed down without changing its pitch: Rubber Band (natural for
 * speech), or atempo when this ffmpeg lacks it. The result is 1/tempo as long; the format follows `out`'s name.
 */
export async function timeStretch(input: string, out: string, tempo: number): Promise<void> {
  if (!Number.isFinite(tempo) || tempo <= 0) throw new Error('Ogiltigt tempo.')
  const source = await requireAudio(input)
  let stretch: string
  if (Math.abs(tempo - 1) < 1e-4) stretch = 'anull'
  else if (await hasFilter('rubberband')) stretch = `rubberband=tempo=${tempo.toFixed(6)}:pitchq=quality`
  else {
    // atempo takes 0.5–100 per instance; a chain covers slower tempos.
    const parts: string[] = []
    let rest = tempo
    while (rest < 0.5) {
      parts.push('atempo=0.5')
      rest /= 0.5
    }
    parts.push(`atempo=${rest.toFixed(6)}`)
    stretch = parts.join(',')
  }
  await ffmpegToFile(
    out,
    (tmp) => [
      '-nostdin', '-hide_banner', '-v', 'error',
      '-i', resolve(input),
      '-map', `0:${source.index}`, '-vn', '-sn', '-dn',
      '-af', stretch,
      ...audioOutputArgs(codecFor(out), undefined),
      '-map_metadata', '-1', '-y', tmp
    ],
    { failure: 'Repliken kunde inte anpassas till tiden' }
  )
}

// ── Mixing ───────────────────────────────────────────────────────────────────

/** An AudioMix with every source looked up as a file (edit-mix.ts resolves it): what renderMix plays. */
export interface ResolvedMix {
  /** Seconds; the result is exactly round(duration · 48000) samples. */
  duration: number
  bed: {
    /** The film's own sound (or a bake); null = silence. Ignored when there are stems. */
    path: string | null
    /** Applied to the whole bed (the stems summed, when there are stems). */
    gains: GainSpan[]
    stems?: { voicePath: string | null; voiceGains: GainSpan[]; backgroundPath: string | null; backgroundGains: GainSpan[] }
  }
  layers: (Omit<AudioLayer, 'mediaId' | 'assetAudioId'> & { path: string })[]
  denoise?: 'mild' | 'strong'
  /** Target integrated loudness, LUFS. */
  loudness?: number
  fadeIn?: number
  fadeOut?: number
}

/**
 * A gain envelope as a volume expression of t (seconds): each span multiplies the sound by its gain (0 for mute)
 * from start to end, ramping over `fade` seconds just outside its edges, so the whole span is at its gain and the
 * sound around it is untouched. Overlapping spans multiply.
 */
function envelope(spans: readonly GainSpan[]): string | undefined {
  const terms: string[] = []
  for (const s of spans) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start) continue
    const gain = s.mute ? 0 : Math.pow(10, (Number.isFinite(s.gainDb) ? s.gainDb! : 0) / 20)
    if (Math.abs(gain - 1) < 1e-9) continue
    const ramp = Math.max(0.001, Number.isFinite(s.fade) ? s.fade! : DEFAULT_GAIN_FADE)
    const from = (s.start - ramp).toFixed(6)
    const to = (s.end + ramp).toFixed(6)
    const r = ramp.toFixed(6)
    terms.push(`(1+(${(gain - 1).toFixed(9)})*clip(min((t-(${from}))/${r},((${to})-t)/${r}),0,1))`)
  }
  return terms.length ? terms.join('*') : undefined
}

/** Filters applying gain spans: 1 ms frames (asetnsamples) make the per-frame volume a sample-accurate envelope. */
function gainFilters(spans: readonly GainSpan[]): string[] {
  const expr = envelope(spans)
  return expr ? ['asetnsamples=n=48:p=0', `volume='${expr}':eval=frame`] : []
}

const afftdnDelay = new Map<string, Promise<number>>()

/**
 * How many samples afftdn delays its output at 48 kHz with these settings (1200 with ffmpeg 7.1; measured once
 * per session on an impulse, so another ffmpeg build stays aligned too). The denoised sound is shifted back by it.
 */
function denoiseDelay(settings: string): Promise<number> {
  let measured = afftdnDelay.get(settings)
  if (!measured) {
    measured = (async () => {
      const { ffmpeg } = await binaries()
      const at = 24_000
      const { bytes } = await run(
        ffmpeg,
        [
          '-nostdin', '-hide_banner', '-v', 'error',
          '-f', 'lavfi', '-i', `aevalsrc='if(eq(n,${at}),0.9,0)':s=${MIX_RATE}:d=1.5`,
          '-af', settings,
          '-f', 'f32le', '-ac', '1', 'pipe:1'
        ],
        { timeoutMs: 30_000, binaryStdout: { maxBytes: 64 * MIX_RATE } }
      )
      const samples = new Float32Array(bytes!.buffer, bytes!.byteOffset, Math.floor(bytes!.length / 4))
      let peak = 0
      for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i]) > Math.abs(samples[peak])) peak = i
      return Math.max(0, peak - at)
    })().catch((err: unknown) => {
      afftdnDelay.delete(settings)
      throw err
    })
    afftdnDelay.set(settings, measured)
  }
  return measured
}

/**
 * The noise floor to give afftdn for a file's sound, in dBFS: the 10th percentile of its 50 ms levels (the quietest
 * moments, between words and sounds; digital silence ignored) plus a margin, within afftdn's −80…−20. −50 (afftdn's
 * own default) when the file is silent throughout.
 */
const NOISE_FLOOR_MARGIN_DB = 6

async function noiseFloorDb(path: string, o: { signal?: AbortSignal } = {}): Promise<number> {
  const source = await audioInput(path)
  if (!source) return -50
  const { ffmpeg } = await binaries()
  const rate = 16_000
  const block = rate / 20
  const levels: number[] = []
  let sum = 0
  let count = 0
  let carry: Buffer | undefined
  const onStdoutData = (chunk: Buffer): void => {
    let data = chunk
    if (carry) {
      data = Buffer.concat([carry, chunk])
      carry = undefined
    }
    const whole = data.length - (data.length % 2)
    for (let i = 0; i < whole; i += 2) {
      const v = data.readInt16LE(i) / 32768
      sum += v * v
      if (++count === block) {
        const db = 10 * Math.log10(sum / block + 1e-20)
        if (db > -90) levels.push(db)
        sum = 0
        count = 0
      }
    }
    if (whole < data.length) carry = data.subarray(whole)
  }
  try {
    await run(
      ffmpeg,
      [
        '-nostdin', '-hide_banner', '-v', 'error',
        '-i', resolve(path),
        '-map', `0:${source.index}`, '-vn', '-sn', '-dn',
        '-af', `aresample=${rate},${channelFilter(source.channels, 1) ?? 'anull'}`,
        '-f', 's16le', 'pipe:1'
      ],
      { signal: o.signal, onStdoutData }
    )
  } catch (err) {
    throw audioFailure(err, 'Bruset i ljudet kunde inte mätas')
  }
  if (!levels.length) return -50
  levels.sort((a, b) => a - b)
  // afftdn removes noise at and below its floor, so the floor goes a little above the measured hiss (measured: at
  // the hiss's own level it lowers white noise ~2 dB, 6 dB above it 11 dB mild / 16 dB strong).
  const floor = levels[Math.floor(levels.length * 0.1)] + NOISE_FLOOR_MARGIN_DB
  return Math.round(Math.min(-20, Math.max(-80, floor)))
}

/** Compression of a ducked sound under its sidechain: lowered quickly when speech starts, back within a third of a second. */
const DUCK = 'sidechaincompress=threshold=0.03:ratio=6:attack=15:release=350'

/**
 * Renders a mix to `out`: 48 kHz stereo (32-bit float WAV; .flac and .m4a by name), exactly round(duration · 48000)
 * samples.
 *
 * - The bed is the voice and background stems summed (each with its own gains) when there are stems, else the
 *   film's own sound; then denoise (afftdn with the film's measured noise floor + highpass 80 Hz, its delay
 *   compensated), then the bed's gains. Gains are sample-accurate volume envelopes with 20 ms ramps.
 * - Each layer plays [offset, offset + length) of its file (looped when `loop`), faded in and out, at its gain,
 *   starting exactly on sample round(at · 48000).
 * - Ducking: a speech, voice, effect or audio layer with `duck` lowers the bed under it (the new line is heard over
 *   the film); a music layer with `duck` is itself lowered under the speech — the voice stem (or the bed when there
 *   are no stems) and every speech/voice layer ("Sänk under tal"). Sidechain compression, threshold 0.03, ratio 6,
 *   attack 15 ms, release 350 ms.
 * - Everything is summed without normalisation (amix normalize=0), faded in/out, and with `loudness` brought to that
 *   integrated loudness by one linear gain measured in a first pass (what loudnorm's linear mode does, without its
 *   fallback to dynamic compression or its 192 kHz round trip), with a delay-compensated look-ahead limiter at
 *   −2 dBFS only when the gain would push peaks past −1.5 dBTP (then measured again and made up for).
 */
export async function renderMix(
  mix: ResolvedMix,
  out: string,
  o: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}
): Promise<void> {
  if (!Number.isFinite(mix.duration) || mix.duration <= 0) throw new Error('Ljudet har ingen längd att mixa.')
  const total = samplesAt(mix.duration)
  // The bed and sidechains run past the end: sidechaincompress ends with its shorter input, at a frame boundary.
  const padded = total + MIX_RATE
  const resample = await onTimeline(MIX_RATE)
  const stereo = 'aformat=sample_fmts=fltp:channel_layouts=stereo'

  const inputs: string[][] = []
  const graph: string[] = []
  let labelCount = 0
  const label = (prefix: string): string => `${prefix}${labelCount++}`
  /** Splits a stream into n copies (or passes it on). */
  const split = (stream: string, n: number): string[] => {
    if (n <= 1) return [stream]
    const outs = Array.from({ length: n }, () => label('s'))
    graph.push(`[${stream}]asplit=${n}${outs.map((s) => `[${s}]`).join('')}`)
    return outs
  }
  const silence = (): string => {
    const s = label('z')
    graph.push(`anullsrc=r=${MIX_RATE}:cl=stereo,atrim=end_sample=${padded}[${s}]`)
    return s
  }
  /** A file's sound on the time line, stereo, with gains, padded to the padded length; undefined without sound. */
  const timelineInput = async (path: string | null, gains: GainSpan[]): Promise<string | undefined> => {
    if (!path) return undefined
    const source = await audioInput(path)
    if (!source) return undefined
    inputs.push(['-i', resolve(path)])
    const s = label('t')
    const chain = [resample, channelFilter(source.channels, 2), stereo, ...gainFilters(gains)].filter(Boolean)
    graph.push(`[${inputs.length - 1}:${source.index}]${chain.join(',')},apad=whole_len=${padded},atrim=end_sample=${padded}[${s}]`)
    return s
  }

  // Layers first (their probes decide which play at all).
  type Prepared = { layer: ResolvedMix['layers'][number]; stream: string }
  const prepared: Prepared[] = []
  for (const layer of mix.layers) {
    const source = await audioInput(layer.path)
    if (!source) continue
    const offset = samplesAt(Math.max(0, layer.offset))
    let length = samplesAt(Math.max(0, layer.length))
    if (!layer.loop && source.duration !== undefined) length = Math.min(length, samplesAt(source.duration) - offset)
    if (length <= 0) continue
    inputs.push([...(layer.loop ? ['-stream_loop', '-1'] : []), '-i', resolve(layer.path)])
    const fadeIn = Math.min(length, samplesAt(Math.max(0, layer.fadeIn)))
    const fadeOut = Math.min(length, samplesAt(Math.max(0, layer.fadeOut)))
    const chain = [
      `aresample=${MIX_RATE}${await resamplerOption()}`,
      channelFilter(source.channels, 2),
      stereo,
      `atrim=start_sample=${offset}:end_sample=${offset + length}`,
      'asetpts=PTS-STARTPTS',
      fadeIn > 0 ? `afade=t=in:ss=0:ns=${fadeIn}` : undefined,
      fadeOut > 0 ? `afade=t=out:ss=${length - fadeOut}:ns=${fadeOut}` : undefined,
      Number.isFinite(layer.gainDb) && layer.gainDb !== 0 ? `volume=${layer.gainDb.toFixed(3)}dB` : undefined,
      `adelay=delays=${samplesAt(Math.max(0, layer.at))}S:all=1`
    ].filter(Boolean)
    const s = label('l')
    graph.push(`[${inputs.length - 1}:${source.index}]${chain.join(',')}[${s}]`)
    prepared.push({ layer, stream: s })
  }
  const duckers = prepared.filter((p) => p.layer.duck && p.layer.kind !== 'music')
  const duckedMusic = prepared.filter((p) => p.layer.duck && p.layer.kind === 'music')
  const speech = prepared.filter((p) => !(p.layer.duck && p.layer.kind === 'music') && (p.layer.kind === 'speech' || p.layer.kind === 'voice' || p.layer.duck))

  // The bed.
  const stems = mix.bed.stems
  let voice: string | undefined
  let bed: string
  if (stems) {
    voice = await timelineInput(stems.voicePath, stems.voiceGains)
    const background = await timelineInput(stems.backgroundPath, stems.backgroundGains)
    let voiceForBed = voice
    if (voice && duckedMusic.length) {
      const copies = split(voice, 2)
      voiceForBed = copies[0]
      voice = copies[1]
    }
    const parts = [voiceForBed, background].filter((s): s is string => !!s)
    if (parts.length === 2) {
      bed = label('b')
      graph.push(`[${parts[0]}][${parts[1]}]amix=inputs=2:normalize=0:duration=longest[${bed}]`)
    } else bed = parts[0] ?? silence()
  } else {
    bed = (await timelineInput(mix.bed.path, [])) ?? silence()
  }
  const bedFilters: string[] = []
  // The noise lives in the background stem when there is one.
  const noisy = stems ? (stems.backgroundPath ?? stems.voicePath) : mix.bed.path
  if (mix.denoise && noisy) {
    // afftdn only removes what lies under its noise floor, so the floor is set from the film's own (measured). Its
    // noise tracking (tn) is left off: on steady hiss it settled on a floor that removed under 2 dB.
    const floor = await noiseFloorDb(noisy, { signal: o.signal })
    const settings = `afftdn=nr=${mix.denoise === 'strong' ? 24 : 12}:nf=${floor}`
    const delay = await denoiseDelay(settings)
    bedFilters.push(
      ...(delay > 0 ? [`apad=pad_len=${delay}`] : []),
      settings,
      ...(delay > 0 ? [`atrim=start_sample=${delay}`, 'asetpts=PTS-STARTPTS'] : []),
      'highpass=f=80'
    )
  }
  bedFilters.push(...gainFilters(mix.bed.gains))
  if (bedFilters.length) {
    const next = label('b')
    graph.push(`[${bed}]${bedFilters.join(',')},apad=whole_len=${padded},atrim=end_sample=${padded}[${next}]`)
    bed = next
  }
  // The speech the music ducks under: the voice stem, else the whole bed (before it is ducked itself).
  let bedAsSpeech: string | undefined
  if (duckedMusic.length && !voice) {
    const copies = split(bed, 2)
    bed = copies[0]
    bedAsSpeech = copies[1]
  }

  // Copies of each layer for the final sum and the sidechains.
  const finalStreams = new Map<Prepared, string>()
  const duckerCopies: string[] = []
  const speechCopies: string[] = []
  for (const p of prepared) {
    const toDuckers = duckers.includes(p)
    const toSpeech = duckedMusic.length > 0 && speech.includes(p)
    const copies = split(p.stream, 1 + (toDuckers ? 1 : 0) + (toSpeech ? 1 : 0))
    finalStreams.set(p, copies[0])
    let next = 1
    if (toDuckers) duckerCopies.push(copies[next++])
    if (toSpeech) speechCopies.push(copies[next++])
  }
  const sumPadded = (streams: string[]): string => {
    const s = label('m')
    const sum = streams.length > 1 ? `amix=inputs=${streams.length}:normalize=0:duration=longest,` : ''
    graph.push(`${streams.map((x) => `[${x}]`).join('')}${sum}apad=whole_len=${padded},atrim=end_sample=${padded}[${s}]`)
    return s
  }
  if (duckerCopies.length) {
    const sidechain = sumPadded(duckerCopies)
    const next = label('b')
    graph.push(`[${bed}][${sidechain}]${DUCK}[${next}]`)
    bed = next
  }
  const finals: string[] = [bed]
  if (duckedMusic.length) {
    const music = sumPadded(duckedMusic.map((p) => finalStreams.get(p)!))
    const sidechainSources = [voice ?? bedAsSpeech!, ...speechCopies]
    const sidechain = sumPadded(sidechainSources)
    const ducked = label('m')
    graph.push(`[${music}][${sidechain}]${DUCK}[${ducked}]`)
    finals.push(ducked)
  }
  for (const p of prepared) if (!duckedMusic.includes(p)) finals.push(finalStreams.get(p)!)

  const fadeIn = Math.min(total, samplesAt(Math.max(0, mix.fadeIn ?? 0)))
  const fadeOut = Math.min(total, samplesAt(Math.max(0, mix.fadeOut ?? 0)))
  const tail = [
    `apad=whole_len=${total}`,
    `atrim=end_sample=${total}`,
    ...(fadeIn > 0 ? [`afade=t=in:ss=0:ns=${fadeIn}`] : []),
    ...(fadeOut > 0 ? [`afade=t=out:ss=${total - fadeOut}:ns=${fadeOut}`] : [])
  ].join(',')
  const sum = finals.length > 1 ? `amix=inputs=${finals.length}:normalize=0:duration=first,` : ''
  graph.push(`${finals.map((s) => `[${s}]`).join('')}${sum}${tail}[mix]`)

  const normalize = mix.loudness !== undefined && Number.isFinite(mix.loudness)
  const codec = codecFor(out)
  // With loudness, the mix goes to a float WAV first; the linear gain is applied in a second pass.
  const mixOut = normalize ? join(dirname(resolve(out)), `.${basename(out, extname(out))}.${randomUUID().slice(0, 8)}.part.wav`) : out
  const share = normalize ? 0.8 : 1
  if (normalize) partialFiles.add(mixOut)
  try {
    await ffmpegToFile(
      mixOut,
      (tmp) => [
        '-nostdin', '-hide_banner', '-v', 'error',
        ...inputs.flat(),
        '-filter_complex', graph.join(';'),
        '-map', '[mix]', '-vn', '-sn', '-dn',
        ...audioOutputArgs(normalize ? 'pcm_f32le' : codec, '256k'),
        '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
        '-progress', 'pipe:1', '-nostats',
        '-y', tmp
      ],
      { failure: 'Ljudet kunde inte mixas', signal: o.signal, onStdout: progressReader(mix.duration, o.onProgress, (f) => f * share) }
    )
    if (!normalize) return

    const target = mix.loudness!
    const measured = await loudness(mixOut)
    const audible = Number.isFinite(measured.lufs) && measured.lufs > -70
    let gain = audible ? target - measured.lufs : 0
    // Linear normalisation can push peaks past the true-peak ceiling; only those few peaks are limited then.
    const limit = audible && measured.truePeak + gain > -1.5
    const apply = (gainDb: number, from: number, to: number): Promise<void> =>
      ffmpegToFile(
        out,
        (tmp) => [
          '-nostdin', '-hide_banner', '-v', 'error',
          '-i', mixOut,
          '-af', [
            ...(gainDb !== 0 ? [`volume=${gainDb.toFixed(3)}dB`] : []),
            // Look-ahead limiting with its delay compensated (latency=1), so nothing moves in time.
            ...(limit ? ['alimiter=limit=0.794:level=0:latency=1:attack=5:release=50'] : []),
            `apad=whole_len=${total}`,
            `atrim=end_sample=${total}`
          ].join(','),
          ...audioOutputArgs(codec, '256k'),
          '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
          '-progress', 'pipe:1', '-nostats',
          '-y', tmp
        ],
        { failure: 'Ljudnivån kunde inte jämnas ut', signal: o.signal, onStdout: progressReader(mix.duration, o.onProgress, (f) => from + f * (to - from)) }
      )
    await apply(gain, share, limit ? 0.9 : 1)
    // Limiting takes some loudness away (more the spikier the sound): measured again and made up for, at most twice.
    for (let pass = 0; limit && pass < 2; pass++) {
      const result = await loudness(out)
      const short = target - result.lufs
      if (!Number.isFinite(short) || Math.abs(short) <= 0.3) break
      gain += short
      await apply(gain, 0.9, 1)
    }
  } finally {
    if (normalize) {
      await rm(mixOut, { force: true })
      partialFiles.delete(mixOut)
    }
  }
}

/**
 * Pieces of sound (each already aligned to its exact length, audio-align.ts) put on one track at their absolute
 * sample positions: every chunk is delayed by its own start (adelay=<n>S) and the delayed chunks are summed
 * (amix normalize=0), so no error accumulates from chunk to chunk however many there are. The result is exactly
 * `totalSamples` at 48 kHz (32-bit float WAV, .flac by name), mono when every chunk is mono, else stereo.
 */
export async function assembleAt(
  chunks: { path: string; startSample: number }[],
  totalSamples: number,
  out: string,
  o: { signal?: AbortSignal } = {}
): Promise<void> {
  const total = Math.max(1, Math.round(totalSamples))
  const sources = await Promise.all(chunks.map(async (c) => ({ ...c, source: await requireAudio(c.path) })))
  const channels: 1 | 2 = sources.every((s) => s.source.channels === 1) ? 1 : 2
  const layout = channels === 1 ? 'mono' : 'stereo'
  const resample = `aresample=${MIX_RATE}${await resamplerOption()}`
  const graph: string[] = []
  sources.forEach((s, i) => {
    const chain = [resample, channelFilter(s.source.channels, channels), `aformat=sample_fmts=fltp:channel_layouts=${layout}`, 'asetpts=PTS-STARTPTS', `adelay=delays=${Math.max(0, Math.round(s.startSample))}S:all=1`]
    graph.push(`[${i}:${s.source.index}]${chain.filter(Boolean).join(',')}[c${i}]`)
  })
  const tail = `apad=whole_len=${total},atrim=end_sample=${total}`
  if (!sources.length) graph.push(`anullsrc=r=${MIX_RATE}:cl=${layout},${tail}[out]`)
  else if (sources.length === 1) graph.push(`[c0]${tail}[out]`)
  else graph.push(`${sources.map((_, i) => `[c${i}]`).join('')}amix=inputs=${sources.length}:normalize=0:duration=longest,${tail}[out]`)
  await ffmpegToFile(
    out,
    (tmp) => [
      '-nostdin', '-hide_banner', '-v', 'error',
      ...sources.flatMap((s) => ['-i', resolve(s.path)]),
      '-filter_complex', graph.join(';'),
      '-map', '[out]',
      ...audioOutputArgs(codecFor(out), undefined),
      '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
      '-y', tmp
    ],
    { failure: 'Rösten kunde inte sättas ihop', signal: o.signal }
  )
}

// ── Putting video back together ──────────────────────────────────────────────

/**
 * The video with a new sound (or none, for `audio` null): the picture copied untouched (`-c:v copy`), the sound
 * encoded as AAC 192 kb/s 48 kHz stereo and cut or padded to exactly the video's length, +faststart, no metadata.
 */
export async function replaceAudioTrack(
  video: string,
  audio: string | null,
  out: string,
  o: { signal?: AbortSignal } = {}
): Promise<void> {
  const picture = await probe(video)
  const source = audio ? await requireAudio(audio) : undefined
  const total = samplesAt(picture.duration)
  const sound =
    audio && source
      ? [
          '-map', `1:${source.index}`,
          '-af', `${await onTimeline(MIX_RATE)},${channelFilter(source.channels, 2) ?? 'anull'},apad=whole_len=${total},atrim=end_sample=${total}`,
          '-c:a', 'aac', '-b:a', '192k', '-ar', String(MIX_RATE), '-ac', '2'
        ]
      : ['-an']
  await ffmpegToFile(
    out,
    (tmp) => [
      '-nostdin', '-hide_banner', '-v', 'error',
      '-i', resolve(video),
      ...(audio ? ['-i', resolve(audio)] : []),
      '-map', '0:V:0', '-c:v', 'copy',
      ...sound,
      '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-movflags', '+faststart',
      '-f', 'mp4', '-y', tmp
    ],
    { failure: 'Ljudet kunde inte läggas på videon', signal: o.signal }
  )
}

export interface SplicePart {
  path: string
  /** Seconds in the part's own file; cut on its own frame grid (the frames concatClips would keep). */
  start: number
  end: number
  /** Retime the part to last exactly this long (an AI take fitted into the gap it replaces). */
  fitTo?: number
}

/**
 * Pictures of several files back to back, frame-exact: each part becomes exactly its own number of frames at `fps`
 * (its frames on its own grid, or round(fitTo · fps) when retimed), scaled and padded to width × height, then
 * faded in from and out to black over whole frames. `fps` comes before `scale` (ffmpeg 7.1 drops a part's last
 * frame otherwise). H.264 CRF 18, BT.709, no sound: replaceAudioTrack adds it.
 */
export async function spliceVideo(o: {
  parts: SplicePart[]
  out: string
  width: number
  height: number
  fps: number
  fadeIn?: number
  fadeOut?: number
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}): Promise<void> {
  if (!o.parts.length) throw new Error('Det finns ingen bild att sätta ihop.')
  const fpsText = rationalFps(o.fps)
  const fps = rationalValue(fpsText)
  const w = even(o.width)
  const h = even(o.height)
  const probes = await Promise.all(o.parts.map((p) => probe(p.path)))
  const graph: string[] = []
  let frames = 0
  o.parts.forEach((part, i) => {
    const p = probes[i]
    const start = clamp(part.start, 0, p.duration)
    const end = clamp(part.end, start, p.duration)
    const span = frameSpan(start, end, p.fps > 0 ? p.fps : fps, p.duration)
    const fit = part.fitTo !== undefined && Number.isFinite(part.fitTo) && part.fitTo > 0 ? part.fitTo : undefined
    const count = Math.max(1, Math.round((fit ?? span.length) * fps))
    frames += count
    const chain = [
      `trim=start=${secs(start)}:end=${secs(end)}`,
      'setpts=PTS-STARTPTS',
      ...(fit ? [`setpts=PTS*${(fit / span.length).toFixed(9)}`] : []),
      `fps=${fpsText}`,
      `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
      'setsar=1',
      'format=yuv420p',
      // Exactly `count` frames: a rounding short of them is filled with the last frame, extra ones are cut.
      'tpad=stop_mode=clone:stop=2',
      `trim=end_frame=${count}`,
      'setpts=PTS-STARTPTS'
    ]
    graph.push(`[${i}:V:0]${chain.join(',')}[p${i}]`)
  })
  const fadeInFrames = Math.min(frames, Math.round(Math.max(0, o.fadeIn ?? 0) * fps))
  const fadeOutFrames = Math.min(frames, Math.round(Math.max(0, o.fadeOut ?? 0) * fps))
  // fade starts in on a black frame but never reaches black on its last faded frame (only the frames after it are
  // black), so a fade-out spans one frame less and the film ends on a black frame.
  const fadeOutSpan = Math.max(1, fadeOutFrames - 1)
  const fades = [
    ...(fadeInFrames > 0 ? [`fade=t=in:s=0:n=${fadeInFrames}`] : []),
    ...(fadeOutFrames > 0 ? [`fade=t=out:s=${Math.max(0, frames - fadeOutSpan - 1)}:n=${fadeOutSpan}`] : [])
  ]
  const joined = o.parts.length > 1 ? `${o.parts.map((_, i) => `[p${i}]`).join('')}concat=n=${o.parts.length}:v=1:a=0` : '[p0]null'
  graph.push(`${joined}${fades.length ? `,${fades.join(',')}` : ''},format=yuv420p,${BT709_FRAMES}[v]`)
  await ffmpegToFile(
    o.out,
    (tmp) => [
      '-nostdin', '-hide_banner', '-v', 'error',
      ...o.parts.flatMap((p) => ['-i', resolve(p.path)]),
      '-filter_complex', graph.join(';'),
      '-map', '[v]', '-an', '-sn', '-dn',
      // Constant frame rate at the output: the frames are on the grid already, and this gives the last one its
      // duration back (trim leaves it without one, and the file would end a frame early).
      '-fps_mode', 'cfr', '-r', fpsText,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      '-map_metadata', '-1', '-map_chapters', '-1',
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      '-f', 'mp4', '-y', tmp
    ],
    {
      failure: 'Bilden kunde inte klippas ihop',
      signal: o.signal,
      onStdout: progressReader(frames / fps, o.onProgress)
    }
  )
}

// ── The timeline: waveform, filmstrip and cuts ───────────────────────────────

/** Samples per second the waveform is read at: plenty for a picture of the sound, light on a long film. */
const WAVEFORM_RATE = 16_000
/** Peaks are first kept per 10 ms block, then grouped into the buckets asked for. */
const WAVEFORM_BLOCK = WAVEFORM_RATE / 100

/**
 * The sound's peak level (0–1 of full scale) in each of `buckets` equal stretches of the file, for the timeline's
 * Ljud lane; all zeros when the file has no sound ffmpeg can decode. With `duration` (the film's length, which the
 * lane is drawn across) each stretch is that much time of the film: sound that ends early leaves the last buckets
 * at 0, and sound running past the picture is left out, so a peak is drawn where it is heard.
 */
export async function waveform(
  path: string,
  buckets: number,
  o: { signal?: AbortSignal; duration?: number } = {}
): Promise<number[]> {
  const n = Math.max(1, Math.min(100_000, Math.floor(buckets)))
  const source = await audioInput(path)
  if (!source) return new Array<number>(n).fill(0)
  const { ffmpeg } = await binaries()
  const blocks: number[] = []
  let blockPeak = 0
  let inBlock = 0
  let carry: Buffer | undefined
  const onStdoutData = (chunk: Buffer): void => {
    let data = chunk
    if (carry) {
      data = Buffer.concat([carry, chunk])
      carry = undefined
    }
    const whole = data.length - (data.length % 2)
    for (let i = 0; i < whole; i += 2) {
      const v = Math.abs(data.readInt16LE(i))
      if (v > blockPeak) blockPeak = v
      if (++inBlock === WAVEFORM_BLOCK) {
        blocks.push(blockPeak / 32768)
        blockPeak = 0
        inBlock = 0
      }
    }
    if (whole < data.length) carry = data.subarray(whole)
  }
  try {
    await run(
      ffmpeg,
      [
        '-nostdin', '-hide_banner', '-v', 'error',
        '-i', resolve(path),
        '-map', `0:${source.index}`, '-vn', '-sn', '-dn',
        '-af', `aresample=${WAVEFORM_RATE}:first_pts=0`, '-ac', '1',
        '-f', 's16le', 'pipe:1'
      ],
      { signal: o.signal, onStdoutData }
    )
  } catch (err) {
    throw audioFailure(err, 'Ljudets vågform kunde inte läsas')
  }
  if (inBlock > 0) blocks.push(blockPeak / 32768)
  const peaks = new Array<number>(n).fill(0)
  if (!blocks.length) return peaks
  const level = (peak: number): number => Math.round(Math.min(1, peak) * 1000) / 1000
  // Blocks are placed by their time (first_pts=0 pads a late start), over the film's length when it is given.
  const blockSeconds = WAVEFORM_BLOCK / WAVEFORM_RATE
  const span = o.duration && Number.isFinite(o.duration) && o.duration > 0 ? o.duration : blocks.length * blockSeconds
  blocks.forEach((peak, i) => {
    const t = i * blockSeconds
    if (t >= span) return
    const bucket = Math.min(n - 1, Math.floor((t / span) * n))
    if (peak > peaks[bucket]) peaks[bucket] = level(peak)
  })
  // Buckets shorter than a block (a very short film): each shows the block it lies in, none past the sound's end.
  if (span / n < blockSeconds) {
    for (let b = 0; b < n; b++) {
      const i = Math.floor((b * span) / n / blockSeconds)
      peaks[b] = i < blocks.length ? level(blocks[i]) : 0
    }
  }
  return peaks
}

/**
 * `count` small JPEGs (120 px tall; a smaller film keeps its height) spread evenly over the film, each from the middle of its stretch, written into
 * outDir as filmstrip-000.jpg… Returns the ones that could be taken, with the moment each shows.
 */
export async function filmstrip(path: string, outDir: string, count: number): Promise<{ time: number; path: string }[]> {
  const n = Math.max(1, Math.min(500, Math.floor(count)))
  const info = await probe(path)
  await mkdir(outDir, { recursive: true })
  const items = Array.from({ length: n }, (_, i) => ({
    i,
    time: Math.round(((i + 0.5) * info.duration * 1000) / n) / 1000
  }))
  const done: { time: number; path: string }[] = []
  await forEachLimited(items, FRAME_CONCURRENCY, async ({ i, time }) => {
    const out = join(outDir, `filmstrip-${String(i).padStart(3, '0')}.jpg`)
    // Quoted so the comma inside min() isn't read as a filter separator; a small film isn't upscaled.
    const scale = `scale=-2:'min(${FILMSTRIP_HEIGHT},ih)'`
    try {
      let jpeg = await frameJpeg(path, time, info, scale)
      if (!jpeg) jpeg = await grabJpeg(path, [], scale).catch(() => undefined)
      if (!jpeg) return
      await writeThroughTemp(out, (tmp) => writeFile(tmp, jpeg!))
      done.push({ time, path: out })
    } catch (err) {
      console.warn(`Filmstrip frame at ${time} s of ${path} failed: ${errorMessage(err)}`)
    }
  })
  return done.sort((a, b) => a.time - b.time)
}

/**
 * Where the picture cuts (scene changes found by scdet, `threshold` 0–100, default 10), in seconds: the first frame
 * of each new shot. For films without recorded cut markers, so Klippgränser still show where a sequence was joined.
 */
export async function sceneCuts(path: string, threshold = 10, o: { signal?: AbortSignal } = {}): Promise<number[]> {
  const { ffmpeg } = await binaries()
  const t = Math.min(100, Math.max(0.1, Number.isFinite(threshold) ? threshold : 10))
  const cuts: number[] = []
  const onStderr = lineReader((line) => {
    const m = /lavfi\.scd\.time:\s*([\d.]+)/.exec(line)
    if (m) cuts.push(Number(m[1]))
  })
  try {
    await run(
      ffmpeg,
      [
        '-nostdin', '-hide_banner', '-nostats', '-v', 'info',
        '-hwaccel', 'videotoolbox',
        '-i', resolve(path),
        '-map', '0:V:0', '-an', '-sn', '-dn',
        '-vf', `scale=320:-2,scdet=threshold=${t}`,
        '-f', 'null', '-'
      ],
      { signal: o.signal, onStderr }
    )
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new Error(`Klippen i filmen kunde inte hittas: ${errorMessage(err)}`)
  }
  return [...new Set(cuts.filter((c) => Number.isFinite(c) && c > 0).map((c) => Math.round(c * 1000) / 1000))].sort((a, b) => a - b)
}

// ── Building blocks for audio-align.ts ───────────────────────────────────────

/**
 * A file's sound (first decodable audio stream) decoded to mono 32-bit float samples at `rate` (default 48 kHz),
 * from its first sample: what a decoder gives, without moving it onto a time line. At most `maxSeconds` (default
 * 15 min) is decoded, so a mistake can't fill memory. Rejects with "Filen innehåller inget ljud." without sound.
 */
export async function decodeSamples(
  path: string,
  o: { rate?: number; maxSeconds?: number; signal?: AbortSignal } = {}
): Promise<Float32Array> {
  const source = await requireAudio(path)
  const rate = o.rate && o.rate > 0 ? Math.round(o.rate) : MIX_RATE
  const maxSeconds = o.maxSeconds && o.maxSeconds > 0 ? o.maxSeconds : 15 * 60
  const { ffmpeg } = await binaries()
  let bytes: Buffer | undefined
  try {
    ;({ bytes } = await run(
      ffmpeg,
      [
        '-nostdin', '-hide_banner', '-v', 'error',
        '-i', resolve(path),
        '-map', `0:${source.index}`, '-vn', '-sn', '-dn',
        '-af', `aresample=${rate}${await resamplerOption()},${channelFilter(source.channels, 1) ?? 'anull'}`,
        '-t', secs(maxSeconds),
        '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1'
      ],
      { signal: o.signal, binaryStdout: { maxBytes: Math.ceil(maxSeconds * rate * 4) + 1024 * 1024 } }
    ))
  } catch (err) {
    throw audioFailure(err, 'Ljudet kunde inte läsas')
  }
  const data = bytes ?? Buffer.alloc(0)
  // A copy on its own aligned buffer: Buffer pools may start at an offset that isn't a multiple of 4.
  const aligned = new Uint8Array(Math.floor(data.length / 4) * 4)
  aligned.set(data.subarray(0, aligned.length))
  return new Float32Array(aligned.buffer)
}

/**
 * A file's sound (first decodable audio stream) through an ffmpeg audio filter chain into `out` (format by name:
 * .wav 32-bit float, .flac 24-bit, .mp3, .m4a). For sample-exact work: the filters see the decoded stream as is.
 */
export async function filterAudio(
  input: string,
  out: string,
  filters: string[],
  o: { signal?: AbortSignal; failure?: string } = {}
): Promise<void> {
  const source = await requireAudio(input)
  await ffmpegToFile(
    out,
    (tmp) => [
      '-nostdin', '-hide_banner', '-v', 'error',
      '-i', resolve(input),
      '-map', `0:${source.index}`, '-vn', '-sn', '-dn',
      '-af', filters.length ? filters.join(',') : 'anull',
      ...audioOutputArgs(codecFor(out), undefined),
      '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
      '-y', tmp
    ],
    { failure: o.failure ?? 'Ljudet kunde inte bearbetas', signal: o.signal }
  )
}

/** The resampling filter for 48 kHz (soxr when this ffmpeg has it). */
export async function resampleTo48k(): Promise<string> {
  return `aresample=${MIX_RATE}${await resamplerOption()}`
}
