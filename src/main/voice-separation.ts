// Voice and background separation with macOS's own AUSoundIsolation audio unit, through the small helper
// `studio-voice-isolate` built from native/voice-isolate/main.swift (npm run build:helpers) and shipped in the app's
// Resources/bin. It runs locally and offline at ~28× real time, so separating is free: it enables removing or
// keeping only the voice, and keeping the music and effects under a new voice. The helper is optional: without it
// (another OS, macOS before 13, a build without the Swift toolchain) these features are off with a Swedish reason.

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { release } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { app } from 'electron'
import type { SeparationStatus } from '@shared/types'
import { extractAudio, MIX_RATE, probeAudio, probeMedia, runHelper, writeThroughTemp } from './ffmpeg'

const HELPER = 'studio-voice-isolate'
/** The probe instantiates the audio unit once; well under a second normally. */
const PROBE_TIMEOUT_MS = 20_000
/**
 * The helper reports its progress every few percent and runs at ~28× real time: no progress line for this long means
 * it has stalled (a hung audio unit), and it is stopped.
 */
const STALL_MS = 120_000
/** At least this long, and at most the sound's own length in real time (~28× what it normally needs). */
const MIN_RUN_MS = 5 * 60_000
/** The free space a separation leaves on the disk, beyond its scratch files. */
const SCRATCH_RESERVE_BYTES = 1024 ** 3
/** Darwin 22 is macOS 13 Ventura, where AUSoundIsolation first shipped. */
const MIN_DARWIN = 22

/** Where the helper lives: inside the app when packaged, the build output of the repository in development. */
export function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', HELPER)
    : join(app.getAppPath(), 'build', 'bin', HELPER)
}

interface ProbeReply {
  ok?: boolean
  hq?: boolean
  latency?: number
  error?: string
}

let available: Promise<SeparationStatus> | undefined

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function check(): Promise<SeparationStatus> {
  if (process.platform !== 'darwin') {
    return { available: false, message: 'Röstseparering finns bara på macOS.' }
  }
  const darwin = Number.parseInt(release().split('.')[0] ?? '', 10)
  if (!(darwin >= MIN_DARWIN)) {
    return { available: false, message: 'Röstseparering kräver macOS 13 Ventura eller senare.' }
  }
  const helper = helperPath()
  if (!(await isExecutable(helper))) {
    return {
      available: false,
      message: app.isPackaged
        ? 'Röstseparering saknas i den här versionen av Studio. Installera om Studio.'
        : 'Röstseparering är inte byggd. Kör npm run build:helpers (kräver Xcode Command Line Tools).'
    }
  }
  let reply: ProbeReply
  try {
    const { stdout } = await runHelper(helper, ['--probe'], { timeoutMs: PROBE_TIMEOUT_MS })
    reply = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as ProbeReply
  } catch (err) {
    console.warn('The voice separation helper failed its probe:', err)
    return { available: false, message: 'Röstseparering kunde inte startas på den här datorn.' }
  }
  if (!reply.ok) {
    console.warn('The voice separation helper reported:', reply.error)
    return { available: false, message: 'Den här datorn saknar Apples röstisolering (AUSoundIsolation).' }
  }
  return { available: true, quality: reply.hq ? 'high' : 'standard' }
}

/**
 * Whether this Mac can separate voice from background, and how well ('high' = the High Quality Voice model of
 * macOS 15 and later). Only success is cached, so building the helper while Studio runs is picked up next time.
 */
export function separationStatus(): Promise<SeparationStatus> {
  available ??= check().then((status) => {
    if (!status.available) available = undefined
    return status
  })
  return available
}

/** Reads the helper's "progress=0.42" lines. */
function progressLines(onProgress: (fraction: number) => void): (chunk: string) => void {
  let pending = ''
  return (chunk) => {
    pending += chunk
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const m = /^progress=([\d.]+)/.exec(pending.slice(0, nl).trim())
      pending = pending.slice(nl + 1)
      if (m) onProgress(Math.min(1, Math.max(0, Number(m[1]))))
    }
  }
}

const SCRATCH_PREFIX = '.separera-'
/** Scratch folders of separations running in this process. */
const scratchInUse = new Set<string>()

/**
 * Scratch folders a crash or a quit mid-separation left next to the stems (their WAVs are hundreds of MB per minute
 * of film). Those of separations still running here are kept. Never throws.
 */
async function removeStaleScratch(dir: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    if (!name.startsWith(SCRATCH_PREFIX) || scratchInUse.has(path)) continue
    await rm(path, { recursive: true, force: true }).catch((err: unknown) => {
      console.warn(`Could not remove leftover separation scratch ${path}:`, err)
    })
  }
}

/** "1,2 GB" / "340 MB". */
function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

/**
 * Refuses (Swedish) when the scratch files won't fit: the sound three times over as 32-bit float WAV at 48 kHz (the
 * extracted input, the voice, the background), with SCRATCH_RESERVE_BYTES still left. Unknown free space or length
 * passes (the write itself then reports a full disk).
 */
async function checkScratchSpace(dir: string, seconds: number | undefined, channels: number): Promise<void> {
  if (!seconds || !(seconds > 0)) return
  const needed = seconds * MIX_RATE * channels * 4 * 3
  let free: number
  try {
    const s = await statfs(dir)
    free = Number(s.bavail) * Number(s.bsize)
  } catch {
    return
  }
  if (free - needed < SCRATCH_RESERVE_BYTES) {
    throw new Error(
      `Det finns för lite ledigt utrymme på disken för att separera rösten (behöver ~${formatBytes(needed)} under tiden).`
    )
  }
}

/** A stem written by the helper (32-bit float WAV) moved or encoded to `out`, by its name (.wav kept, .flac 24-bit). */
async function placeStem(wav: string, out: string): Promise<void> {
  if (extname(out).toLowerCase() === '.wav') {
    await writeThroughTemp(out, (tmp) => rename(wav, tmp))
    return
  }
  await extractAudio(wav, out)
}

/**
 * Splits the sound of `input` (its first decodable audio track) into the voice and everything else, written to
 * `out.voice` and `out.background` (.flac as 24-bit FLAC, .wav as 32-bit float): both exactly as long as the input's
 * sound at 48 kHz, latency-compensated to the sample, and summing back to the original (background = input − voice).
 * The sound is first extracted at 48 kHz, keeping stereo (the model scores ~4 dB better on stereo cues); a mono
 * track stays mono, which scores better than the same sound duplicated. Rejects in Swedish when separation isn't
 * available here or the file has no sound.
 */
export async function separateStems(
  input: string,
  out: { voice: string; background: string },
  o: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}
): Promise<void> {
  const status = await separationStatus()
  if (!status.available) throw new Error(status.message ?? 'Röstseparering saknas på den här datorn.')
  const report = (fraction: number): void => {
    try {
      o.onProgress?.(Math.min(1, Math.max(0, fraction)))
    } catch (err) {
      console.warn('Separation progress callback failed:', err)
    }
  }
  const info = await probeMedia(input).catch(() => undefined)
  // An audio-only file has no video stream for probeMedia; extractAudio reads it all the same.
  const firstAudio = info?.audioStreams.find((s) => s.decodable)
  const channels: 1 | 2 = firstAudio?.channels === 1 ? 1 : 2
  const seconds = info?.duration ?? (await probeAudio(input).then((a) => a.duration, () => undefined))
  // Scratch next to the stems (the same volume, so the results are renamed, not copied, into place).
  const stemsDir = dirname(out.voice)
  await removeStaleScratch(stemsDir)
  await mkdir(stemsDir, { recursive: true })
  await checkScratchSpace(stemsDir, seconds, channels)
  const work = join(stemsDir, `${SCRATCH_PREFIX}${randomUUID().slice(0, 8)}`)
  await mkdir(work, { recursive: true })
  scratchInUse.add(work)
  try {
    const source = join(work, 'in.wav')
    await extractAudio(input, source, {
      rate: MIX_RATE,
      channels,
      codec: 'pcm_f32le',
      signal: o.signal,
      onProgress: (f) => report(f * 0.08)
    })
    const voice = join(work, 'voice.wav')
    const background = join(work, 'background.wav')
    const args = [source, voice, background, ...(status.quality === 'high' ? [] : ['--standard'])]
    // A watchdog: the helper is killed when its progress stalls, or when it runs far longer than the sound could take.
    const watchdog = new AbortController()
    let stopped: 'stalled' | 'slow' | undefined
    const stop = (why: 'stalled' | 'slow'): void => {
      stopped ??= why
      watchdog.abort()
    }
    const forward = (): void => watchdog.abort()
    o.signal?.addEventListener('abort', forward, { once: true })
    if (o.signal?.aborted) watchdog.abort()
    let stall = setTimeout(() => stop('stalled'), STALL_MS)
    const wall = setTimeout(() => stop('slow'), Math.max(MIN_RUN_MS, (seconds ?? 2 * 3600) * 1000))
    try {
      await runHelper(helperPath(), args, {
        signal: watchdog.signal,
        onStdout: progressLines((f) => {
          clearTimeout(stall)
          stall = setTimeout(() => stop('stalled'), STALL_MS)
          report(0.08 + f * 0.82)
        })
      })
    } catch (err) {
      if (stopped && !o.signal?.aborted) {
        available = undefined
        throw new Error(
          stopped === 'stalled'
            ? 'Röstsepareringen stannade upp och avbröts. Försök igen – händer det igen, starta om datorn.'
            : 'Röstsepareringen tog orimligt lång tid och avbröts. Försök igen.',
          { cause: err }
        )
      }
      if (err instanceof Error && err.name === 'AbortError') throw err
      // A helper that broke since the last check is checked again next time.
      available = undefined
      throw new Error(`Röstsepareringen misslyckades: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    } finally {
      clearTimeout(stall)
      clearTimeout(wall)
      o.signal?.removeEventListener('abort', forward)
    }
    report(0.9)
    await placeStem(voice, out.voice)
    report(0.95)
    await placeStem(background, out.background)
    report(1)
  } finally {
    await rm(work, { recursive: true, force: true })
    scratchInUse.delete(work)
  }
}
