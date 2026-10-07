// Sequences: ordered segments whose selected takes are cut together into one longer video.
// Each sequence has a folder in Sekvenser/ named after it: its takes live in Tagningar/ inside it, its stills
// (the storyboard's keyframes) in Storyboard/ and its exports next to those, so the folder is what the user sees
// of the sequence in Finder.

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { ipcMain, shell } from 'electron'
import {
  audioForModel,
  DEFAULT_PARAMS,
  endImageVariant,
  imageToVideoVariant,
  kindOfModelId,
  paramsForSubmit,
  pickOption,
  PREFERRED,
  supportsAudioInput,
  supportsEndImage
} from '@shared/models'
import {
  blockingContinuationError,
  blockingPromptError,
  findAudioTokens,
  findImageTokens
} from '@shared/prompt-refs'
import type {
  ExportProgress,
  Generation,
  GenerationParams,
  SegmentFramePreview,
  SegmentImageSlot,
  SegmentImageSource,
  SegmentInit,
  SegmentPatch,
  Sequence,
  SequenceSummary,
  Still,
  VideoModel
} from '@shared/types'
import { isAgentCall } from './agent/local-ipc'
import * as db from './db'
import { concatClips, extractFrame, extractFrameAtOrAfter, frameStartAtOrAfter, probe } from './ffmpeg'
import { prepareSubmission, toPublic, type JobManager } from './jobs'
import {
  FOLDERS,
  framesDir,
  fromStoredPath,
  generationsDayDir,
  isInsideRoot,
  libraryOperationSettled,
  movePath,
  referencesDayDir,
  removeDayFolderIfEmpty,
  renameLibraryFolder,
  safeName,
  sequenceDir,
  sequenceTakesDir,
  tmpDir,
  toStoredPath
} from './paths'
import { placeFile } from './references'
import { buildConcatClips, missingTakesMessage, reserveExportPath } from './sequence-export'
import * as store from './sequence-store'
import { ensureImagesExist, type VeniceClient } from './venice'

/**
 * What the sequence service needs from the stills service (stills.ts) to put images into keyframe slots. Both
 * create a still of the sequence (or hand back the one an identical earlier call made), so the image is in its
 * Storyboard folder and its stills strip from then on; they announce the new still themselves.
 */
export interface StillsAccess {
  /** Copies an image file from outside Studio into the sequence's Storyboard folder as a still ('upload'). */
  importFile(path: string, sequenceId: string): Promise<Still>
  /** Saves the frame of a take at `time` seconds as a still of the sequence ('frame'). */
  saveFrame(generationId: string, time: number, sequenceId?: string): Promise<Still>
}

interface Deps {
  jobs: JobManager
  venice: VeniceClient
  notify: (sequenceId: string) => void
  exportProgress: (p: ExportProgress) => void
  /**
   * The video model list (cached in main): which end-capable sibling of a model Venice offers, and the options
   * (duration, resolution …) a clip switched to it keeps. Without it the switch goes by the model ids alone.
   */
  models?: () => Promise<VideoModel[]>
  /** Puts uploaded files and frames into a sequence's stills (setSegmentImage, bridgeSegment). */
  stills?: StillsAccess
  /** The stills of a sequence were moved, kept or removed (undefined: possibly any sequence's). */
  stillsChanged?: (sequenceId?: string) => void
}

interface SequencePatch {
  name?: string
  defaults?: Partial<GenerationParams>
}

/**
 * What a take the user approved through an agent may be: called with the clip right before its take is sent, on the
 * very database state the take is built from, so nothing written afterwards can change what is paid for.
 * Returns why it must not be sent (Swedish), or undefined. Only the agent connection passes one, in this
 * process (a window's IPC call can't carry a function).
 */
export type SubmitGuard = (segmentId: string) => string | undefined

function asGuard(value: unknown): SubmitGuard | undefined {
  return typeof value === 'function' ? (value as SubmitGuard) : undefined
}

/** Who asked for a change to the clips. */
interface Caller {
  /** An agent's tool call (see isAgentCall), not the user in a window. */
  byAgent?: boolean
}

/** State of one "generate all" run. A new run gets a new object, so a superseded loop can tell. */
interface Run {
  running: boolean
  stopped: boolean
  error?: string
  /** Set for a run the user approved through an agent: it pays only for the clips they were shown. */
  guard?: SubmitGuard
}

/** Thrown inside a run when the user pressed stop before the next take was submitted. */
class RunStopped extends Error {}

/** How often a run re-checks a take it is waiting for (stop pressed, take deleted). */
const WATCH_INTERVAL_MS = 3000

/** Attempts at moving a file when another writer takes its new name between the check and the move. */
const PLACE_ATTEMPTS = 3

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** movePath refused because the destination exists (or another move is heading there right now). */
function nameTaken(err: unknown, to: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'EEXIST' || existsSync(to)
}

/**
 * Moves `from` to the path `pick` returns (a free name, checked before the move). When another writer takes
 * that name between the check and the move, picks again. Never overwrites; resolves the new path.
 */
async function moveToFreeName(from: string, pick: () => string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const to = pick()
    try {
      await movePath(from, to)
      return to
    } catch (err) {
      if (attempt < PLACE_ATTEMPTS && existsSync(from) && nameTaken(err, to)) continue
      throw err
    }
  }
}

/** How a clip takes its frames from its neighbours, as its position allows. */
interface ClipLinks {
  /** Starts on the previous clip's last frame (continue_from_previous, never the first clip). */
  continuing: boolean
  /** Ends on the next clip's first frame (end_from_next, never the last clip). */
  ending: boolean
}

function linksOf(rows: readonly store.SegmentRow[], index: number): ClipLinks {
  const row = rows[index]
  return {
    continuing: index > 0 && !!row?.continue_from_previous,
    ending: index >= 0 && index < rows.length - 1 && !!row?.end_from_next
  }
}

/**
 * The params a take of the clip is sent with. A clip that takes a frame from a neighbour always generates
 * with the image-to-video sibling of its model, which takes no reference audio; that frame is only filled in
 * when the take is generated (until then the slot is empty, not a stale image of its own).
 */
function takeParams(row: store.SegmentRow, links: ClipLinks): GenerationParams {
  const params = store.parseParams(row.params)
  if (!links.continuing && !links.ending) return params
  return {
    ...params,
    model: imageToVideoVariant(params.model),
    referenceAudios: undefined,
    ...(links.continuing ? { startImage: undefined } : {}),
    ...(links.ending ? { endImage: undefined } : {})
  }
}

/** The clip would be sent with an end image (its own or the next clip's frame) that its model can't take. */
function endImageProblem(params: GenerationParams, links: ClipLinks): string | undefined {
  if (supportsEndImage(params.model)) return undefined
  if (links.ending) {
    return (
      `Modellen ${params.model} kan inte ta en slutbild. Välj en bild-till-video-modell som kan det ` +
      '(till exempel Seedance), eller slå av ”Slutbild från nästa klipp”.'
    )
  }
  if (params.endImage && kindOfModelId(params.model) === 'image-to-video') {
    return `Modellen ${params.model} kan inte ta en slutbild. Välj en modell som kan det, eller ta bort slutbilden.`
  }
  return undefined
}

/**
 * Why a take of the clip can't be sent as it stands (Swedish), or undefined when it can. Checked before
 * "generate all" pays for anything and again right before each take is sent; JobManager.submit checks the
 * prompt's references once more on what actually goes to Venice, and measures the audio clips (whose windows
 * this checks only as far as the clip states them). Whether the neighbours have the takes its frames come
 * from is checked where the frames are taken.
 */
function clipProblem(params: GenerationParams, links: ClipLinks): string | undefined {
  const kind = kindOfModelId(params.model)
  if (!params.prompt.trim()) return 'Skriv en prompt för klippet först.'
  // Before the prompt's references: an end image the model can't take is a keyframe the user would pay to lose.
  const end = endImageProblem(params, links)
  if (end) return end
  // The general message advises switching to reference mode, which a continuation can't do.
  if (links.continuing) return blockingContinuationError(params)
  if (kind === 'reference-to-video' && !params.referenceImages?.length) {
    // Venice refuses reference audio without a picture, so a clip with only a voice needs one too.
    return params.referenceAudios?.length && supportsAudioInput(params.model)
      ? 'Lägg till minst en referensbild för klippet – ljudklipp skickas bara tillsammans med en bild.'
      : 'Lägg till minst en referensbild för klippet.'
  }
  if (kind === 'image-to-video' && !params.startImage) {
    return 'Lägg till en startbild för klippet, eller låt det fortsätta från föregående klipp.'
  }
  return blockingPromptError(params)
}

/** The word in front of an @AudioN inside a reference's brackets ("voice @Audio1", "röst @Audio1"). */
const AUDIO_WORD_BEFORE = /(^|[(,][ \t]*)(?:voice|sound|röst|ljud)[ \t]+$/iu

/**
 * A line that explains tokens rather than the shot: "@Image1 – Anna, the woman: identity …",
 * "- @Image2, @Image3: the room".
 */
const LEGEND_LINE =
  /^\s*(?:[-*•]\s+)?@(?:image|audio)\d+(?:\s*(?:,|&|and|och)\s*@(?:image|audio)\d+)*\s*(?:[–—:=]|-(?!\w))/iu

/** A heading of its own line, like "REFERENCES:" or "Referenser:". */
const HEADING_LINE = /^\s*[^\s:][^:]{0,38}:\s*$/u

/** One line without its tokens; labels and brackets left empty go with them. */
function stripLineTokens(line: string): string {
  const tokens = [...findImageTokens(line), ...findAudioTokens(line)].sort((a, b) => a.start - b.start)
  if (!tokens.length) return line
  let out = ''
  let last = 0
  for (const t of tokens) {
    const head = line.slice(last, t.start)
    // "röst @Audio1" inside a reference's brackets is a label, not running text: the word goes with the token.
    out += /^@audio/i.test(t.raw) ? head.replace(AUDIO_WORD_BEFORE, '$1') : head
    last = t.end
  }
  out += line.slice(last)
  // The line keeps its own indentation; what a token at its start leaves in front goes.
  const indent = /^[ \t]*/.exec(line)![0]
  return (
    indent +
    out
      // Brackets that held only tokens: "Anna ( , )" → "Anna".
      .replace(/[ \t]*\((?:[\s,;&]|och|and)*\)/giu, '')
      // Separators left at the edges of brackets: "(, x" → "(x", "x ,)" → "x)".
      .replace(/\(\s*[,;]\s*/g, '(')
      .replace(/\s*[,;]\s*\)/g, ')')
      .replace(/[ \t]+([,.;:!?])/g, '$1')
      .replace(/([,;])(?:\s*[,;])+/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/^[ \t,;]+/, '')
      .replace(/[ \t]+$/, '')
  )
}

/**
 * The text without its @ImageN / @AudioN tokens, for a clip that becomes image-to-video and so sends no
 * references: "Anna (@Image1, röst @Audio1) wearing Red dress (@Image3) walks" → "Anna wearing Red dress walks".
 * Lines that only explain tokens ("@Image1 – Anna, the woman …") go, and so does a heading ("REFERENCES:") whose
 * lines all went. The names stay, so the prompt still says who is who; the look comes from the keyframes.
 */
export function withoutReferenceTokens(text: string): string {
  if (!findImageTokens(text).length && !findAudioTokens(text).length) return text
  const lines = text.split('\n')
  const kept: (string | null)[] = lines.map((line) => (LEGEND_LINE.test(line) ? null : stripLineTokens(line)))
  for (let i = 0; i < lines.length; i++) {
    if (kept[i] === null || !HEADING_LINE.test(lines[i])) continue
    // Its section runs to the next blank line or heading.
    let j = i + 1
    while (j < lines.length && lines[j].trim() && (kept[j] === null || !HEADING_LINE.test(lines[j]))) j++
    const block = kept.slice(i + 1, j)
    if (!block.length || block.some((l) => l !== null)) continue
    // The heading's whole section was token explanations: it goes too, with the blank line after it.
    kept[i] = null
    if (j < lines.length && !lines[j].trim()) kept[j] = null
  }
  return kept
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*\n/, '')
    .trimEnd()
}

/**
 * The clip's params once it is made from keyframes: generated image-to-video (by a model that takes an end
 * image when it has one), so its reference images and audio can't be sent: they are dropped, and their tokens
 * taken out of the prompts so it can be generated as it stands. Duration, resolution and aspect ratio are kept
 * where the new model offers them (the model list decides, when it can be had); the audio setting too.
 */
function asKeyframed(
  params: GenerationParams,
  needsEnd: boolean,
  models: readonly VideoModel[] | undefined
): GenerationParams {
  const ids = models?.map((m) => m.id)
  const model = needsEnd ? endImageVariant(params.model, ids) : imageToVideoVariant(params.model)
  const negative = params.negativePrompt === undefined ? undefined : withoutReferenceTokens(params.negativePrompt)
  const next: GenerationParams = {
    ...params,
    model,
    prompt: withoutReferenceTokens(params.prompt),
    negativePrompt: negative || undefined,
    referenceImages: undefined,
    referenceAudios: undefined
  }
  return model !== params.model ? fitToModel(next, models) : next
}

/**
 * Params just switched to another model, with the options that model offers (the list decides, when it could
 * be had): the same rule as the Generate form uses when the model changes, so a clip moved to another family
 * isn't sent with a duration or resolution its new model refuses. Unchanged without the list.
 */
function fitToModel(params: GenerationParams, models: readonly VideoModel[] | undefined): GenerationParams {
  const info = models?.find((m) => m.id === params.model)
  if (!info) return params
  return {
    ...params,
    duration: pickOption(info.durations, params.duration, PREFERRED.durations) ?? params.duration,
    resolution: pickOption(info.resolutions, params.resolution, PREFERRED.resolutions),
    aspectRatio: pickOption(info.aspectRatios, params.aspectRatio, PREFERRED.aspectRatios),
    audio: audioForModel(info, params.audio)
  }
}

/**
 * The clip's explicit start image when it is generated image-to-video (one in another mode is left-over form
 * state, never sent).
 */
function ownStartImage(params: GenerationParams): string | undefined {
  return kindOfModelId(params.model) === 'image-to-video' ? params.startImage : undefined
}

/** A keyframe source that is an image of its own rather than a neighbour's frame. */
type ExplicitImage = Exclude<SegmentImageSource, { kind: 'previous' } | { kind: 'next' }>

function isExplicitImage(source: SegmentImageSource | null | undefined): source is ExplicitImage {
  return !!source && source.kind !== 'previous' && source.kind !== 'next'
}

/**
 * A picture path held across an await, carried along the stored-path rewrites made since `mark` (a sequence folder
 * renamed while the model list was fetched, say), so a clip is never written pointing where the file was. With
 * `slot`, a picture that is gone even so is refused (Swedish) rather than written.
 */
function followImage(path: string, mark: number, slot?: SegmentImageSlot): string {
  const followed = db.followRewrites({ model: '', prompt: '', duration: '', startImage: path }, mark).startImage ?? path
  if (slot && !existsSync(followed)) throw new Error(`${slotName(slot)} finns inte längre: ${basename(followed)}.`)
  return followed
}

/** Image files a keyframe slot takes, as the file dialog offers them. */
const IMAGE_FILE = /\.(jpe?g|png|webp)$/i

/** How long bridging waits for the model list before it goes by the model ids alone. */
const MODELS_TIMEOUT_MS = 5000

/** "Startbilden"/"Slutbilden" for messages about a slot. */
const slotName = (slot: SegmentImageSlot): string => (slot === 'start' ? 'Startbilden' : 'Slutbilden')

/**
 * The order "generate all" makes the clips that lack a finished selected take: each one after the neighbours
 * whose frames it takes (a continuation after the previous clip, a clip ending on the next clip's first frame
 * after that clip), otherwise in the sequence's order; a chain of continuations runs forward, and a clip
 * between its neighbours waits for both. `order` holds clip indices. `stuck`: clips that can't be made in any
 * order, because two of them wait on each other (a clip that ends on the next clip, which in turn continues
 * from it, neither made yet) or on such a pair.
 */
export function generationOrder(rows: readonly store.SegmentRow[]): { order: number[]; stuck: number[] } {
  const ready = rows.map((r) => store.isUsable(store.selectedTake(r)))
  const waitsFor = (i: number): number[] => {
    const links = linksOf(rows, i)
    const deps: number[] = []
    if (links.continuing && !ready[i - 1]) deps.push(i - 1)
    if (links.ending && !ready[i + 1]) deps.push(i + 1)
    return deps
  }
  const missing = rows.flatMap((_, i) => (ready[i] ? [] : [i]))
  const planned = new Set<number>()
  const order: number[] = []
  // Each round takes the first clip (in sequence order) that has nothing left to wait for.
  for (;;) {
    const next = missing.find((i) => !planned.has(i) && waitsFor(i).every((d) => planned.has(d)))
    if (next === undefined) break
    planned.add(next)
    order.push(next)
  }
  return { order, stuck: missing.filter((i) => !planned.has(i)) }
}

/**
 * Why the stuck clips (generationOrder) can't be made, in Swedish: the first pair that waits on each other,
 * and what can be switched off to break it.
 */
function waitingMessage(rows: readonly store.SegmentRow[], stuck: readonly number[]): string {
  const pair = stuck.find((i) => stuck.includes(i + 1) && linksOf(rows, i).ending && linksOf(rows, i + 1).continuing)
  if (pair === undefined) return 'Klippen väntar på varandras tagningar och kan inte genereras i någon ordning.'
  const a = pair + 1
  const b = pair + 2
  return (
    `Klipp ${a} och ${b} väntar på varandra: klipp ${a} ska sluta på första bildrutan i klipp ${b}, som ska ` +
    `börja på sista bildrutan i klipp ${a}, och inget av dem har en tagning än. Slå av ` +
    `”Slutbild från nästa klipp” för klipp ${a} eller ”Fortsätt från föregående klipp” för klipp ${b}.`
  )
}

/** A clip "generate all" would pay for. */
export interface MissingClip {
  segmentId: string
  /** 1-based position in the sequence, as shown to the user ("Klipp 3"). */
  clip: number
  /**
   * What its take would be sent with; the start frame of a continuation and the end frame of a clip ending on
   * the next one are only extracted when its turn comes.
   */
  params: GenerationParams
  /** Why it can't be generated as it stands (Swedish), e.g. a prompt naming a picture that isn't there. */
  problem?: string
  /** It and another clip wait on each other's takes (see generationOrder); `problem` names both clips. */
  waiting?: boolean
}

/**
 * A missing clip's problem as one line for a run's error or an agent ("Klipp 3: Skriv en prompt …"); the
 * message about two clips waiting on each other names its clips itself.
 */
export function missingClipProblem(clip: MissingClip): string | undefined {
  if (!clip.problem) return undefined
  return clip.waiting ? clip.problem : `Klipp ${clip.clip}: ${clip.problem}`
}

export class SequenceService {
  private readonly runs = new Map<string, Run>()
  /** Runs whose loop hasn't returned yet; a stopped run's loop may still be finishing its current step. */
  private readonly loops = new Set<Run>()
  private readonly exports = new Map<string, AbortController>()
  /**
   * Takes on their way to Venice (frame grab, quote, image upload), by segment id. A take's row is only
   * written once Venice has accepted the job, which can take seconds with several reference photos; until
   * then this is the only sign that the clip is already being paid for.
   */
  private readonly submitting = new Map<string, Promise<Generation>>()
  /**
   * File work (creating and renaming sequence folders, moving takes, placing exports) runs one task at a
   * time: each task picks free names and reads folder names from the database, so two interleaving could put
   * a file into a folder that is being renamed away, or give two sequences the same folder.
   */
  private fileQueue: Promise<void> = Promise.resolve()
  private fileTasks = 0
  /** Sequence name at which renaming the sequence's folder last failed, by sequence id. */
  private readonly folderSyncFailed = new Map<string, string>()

  private sql(): ReturnType<typeof db.getDb> {
    return db.getDb()
  }

  constructor(private readonly deps: Deps) {
    deps.jobs.on('settled', (g: db.StoredGeneration) => this.onSettled(g))
  }

  /** Why the library can't be switched or tidied up right now (Swedish), or undefined when it can. */
  isBusy(): string | undefined {
    if (this.exports.size) return 'En export pågår.'
    if (this.loops.size || [...this.runs.values()].some((r) => r.running)) return '”Generera saknade” pågår.'
    if (this.submitting.size) return 'En tagning skickas till Venice.'
    if (this.fileTasks) return 'Sekvensernas filer flyttas just nu.'
    return undefined
  }

  // ── Sequences ──────────────────────────────────────────────────────────────

  list(): SequenceSummary[] {
    return store.listSequenceSummaries()
  }

  get(id: string): Sequence {
    const run = this.runs.get(id)
    return store.loadSequence(id, { running: run?.running ?? false, error: run?.error })
  }

  /** Creates the sequence together with its folder, Sekvenser/<name>/Tagningar. */
  async create(name: string): Promise<Sequence> {
    const clean = store.cleanSequenceName(name)
    const id = await this.withFiles(async () => {
      const id = randomUUID()
      const now = Date.now()
      const folder = store.availableFolderName(store.folderBaseName(clean))
      try {
        sequenceTakesDir(folder)
      } catch (err) {
        throw new Error(`Kunde inte skapa mappen för sekvensen: ${errorText(err)}`)
      }
      const { model, duration, resolution, aspectRatio, audio } = DEFAULT_PARAMS
      try {
        this.sql()
          .prepare(
            'INSERT INTO sequences (id, name, defaults, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(
            id,
            clean,
            JSON.stringify(store.pickDefaults({ model, duration, resolution, aspectRatio, audio })),
            folder,
            now,
            now
          )
      } catch (err) {
        await store.removeFolderIfEmpty(folder)
        throw err
      }
      return id
    })
    return this.changed(id)
  }

  async update(id: string, patch: SequencePatch): Promise<Sequence> {
    const row = store.requireSequenceRow(id)
    const name = patch?.name !== undefined ? store.cleanSequenceName(patch.name) : row.name
    const defaults = patch?.defaults
      ? { ...store.parseDefaults(row.defaults), ...store.pickDefaults(patch.defaults) }
      : store.parseDefaults(row.defaults)
    this.sql()
      .prepare('UPDATE sequences SET name = ?, defaults = ?, updated_at = ? WHERE id = ?')
      .run(name, JSON.stringify(defaults), Date.now(), id)
    // The folder follows the name, now or once the takes on their way into it have landed.
    if (name !== row.name) await this.syncFolder(id, true)
    return this.changed(id, false)
  }

  /**
   * Deletes the sequence. Its takes become ordinary generations and their videos go back to Genereringar/;
   * exports are finished films, so they and the folder holding them stay. Its stills go to the Trash, except
   * those that generations or clips elsewhere still use (the released takes were made from them, say): they
   * move to Referensbilder/ and stay listed among all stills. Only empty folders are removed.
   */
  async delete(id: string): Promise<void> {
    if (!store.getSequenceRow(id)) return
    this.stopGenerateAll(id, false)
    this.runs.delete(id)
    this.folderSyncFailed.delete(id)
    this.exports.get(id)?.abort()
    const { takeIds: freed, moved } = await this.withFiles(async () => {
      const row = store.getSequenceRow(id)
      if (!row) return { takeIds: [], moved: false }
      const takeIds = store.takeIdsForSegments(store.listSegmentRows(id).map((s) => s.id))
      // Before the rows go: once the FK has nulled segment_id, nothing says these videos were takes here.
      await this.releaseTakes(takeIds)
      // Read in the same step as the delete, after the moves above: still work isn't queued behind this, so a still
      // recorded for the sequence meanwhile (a frame saved, a picture placed) is released with the others.
      const stills = store.listStillRows(id)
      // Segments cascade; takes get segment_id nulled, exports and stills sequence_id nulled by their FKs.
      this.sql().prepare('DELETE FROM sequences WHERE id = ?').run(id)
      // Once its clips are gone, only uses elsewhere count.
      const kept = await this.releaseStills(stills)
      if (row.folder && !store.folderInUse(row.folder)) await store.removeFolderIfEmpty(row.folder)
      return { takeIds, moved: kept }
    })
    this.announceGenerations(freed)
    this.deps.notify(id)
    // Stills that other sequences' clips use moved to Referensbilder, and those clips' paths with them.
    if (moved) this.announceRewrites()
    // Its stills are gone, or listed without a sequence now.
    this.deps.stillsChanged?.(undefined)
  }

  /**
   * Stored paths were rewritten below a folder other rows may point into (a still kept in Referensbilder, a sequence
   * folder renamed): every sequence refetches, since a clip editor open on another sequence would otherwise save
   * the old path back with its next edit; generations and stills whose paths changed are sent again too.
   */
  private announceRewrites(more: readonly string[] = []): void {
    for (const id of this.sql().prepare('SELECT id FROM sequences').pluck().all() as string[]) this.deps.notify(id)
    this.announceGenerations([...new Set([...more, ...db.takeRewrittenGenerations()])])
    if (db.takeRewrittenStills()) this.deps.stillsChanged?.(undefined)
  }

  /**
   * The stills of a deleted sequence: one that a generation, a clip or another still still uses moves to
   * Referensbilder/<today>/ (every row using it follows); the rest go to the Trash with their rows (deleted outright
   * on a volume without one, as stills' own delete does). Best effort per still: what can't be moved stays where
   * it is, with its row (so "Städa upp" finds it). Resolves whether any still was moved (stored paths rewritten).
   * Only in withFiles.
   */
  private async releaseStills(stills: store.StillRow[]): Promise<boolean> {
    // Unused ones go first, round after round: a still only another unused still of the sequence was made
    // from (as its reference image) is unused too once that one is gone.
    let remaining = stills
    const unused: store.StillRow[] = []
    for (let changed = true; changed; ) {
      changed = false
      for (const still of remaining) {
        if (db.isStoredPathRecorded(still.file_path, { ignoreStillId: still.id })) continue
        this.sql().prepare('DELETE FROM stills WHERE id = ?').run(still.id)
        unused.push(still)
        changed = true
      }
      remaining = remaining.filter((s) => !unused.includes(s))
    }
    let moved = false
    for (const still of remaining) {
      const path = fromStoredPath(still.file_path)
      if (!isInsideRoot(path) || !existsSync(path)) continue
      await this.keepStill(path).then(
        (kept) => {
          moved ||= kept
        },
        (err: unknown) => console.warn(`Could not keep the still ${path}:`, err)
      )
    }
    for (const still of unused) {
      const path = fromStoredPath(still.file_path)
      // Only the library's own copies: a path outside it is somebody else's file.
      if (!isInsideRoot(path) || !existsSync(path)) continue
      // Its row is gone already: a file left behind would be listed nowhere, and keep the folder from going.
      await shell
        .trashItem(path)
        .catch(() => rm(path, { force: true }))
        .catch((err: unknown) => console.warn(`Could not remove ${path}:`, err))
    }
    return moved
  }

  /**
   * Moves a still that is still used into Referensbilder/<today>/ and points every row at the new place. Resolves
   * whether it moved.
   */
  private async keepStill(path: string): Promise<boolean> {
    // Already where stills of no sequence live.
    if (toStoredPath(path).startsWith(`${FOLDERS.references}/`)) return false
    const ext = extname(path)
    const dest = await placeFile(
      path,
      referencesDayDir(new Date()),
      safeName(basename(path, ext), { fallback: 'Stillbild' }),
      ext.toLowerCase()
    )
    try {
      this.sql().transaction(() => db.rewriteStoredPrefix(toStoredPath(path), toStoredPath(dest)))()
    } catch (err) {
      // Put the file back so every stored path still points at it.
      await movePath(dest, path).catch((e: unknown) => console.warn(`Could not move ${dest} back to ${path}:`, e))
      throw err
    }
    return true
  }

  // ── Segments ───────────────────────────────────────────────────────────────

  /**
   * An agent may not change a sequence's clips while "Generera saknade" runs for it: the run reads the clips as
   * it goes, so a clip added or rewritten meanwhile would be paid for without the user having seen it. Checked here,
   * right before the write: the tool's own check comes before lookups that can take a while (the model list).
   */
  private refuseWhileRunning(sequenceId: string, caller: Caller): void {
    if (!caller.byAgent || !this.runs.get(sequenceId)?.running) return
    throw new Error(
      '”Generera saknade” pågår för sekvensen. Vänta tills körningen är klar (eller be användaren stoppa den) innan du ändrar klippen.'
    )
  }

  async addSegment(sequenceId: string, init: SegmentInit = {}, caller: Caller = {}): Promise<Sequence> {
    init = init ?? {}
    // Taking a frame from a neighbour may switch the model: the list says which sibling Venice offers and what
    // options it has. Fetched before the rows are read, so what is written below is built from what was read.
    const models = init.endFromNext || init.continueFromPrevious !== false ? await this.modelList() : undefined
    const sequence = store.requireSequenceRow(sequenceId)
    this.refuseWhileRunning(sequenceId, caller)
    const rows = store.listSegmentRows(sequenceId)

    let index = rows.length
    if (init.afterSegmentId) {
      const after = rows.findIndex((r) => r.id === init.afterSegmentId)
      if (after >= 0) index = after + 1
    }
    const previous = index > 0 ? rows[index - 1] : undefined

    const source = init.fromGenerationId ? db.getGeneration(init.fromGenerationId) : undefined
    if (init.fromGenerationId && !source) throw new Error('Tagningen finns inte längre.')

    let params: GenerationParams
    if (source) params = store.sanitizeParams(source.params)
    else if (init.params) params = store.sanitizeParams(init.params)
    // The previous clip's settings, but not what belongs to its shot: its prompt, and its keyframes (a new
    // storyboard panel starts with empty slots).
    else if (previous) {
      params = { ...store.parseParams(previous.params), prompt: '', startImage: undefined, endImage: undefined }
    }
    else params = store.sanitizeParams({ ...DEFAULT_PARAMS, ...store.parseDefaults(sequence.defaults) })

    const chosen = params.model
    const hasNext = index < rows.length
    if (init.endFromNext && !hasNext) {
      throw new Error('Ett klipp sist i sekvensen har inget nästa klipp att ta sin slutbild från.')
    }
    const ending = hasNext && !!init.endFromNext
    if (ending) {
      // The end frame comes from the next clip at generation time, with a model that can take one (and no
      // references, which image-to-video can't send).
      params = {
        ...params,
        model: endImageVariant(params.model, models?.map((m) => m.id)),
        endImage: undefined,
        referenceImages: undefined,
        referenceAudios: undefined
      }
    }

    const continuing = !!previous && (init.continueFromPrevious ?? !source)
    if (continuing) {
      // The start frame comes from the previous clip at generation time; image inputs would be stale. That
      // includes an end image copied from the previous clip: it is where that clip was meant to end. The
      // image-to-video model takes no reference audio either.
      params = {
        ...params,
        model: imageToVideoVariant(params.model),
        startImage: undefined,
        endImage: undefined,
        referenceImages: undefined,
        referenceAudios: undefined
      }
    }
    // A clip moved to another model gets the options that model offers.
    if (params.model !== chosen) params = fitToModel(params, models)

    const id = randomUUID()
    const adopt = source && !source.segmentId
    this.sql().transaction(() => {
      this.sql()
        .prepare(
          `INSERT INTO segments (id, sequence_id, position, params, continue_from_previous, end_from_next, notes,
             selected_generation_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          sequenceId,
          index,
          store.serializeParams(params),
          continuing ? 1 : 0,
          ending ? 1 : 0,
          store.cleanNotes(init.notes),
          source?.id ?? null,
          Date.now()
        )
      const order = rows.map((r) => r.id)
      order.splice(index, 0, id)
      store.renumberSegments(order)
      if (adopt) db.updateGeneration(source.id, { segmentId: id })
    })()

    if (adopt) await this.adopt(source.id)
    return this.changed(sequenceId)
  }

  async updateSegment(segmentId: string, patch: SegmentPatch, caller: Caller = {}): Promise<Sequence> {
    patch = patch ?? {}
    // Turning a neighbour's frame on may switch the model (see below); fetched before the row is read, so the
    // write works on what was read.
    const models = patch.endFromNext || patch.continueFromPrevious ? await this.modelList() : undefined
    const row = store.requireSegmentRow(segmentId)
    this.refuseWhileRunning(row.sequence_id, caller)
    const rows = store.listSegmentRows(row.sequence_id)
    const index = rows.findIndex((r) => r.id === row.id)

    let continuing = !!row.continue_from_previous
    if (patch.continueFromPrevious !== undefined) {
      if (patch.continueFromPrevious && index === 0) {
        throw new Error('Det första klippet kan inte fortsätta från ett föregående klipp.')
      }
      continuing = !!patch.continueFromPrevious
    }
    let ending = !!row.end_from_next
    if (patch.endFromNext !== undefined) {
      if (patch.endFromNext && index === rows.length - 1) {
        throw new Error('Det sista klippet har inget nästa klipp att ta sin slutbild från.')
      }
      ending = !!patch.endFromNext
    }

    let params = patch.params ? store.sanitizeParams(patch.params) : store.parseParams(row.params)
    const chosen = params.model
    // A segment that takes a frame from a neighbour always generates with the image-to-video sibling; keep the
    // stored model honest.
    if (continuing || ending) params.model = imageToVideoVariant(params.model)
    // Switching "end from the next clip" on makes the clip a keyframed one, as an end slot that gets the next clip's
    // frame and "Gör om mellan grannarna" do (asKeyframed): a model that can take an end image, and no references,
    // which image-to-video can't send (their tokens leave the prompt, so it can be generated as it stands). Later
    // model choices are the user's own: one that can't take it is reported (clipProblem) rather than overruled.
    if (ending && !row.end_from_next) params = asKeyframed(params, true, models)
    // A clip moved to another model gets the options that model offers (when the list was fetched for a switch).
    if (params.model !== chosen) params = fitToModel(params, models)
    const notes = patch.notes !== undefined ? store.cleanNotes(patch.notes) : (row.notes ?? '')

    let selectedId = row.selected_generation_id
    let adoptId: string | undefined
    if (patch.selectedGenerationId === null) selectedId = null
    else if (patch.selectedGenerationId !== undefined) {
      const g = db.getGeneration(patch.selectedGenerationId)
      if (!g) throw new Error('Tagningen finns inte längre.')
      selectedId = g.id
      if (!g.segmentId) adoptId = g.id
    }

    const take = selectedId ? db.getGeneration(selectedId) : undefined
    // Another take selected: a side it was made to meet exactly starts untrimmed (see store.seamTrims).
    const kept =
      take && selectedId !== row.selected_generation_id
        ? store.seamTrims({ ...row, continue_from_previous: continuing ? 1 : 0, end_from_next: ending ? 1 : 0 }, take)
        : { trimStart: row.trim_start, trimEnd: row.trim_end }
    const editingStartOnly = patch.trimStart !== undefined && patch.trimEnd === undefined
    const { trimStart, trimEnd } = store.clampTrims(
      patch.trimStart ?? kept.trimStart,
      patch.trimEnd ?? kept.trimEnd,
      take && store.takeLength(take),
      editingStartOnly ? 'start' : 'end'
    )

    this.sql().transaction(() => {
      this.sql()
        .prepare(
          `UPDATE segments SET params = ?, continue_from_previous = ?, end_from_next = ?, notes = ?,
             selected_generation_id = ?, trim_start = ?, trim_end = ? WHERE id = ?`
        )
        .run(
          store.serializeParams(params),
          continuing ? 1 : 0,
          ending ? 1 : 0,
          notes,
          selectedId,
          trimStart,
          trimEnd,
          row.id
        )
      if (adoptId) db.updateGeneration(adoptId, { segmentId: row.id })
    })()

    if (adoptId) await this.adopt(adoptId)
    return this.changed(row.sequence_id)
  }

  /** Deletes the segment; its takes become ordinary generations and their videos go back to Genereringar/. */
  async deleteSegment(segmentId: string, caller: Caller = {}): Promise<Sequence> {
    const row = store.requireSegmentRow(segmentId)
    this.refuseWhileRunning(row.sequence_id, caller)
    const freed = await this.withFiles(async () => {
      if (!store.getSegmentRow(row.id)) return []
      // The file queue may have kept this waiting; a run may have started meanwhile.
      this.refuseWhileRunning(row.sequence_id, caller)
      const takeIds = store.takeIdsForSegments([row.id])
      await this.releaseTakes(takeIds)
      this.sql().transaction(() => {
        this.sql().prepare('DELETE FROM segments WHERE id = ?').run(row.id)
        store.renumberSegments(store.listSegmentRows(row.sequence_id).map((r) => r.id))
      })()
      return takeIds
    })
    this.announceGenerations(freed)
    return this.changed(row.sequence_id)
  }

  moveSegment(segmentId: string, toIndex: number, caller: Caller = {}): Sequence {
    const row = store.requireSegmentRow(segmentId)
    this.refuseWhileRunning(row.sequence_id, caller)
    const order = store
      .listSegmentRows(row.sequence_id)
      .map((r) => r.id)
      .filter((id) => id !== row.id)
    const target = Number.isFinite(toIndex) ? Math.min(Math.max(0, Math.round(toIndex)), order.length) : row.position
    order.splice(target, 0, row.id)
    this.sql().transaction(() => store.renumberSegments(order))()
    return this.changed(row.sequence_id)
  }

  // ── Keyframes ──────────────────────────────────────────────────────────────

  /**
   * Puts an image into the clip's start or end slot, or empties it (null). 'previous' / 'next' make the slot
   * automatic (continue_from_previous / end_from_next); any image makes the slot explicit. A slot that gets
   * something makes the clip a keyframed one (asKeyframed: image-to-video, references dropped).
   */
  async setSegmentImage(
    segmentId: string,
    slot: SegmentImageSlot,
    source: SegmentImageSource | null,
    caller: Caller = {}
  ): Promise<Sequence> {
    if (slot !== 'start' && slot !== 'end') throw new Error('Okänd bildplats: välj start- eller slutbild.')
    const before = store.requireSegmentRow(segmentId)
    this.refuseWhileRunning(before.sequence_id, caller)
    const kind = source ? source.kind : null
    if (kind === 'previous' && slot !== 'start') {
      throw new Error('Föregående klipps sista bildruta kan bara bli startbild.')
    }
    if (kind === 'next' && slot !== 'end') throw new Error('Nästa klipps första bildruta kan bara bli slutbild.')
    if (source && kind !== 'previous' && kind !== 'next') {
      if (!['file', 'asset-image', 'still', 'frame'].includes(kind as string)) throw new Error('Okänd sorts bild.')
    }
    // Checked before a file is copied or a frame saved: neither should happen for a slot that can't take it.
    this.checkAutomaticSlot(before, kind)

    // Renames from here on (the sequence's folder, an asset's) move the picture while it is held below.
    const mark = db.rewriteMark()
    // May copy a file or extract a frame (seconds); the row is read again afterwards.
    const picked = isExplicitImage(source) ? await this.slotImage(before, slot, source) : undefined
    const models = source ? await this.modelList() : undefined

    const row = store.requireSegmentRow(segmentId)
    this.refuseWhileRunning(row.sequence_id, caller)
    this.checkAutomaticSlot(row, kind)
    const image = picked && followImage(picked, mark, slot)
    let params = store.parseParams(row.params)
    let continuing = !!row.continue_from_previous
    let ending = !!row.end_from_next
    if (slot === 'start') {
      params.startImage = image
      continuing = kind === 'previous'
    } else {
      params.endImage = image
      ending = kind === 'next'
    }
    if (source) params = asKeyframed(params, ending || !!params.endImage, models)
    this.writeKeyframes(row.id, params, continuing, ending)
    return this.changed(row.sequence_id)
  }

  /** The automatic slot needs the neighbour it takes its frame from. */
  private checkAutomaticSlot(row: store.SegmentRow, kind: SegmentImageSource['kind'] | null): void {
    if (kind !== 'previous' && kind !== 'next') return
    const rows = store.listSegmentRows(row.sequence_id)
    const index = rows.findIndex((r) => r.id === row.id)
    if (kind === 'previous' && index <= 0) {
      throw new Error('Det första klippet har inget föregående klipp att ta sin startbild från.')
    }
    if (kind === 'next' && index >= rows.length - 1) {
      throw new Error('Det sista klippet har inget nästa klipp att ta sin slutbild från.')
    }
  }

  /**
   * The image file a slot gets for an explicit source: a library photo or a still as it is, a file or a frame
   * as a new still of the sequence.
   */
  private async slotImage(row: store.SegmentRow, slot: SegmentImageSlot, source: ExplicitImage): Promise<string> {
    let path: string | undefined
    switch (source.kind) {
      case 'asset-image': {
        const id = typeof source.imageId === 'string' ? source.imageId : ''
        const stored = this.sql().prepare('SELECT file_path FROM asset_images WHERE id = ?').pluck().get(id) as
          | string
          | undefined
        if (!stored) throw new Error('Bilden finns inte längre i biblioteket.')
        path = fromStoredPath(stored)
        break
      }
      case 'still': {
        const still = store.getStillRow(source.stillId)
        if (!still) throw new Error('Stillbilden finns inte längre.')
        path = fromStoredPath(still.file_path)
        break
      }
      case 'file': {
        if (typeof source.path !== 'string' || !source.path) throw new Error('Välj en bild.')
        if (!IMAGE_FILE.test(source.path)) throw new Error('Välj en bild i formatet JPG, PNG eller WebP.')
        if (!existsSync(source.path) || !statSync(source.path).isFile()) {
          throw new Error(`Bilden finns inte: ${basename(source.path)}.`)
        }
        path = (await this.requireStills().importFile(source.path, row.sequence_id)).path
        break
      }
      case 'frame': {
        if (typeof source.time !== 'number' || !Number.isFinite(source.time) || source.time < 0) {
          throw new Error('Ogiltig tidpunkt för bildrutan.')
        }
        if (typeof source.generationId !== 'string' || !db.getGeneration(source.generationId)) {
          throw new Error('Tagningen finns inte längre.')
        }
        path = (await this.requireStills().saveFrame(source.generationId, source.time, row.sequence_id)).path
        break
      }
    }
    if (!path || !existsSync(path)) {
      throw new Error(`${slotName(slot)} finns inte längre${path ? `: ${basename(path)}` : ''}.`)
    }
    return path
  }

  private requireStills(): StillsAccess {
    if (!this.deps.stills) throw new Error('Stillbilder kan inte sparas just nu.')
    return this.deps.stills
  }

  /** The video model list, or undefined when it can't be had in time (offline, say). Never rejects. */
  private async modelList(): Promise<VideoModel[] | undefined> {
    const load = this.deps.models
    if (!load) return undefined
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), MODELS_TIMEOUT_MS)
    })
    try {
      return await Promise.race([load().catch(() => undefined), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private writeKeyframes(segmentId: string, params: GenerationParams, continuing: boolean, ending: boolean): void {
    this.sql()
      .prepare('UPDATE segments SET params = ?, continue_from_previous = ?, end_from_next = ? WHERE id = ?')
      .run(store.serializeParams(params), continuing ? 1 : 0, ending ? 1 : 0, segmentId)
  }

  /**
   * "Gör om mellan grannarna": the clip starts on the previous clip's last frame and ends on the next clip's
   * first frame, with the end-capable image-to-video model of its family, so a new take fits between the
   * neighbours without touching them. The first clip, which has no previous clip, keeps its own start image,
   * or gets its current take's first shown frame (saved as a still); the last clip ends where it likes, or on
   * its own end image. Free: only the clip's settings change.
   */
  async bridgeSegment(segmentId: string, caller: Caller = {}): Promise<Sequence> {
    const before = store.requireSegmentRow(segmentId)
    this.refuseWhileRunning(before.sequence_id, caller)
    const beforeRows = store.listSegmentRows(before.sequence_id)
    const beforeIndex = beforeRows.findIndex((r) => r.id === before.id)
    if (beforeRows.length < 2) {
      throw new Error('Klippet har inga grannar att göras om mellan. Lägg till fler klipp i sekvensen först.')
    }
    // Renames from here on (the sequence's folder) move the opening frame while it is held below.
    const mark = db.rewriteMark()
    // The first clip keeps where it starts: its own keyframe, or the first frame its take shows now.
    let openingFrame: string | undefined
    const ownStart = ownStartImage(store.parseParams(before.params))
    if (beforeIndex === 0 && !(ownStart && existsSync(ownStart))) {
      const take = store.selectedTake(before)
      if (store.isUsable(take) && this.deps.stills) {
        try {
          // The first frame a clip trimmed there shows, as the export cuts (see frameStartAtOrAfter).
          const time = await frameStartAtOrAfter(take.filePath, before.trim_start)
          openingFrame = (await this.deps.stills.saveFrame(take.id, time, before.sequence_id)).path
        } catch (err) {
          // The preview then says the clip needs a start image; nothing is paid for without one.
          console.warn(`Could not keep the opening frame of segment ${before.id}:`, err)
        }
      }
    }
    const models = await this.modelList()

    // Read again after the awaits: the clip may have moved, and its neighbours with it.
    const row = store.requireSegmentRow(segmentId)
    this.refuseWhileRunning(row.sequence_id, caller)
    const rows = store.listSegmentRows(row.sequence_id)
    const index = rows.findIndex((r) => r.id === row.id)
    if (rows.length < 2) {
      throw new Error('Klippet har inga grannar att göras om mellan. Lägg till fler klipp i sekvensen först.')
    }
    const continuing = index > 0
    const ending = index < rows.length - 1
    const params = store.parseParams(row.params)
    const ownEnd = kindOfModelId(params.model) === 'image-to-video' ? params.endImage : undefined
    const followed = openingFrame && followImage(openingFrame, mark)
    // One that went missing even so is left out: the preview then says the clip needs a start image.
    const opening = followed && existsSync(followed) ? followed : undefined
    const keyframes: GenerationParams = {
      ...params,
      startImage: continuing ? undefined : (opening ?? ownStartImage(params)),
      endImage: ending ? undefined : ownEnd
    }
    this.writeKeyframes(row.id, asKeyframed(keyframes, ending || !!keyframes.endImage, models), continuing, ending)
    return this.changed(row.sequence_id)
  }

  /**
   * The start and end images the clip would be generated from right now: the neighbours' frames (extracted
   * and cached as for a take; free) or its own keyframes, and why it can't be generated as it stands.
   */
  async previewSegmentFrames(segmentId: string): Promise<SegmentFramePreview> {
    // A take that is being moved is briefly missing from its recorded path.
    await this.filesSettled()
    const row = store.requireSegmentRow(segmentId)
    const rows = store.listSegmentRows(row.sequence_id)
    const index = rows.findIndex((r) => r.id === row.id)
    const links = linksOf(rows, index)
    const params = takeParams(row, links)
    const problems: string[] = []
    const preview: SegmentFramePreview = { problems }
    const note = (problem: string | undefined): void => {
      if (problem && !problems.includes(problem)) problems.push(problem)
    }

    if (links.continuing) {
      const previous = rows[index - 1]
      if (!store.isUsable(store.selectedTake(previous))) note(`Klipp ${index} har ingen färdig vald tagning än.`)
      else {
        try {
          const frame = await this.lastFrameOf(previous, index)
          preview.start = { path: frame.path, source: 'previous', fromClip: index, time: frame.time }
        } catch (err) {
          note(`Startbilden kunde inte tas ut ur klipp ${index}: ${errorText(err)}`)
        }
      }
    } else if (ownStartImage(params)) {
      preview.start = { path: params.startImage!, source: 'image' }
      if (!existsSync(params.startImage!)) note(`Startbilden finns inte längre: ${basename(params.startImage!)}.`)
    }

    if (links.ending) {
      const next = rows[index + 1]
      if (!store.isUsable(store.selectedTake(next))) note(`Klipp ${index + 2} har ingen färdig vald tagning än.`)
      else {
        try {
          const frame = await this.firstFrameOf(next, index + 2)
          preview.end = { path: frame.path, source: 'next', fromClip: index + 2, time: frame.time }
        } catch (err) {
          note(`Slutbilden kunde inte tas ut ur klipp ${index + 2}: ${errorText(err)}`)
        }
      }
    } else if (params.endImage && kindOfModelId(params.model) === 'image-to-video') {
      preview.end = { path: params.endImage, source: 'image' }
      if (!existsSync(params.endImage)) note(`Slutbilden finns inte längre: ${basename(params.endImage)}.`)
    }

    // The frames stand in for the slots they fill when the clip's own settings are checked.
    const startImage = preview.start?.path ?? params.startImage
    note(clipProblem({ ...params, startImage, endImage: preview.end?.path ?? params.endImage }, links))
    return preview
  }

  /** Queues a new take from the segment editor's button (or an approval, with its guard). */
  generateSegment(segmentId: string, guard?: SubmitGuard): Promise<Generation> {
    // E.g. "generate all" is uploading this very clip; a second submit would pay for it twice.
    if (this.submitting.has(segmentId)) {
      return Promise.reject(
        new Error('En tagning för klippet skickas redan till Venice. Vänta tills den syns bland tagningarna.')
      )
    }
    return this.submit(segmentId, undefined, guard)
  }

  /** Starts a submit and records it in `submitting` until Venice has answered (or it failed). */
  private submit(segmentId: string, cancelled?: () => boolean, guard?: SubmitGuard): Promise<Generation> {
    const pending = this.submitTake(segmentId, cancelled, guard)
    this.submitting.set(segmentId, pending)
    const clear = (): void => {
      if (this.submitting.get(segmentId) === pending) this.submitting.delete(segmentId)
      // A folder rename waits while a take is on its way; this may have been the last one.
      try {
        this.requestFolderSync(store.getSegmentRow(segmentId)?.sequence_id)
      } catch (err) {
        console.warn('Could not check the sequence folder after a submit', err)
      }
    }
    pending.then(clear, clear)
    return pending
  }

  /**
   * Queues a new take. `cancelled` lets a "generate all" run bail out before money is spent
   * when the user pressed stop while the frame was being extracted or the price quoted. `guard`: see
   * SubmitGuard.
   */
  private async submitTake(segmentId: string, cancelled?: () => boolean, guard?: SubmitGuard): Promise<Generation> {
    // A take that is being moved is briefly missing from its recorded path; don't mistake that for a gap.
    await this.filesSettled()
    const row = store.requireSegmentRow(segmentId)
    const rows = store.listSegmentRows(row.sequence_id)
    const index = rows.findIndex((r) => r.id === row.id)
    const links = linksOf(rows, index)
    // Synchronously with the reads above: the take is built from exactly what the guard looked at.
    const refused = guard?.(row.id)
    if (refused) throw new Error(refused)

    const params = takeParams(row, links)
    // Before the frame grabs and the quote: a clip that can't be sent as it stands costs nothing to refuse.
    const problem = clipProblem(params, links)
    if (problem) throw new Error(problem)
    // Both neighbours are checked before either frame is extracted, so a missing take is reported at once.
    if (links.continuing) this.requireNeighbourTake(rows[index - 1], index)
    if (links.ending) this.requireNeighbourTake(rows[index + 1], index + 2)
    if (links.continuing) params.startImage = (await this.lastFrameOf(rows[index - 1], index)).path
    if (links.ending) params.endImage = (await this.firstFrameOf(rows[index + 1], index + 2)).path

    ensureImagesExist(paramsForSubmit(params))
    // Measures the voice clips before the quote: windows Venice would refuse cost nothing to refuse here.
    const p = await prepareSubmission(params)

    const quote = await this.deps.venice.quote(p).catch(() => undefined)
    if (cancelled?.()) throw new RunStopped()
    // Consent errors (NEEDS_CONSENT…) propagate unchanged so the renderer can ask and retry.
    const generation = await this.deps.jobs.submit(p, { quote, segmentId: row.id })
    this.useImportedCopies(row.id, p, generation.params)
    if (store.getSequenceRow(row.sequence_id)) {
      store.touchSequence(row.sequence_id)
      this.deps.notify(row.sequence_id)
    }
    return generation
  }

  /**
   * Pictures and audio clips from outside the library were copied into Referensbilder when the take was
   * submitted. The segment uses those copies from now on (each clip keeping the window the segment chose), so
   * it keeps working when the originals are moved or deleted.
   * Best effort: the take is already paid for, so nothing here may fail the submit.
   */
  private useImportedCopies(segmentId: string, sent: GenerationParams, stored: GenerationParams): void {
    try {
      const copies = new Map<string, string>()
      const pair = (from: string | undefined, to: string | undefined): void => {
        if (from && to && from !== to) copies.set(from, to)
      }
      pair(sent.startImage, stored.startImage)
      pair(sent.endImage, stored.endImage)
      sent.referenceImages?.forEach((r, i) => pair(r, stored.referenceImages?.[i]))
      sent.referenceAudios?.forEach((a, i) => pair(a.path, stored.referenceAudios?.[i]?.path))
      if (!copies.size) return
      const row = store.getSegmentRow(segmentId)
      if (!row) return
      const params = store.parseParams(row.params)
      const use = (path: string | undefined): string | undefined => (path && copies.get(path)) || path
      const next: GenerationParams = {
        ...params,
        startImage: use(params.startImage),
        endImage: use(params.endImage),
        referenceImages: params.referenceImages?.map((r) => copies.get(r) ?? r),
        referenceAudios: params.referenceAudios?.map((a) => ({ ...a, path: copies.get(a.path) ?? a.path }))
      }
      const json = store.serializeParams(next)
      if (json !== store.serializeParams(params)) {
        this.sql().prepare('UPDATE segments SET params = ? WHERE id = ?').run(json, segmentId)
      }
    } catch (err) {
      console.warn(`Could not point segment ${segmentId} at the library copies of its pictures:`, err)
    }
  }

  /** A neighbour a frame is taken from needs a finished selected take. */
  private requireNeighbourTake(neighbour: store.SegmentRow, number: number): Generation & { filePath: string } {
    const take = store.selectedTake(neighbour)
    if (!store.isUsable(take)) throw new Error(`Klipp ${number} behöver en färdig vald tagning först.`)
    return take
  }

  /**
   * The previous segment's selected take's last frame (or the frame where its end trim cuts), extracted once and
   * cached per take and timestamp in the library's hidden frame folder; `time` is where it is in that take.
   */
  private async lastFrameOf(
    previous: store.SegmentRow,
    previousNumber: number
  ): Promise<{ path: string; time?: number }> {
    const take = this.requireNeighbourTake(previous, previousNumber)
    let at: number | undefined
    let length = take.videoDuration
    if (previous.trim_end > 0) {
      length ??= (await probe(take.filePath)).duration
      // Computed exactly like the export's cut point (buildConcatClips), so both end on the same frame.
      at = Math.max(0, length - previous.trim_end)
    }
    // "v2": frames cached before extractFrame matched the export's trim could be one frame off. The renderer
    // reads the trailing "-<ms>" (continuationMismatch), so it must stay last.
    const name = `${take.id}-${at === undefined ? 'last' : `v2-${Math.round(at * 1000)}`}.png`
    const framePath = join(framesDir(), name)
    const time = at ?? length
    if (existsSync(framePath) && statSync(framePath).size > 0) return { path: framePath, time }
    return { path: await extractFrame(take.filePath, framePath, at), time }
  }

  /**
   * The next segment's selected take's first shown frame: the first one at or after its start trim, the frame
   * the export starts that clip on. Cached like lastFrameOf, as `<take id>-first-<ms>.png`, so another take or
   * start trim gets a frame of its own (the renderer's endMismatch reads that name).
   */
  private async firstFrameOf(next: store.SegmentRow, nextNumber: number): Promise<{ path: string; time: number }> {
    const take = this.requireNeighbourTake(next, nextNumber)
    const at = Math.max(0, next.trim_start)
    const framePath = join(framesDir(), `${take.id}-first-${Math.round(at * 1000)}.png`)
    if (existsSync(framePath) && statSync(framePath).size > 0) return { path: framePath, time: at }
    return { path: await extractFrameAtOrAfter(take.filePath, framePath, at), time: at }
  }

  // ── Take settling ──────────────────────────────────────────────────────────

  /** Selects a freshly completed take unless the segment already has a usable or pending one. */
  private autoSelect(row: store.SegmentRow, take: Generation): boolean {
    if (!store.isUsable(take)) return false
    const current = store.selectedTake(row)
    if (current?.id === take.id || store.isUsable(current) || store.isPending(current)) return false
    store.setSelectedTake(row, take)
    store.touchSequence(row.sequence_id)
    return true
  }

  private onSettled(settled: db.StoredGeneration): void {
    // Runs inside the JobManager's emit, so it must never throw.
    try {
      const g = db.getGeneration(settled.id)
      if (!g) return
      if (g.segmentId && g.status === 'completed') {
        const row = store.getSegmentRow(g.segmentId)
        if (row) this.autoSelect(row, g)
      }
      for (const id of this.sequencesShowing(g)) this.deps.notify(id)
      if (this.misplaced(g)) {
        void this.withFiles(() => this.tidyGeneration(g.id))
          .then((moved) => {
            if (moved) this.announceMoved([g.id])
          })
          .catch((err: unknown) => console.warn(`Could not move generation ${g.id} to its folder:`, err))
      }
      // A folder rename waits for takes on their way into the folder; this may have been the last one.
      if (g.segmentId) this.requestFolderSync(store.getSegmentRow(g.segmentId)?.sequence_id)
    } catch (err) {
      console.warn('Could not update sequence after generation settled', err)
    }
  }

  /** Its own sequence, plus any that picked it from the feed into one of their segments. */
  private sequencesShowing(g: Pick<Generation, 'id' | 'segmentId'>): string[] {
    return this.sql()
      .prepare('SELECT DISTINCT sequence_id FROM segments WHERE id = ? OR selected_generation_id = ?')
      .pluck()
      .all(g.segmentId ?? null, g.id) as string[]
  }

  /** Re-broadcasts generations whose segment link changed, so the feed's badges stay right. */
  private announceGenerations(ids: string[]): void {
    for (const id of ids) {
      const g = db.getGeneration(id)
      if (g) this.deps.jobs.emit('update', toPublic(g))
    }
  }

  /** After videos moved: the feed and every sequence showing them need the new paths. */
  private announceMoved(ids: string[]): void {
    this.announceGenerations(ids)
    const sequenceIds = new Set<string>()
    for (const id of ids) {
      const g = db.getGeneration(id)
      if (g) for (const s of this.sequencesShowing(g)) sequenceIds.add(s)
    }
    for (const id of sequenceIds) this.deps.notify(id)
  }

  // ── Folders and files ──────────────────────────────────────────────────────

  /**
   * Queues file work behind whatever file work is already running (see fileQueue), and behind a running
   * "Städa upp" or library switch: those read folder names once and move files by them, so a rename in
   * between would send takes into a folder that no longer belongs to the sequence.
   */
  private withFiles<T>(task: () => Promise<T>): Promise<T> {
    const run = this.fileQueue.then(async () => {
      await libraryOperationSettled()
      // Counted as busy only once it runs, so work waiting for a switch doesn't make the switch refuse itself.
      this.fileTasks++
      try {
        return await task()
      } finally {
        this.fileTasks--
      }
    })
    this.fileQueue = run.then(
      () => {},
      () => {}
    )
    return run
  }

  /** Resolves once the file work queued so far is done. */
  private filesSettled(): Promise<void> {
    return this.fileQueue
  }

  /**
   * Moves a generation's video to the folder and base name `target` picks, under a free name, and records
   * the new path. Videos outside the library are the owner's own files and stay where they are, as does one
   * that is already in the target folder. Resolves the new path, or undefined when nothing moved.
   */
  private async relocate(
    id: string,
    target: (g: db.StoredGeneration) => { dir: string; base: string } | undefined
  ): Promise<string | undefined> {
    const g = db.getGeneration(id)
    const from = g?.filePath
    if (!g || !from || !isInsideRoot(from) || !existsSync(from)) return undefined
    const place = target(g)
    if (!place || store.samePath(dirname(from), place.dir)) return undefined
    const ext = extname(from).toLowerCase() || '.mp4'
    const to = await moveToFreeName(from, () => join(place.dir, store.availableFileName(place.dir, place.base, ext)))
    if (!db.getGeneration(id)) {
      // Deleted while it moved, so the delete missed the video: finish that the way the delete would have.
      await shell.trashItem(to).catch((err: unknown) => console.warn(`Could not move ${to} to the trash:`, err))
      return undefined
    }
    try {
      db.updateGeneration(id, { filePath: to })
    } catch (err) {
      // Put the video back where the database still says it is.
      await movePath(to, from).catch((e: unknown) => console.warn(`Could not move ${to} back to ${from}:`, e))
      throw err
    }
    // A generation adopted as a take may have been the last one of its day.
    await removeDayFolderIfEmpty(dirname(from))
    return to
  }

  /** Moves a take's video into its sequence's Tagningar/ (giving a sequence from before folders one). */
  private moveIntoSequence(id: string): Promise<string | undefined> {
    return this.relocate(id, (g) => {
      const sequence = g.segmentId ? store.sequenceOfSegment(g.segmentId) : undefined
      const folder = sequence && this.ensureFolder(sequence.id)
      return folder ? { dir: sequenceTakesDir(folder), base: store.takeFileBase(g) } : undefined
    })
  }

  /**
   * Moves a video that lies in Sekvenser/ back to Genereringar/<day>/. If the sequence folder it left
   * belongs to no sequence any more (deleted meanwhile), that folder is removed once empty.
   */
  private async moveOutOfSequences(id: string): Promise<string | undefined> {
    const before = db.getGeneration(id)?.filePath
    const left = before ? store.sequenceFolderOfPath(before) : undefined
    if (!left) return undefined
    const moved = await this.relocate(id, (g) => ({
      dir: generationsDayDir(new Date(g.createdAt)),
      base: store.freeFileBase(g)
    }))
    if (moved && !store.folderInUse(left)) await store.removeFolderIfEmpty(left)
    return moved
  }

  /** Moves the videos of takes that are about to be freed (segment or sequence deleted) out of Sekvenser/. */
  private async releaseTakes(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.moveOutOfSequences(id)
      } catch (err) {
        // The delete goes ahead: the video stays where the database says it is, and "Städa upp" can move it.
        console.warn(`Could not move generation ${id} out of its sequence folder:`, err)
      }
    }
  }

  /** A generation from the feed became a take: its video moves into the sequence's folder. */
  private async adopt(id: string): Promise<void> {
    try {
      await this.withFiles(() => this.moveIntoSequence(id))
    } catch (err) {
      // It is a take either way; the video just stays where it was (and where the database says it is).
      console.warn(`Could not move generation ${id} into its sequence folder:`, err)
    }
    this.announceGenerations([id])
  }

  /**
   * Where a video has to go when it isn't where its take status says: 'out' of Sekvenser/ for a generation
   * that is no take, 'in' to its sequence's Tagningar/ for a take. Undefined when it is fine where it is
   * (a sequence from before folders gets one from "Städa upp" or its next rename, not from here).
   */
  private misplaced(g: Pick<Generation, 'filePath' | 'segmentId'>): 'in' | 'out' | undefined {
    if (!g.filePath) return undefined
    if (!g.segmentId) return store.sequenceFolderOfPath(g.filePath) ? 'out' : undefined
    const sequence = store.sequenceOfSegment(g.segmentId)
    if (!sequence?.folder || store.isUnder(g.filePath, store.takesPath(sequence.folder))) return undefined
    return 'in'
  }

  /**
   * After a video was saved: when it stopped or started being a take while it was being saved (its segment
   * deleted, say), it went to the old place; move it to the right one.
   */
  private async tidyGeneration(id: string): Promise<string | undefined> {
    const g = db.getGeneration(id)
    const where = g && this.misplaced(g)
    if (where === 'out') return this.moveOutOfSequences(id)
    if (where === 'in') return this.moveIntoSequence(id)
    return undefined
  }

  /** The sequence's folder name, giving it one (and creating it) when it has none. Only inside withFiles. */
  private ensureFolder(sequenceId: string): string | undefined {
    const row = store.getSequenceRow(sequenceId)
    if (!row) return undefined
    if (row.folder) return row.folder
    const folder = store.availableFolderName(store.folderBaseName(row.name))
    sequenceTakesDir(folder)
    store.setSequenceFolder(row.id, folder)
    return folder
  }

  /**
   * The folder doesn't fit the sequence's name (or there is none yet). Automatic retries leave a sequence
   * alone after a failed rename until its name changes again, so a folder that can't be renamed (locked,
   * no permission) isn't attempted on every edit.
   */
  private folderOutdated(sequenceId: string, retryFailed: boolean): boolean {
    const row = store.getSequenceRow(sequenceId)
    if (!row || (row.folder && store.folderMatchesName(row.folder, row.name))) return false
    return retryFailed || this.folderSyncFailed.get(row.id) !== row.name
  }

  /**
   * Something is about to write into or read from the folder by path: a take being submitted or rendered
   * (its video is placed into Tagningar/ by the folder name looked up when it is saved), or an export
   * (ffmpeg opens the takes by path).
   */
  private folderBusy(sequenceId: string): boolean {
    if (this.exports.has(sequenceId)) return true
    if (store.listSegmentRows(sequenceId).some((r) => this.submitting.has(r.id))) return true
    return store.hasPendingTakes(sequenceId)
  }

  /**
   * Renames the sequence's folder after the sequence, rewriting every stored path below it. Put off while
   * the folder is busy; whatever kept it busy (and any later change to the sequence) asks again. Never
   * rejects: the name change itself has already been saved, the folder just keeps its old name for now.
   */
  private syncFolder(sequenceId: string, retryFailed = false): Promise<void> {
    if (!this.folderOutdated(sequenceId, retryFailed)) return Promise.resolve()
    return this.withFiles(async () => {
      if (!this.folderOutdated(sequenceId, retryFailed) || this.folderBusy(sequenceId)) return
      const row = store.requireSequenceRow(sequenceId)
      try {
        if (!row.folder) {
          this.ensureFolder(row.id)
        } else {
          const name = store.availableFolderName(store.folderBaseName(row.name))
          // The new name is recorded in the same transaction as the rewritten paths, so the row, the paths
          // and the disk can't disagree (the folder is renamed back if that transaction fails).
          await renameLibraryFolder(store.folderPath(row.folder), store.folderPath(name), () =>
            store.setSequenceFolder(row.id, name)
          )
          // A folder removed in Finder comes back empty under the new name.
          sequenceTakesDir(name)
        }
        this.folderSyncFailed.delete(row.id)
      } catch (err) {
        this.folderSyncFailed.set(row.id, row.name)
        throw err
      }
      // Every take's path changed; the feed and the sequences showing them hold the old ones. So did the paths
      // of its stills (and of any other still made from them), and of keyframes that clips of other sequences take
      // from its Storyboard folder: every sequence refetches, or an editor open on one would save the old path back.
      this.announceRewrites(store.takeIdsForSegments(store.listSegmentRows(row.id).map((s) => s.id)))
    }).catch((err: unknown) => console.warn(`Could not rename the folder of sequence ${sequenceId}:`, err))
  }

  /** Retries a folder rename that may have been put off. Never throws. */
  private requestFolderSync(sequenceId: string | undefined): void {
    if (!sequenceId) return
    try {
      void this.syncFolder(sequenceId)
    } catch (err) {
      console.warn(`Could not check the folder of sequence ${sequenceId}:`, err)
    }
  }

  // ── Generate all ───────────────────────────────────────────────────────────

  /**
   * The clips "generate all" would pay for if it started now, in the order it would make them (see
   * generationOrder): each one without a finished selected take that isn't already rendering or on its way to
   * Venice, with what its take would be sent with and, when it can't be sent as it stands, why not. A run
   * doesn't start while any of them has a problem.
   */
  missingClips(sequenceId: string): MissingClip[] {
    const rows = store.listSegmentRows(store.requireSequenceRow(sequenceId).id)
    const { order, stuck } = generationOrder(rows)
    const blocked = stuck.length ? waitingMessage(rows, stuck) : undefined
    return [...order, ...stuck].flatMap((index): MissingClip[] => {
      const row = rows[index]
      if (this.pendingTake(row) || this.submitting.has(row.id)) return []
      const links = linksOf(rows, index)
      const params = takeParams(row, links)
      const waiting = stuck.includes(index)
      const problem = waiting ? blocked : clipProblem(params, links)
      return [
        {
          segmentId: row.id,
          clip: index + 1,
          params: paramsForSubmit(params),
          ...(problem ? { problem } : {}),
          ...(waiting ? { waiting } : {})
        }
      ]
    })
  }

  /** `guard`: for a run the user approved through an agent (see SubmitGuard); every take it pays for is checked. */
  startGenerateAll(sequenceId: string, guard?: SubmitGuard): void {
    store.requireSequenceRow(sequenceId)
    if (this.runs.get(sequenceId)?.running) return
    const run: Run = { running: true, stopped: false, guard }
    this.runs.set(sequenceId, run)
    this.deps.notify(sequenceId)
    void this.runLoop(sequenceId, run)
  }

  /**
   * Ends the run right away for the UI; the loop notices at its next check. A take that is already
   * queued at Venice keeps rendering and is still auto-selected when it lands.
   */
  stopGenerateAll(sequenceId: string, notify = true): void {
    const run = this.runs.get(sequenceId)
    if (!run?.running) return
    run.stopped = true
    run.running = false
    if (notify) this.deps.notify(sequenceId)
  }

  private clipNumber(segmentId: string | undefined, fallback: number): number {
    const row = segmentId ? store.getSegmentRow(segmentId) : undefined
    if (!row) return fallback
    const index = store.listSegmentRows(row.sequence_id).findIndex((r) => r.id === row.id)
    return index >= 0 ? index + 1 : fallback
  }

  private async runLoop(sequenceId: string, run: Run): Promise<void> {
    this.loops.add(run)
    // Segments this run has already paid for; never generate one twice in a run.
    const generated = new Set<string>()
    let clip = 0
    let segmentId: string | undefined
    try {
      // Nothing is paid for while a clip further on can't be sent as it stands (its prompt names a picture
      // that isn't there, it has no prompt…): better to hear that now than after the clips before it are made.
      await this.filesSettled()
      if (!run.stopped && store.getSequenceRow(sequenceId)) {
        const blocked = this.missingClips(sequenceId).find((c) => c.problem)
        if (blocked) {
          run.error = missingClipProblem(blocked)
          return
        }
      }
      // State is re-read every step: the user may add, move, delete or re-select while this runs.
      while (!run.stopped) {
        // A take that is being moved is briefly missing from its recorded path; don't pay for it again.
        await this.filesSettled()
        if (run.stopped || !store.getSequenceRow(sequenceId)) break
        const rows = store.listSegmentRows(sequenceId)
        // The next clip whose neighbours' frames are there (or will be: their takes come first).
        const { order, stuck } = generationOrder(rows)
        if (!order.length) {
          // Clips changed while the run went on (it checked before it started) so that two wait on each other.
          if (stuck.length) run.error = waitingMessage(rows, stuck)
          break
        }
        const index = order[0]
        const row = rows[index]
        clip = index + 1
        segmentId = row.id

        let takeId = this.pendingTake(row)?.id
        const inFlight = takeId ? undefined : this.submitting.get(row.id)
        if (inFlight) {
          // Already being uploaded, by the editor's button or by a run that was stopped mid-upload: wait for
          // that take instead of paying for the clip a second time. A run stopped before it paid gives way.
          const g = await inFlight.catch((err: unknown) => {
            if (err instanceof RunStopped) return undefined
            throw err
          })
          if (run.stopped) break
          if (!g) continue
          takeId = g.id
        } else if (!takeId) {
          if (generated.has(row.id)) {
            run.error = `Klipp ${clip}: den nya tagningen togs bort eller valdes bort, så körningen stoppades.`
            break
          }
          generated.add(row.id)
          takeId = (await this.submit(row.id, () => run.stopped, run.guard)).id
          if (run.stopped) break
        }

        const take = await this.awaitTake(takeId, run)
        if (run.stopped) break
        if (!take) continue // Deleted while we waited; look at the sequence again.
        if (take.status === 'failed') {
          // The clip was deleted, or the take no longer belongs to it, while it rendered: nothing to report
          // for the clip that now has its number, so look at the sequence again.
          const current = store.getSegmentRow(row.id)
          if (!current || (take.segmentId !== current.id && current.selected_generation_id !== take.id)) continue
          run.error = `Klipp ${this.clipNumber(current.id, clip)}: ${take.error || 'Genereringen misslyckades.'}`
          break
        }
        // The 'settled' handler normally did this already; doing it here too removes any ordering doubt.
        const owner = take.segmentId ? store.getSegmentRow(take.segmentId) : undefined
        if (owner) this.autoSelect(owner, take)
      }
    } catch (err) {
      if (!(err instanceof RunStopped) && !run.stopped) {
        // Consent errors stay raw ("Klipp N: NEEDS_CONSENT:{…}") so the view can ask and restart the run.
        let number = clip
        try {
          number = this.clipNumber(segmentId, clip)
        } catch {
          // The library was closed under the run; the number it had is good enough.
        }
        // No number when it went wrong before the run got to any clip.
        run.error = number ? `Klipp ${number}: ${errorText(err)}` : errorText(err)
      }
    } finally {
      this.loops.delete(run)
      const wasRunning = run.running
      run.running = false
      try {
        // A stopped or superseded run has already been reported as not running.
        if (wasRunning && this.runs.get(sequenceId) === run && store.getSequenceRow(sequenceId)) {
          this.deps.notify(sequenceId)
        }
      } catch (err) {
        console.warn('Could not report the end of a generate-all run', err)
      }
    }
  }

  /** The segment's selected take if it's still rendering, else its newest rendering take. */
  private pendingTake(row: store.SegmentRow): db.StoredGeneration | undefined {
    const selected = store.selectedTake(row)
    if (store.isPending(selected)) return selected
    return db.listGenerationsForSegments([row.id]).find((g) => store.isPending(g))
  }

  /**
   * Resolves with the settled take, or undefined if the run was stopped or the take deleted meanwhile.
   * The periodic check keeps a stop responsive and guards against a wait that would never resolve.
   */
  private awaitTake(id: string, run: Run): Promise<db.StoredGeneration | undefined> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearInterval(timer)
        fn()
      }
      const timer = setInterval(() => {
        if (run.stopped) return finish(() => resolve(undefined))
        try {
          const g = db.getGeneration(id)
          if (!g) finish(() => resolve(undefined))
          else if (g.status === 'completed' || g.status === 'failed') finish(() => resolve(g))
        } catch (err) {
          // E.g. the library was closed; a timer callback must not throw.
          finish(() => reject(err))
        }
      }, WATCH_INTERVAL_MS)
      // Wrapped so a synchronous throw still goes through finish() and clears the timer.
      Promise.resolve()
        .then(() => this.deps.jobs.waitFor(id))
        .then(
          (g) => finish(() => resolve(g)),
          (err: unknown) =>
            finish(() => {
              let exists = true
              try {
                exists = !!db.getGeneration(id)
              } catch {
                // The library was closed; report the original error.
              }
              if (exists) reject(err)
              else resolve(undefined)
            })
        )
    })
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  /**
   * Renders the cut into the scratch folder and then moves it into the sequence's folder as
   * "<Sekvensnamn> <YYYY-MM-DD HH.MM>.mp4", so Finder never shows a half-written film and a folder rename
   * meanwhile can't pull the target away. Resolves with the film's path.
   */
  async export(sequenceId: string): Promise<string> {
    store.requireSequenceRow(sequenceId)
    if (this.exports.has(sequenceId)) throw new Error('Sekvensen exporteras redan.')
    const controller = new AbortController()
    this.exports.set(sequenceId, controller)
    const startedAt = new Date()
    const emit = (p: Omit<ExportProgress, 'sequenceId'>): void => this.deps.exportProgress({ sequenceId, ...p })
    let progress = 0
    let started = false
    let rendered: string | undefined
    try {
      // A take that is being moved is briefly missing from its recorded path.
      await this.filesSettled()
      const rows = store.listSegmentRows(store.requireSequenceRow(sequenceId).id)
      if (!rows.length) throw new Error('Sekvensen har inga klipp att exportera.')
      const takes = rows.map((r) => store.selectedTake(r))
      const missing = takes.flatMap((t, i) => (store.isUsable(t) ? [] : [i + 1]))
      if (missing.length) throw new Error(missingTakesMessage(missing))

      started = true
      emit({ progress: 0 })
      const clips = await buildConcatClips(rows, takes.filter(store.isUsable))
      rendered = join(tmpDir(), `export-${randomUUID()}.mp4`)
      let lastStep = 0
      await concatClips(clips, rendered, {
        signal: controller.signal,
        onProgress: (fraction) => {
          progress = Math.min(1, Math.max(0, fraction))
          // ffmpeg reports several times a second; half-percent steps are plenty for a progress bar.
          const step = Math.floor(progress * 200)
          if (step === lastStep) return
          lastStep = step
          emit({ progress })
        }
      })
      if (controller.signal.aborted) throw new Error('Exporten avbröts.')
      const film = rendered
      const path = await this.withFiles(() => this.placeExport(sequenceId, film, startedAt, controller.signal))
      emit({ progress: 1, done: true, path })
      return path
    } catch (err) {
      const message = controller.signal.aborted ? 'Exporten avbröts.' : errorText(err)
      if (started) emit({ progress, done: true, error: message })
      throw new Error(message)
    } finally {
      // Only still there when the export failed or was cancelled; the scratch folder is the app's own.
      if (rendered) await rm(rendered, { force: true }).catch(() => {})
      this.exports.delete(sequenceId)
      // A folder rename waits for a running export.
      this.requestFolderSync(sequenceId)
    }
  }

  /** Moves a rendered film into the sequence's folder under a free name and records it. Only inside withFiles. */
  private async placeExport(sequenceId: string, rendered: string, at: Date, signal: AbortSignal): Promise<string> {
    // Deleting the sequence cancels its export: don't recreate the folder that the delete removes.
    if (signal.aborted) throw new Error('Exporten avbröts.')
    const folder = this.ensureFolder(sequenceId)
    if (!folder) throw new Error('Sekvensen finns inte längre.')
    const dir = sequenceDir(folder)
    const name = store.requireSequenceRow(sequenceId).name
    for (let attempt = 1; ; attempt++) {
      const target = reserveExportPath(dir, name, at)
      try {
        await movePath(rendered, target.path)
      } catch (err) {
        target.release()
        // Another file took the name between the check and the move: take the next free one.
        if (attempt < PLACE_ATTEMPTS && existsSync(rendered) && nameTaken(err, target.path)) continue
        throw new Error(`Filmen kunde inte sparas i sekvensens mapp: ${errorText(err)}`)
      }
      target.release()
      try {
        store.recordExport(sequenceId, target.path)
      } catch (err) {
        // The film is in place either way; only "Städa upp" and library moves lose track of it.
        console.warn(`Could not record the export ${target.path}:`, err)
      }
      return target.path
    }
  }

  /** Bumps updated_at (unless the caller already did), broadcasts and returns the fresh sequence. */
  private changed(sequenceId: string, touch = true): Sequence {
    if (touch) store.touchSequence(sequenceId)
    this.deps.notify(sequenceId)
    // A folder rename that was put off may be possible now (e.g. the pending take's clip was deleted).
    this.requestFolderSync(sequenceId)
    return this.get(sequenceId)
  }
}

/**
 * Registers the sequence IPC handlers and returns the service behind them, so the rest of the main process
 * works on the same runs and file queue as the views (e.g. `isBusy` tells the library switcher what would be
 * interrupted, `missingClips` what "generate all" would pay for).
 */
export function registerSequenceIpc(deps: Deps): SequenceService {
  const s = new SequenceService(deps)

  ipcMain.handle('sequences:list', () => s.list())
  ipcMain.handle('sequences:get', (_e, id: string) => s.get(id))
  ipcMain.handle('sequences:create', (_e, name: string) => s.create(name))
  ipcMain.handle('sequences:update', (_e, id: string, patch: SequencePatch) => s.update(id, patch ?? {}))
  ipcMain.handle('sequences:delete', (_e, id: string) => s.delete(id))

  ipcMain.handle('segments:add', (e, sequenceId: string, init?: SegmentInit) =>
    s.addSegment(sequenceId, init ?? {}, { byAgent: isAgentCall(e) })
  )
  ipcMain.handle('segments:update', (e, segmentId: string, patch: SegmentPatch) =>
    s.updateSegment(segmentId, patch, { byAgent: isAgentCall(e) })
  )
  ipcMain.handle('segments:delete', (e, segmentId: string) => s.deleteSegment(segmentId, { byAgent: isAgentCall(e) }))
  ipcMain.handle('segments:move', (e, segmentId: string, toIndex: number) =>
    s.moveSegment(segmentId, toIndex, { byAgent: isAgentCall(e) })
  )
  ipcMain.handle(
    'segments:setImage',
    (e, segmentId: string, slot: SegmentImageSlot, source: SegmentImageSource | null) =>
      s.setSegmentImage(segmentId, slot, source ?? null, { byAgent: isAgentCall(e) })
  )
  ipcMain.handle('segments:previewFrames', (_e, segmentId: string) => s.previewSegmentFrames(segmentId))
  ipcMain.handle('segments:bridge', (e, segmentId: string) => s.bridgeSegment(segmentId, { byAgent: isAgentCall(e) }))
  // The guard argument only ever comes from an approval in this process (see SubmitGuard).
  ipcMain.handle('segments:generate', (_e, segmentId: string, guard?: unknown) =>
    s.generateSegment(segmentId, asGuard(guard))
  )

  ipcMain.handle('sequences:generateAll', (_e, sequenceId: string, guard?: unknown) =>
    s.startGenerateAll(sequenceId, asGuard(guard))
  )
  // Read-only; the agent connection asks it what a "generate all" approval would pay for.
  ipcMain.handle('sequences:missingClips', (_e, sequenceId: string) => s.missingClips(sequenceId))
  ipcMain.handle('sequences:stopGenerateAll', (_e, sequenceId: string) => s.stopGenerateAll(sequenceId))
  ipcMain.handle('sequences:export', (_e, sequenceId: string) => s.export(sequenceId))

  return s
}
