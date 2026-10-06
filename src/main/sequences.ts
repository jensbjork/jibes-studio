// Sequences: ordered segments whose selected takes are cut together into one longer video.
// Each sequence has a folder in Sekvenser/ named after it: its takes live in Tagningar/ inside it and its
// exports next to that, so the folder is what the user sees of the sequence in Finder.

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { ipcMain, shell } from 'electron'
import { DEFAULT_PARAMS, imageToVideoVariant, kindOfModelId, paramsForSubmit } from '@shared/models'
import { blockingContinuationError, blockingPromptError } from '@shared/prompt-refs'
import type {
  ExportProgress,
  Generation,
  GenerationParams,
  SegmentInit,
  SegmentPatch,
  Sequence,
  SequenceSummary
} from '@shared/types'
import { isAgentCall } from './agent/local-ipc'
import * as db from './db'
import { concatClips, extractFrame, probe } from './ffmpeg'
import { toPublic, type JobManager } from './jobs'
import {
  framesDir,
  generationsDayDir,
  isInsideRoot,
  libraryOperationSettled,
  movePath,
  removeDayFolderIfEmpty,
  renameLibraryFolder,
  sequenceDir,
  sequenceTakesDir,
  tmpDir
} from './paths'
import { buildConcatClips, missingTakesMessage, reserveExportPath } from './sequence-export'
import * as store from './sequence-store'
import { ensureImagesExist, type VeniceClient } from './venice'

interface Deps {
  jobs: JobManager
  venice: VeniceClient
  notify: (sequenceId: string) => void
  exportProgress: (p: ExportProgress) => void
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

/**
 * The params a take of the clip is sent with. A continuation always generates with the image-to-video
 * sibling; its start frame is only filled in when the take is generated.
 */
function takeParams(row: store.SegmentRow, continuing: boolean): GenerationParams {
  const params = store.parseParams(row.params)
  return continuing ? { ...params, model: imageToVideoVariant(params.model) } : params
}

/**
 * Why a take of the clip can't be sent as it stands (Swedish), or undefined when it can. Checked before
 * "generate all" pays for anything and again right before each take is sent; JobManager.submit checks the
 * prompt's references once more on what actually goes to Venice.
 */
function clipProblem(params: GenerationParams, continuing: boolean): string | undefined {
  const kind = kindOfModelId(params.model)
  if (!params.prompt.trim()) return 'Skriv en prompt för klippet först.'
  // The general message advises switching to reference mode, which a continuation can't do.
  if (continuing) return blockingContinuationError(params)
  if (kind === 'reference-to-video' && !params.referenceImages?.length) {
    return 'Lägg till minst en referensbild för klippet.'
  }
  if (kind === 'image-to-video' && !params.startImage) {
    return 'Lägg till en startbild för klippet, eller låt det fortsätta från föregående klipp.'
  }
  return blockingPromptError(params)
}

/** A clip "generate all" would pay for. */
export interface MissingClip {
  segmentId: string
  /** 1-based position in the sequence, as shown to the user ("Klipp 3"). */
  clip: number
  /** What its take would be sent with; a continuation's start frame is only extracted when its turn comes. */
  params: GenerationParams
  /** Why it can't be generated as it stands (Swedish), e.g. a prompt naming a picture that isn't there. */
  problem?: string
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
   * exports are finished films, so they and the folder holding them stay. Only empty folders are removed.
   */
  async delete(id: string): Promise<void> {
    if (!store.getSequenceRow(id)) return
    this.stopGenerateAll(id, false)
    this.runs.delete(id)
    this.folderSyncFailed.delete(id)
    this.exports.get(id)?.abort()
    const freed = await this.withFiles(async () => {
      const row = store.getSequenceRow(id)
      if (!row) return []
      const takeIds = store.takeIdsForSegments(store.listSegmentRows(id).map((s) => s.id))
      // Before the rows go: once the FK has nulled segment_id, nothing says these videos were takes here.
      await this.releaseTakes(takeIds)
      // Segments cascade; takes get segment_id nulled and exports sequence_id nulled by their FKs.
      this.sql().prepare('DELETE FROM sequences WHERE id = ?').run(id)
      if (row.folder && !store.folderInUse(row.folder)) await store.removeFolderIfEmpty(row.folder)
      return takeIds
    })
    this.announceGenerations(freed)
    this.deps.notify(id)
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
    else if (previous) params = { ...store.parseParams(previous.params), prompt: '' }
    else params = store.sanitizeParams({ ...DEFAULT_PARAMS, ...store.parseDefaults(sequence.defaults) })

    const continuing = !!previous && (init.continueFromPrevious ?? !source)
    if (continuing) {
      // The start frame comes from the previous clip at generation time; image inputs would be stale. That
      // includes an end image copied from the previous clip: it is where that clip was meant to end.
      params = {
        ...params,
        model: imageToVideoVariant(params.model),
        startImage: undefined,
        endImage: undefined,
        referenceImages: undefined
      }
    }

    const id = randomUUID()
    const adopt = source && !source.segmentId
    this.sql().transaction(() => {
      this.sql()
        .prepare(
          `INSERT INTO segments (id, sequence_id, position, params, continue_from_previous, selected_generation_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          sequenceId,
          index,
          store.serializeParams(params),
          continuing ? 1 : 0,
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
    const row = store.requireSegmentRow(segmentId)
    this.refuseWhileRunning(row.sequence_id, caller)
    const rows = store.listSegmentRows(row.sequence_id)
    const index = rows.findIndex((r) => r.id === row.id)
    patch = patch ?? {}

    let continuing = !!row.continue_from_previous
    if (patch.continueFromPrevious !== undefined) {
      if (patch.continueFromPrevious && index === 0) {
        throw new Error('Det första klippet kan inte fortsätta från ett föregående klipp.')
      }
      continuing = !!patch.continueFromPrevious
    }

    const params = patch.params ? store.sanitizeParams(patch.params) : store.parseParams(row.params)
    // A continuing segment always generates with the image-to-video sibling; keep the stored model honest.
    if (continuing) params.model = imageToVideoVariant(params.model)

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
    const editingStartOnly = patch.trimStart !== undefined && patch.trimEnd === undefined
    const { trimStart, trimEnd } = store.clampTrims(
      patch.trimStart ?? row.trim_start,
      patch.trimEnd ?? row.trim_end,
      take && store.takeLength(take),
      editingStartOnly ? 'start' : 'end'
    )

    this.sql().transaction(() => {
      this.sql()
        .prepare(
          `UPDATE segments SET params = ?, continue_from_previous = ?, selected_generation_id = ?,
             trim_start = ?, trim_end = ? WHERE id = ?`
        )
        .run(store.serializeParams(params), continuing ? 1 : 0, selectedId, trimStart, trimEnd, row.id)
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
    const continuing = index > 0 && !!row.continue_from_previous
    // Synchronously with the reads above: the take is built from exactly what the guard looked at.
    const refused = guard?.(row.id)
    if (refused) throw new Error(refused)

    const params = takeParams(row, continuing)
    // Before the frame grab and the quote: a clip that can't be sent as it stands costs nothing to refuse.
    const problem = clipProblem(params, continuing)
    if (problem) throw new Error(problem)
    if (continuing) params.startImage = await this.continuationFrame(rows[index - 1], index)

    const p = paramsForSubmit(params)
    ensureImagesExist(p)

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
   * Pictures from outside the library were copied into Referensbilder when the take was submitted. The
   * segment uses those copies from now on, so it keeps working when the originals are moved or deleted.
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
      if (!copies.size) return
      const row = store.getSegmentRow(segmentId)
      if (!row) return
      const params = store.parseParams(row.params)
      const use = (path: string | undefined): string | undefined => (path && copies.get(path)) || path
      const next: GenerationParams = {
        ...params,
        startImage: use(params.startImage),
        endImage: use(params.endImage),
        referenceImages: params.referenceImages?.map((r) => copies.get(r) ?? r)
      }
      const json = store.serializeParams(next)
      if (json !== store.serializeParams(params)) {
        this.sql().prepare('UPDATE segments SET params = ? WHERE id = ?').run(json, segmentId)
      }
    } catch (err) {
      console.warn(`Could not point segment ${segmentId} at the library copies of its pictures:`, err)
    }
  }

  /**
   * The previous segment's selected take's last frame (or the frame where its end trim cuts),
   * extracted once and cached per take and timestamp in the library's hidden frame folder.
   */
  private async continuationFrame(previous: store.SegmentRow, previousNumber: number): Promise<string> {
    const take = store.selectedTake(previous)
    if (!store.isUsable(take)) throw new Error(`Klipp ${previousNumber} behöver en färdig vald tagning först.`)

    let at: number | undefined
    if (previous.trim_end > 0) {
      const length = take.videoDuration ?? (await probe(take.filePath)).duration
      // Computed exactly like the export's cut point (buildConcatClips), so both end on the same frame.
      at = Math.max(0, length - previous.trim_end)
    }
    // "v2": frames cached before extractFrame matched the export's trim could be one frame off. The renderer
    // reads the trailing "-<ms>" (continuationMismatch), so it must stay last.
    const name = `${take.id}-${at === undefined ? 'last' : `v2-${Math.round(at * 1000)}`}.png`
    const framePath = join(framesDir(), name)
    if (existsSync(framePath) && statSync(framePath).size > 0) return framePath
    return extractFrame(take.filePath, framePath, at)
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
      // Every take's path changed; the feed and the sequences showing them hold the old ones.
      this.announceMoved(store.takeIdsForSegments(store.listSegmentRows(row.id).map((s) => s.id)))
      this.deps.notify(row.id)
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
   * The clips "generate all" would pay for if it started now, in order: each one without a finished selected
   * take that isn't already rendering or on its way to Venice, with what its take would be sent with and,
   * when it can't be sent as it stands, why not. A run doesn't start while any of them has a problem.
   */
  missingClips(sequenceId: string): MissingClip[] {
    const rows = store.listSegmentRows(store.requireSequenceRow(sequenceId).id)
    return rows.flatMap((row, index): MissingClip[] => {
      if (store.isUsable(store.selectedTake(row)) || this.pendingTake(row) || this.submitting.has(row.id)) return []
      const continuing = index > 0 && !!row.continue_from_previous
      const params = takeParams(row, continuing)
      const problem = clipProblem(params, continuing)
      return [{ segmentId: row.id, clip: index + 1, params: paramsForSubmit(params), ...(problem ? { problem } : {}) }]
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
          run.error = `Klipp ${blocked.clip}: ${blocked.problem}`
          return
        }
      }
      // State is re-read every step: the user may add, move, delete or re-select while this runs.
      while (!run.stopped) {
        // A take that is being moved is briefly missing from its recorded path; don't pay for it again.
        await this.filesSettled()
        if (run.stopped || !store.getSequenceRow(sequenceId)) break
        const rows = store.listSegmentRows(sequenceId)
        const index = rows.findIndex((r) => !store.isUsable(store.selectedTake(r)))
        if (index < 0) break
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
