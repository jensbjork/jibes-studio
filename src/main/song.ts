// Songs: "New sequence from a song…" and a sequence's song (Sequence.song) – its file, its separated vocals, its lyrics
// and its analysis. The rules of the song's clips (their places, adding, deleting) are the sequence service's
// (sequences.ts); sending a song clip and measuring a take's singing are song-sync.ts's.
//
// - The song is copied into the sequence's folder (Sequences/<name>/Audio/<file>), so it moves with it; the vocals are
//   separated on this Mac (free, voice-separation.ts) into Audio/<name> (vocals).flac.
// - The lyrics are transcribed (paid: Venice ASR with word times, priced first, the budget applies) from the vocals
//   when there are any (cleaner), else the mix; each transcription is a media_jobs row (op 'transcribe', no edit, the
//   sequence in its request) that Spending places on the sequence. A line corrected by hand keeps its timing.
// - Long work runs in the background, one step at a time per sequence (separate → transcribe → analyse → split into
//   clips), shown in Sequence.songWork and Activity; a step that fails says why in Sequence.songError and the next
//   goes on without it.

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { transcriptionPriceUsd } from '@shared/edit-plan'
import { evenBoundaries, lyricLines, MAX_SONG_SECONDS, MIN_SONG_SECONDS, retimeLine, suggestSections } from '@shared/song'
import { DEFAULT_SONG_TARGET_SECONDS, MAX_SONG_WINDOW_SECONDS, MIN_SONG_WINDOW_SECONDS } from '@shared/song-window'
import type {
  AsrModel,
  Sequence,
  SequenceSong,
  SongImportOptions,
  SongLyrics,
  SongOverview,
  SongWork
} from '@shared/types'
import { isAgentCall } from './agent/local-ipc'
import { AUDIO_FILE_TYPES } from './assets'
import { assertWithinBudget } from './budget'
import * as db from './db'
import { libraryDirector } from './directors'
import { DEFAULT_ASR } from './edit-ops'
import { extractAudio, probeAudio } from './ffmpeg'
import { isInsideRoot, tmpDir, toStoredPath } from './paths'
import { isConfirmedHere, noteRequestedBy } from './requested-by'
import * as store from './sequence-store'
import type { SequenceService } from './sequences'
import { analyseSong, cachedSongAnalysis, overviewOf } from './song-analysis'
import { assertAgentFiles } from './upload-paths'
import type { VeniceAudio } from './venice-audio'
import { separateStems, separationStatus } from './voice-separation'

/** Venice takes at most ~24 MB in one transcription (the song is sent as 64 kb/s mono MP3: ~50 minutes). */
const ASR_MAX_BYTES = 24 * 1024 * 1024
/** Progress alone is announced at most this often (a whole sequence is sent to the window each time). */
const PROGRESS_INTERVAL_MS = 500

/** Said when an agent's call reaches what only the user (or an approved request) may do. */
const USER_ONLY = 'Only you can do this in Studio.'
const NO_SONG = 'The sequence has no song.'
/** Said to an agent that asks for lyrics without an approval. */
const LYRICS_NEED_APPROVAL = 'Transcribing the lyrics is paid: ask for it with request_song_lyrics, which the user approves.'

/** The file name the vocals get next to the song, from the song's file. */
export function vocalsFileName(songPath: string): string {
  return `${basename(songPath, extname(songPath))} (vocals).flac`
}

/** What runs for a sequence's song right now (Activity, work.ts). */
export interface SongActiveWork {
  sequenceId: string
  stage: SongWork['stage']
  fraction?: number
  startedAt: number
}

/**
 * The model a song's lyrics are transcribed with, among Venice's transcription models: `wanted`, which must time every
 * word (Scribe, xAI: the lyrics need each word's time), or by default Scribe, else the first that times words.
 */
export function lyricsModelOf(models: readonly AsrModel[], wanted?: string): AsrModel {
  const timed = models.filter((m) => m.timestamps === 'word')
  const model = timed.find((m) => m.id === (wanted ?? DEFAULT_ASR)) ?? (wanted ? undefined : timed[0])
  if (model) return model
  if (!wanted) throw new Error('Venice offers no transcription model that times every word right now.')
  throw new Error(
    `${wanted} isn't a transcription model that times every word. Choose one of: ${timed.map((m) => m.id).join(', ') || 'none right now'}.`
  )
}

/** A transcription about to be paid for: the model, its language hint and the price the user is shown. */
export interface LyricsPlan {
  model: string
  modelName: string
  language?: string
  priceUsd: number
  /** The song's length it was priced for. */
  seconds: number
}

interface SongDeps {
  sequences: SequenceService
  audio: VeniceAudio
  /** The sequence changed (its song, its work, its clips): the window refetches it. */
  notify: (sequenceId: string) => void
  /** Work started, moved on or stopped: the status summary reads activeWork() again. */
  workChanged?: () => void
}

/** A step that ended without an error but with something to tell (no words heard). */
class SongNotice extends Error {}

const STEP_FAILED: Record<SongWork['stage'], string> = {
  copying: 'The song could not be copied in',
  separating: "The vocals couldn't be separated",
  transcribing: "The lyrics couldn't be transcribed",
  analysing: "The song couldn't be analysed",
  splitting: "The song couldn't be split into clips"
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The audio file a caller hands over, checked: a file Studio reads as sound (by its extension), which exists. */
function audioFile(path: unknown): string {
  if (typeof path !== 'string' || !path) throw new Error('Choose an audio file.')
  const ext = extname(path).slice(1).toLowerCase()
  if (!AUDIO_FILE_TYPES.includes(ext)) {
    throw new Error(`${basename(path)} is not an audio file Studio reads (MP3, WAV, M4A, AAC, AIFF, FLAC or OGG).`)
  }
  let file = false
  try {
    file = statSync(path).isFile()
  } catch {
    file = false
  }
  if (!file) throw new Error(`${basename(path)} no longer exists.`)
  return path
}

/** Import options from the window or an agent; anything malformed is left out, a clip length kept to 2–15 s. */
function cleanOptions(input: unknown): SongImportOptions {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const out: SongImportOptions = {}
  if (typeof o.name === 'string' && o.name.trim()) out.name = o.name.trim()
  if (typeof o.separateVocals === 'boolean') out.separateVocals = o.separateVocals
  if (o.lyrics === true) out.lyrics = true
  else if (o.lyrics && typeof o.lyrics === 'object') {
    const l = o.lyrics as Record<string, unknown>
    out.lyrics = {
      ...(typeof l.model === 'string' && l.model ? { model: l.model } : {}),
      ...(typeof l.language === 'string' && l.language.trim() ? { language: l.language.trim() } : {})
    }
  }
  if (typeof o.targetSeconds === 'number' && Number.isFinite(o.targetSeconds)) {
    out.targetSeconds = Math.min(MAX_SONG_WINDOW_SECONDS, Math.max(MIN_SONG_WINDOW_SECONDS, o.targetSeconds))
  }
  if (o.confirmOverBudget === true) out.confirmOverBudget = true
  return out
}

/** The song's length, or a refusal for one too short to hold a clip or too long to analyse. */
async function songLength(path: string): Promise<number> {
  const { duration } = await probeAudio(path)
  if (duration < MIN_SONG_SECONDS) {
    throw new Error(`The song is only ${duration.toFixed(1)} s long: it needs at least ${MIN_SONG_SECONDS} s for one clip.`)
  }
  if (duration > MAX_SONG_SECONDS) {
    throw new Error(`The song is ${Math.round(duration / 60)} minutes long: Studio takes songs of at most ${MAX_SONG_SECONDS / 60} minutes.`)
  }
  return Math.round(duration * 1000) / 1000
}

/**
 * Records a paid transcription of a sequence's song, at what it cost, so Spending (spending.ts) counts it on the
 * sequence: a finished media_jobs row with no edit and the sequence in its request. Noted as the agent's when it
 * runs for an approved request.
 */
function recordTranscription(sequenceId: string, plan: LyricsPlan): void {
  try {
    const id = randomUUID()
    const now = Date.now()
    const request = { label: 'Song lyrics', sequenceId, model: plan.model, seconds: plan.seconds }
    db.getDb()
      .prepare(
        `INSERT INTO media_jobs (id, edit_id, asset_id, base_generation_id, op, request, status, quote, cost,
           take_generation_id, result_generation_id, error, created_at, updated_at)
         VALUES (?, NULL, NULL, NULL, 'transcribe', ?, 'completed', ?, ?, NULL, NULL, NULL, ?, ?)`
      )
      .run(id, JSON.stringify(request), plan.priceUsd, plan.priceUsd, now, now)
    noteRequestedBy(id)
  } catch (err) {
    // Bookkeeping: the lyrics are there either way; Venice's own account has the charge.
    console.warn('Could not record the transcription of a song:', err)
  }
}

export class SongService {
  /** Each sequence's song work, one step after another (a promise that never rejects). */
  private readonly queues = new Map<string, Promise<void>>()
  /** The step running for each sequence. */
  private readonly running = new Map<string, SongActiveWork>()
  /** When each sequence's progress was last announced. */
  private readonly announced = new Map<string, number>()
  /**
   * Sequences whose clips got their places from Studio, not from someone choosing them (a song put on clips nothing
   * has been put in): the split after the analysis may place them again. Choosing places (songs:setSections) ends it.
   */
  private readonly autoPlaced = new Set<string>()

  constructor(private readonly deps: SongDeps) {}

  // ── State ──────────────────────────────────────────────────────────────────

  /** What runs right now, for Activity. */
  activeWork(): SongActiveWork[] {
    return [...this.running.values()].map((w) => ({ ...w }))
  }

  /** Why the library can't be switched or tidied right now (a song being copied, separated, transcribed or analysed). */
  isBusy(): string | undefined {
    return this.queues.size ? 'A song is being prepared (its vocals separated, its lyrics transcribed or its beat found).' : undefined
  }

  private workChanged(): void {
    try {
      this.deps.workChanged?.()
    } catch (err) {
      console.warn('Announcing a change of song work failed:', err)
    }
  }

  private announce(sequenceId: string): void {
    this.announced.set(sequenceId, Date.now())
    try {
      this.deps.notify(sequenceId)
    } catch (err) {
      console.warn('Announcing a song change failed:', err)
    }
  }

  /** Sets the step running for the sequence (undefined: none), as songWork and in Activity. */
  private setWork(sequenceId: string, stage: SongWork['stage'] | undefined, fraction?: number): void {
    const was = this.running.get(sequenceId)
    const { error } = store.songRuntimeOf(sequenceId)
    if (!stage) {
      this.running.delete(sequenceId)
      store.setSongRuntime(sequenceId, { error })
    } else {
      const work: SongWork = { stage, ...(fraction !== undefined ? { fraction: Math.round(fraction * 100) / 100 } : {}) }
      this.running.set(sequenceId, {
        sequenceId,
        stage,
        ...(work.fraction !== undefined ? { fraction: work.fraction } : {}),
        startedAt: was?.stage === stage ? was.startedAt : Date.now()
      })
      store.setSongRuntime(sequenceId, { work, error })
    }
    // A new step is announced at once; progress within a step at most every PROGRESS_INTERVAL_MS.
    const progressOnly = !!stage && was?.stage === stage
    if (progressOnly && Date.now() - (this.announced.get(sequenceId) ?? 0) < PROGRESS_INTERVAL_MS) return
    this.announce(sequenceId)
    this.workChanged()
  }

  private setError(sequenceId: string, error: string | undefined): void {
    store.setSongRuntime(sequenceId, { work: store.songRuntimeOf(sequenceId).work, error })
  }

  /**
   * Runs `task` after the sequence's song work queued so far; resolves when it is done (never rejects). `first`: the
   * step it starts with, shown at once when nothing else runs for the sequence (the caller answers before it starts).
   */
  private enqueue(sequenceId: string, first: SongWork['stage'], task: () => Promise<void>): Promise<void> {
    if (!this.queues.has(sequenceId)) this.setWork(sequenceId, first)
    const previous = this.queues.get(sequenceId) ?? Promise.resolve()
    const next = previous.then(task).catch((err: unknown) => console.warn(`Song work on ${sequenceId} failed:`, err))
    this.queues.set(sequenceId, next)
    this.workChanged()
    void next.finally(() => {
      if (this.queues.get(sequenceId) !== next) return
      this.queues.delete(sequenceId)
      // A first step shown at once that never started (the song went meanwhile).
      if (this.running.has(sequenceId)) this.setWork(sequenceId, undefined)
      this.workChanged()
    })
    return next
  }

  /**
   * One step of the song work: shown while it runs; a failure is kept as the song's error (and the work goes on). False
   * when it failed or the sequence or its song is gone.
   */
  private async step(
    sequenceId: string,
    stage: SongWork['stage'],
    run: (report: (fraction: number) => void) => Promise<void>
  ): Promise<boolean> {
    if (!store.sequenceSong(sequenceId)) return false
    // Without a fraction until the step reports one (a transcription never does).
    this.setWork(sequenceId, stage)
    try {
      await run((fraction) => this.setWork(sequenceId, stage, fraction))
      return true
    } catch (err) {
      if (!store.getSequenceRow(sequenceId)) return false
      const message = err instanceof SongNotice ? err.message : `${STEP_FAILED[stage]}: ${errorText(err)}`
      console.warn(`Song step ${stage} of ${sequenceId} failed:`, err)
      this.setError(sequenceId, message)
      return false
    } finally {
      this.setWork(sequenceId, undefined)
    }
  }

  private requireSong(sequenceId: string): SequenceSong {
    store.requirePlainSequence(sequenceId)
    const song = store.sequenceSong(sequenceId)
    if (!song) throw new Error(NO_SONG)
    return song
  }

  /** The song, whose file must be where the sequence says (moved or deleted in Finder: said plainly). */
  private requireSongFile(sequenceId: string): SequenceSong {
    const song = this.requireSong(sequenceId)
    if (!existsSync(song.path)) {
      throw new Error(`The song's file is missing: ${basename(song.path)}. Put it back in the sequence's folder (Audio).`)
    }
    return song
  }

  // ── Lyrics: the price ──────────────────────────────────────────────────────

  /** The transcription models Venice lists (free). */
  private async wordModels(): Promise<AsrModel[]> {
    return (await this.deps.audio.catalog()).transcription
  }

  /** What transcribing `seconds` of song with `model` (default: Scribe, else the first that times words) costs. */
  async lyricsPlan(seconds: number, opts: { model?: string; language?: string } = {}): Promise<LyricsPlan> {
    const model = lyricsModelOf(await this.wordModels(), opts.model)
    return {
      model: model.id,
      modelName: model.name,
      ...(opts.language ? { language: opts.language } : {}),
      priceUsd: transcriptionPriceUsd(seconds, model.usdPerSecond),
      seconds
    }
  }

  async quoteLyrics(sequenceId: string, model?: unknown): Promise<number> {
    const song = this.requireSong(sequenceId)
    return (await this.lyricsPlan(song.duration, typeof model === 'string' && model ? { model } : {})).priceUsd
  }

  // ── The song ───────────────────────────────────────────────────────────────

  /**
   * "New sequence from a song…": a new sequence (named after the file unless told otherwise) with a copy of the file
   * as its song; resolves at once. The vocals are separated (by default when this Mac can), the lyrics transcribed
   * when asked (priced and checked against the budget first: OVER_BUDGET unless confirmed, before anything is made),
   * the song analysed and split into clips of about `targetSeconds`, in the background.
   */
  async createSequence(path: unknown, input: unknown): Promise<Sequence> {
    const file = audioFile(path)
    const opts = cleanOptions(input)
    const duration = await songLength(file)
    const lyrics = opts.lyrics
      ? await this.lyricsPlan(duration, opts.lyrics === true ? {} : opts.lyrics)
      : undefined
    if (lyrics) assertWithinBudget(lyrics.priceUsd, { confirmed: opts.confirmOverBudget })
    const separate = opts.separateVocals ?? (await separationStatus()).available
    const name = basename(file)
    const id = await this.deps.sequences.createRow(opts.name ?? basename(file, extname(file)))
    try {
      const copied = await this.deps.sequences.placeSongFile(id, file, name)
      store.writeSequenceSong(id, { path: copied, name, duration })
    } catch (err) {
      await this.deps.sequences.delete(id).catch((e: unknown) => console.warn('Could not remove the half-made sequence:', e))
      throw err
    }
    this.prepare(id, { separate, lyrics, targetSeconds: opts.targetSeconds ?? DEFAULT_SONG_TARGET_SECONDS })
    this.announce(id)
    return this.deps.sequences.get(id)
  }

  /**
   * Puts a song on a sequence, or takes it off (null). A new song is copied in like "New sequence from a song…": the
   * clips a sequence has keep their places, cut to the new song's length (a sequence without a song spreads them
   * evenly over it), and are refused – with nothing changed – when that would remove a clip with takes, a prompt or
   * notes. Taking the song off leaves the clips as ordinary clips and the song's files where they are.
   */
  async setSong(sequenceId: string, path: unknown, input: unknown, caller: { byAgent?: boolean } = {}): Promise<Sequence> {
    store.requirePlainSequence(sequenceId)
    if (path === null) {
      const sequence = this.deps.sequences.removeSong(sequenceId, caller)
      store.setSongRuntime(sequenceId, undefined)
      return sequence
    }
    const file = audioFile(path)
    const opts = cleanOptions(input)
    const duration = await songLength(file)
    const lyrics = opts.lyrics
      ? await this.lyricsPlan(duration, opts.lyrics === true ? {} : opts.lyrics)
      : undefined
    if (lyrics) assertWithinBudget(lyrics.priceUsd, { confirmed: opts.confirmOverBudget })
    const separate = opts.separateVocals ?? (await separationStatus()).available
    const before = store.sequenceSong(sequenceId)
    const rows = store.listSegmentRows(sequenceId)
    const copied = await this.deps.sequences.placeSongFile(sequenceId, file, basename(file))
    const song: SequenceSong = { path: copied, name: basename(file), duration }
    try {
      if (rows.every((r) => store.isUntouchedSegment(r))) this.autoPlaced.add(sequenceId)
      else this.autoPlaced.delete(sequenceId)
      if (!rows.length) store.writeSequenceSong(sequenceId, song)
      else {
        // The places the clips have, cut to the new length; without a song yet, the clips share it evenly.
        const cuts = before
          ? rows.slice(1).flatMap((r) => {
              const start = store.parseParams(r.params).song?.start
              return start !== undefined && start <= duration - MIN_SONG_WINDOW_SECONDS ? [start] : []
            })
          : evenBoundaries(rows.length, duration)
        await this.deps.sequences.setSongSections(sequenceId, dedupeCuts(cuts), caller, { song })
      }
    } catch (err) {
      await rm(copied, { force: true }).catch(() => {})
      throw err
    }
    this.setError(sequenceId, undefined)
    this.prepare(sequenceId, { separate, lyrics, targetSeconds: opts.targetSeconds ?? songTargetSeconds(sequenceId) })
    this.announce(sequenceId)
    return this.deps.sequences.get(sequenceId)
  }

  /**
   * The background work after a song came in: separate, transcribe, analyse, and split it into clips while its places
   * haven't been chosen (a new sequence has no clips).
   */
  private prepare(sequenceId: string, plan: { separate: boolean; lyrics?: LyricsPlan; targetSeconds: number }): void {
    this.setError(sequenceId, undefined)
    const first = plan.separate ? 'separating' : plan.lyrics ? 'transcribing' : 'analysing'
    void this.enqueue(sequenceId, first, async () => {
      if (plan.separate) await this.step(sequenceId, 'separating', (report) => this.separateNow(sequenceId, report))
      if (plan.lyrics) {
        const lyrics = plan.lyrics
        await this.stepThenParts(sequenceId, 'transcribing', () => this.transcribeNow(sequenceId, lyrics))
      }
      await this.stepThenParts(sequenceId, 'analysing', (report) => this.analyseNow(sequenceId, report))
      await this.step(sequenceId, 'splitting', () => this.splitNow(sequenceId, plan.targetSeconds))
    })
  }

  // ── Steps ──────────────────────────────────────────────────────────────────

  /** Separates the song's vocals into Audio/<name> (vocals).flac (replacing vocals made before, which go to the Trash). */
  private async separateNow(sequenceId: string, report: (fraction: number) => void): Promise<void> {
    const song = this.requireSong(sequenceId)
    const release = this.deps.sequences.holdSongFolder(sequenceId)
    const dir = await mkdtemp(join(tmpDir(), 'song-'))
    try {
      const voice = join(dir, 'voice.flac')
      await separateStems(song.path, { voice, background: join(dir, 'background.flac') }, { onProgress: report })
      const now = store.sequenceSong(sequenceId)
      // Replaced or taken off meanwhile: these vocals belong to no song any more.
      if (!now || now.path !== song.path) return
      const placed = await this.deps.sequences.placeSongFile(sequenceId, voice, vocalsFileName(song.path), { move: true })
      const latest = store.sequenceSong(sequenceId)
      if (!latest || latest.path !== song.path) {
        await rm(placed, { force: true })
        return
      }
      store.writeSequenceSong(sequenceId, { ...latest, vocalsPath: placed })
      // Vocals made before are Studio's own: they go to the Trash once the new ones are recorded.
      const old = latest.vocalsPath
      if (old && old !== placed && existsSync(old) && isInsideRoot(old) && !db.isStoredPathRecorded(toStoredPath(old))) {
        await shell.trashItem(old).catch((err: unknown) => console.warn('Could not move the old vocals to the Trash:', err))
      }
      this.announce(sequenceId)
    } finally {
      release()
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Transcribes the song (paid, once: never retried) from its vocals when there are any, else the whole song, and
   * makes the lines (shared/song.ts lyricLines); the lyrics there were are replaced.
   */
  private async transcribeNow(sequenceId: string, plan: LyricsPlan): Promise<void> {
    const song = this.requireSong(sequenceId)
    const source = song.vocalsPath && existsSync(song.vocalsPath) ? song.vocalsPath : song.path
    const dir = await mkdtemp(join(tmpDir(), 'song-'))
    try {
      const sent = join(dir, 'song.mp3')
      const release = this.deps.sequences.holdSongFolder(sequenceId)
      try {
        await extractAudio(source, sent, { rate: 16000, channels: 1, codec: 'mp3', bitrate: '64k' })
      } finally {
        release()
      }
      if ((await stat(sent)).size > ASR_MAX_BYTES) {
        throw new Error('The song is too long to transcribe in one go (at most ~24 MB of sound).')
      }
      const out = await this.deps.audio.transcribe({
        model: plan.model,
        file: await readFile(sent),
        filename: 'song.mp3',
        ...(plan.language ? { language: plan.language } : {})
      })
      // Paid now, whatever happens next.
      recordTranscription(sequenceId, plan)
      const now = store.sequenceSong(sequenceId)
      if (!now || now.path !== song.path) return
      const at = Date.now()
      const lyrics: SongLyrics = {
        lines: lyricLines(out),
        model: plan.model,
        ...((out.language ?? plan.language) ? { language: out.language ?? plan.language } : {}),
        costUsd: plan.priceUsd,
        createdAt: at,
        updatedAt: at
      }
      store.writeSequenceSong(sequenceId, { ...now, lyrics })
      this.announce(sequenceId)
      if (!lyrics.lines.length) throw new SongNotice('No sung words were heard in the song.')
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Finds the song's beat, bars and where its vocals are sung (cached by the files). */
  private async analyseNow(sequenceId: string, report: (fraction: number) => void): Promise<void> {
    const song = this.requireSong(sequenceId)
    const release = this.deps.sequences.holdSongFolder(sequenceId)
    try {
      await analyseSong(song, { onProgress: report })
    } finally {
      release()
    }
  }

  /**
   * Splits the song into clips of about `targetSeconds` by its analysis and lyrics (without an analysis, by the lyrics
   * and lengths alone) – only while its places haven't been chosen: no clips yet, one empty clip (the whole song), or
   * empty clips Studio placed itself (a song put on them). Places chosen meanwhile, or anything put in a clip, stay as
   * they are.
   */
  private async splitNow(sequenceId: string, targetSeconds: number): Promise<void> {
    const rows = store.listSegmentRows(sequenceId)
    const placedByStudio = rows.length <= 1 || this.autoPlaced.has(sequenceId)
    this.autoPlaced.delete(sequenceId)
    if (!placedByStudio || rows.some((r) => !store.isUntouchedSegment(r))) return
    const song = this.requireSong(sequenceId)
    const cuts = suggestedCuts(song, targetSeconds, await cachedSongAnalysis(song))
    await this.deps.sequences.setSongSections(sequenceId, cuts)
  }

  // ── The song's handlers ────────────────────────────────────────────────────

  /** Peaks, beats and bars (analysed now when they aren't cached). */
  async overview(sequenceId: string): Promise<SongOverview> {
    return overviewOf(await analyseSong(this.requireSongFile(sequenceId)))
  }

  /** The cut points the song suggests for places of about `targetSeconds` (shared/song.ts suggestSections). */
  async suggestSections(sequenceId: string, targetSeconds: unknown): Promise<number[]> {
    const song = this.requireSongFile(sequenceId)
    const target =
      typeof targetSeconds === 'number' && Number.isFinite(targetSeconds) ? targetSeconds : songTargetSeconds(sequenceId)
    return suggestedCuts(song, target, (await cachedSongAnalysis(song)) ?? (await analyseSong(song)))
  }

  /**
   * Transcribes the lyrics again (paid), replacing any there are: priced and checked against the budget now (OVER_BUDGET
   * unless confirmed), then done in the background; resolves at once with the sequence showing the work.
   */
  async transcribe(sequenceId: string, input: unknown): Promise<Sequence> {
    const song = this.requireSongFile(sequenceId)
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const plan = await this.lyricsPlan(song.duration, {
      ...(typeof o.model === 'string' && o.model ? { model: o.model } : {}),
      ...(typeof o.language === 'string' && o.language.trim() ? { language: o.language.trim() } : {})
    })
    assertWithinBudget(plan.priceUsd, { confirmed: o.confirmOverBudget === true })
    this.setError(sequenceId, undefined)
    void this.enqueue(sequenceId, 'transcribing', async () => {
      await this.stepThenParts(sequenceId, 'transcribing', () => this.transcribeNow(sequenceId, plan))
    })
    this.announce(sequenceId)
    return this.deps.sequences.get(sequenceId)
  }

  /**
   * Corrects line `lineIndex` (0-based) of the lyrics: its words keep their times when there are as many, else share
   * the line's span (retimeLine). An empty text removes the line (words the transcription heard in the music).
   */
  editLyricLine(sequenceId: string, lineIndex: unknown, text: unknown): Sequence {
    const song = this.requireSong(sequenceId)
    const lyrics = song.lyrics
    if (!lyrics) throw new Error('The song has no lyrics yet. Transcribe them first.')
    const lines = [...lyrics.lines]
    if (typeof lineIndex !== 'number' || !Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error(`There is no such line: the lyrics have ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}.`)
    }
    const clean = typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : ''
    if (clean) lines[lineIndex] = retimeLine(lines[lineIndex], clean)
    else lines.splice(lineIndex, 1)
    store.writeSequenceSong(sequenceId, { ...song, lyrics: { ...lyrics, lines, updatedAt: Date.now() } })
    this.announce(sequenceId)
    return this.deps.sequences.get(sequenceId)
  }

  /** Separates the vocals (again), then analyses the song with them; resolves at once. */
  async separate(sequenceId: string): Promise<Sequence> {
    this.requireSongFile(sequenceId)
    const status = await separationStatus()
    if (!status.available) throw new Error(status.message ?? "Voice separation isn't available on this Mac.")
    this.setError(sequenceId, undefined)
    void this.enqueue(sequenceId, 'separating', async () => {
      if (await this.step(sequenceId, 'separating', (report) => this.separateNow(sequenceId, report))) {
        await this.stepThenParts(sequenceId, 'analysing', (report) => this.analyseNow(sequenceId, report))
      }
    })
    this.announce(sequenceId)
    return this.deps.sequences.get(sequenceId)
  }

  /** The clips' places as someone chose them (the window or an agent): Studio's own split no longer moves them. */
  setSections(sequenceId: string, boundaries: unknown, caller: { byAgent?: boolean } = {}): Promise<Sequence> {
    this.autoPlaced.delete(sequenceId)
    return this.deps.sequences.setSongSections(sequenceId, boundaries, caller)
  }

  /** What decides a clip's default part right now (see redecideSongParts): the lyrics, and where the vocals sing. */
  private async partInputs(sequenceId: string): Promise<Parameters<SequenceService['redecideSongParts']>[1]> {
    const song = store.sequenceSong(sequenceId)
    const analysis = song ? await cachedSongAnalysis(song) : undefined
    return { lyrics: song?.lyrics, ...(analysis?.fromVocals ? { vocalActivity: analysis.vocalActivity } : {}) }
  }

  /**
   * Runs a step that may tell the song where it is sung (the lyrics, the separated vocals' analysis): afterwards the
   * empty clips whose part Studio decided hear what their places now suggest. False when the step failed.
   */
  private async stepThenParts(
    sequenceId: string,
    stage: SongWork['stage'],
    run: (report: (fraction: number) => void) => Promise<void>
  ): Promise<boolean> {
    const before = await this.partInputs(sequenceId)
    if (!(await this.step(sequenceId, stage, run))) return false
    await this.deps.sequences
      .redecideSongParts(sequenceId, before)
      .catch((err: unknown) => console.warn('Deciding what the song clips hear failed:', err))
    return true
  }

  /** Resolves once the song work queued for the sequence so far is done (tests and the agents' tools). */
  whenSettled(sequenceId: string): Promise<void> {
    return this.queues.get(sequenceId) ?? Promise.resolve()
  }
}

/** The cut points shared/song.ts suggests for the song, from its analysis when there is one. */
function suggestedCuts(
  song: SequenceSong,
  targetSeconds: number,
  analysis: Awaited<ReturnType<typeof cachedSongAnalysis>>
): number[] {
  return suggestSections({
    duration: song.duration,
    beats: analysis?.beats ?? [],
    bars: analysis?.bars,
    lyrics: song.lyrics,
    vocalPauses: analysis?.vocalPauses,
    targetSeconds
  })
}

/** Cut points ascending, at least 2 s apart (the later one of two too close goes). */
function dedupeCuts(cuts: readonly number[]): number[] {
  const out: number[] = []
  for (const t of [...cuts].sort((a, b) => a - b)) {
    if (t - (out[out.length - 1] ?? 0) >= MIN_SONG_WINDOW_SECONDS) out.push(t)
  }
  return out
}

/**
 * Registers the songs:* handlers (all but songs:syncTake, song-sync.ts's) and returns the service. An agent hands over
 * only files it uploaded (or the library's own) and never starts a paid transcription itself: that goes through
 * request_song_lyrics, whose approval runs it.
 */
/**
 * The clip length a song is split into by default: the shot length of the sequence's director (Direction.shotSeconds,
 * within the 2–15 s a place may have), else DEFAULT_SONG_TARGET_SECONDS.
 */
function songTargetSeconds(sequenceId: string): number {
  const shot = libraryDirector(store.sequenceDirector(sequenceId))?.direction.shotSeconds
  return typeof shot === 'number'
    ? Math.min(MAX_SONG_WINDOW_SECONDS, Math.max(MIN_SONG_WINDOW_SECONDS, shot))
    : DEFAULT_SONG_TARGET_SECONDS
}

export function registerSongIpc(deps: SongDeps): SongService {
  const s = new SongService(deps)
  const sequence = (id: unknown): string => store.requirePlainSequence(id as string).id
  const paidByAgent = (e: IpcMainInvokeEvent, lyrics: unknown): void => {
    if (isAgentCall(e) && lyrics && !isConfirmedHere()) throw new Error(LYRICS_NEED_APPROVAL)
  }
  const lyricsOf = (opts: unknown): unknown => (opts && typeof opts === 'object' ? (opts as { lyrics?: unknown }).lyrics : undefined)

  ipcMain.handle('songs:createSequence', (e, path: unknown, opts?: unknown) => {
    assertAgentFiles(e, [path])
    paidByAgent(e, lyricsOf(opts))
    return s.createSequence(path, opts)
  })
  ipcMain.handle('songs:set', (e, sequenceId: unknown, path: unknown, opts?: unknown) => {
    if (path !== null) assertAgentFiles(e, [path])
    paidByAgent(e, lyricsOf(opts))
    return s.setSong(sequence(sequenceId), path, opts, { byAgent: isAgentCall(e) })
  })
  ipcMain.handle('songs:overview', (_e, sequenceId: unknown) => s.overview(sequence(sequenceId)))
  ipcMain.handle('songs:suggestSections', (_e, sequenceId: unknown, targetSeconds: unknown) =>
    s.suggestSections(sequence(sequenceId), targetSeconds)
  )
  ipcMain.handle('songs:setSections', (e, sequenceId: unknown, boundaries: unknown) =>
    s.setSections(sequence(sequenceId), boundaries, { byAgent: isAgentCall(e) })
  )
  ipcMain.handle('songs:quoteLyrics', (_e, sequenceId: unknown, model?: unknown) => s.quoteLyrics(sequence(sequenceId), model))
  ipcMain.handle('songs:transcribe', (e, sequenceId: unknown, opts?: unknown) => {
    if (isAgentCall(e) && !isConfirmedHere()) throw new Error(USER_ONLY)
    return s.transcribe(sequence(sequenceId), opts)
  })
  ipcMain.handle('songs:editLyricLine', (_e, sequenceId: unknown, lineIndex: unknown, text: unknown) =>
    s.editLyricLine(sequence(sequenceId), lineIndex, text)
  )
  ipcMain.handle('songs:separate', (_e, sequenceId: unknown) => s.separate(sequence(sequenceId)))
  return s
}
