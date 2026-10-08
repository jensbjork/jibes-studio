// Redigera: one finished film changed into versions. An edit starts from any finished generation (a feed clip, a
// take, the user's own film) used where it is, or from an exported film cloned into the edit's folder; every change
// is a new version (a completed generations row with source 'edit') in Redigeringar/<namn>/, so the original is
// never touched. This module owns the edits:*, audio:* and voices:* IPC; the operations themselves (plans, renders,
// paid jobs) are in edit-ops.ts, persistence in edit-store.ts, the layered sound in edit-mix.ts.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { formatPrice, roundUsd, toSrt } from '@shared/edit-plan'
import { generationTitle } from '@shared/generation-label'
import type {
  AudioCatalog,
  Edit,
  EditJob,
  EditMedia,
  EditOperation,
  EditPlan,
  EditRunOptions,
  EditRunResult,
  EditSummary,
  EditTimeline,
  EditVersion,
  Generation,
  SendTarget,
  SeparationStatus,
  Transcript
} from '@shared/types'
import { isAgentCall } from './agent/local-ipc'
import { AUDIO_FILE_TYPES, setVoiceCloneConsent } from './assets'
import * as db from './db'
import * as mixes from './edit-mix'
import { EditOps, isPictureOp, transcriptFor, versionParams, type OpsDeps } from './edit-ops'
import * as store from './edit-store'
import { extractThumbnail, filmstrip, probe, probeAudio, sceneCuts, waveform } from './ffmpeg'
import { toPublic, videoLocation } from './jobs'
import {
  APP_DATA,
  appDataDir,
  editDir,
  FOLDERS,
  folderRecordedInDb,
  fromStoredPath,
  libraryOperationSettled,
  libraryRoot,
  movePath,
  referencesDayDir,
  renameLibraryFolder,
  safeName,
  thumbsDir,
  toStoredPath
} from './paths'
import { cloneInto, placeFile, serialized } from './references'
import { attachReviewSummary } from './reviews'
import type { SequenceService } from './sequences'
import { separationStatus } from './voice-separation'

export const USER_ONLY = 'Det här kan bara du göra i Studio.'
const UNNAMED = 'Namnlös redigering'
/** The timeline cache (.studio/tidslinje): filmstrips and waveforms beyond this go, least recently used first. */
const TIMELINE_CACHE_BYTES = 512 * 1024 ** 2
const MONTHS = ['jan', 'feb', 'mars', 'apr', 'maj', 'juni', 'juli', 'aug', 'sep', 'okt', 'nov', 'dec']

export interface EditDeps extends OpsDeps {
  sequences: SequenceService
  /**
   * A generation this service removed (a version or an edit's export clone): every list drops it. index.ts routes it
   * to 'generation:delete'; without it the feed drops removed versions only when it is loaded again.
   */
  generationDeleted?: (id: string) => void
  /**
   * Stored paths were rewritten (files an edit's folder held moved to Referensbilder when the edit was deleted): open
   * sequences and the feed read them again. index.ts routes it like any other rewrite.
   */
  pathsRewritten?: () => void
}

export interface EditServiceHandle {
  isBusy(): string | undefined
  /** Whether Redigera keeps the generation (a version, an export copy, an edit's original): see EditService.keeps. */
  keeps(id: string): boolean
  /**
   * Called right before generations:delete removes a generation: throws (Swedish) when Redigera's rules keep it (a
   * running operation's base or a stopped, partly paid one's, an edit's original, a version Redigera wouldn't delete),
   * else hands on its transcript.
   */
  beforeGenerationDelete(id: string): void
  resume(): void
  /**
   * A generation was deleted (generations:delete): an edit whose current version it was falls back on its parent
   * (or v1), versions built on it hang under its parent, a picture job waiting for it fails. `deleted` is the row as
   * it was, when the caller has it (it knows the parent).
   */
  onGenerationDeleted(id: string, deleted?: Partial<Pick<Generation, 'parentId' | 'editId'>>): void
  stop(): void
}

const fold = (s: string): string => s.normalize('NFC').toLowerCase()

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 120) : ''
}

/** "7 okt" (local time). */
function shortDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** A row as the window gets it, flagged when its finished video is gone (moved or deleted in Finder). */
function withFileState(g: db.StoredGeneration): Generation {
  const pub = toPublic(g)
  return g.status === 'completed' && g.filePath && !existsSync(g.filePath) ? { ...pub, fileMissing: true } : pub
}

function mediaView(m: store.StoredMedia): EditMedia {
  return {
    id: m.id,
    kind: m.kind,
    label: m.label,
    path: m.path,
    ...(m.duration !== undefined ? { durationSeconds: m.duration } : {}),
    ...(m.model ? { model: m.model } : {}),
    ...(m.cost !== undefined ? { costUsd: m.cost } : {}),
    createdAt: m.createdAt
  }
}

class EditService {
  readonly ops: EditOps
  /** Folder work (create, rename, delete, prune) one at a time: each picks names and moves files. */
  private readonly files = serialized()
  private fileTasks = 0
  private timelineWork = 0
  private readonly timelines = new Map<string, Promise<TimelineCache>>()

  constructor(private readonly deps: EditDeps) {
    this.ops = new EditOps(deps)
  }

  isBusy(): string | undefined {
    if (this.fileTasks || this.timelineWork) return 'Det pågår en redigering. Vänta tills den är klar och försök igen.'
    return this.ops.isBusy()
  }

  private fileTask<T>(task: () => Promise<T>): Promise<T> {
    this.fileTasks++
    return this.files(async () => {
      try {
        await libraryOperationSettled()
        return await task()
      } finally {
        this.fileTasks--
      }
    })
  }

  private notify(editId: string): void {
    try {
      this.deps.notify(editId)
    } catch (err) {
      console.warn('Edit change listener failed:', err)
    }
  }

  private changed(g: Generation | undefined): void {
    if (!g) return
    try {
      this.deps.generationChanged(toPublic(g as db.StoredGeneration))
    } catch (err) {
      console.warn('Announcing a generation failed:', err)
    }
  }

  private pathsRewritten(): void {
    try {
      this.deps.pathsRewritten?.()
    } catch (err) {
      console.warn('Announcing rewritten paths failed:', err)
    }
  }

  private removed(id: string): void {
    try {
      this.deps.generationDeleted?.(id)
    } catch (err) {
      console.warn('Announcing a removed generation failed:', err)
    }
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  private currentOf(edit: store.EditRow, versions: db.StoredGeneration[]): db.StoredGeneration | undefined {
    return (
      versions.find((v) => v.id === edit.current_generation_id) ??
      versions.find((v) => v.id === edit.origin_generation_id) ??
      versions[versions.length - 1]
    )
  }

  summary(edit: store.EditRow): EditSummary {
    const versions = store.listVersions(edit)
    const takes = store.listTakes(edit.id)
    const current = this.currentOf(edit, versions)
    const poster = current?.thumbPath ?? versions[0]?.thumbPath
    const jobs = store.listJobs(edit.id)
    const audioCost = jobs.filter((j) => !isPictureOp(j.op)).reduce((sum, j) => sum + (j.cost || 0), 0)
    const takeCost = takes.reduce((sum, t) => sum + (t.quote ?? 0), 0)
    return {
      id: edit.id,
      name: edit.name,
      origin: store.originOf(edit),
      ...(current ? { currentId: current.id } : {}),
      ...(poster ? { posterPath: poster } : {}),
      versionCount: versions.length,
      ...(current?.videoDuration !== undefined ? { duration: current.videoDuration } : {}),
      running: jobs.some((j) => j.status === 'running'),
      totalCostUsd: roundUsd(audioCost + takeCost),
      generationIds: [...versions, ...takes].map((g) => g.id),
      updatedAt: edit.updated_at
    }
  }

  list(): EditSummary[] {
    return store.listEditRows().map((e) => this.summary(e))
  }

  get(id: unknown): Edit {
    const edit = store.requireEditRow(id)
    const summary = this.summary(edit)
    const versions = store.listVersions(edit)
    const current = this.currentOf(edit, versions)
    const generations = attachReviewSummary(versions.map((v) => withFileState(v)))
    const views: EditVersion[] = versions.map((v, i) => {
      const origin = v.id === edit.origin_generation_id
      return {
        id: v.id,
        number: store.versionNumber(v, origin),
        ...(!origin && v.parentId ? { parentId: v.parentId } : {}),
        label: origin ? 'Original' : (v.recipe?.label ?? 'Version'),
        op: origin ? 'original' : (v.recipe?.op ?? 'original'),
        ...(!origin && v.recipe?.costUsd !== undefined ? { costUsd: v.recipe.costUsd } : {}),
        current: v.id === current?.id,
        createdAt: v.createdAt,
        generation: generations[i],
        usedBy: store.usedBy(v.id).map(({ kind: _kind, ...u }) => u)
      }
    })
    return {
      ...summary,
      versions: views,
      jobs: store.listJobs(edit.id).map((j) => this.ops.jobView(j)),
      media: store.listMedia(edit.id).map(mediaView),
      takes: attachReviewSummary(store.listTakes(edit.id).map((t) => withFileState(t))),
      createdAt: edit.created_at
    }
  }

  // ── Creating, renaming, deleting ─────────────────────────────────────────

  /** A folder name under Redigeringar/ that no other edit uses, isn't on disk and no row records paths under. */
  private freeFolder(name: string, own?: { id: string; folder: string | null }): string {
    const parent = join(libraryRoot(), FOLDERS.edits)
    const base = safeName(name, { fallback: UNNAMED })
    const claimed = new Set(
      store
        .editFolders()
        .filter((f) => f.id !== own?.id)
        .map((f) => fold(f.folder))
    )
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base} (${n})`
      if (own?.folder && fold(own.folder) === fold(candidate)) return candidate
      const path = join(parent, candidate)
      if (!claimed.has(fold(candidate)) && !existsSync(path) && !folderRecordedInDb(path)) return candidate
    }
  }

  create(source: unknown, name?: unknown): Promise<Edit> {
    const s = (source && typeof source === 'object' ? source : {}) as { generationId?: unknown; exportId?: unknown }
    const { generationId, exportId } = s
    if (typeof generationId === 'string') return this.fileTask(() => this.createFromGeneration(generationId, name))
    if (typeof exportId === 'string') return this.fileTask(() => this.createFromExport(exportId, name))
    return Promise.reject(new Error('Välj en film att redigera.'))
  }

  private async createFromGeneration(generationId: string, name: unknown): Promise<Edit> {
    const g = db.getGeneration(store.safeId(generationId))
    if (!g) throw new Error('Filmen finns inte längre.')
    if (g.status !== 'completed') throw new Error('Filmen är inte klar än.')
    if (!g.filePath || !existsSync(g.filePath)) {
      throw new Error('Filmens videofil saknas (flyttad eller raderad i Finder).')
    }
    const title = cleanName(name) || cleanName(generationTitle(g, 60)) || UNNAMED
    const folder = this.freeFolder(title)
    editDir(folder)
    const now = Date.now()
    const id = randomUUID()
    // A copy of an exported film (another edit's v1) is an export, not the user's own footage, whatever its source.
    const exported = g.recipe?.export
    store.insertEditRow({
      id,
      name: title,
      folder,
      origin_kind: exported ? 'export' : g.source === 'import' ? 'import' : 'generation',
      origin_generation_id: g.id,
      origin_export_id: exported?.exportId && store.exportRow(exported.exportId) ? exported.exportId : null,
      current_generation_id: g.id,
      created_at: now,
      updated_at: now
    })
    this.notify(id)
    return this.get(id)
  }

  private async createFromExport(exportId: string, name: unknown): Promise<Edit> {
    const row = store.exportRow(store.safeId(exportId))
    if (!row) throw new Error('Exporten finns inte längre.')
    const file = fromStoredPath(row.file_path)
    if (!existsSync(file)) throw new Error('Exportens fil saknas (flyttad eller raderad i Finder).')
    const title = cleanName(name) || `${row.sequence_name ?? 'Export'} (export ${shortDate(row.created_at)})`
    const folder = this.freeFolder(title)
    const dir = editDir(folder)
    // v1 is an APFS clone of the export in the edit's folder (no extra space on the same volume): the export itself
    // stays where it is, with its sequence.
    const ext = extname(file).toLowerCase() || '.mp4'
    const clone = await cloneInto(file, dir, safeName(title, { max: 120, fallback: 'Export' }), ext)
    const editId = randomUUID()
    const genId = randomUUID()
    let thumb: string | undefined
    try {
      const p = await probe(clone)
      thumb = await extractThumbnail(clone, join(thumbsDir(), `${genId}.jpg`)).catch(() => undefined)
      const cuts = store.exportCuts(row) ?? (await sceneCuts(clone).catch(() => [] as number[]))
      const now = Date.now()
      db.getDb().transaction(() => {
        store.insertEditRow({
          id: editId,
          name: title,
          folder,
          origin_kind: 'export',
          origin_generation_id: null,
          origin_export_id: row.id,
          current_generation_id: null,
          created_at: now,
          updated_at: now
        })
        db.insertGeneration({
          id: genId,
          createdAt: now,
          source: 'import',
          title,
          editId,
          recipe: {
            op: 'import',
            label: 'Export',
            timing: 'same',
            mix: mixes.defaultMix(genId),
            export: { exportId: row.id, ...(row.sequence_name ? { sequenceName: row.sequence_name } : {}) },
            ...(cuts.length ? { cuts } : {})
          },
          model: '',
          prompt: '',
          params: versionParams(p),
          status: 'completed',
          filePath: clone,
          thumbPath: thumb,
          videoDuration: p.duration,
          completedAt: now,
          reviewCount: 0,
          agentReviewCount: 0
        })
        db.getDb()
          .prepare('UPDATE edits SET origin_generation_id = ?, current_generation_id = ? WHERE id = ?')
          .run(genId, genId, editId)
      })()
    } catch (err) {
      // Nothing records them: they are this call's own files.
      await rm(clone, { force: true }).catch(() => {})
      if (thumb) await rm(thumb, { force: true }).catch(() => {})
      throw err
    }
    this.changed(db.getGeneration(genId))
    this.notify(editId)
    return this.get(editId)
  }

  rename(id: unknown, name: unknown): Promise<Edit> {
    return this.fileTask(async () => {
      const edit = store.requireEditRow(id)
      const next = cleanName(name)
      if (!next) throw new Error('Redigeringen behöver ett namn.')
      if (next === edit.name) return this.get(edit.id)
      const versions = store.listVersions(edit).filter((v) => v.source === 'edit' && v.editId === edit.id)
      const retitle = (): void => {
        const update = db.getDb().prepare('UPDATE generations SET title = ? WHERE id = ?')
        for (const v of versions) update.run(`${next} v${store.versionNumber(v, false)}`, v.id)
      }
      let folder = edit.folder
      const wanted = this.freeFolder(next, { id: edit.id, folder: edit.folder })
      if (edit.folder && wanted !== edit.folder) {
        const parent = join(libraryRoot(), FOLDERS.edits)
        try {
          await renameLibraryFolder(join(parent, edit.folder), join(parent, wanted), () => {
            store.setEditName(edit.id, next, wanted)
            retitle()
          })
          folder = wanted
        } catch (err) {
          // The folder stays (a file in it is open elsewhere, say); the edit is renamed all the same.
          console.warn(`Could not rename the folder of edit ${edit.id}:`, err)
          db.getDb().transaction(() => {
            store.setEditName(edit.id, next, edit.folder)
            retitle()
          })()
        }
      } else {
        db.getDb().transaction(() => {
          store.setEditName(edit.id, next, folder)
          retitle()
        })()
      }
      // Titles and (with the folder) paths changed: the feed gets the versions and takes again.
      for (const g of [...store.listVersions(store.getEditRow(edit.id)!), ...store.listTakes(edit.id)]) this.changed(g)
      this.notify(edit.id)
      return this.get(edit.id)
    })
  }

  /**
   * A version or take leaves the edit: its edit_id is cleared and its video moved to the home it has then, in one
   * write once the file is in place. A move that fails leaves the row as it was (still the edit's), so trying again
   * finds it where it was rather than half detached with its file still in the folder about to be trashed.
   */
  private async moveOutOfEdit(id: string): Promise<void> {
    const g = db.getGeneration(id)
    if (!g) return
    if (!g.filePath || !existsSync(g.filePath)) {
      db.updateGeneration(id, { editId: undefined })
      return
    }
    const { dir, base } = videoLocation({ ...g, editId: undefined })
    if (dirname(g.filePath).normalize('NFC') === dir.normalize('NFC')) {
      db.updateGeneration(id, { editId: undefined })
      return
    }
    const dest = await placeFile(g.filePath, dir, base, extname(g.filePath).toLowerCase() || '.mp4')
    try {
      db.updateGeneration(id, { editId: undefined, filePath: dest })
    } catch (err) {
      await movePath(dest, g.filePath).catch(() => {})
      throw err
    }
  }

  /**
   * Files in a folder about to be trashed that rows still record (an AI take's start image a sequence clip was seeded
   * from, a version whose move out failed earlier): moved out first – a generation's video to its home, anything else
   * to Referensbilder/<day>/ – with every recorded path following. False when one couldn't be moved: the folder then
   * stays, rather than taking a file something still uses into the trash.
   */
  private async rescueRecorded(dir: string): Promise<{ ok: boolean; rewritten: boolean }> {
    if (!db.isStoredPrefixRecorded(toStoredPath(dir))) return { ok: true, rewritten: false }
    let files: string[]
    try {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true })
      files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))
    } catch {
      return { ok: true, rewritten: false }
    }
    let ok = true
    let rewritten = false
    for (const file of files) {
      const stored = toStoredPath(file)
      if (!db.isStoredPathRecorded(stored)) continue
      try {
        const owner = db
          .getDb()
          .prepare('SELECT id FROM generations WHERE file_path = ? COLLATE NOCASE')
          .pluck()
          .get(stored) as string | undefined
        if (owner) {
          await this.moveOutOfEdit(owner)
          this.changed(db.getGeneration(owner))
          continue
        }
        const ext = extname(file)
        const dest = await placeFile(file, referencesDayDir(new Date()), safeName(basename(file, ext)), ext)
        try {
          db.getDb().transaction(() => db.rewriteStoredPrefix(stored, toStoredPath(dest)))()
          rewritten = true
        } catch (err) {
          await movePath(dest, file).catch(() => {})
          throw err
        }
      } catch (err) {
        console.warn(`Could not keep ${file}, which the library still uses:`, err)
        ok = false
      }
    }
    return { ok, rewritten }
  }

  /** An AI take's inputs in the edit's Underlag/ move to Referensbilder/<day>/, its params following. */
  private async releaseInputs(take: db.StoredGeneration, inputsDir: string): Promise<void> {
    const p = take.params
    const paths = [p.startImage, p.endImage, p.sourceVideo, ...(p.referenceVideos ?? [])].filter(
      (x): x is string => typeof x === 'string' && !!x && x.startsWith(`${inputsDir}/`) && existsSync(x)
    )
    for (const path of paths) {
      const ext = extname(path)
      const name = safeName(path.slice(inputsDir.length + 1, -ext.length || undefined))
      const dest = await placeFile(path, referencesDayDir(new Date()), name, ext)
      try {
        db.getDb().transaction(() => db.rewriteStoredPrefix(toStoredPath(path), toStoredPath(dest)))()
      } catch (err) {
        await movePath(dest, path).catch(() => {})
        throw err
      }
    }
  }

  delete(id: unknown): Promise<void> {
    return this.fileTask(async () => {
      const edit = store.getEditRow(store.safeId(id))
      if (!edit) return
      if (store.listJobs(edit.id).some((j) => j.status === 'running')) {
        throw new Error('En åtgärd pågår i redigeringen. Vänta tills den är klar (eller avbryt den) och försök igen.')
      }
      const versions = store.listVersions(edit)
      const own = versions.filter((v) => v.editId === edit.id)
      const takes = store.listTakes(edit.id)
      // Versions a sequence clip uses or another edit started from stay, as ordinary rows in their home.
      const keep = own.filter((v) => store.usedBy(v.id).length > 0 || store.editsStartedFrom(v.id, edit.id).length > 0)
      const keepIds = new Set(keep.map((v) => v.id))
      const trash = own.filter((v) => !keepIds.has(v.id))
      const inputs = edit.folder ? join(libraryRoot(), FOLDERS.edits, edit.folder, 'Underlag') : undefined

      for (const v of keep) await this.moveOutOfEdit(v.id)
      for (const t of takes) {
        await this.moveOutOfEdit(t.id)
        const moved = db.getGeneration(t.id)
        if (moved && inputs) {
          await this.releaseInputs(moved, inputs).catch((err: unknown) => {
            console.warn('Keeping a take input failed:', err)
          })
        }
      }
      db.getDb().transaction(() => {
        // Read while the trashed versions are still there: a kept version (or another edit's) that inherits its
        // transcript through one of them gets a copy of its own (paid for, perhaps corrected by hand).
        this.keepInheritedTranscripts(new Set(trash.map((v) => v.id)), keep.map((v) => v.id))
        for (const v of trash) db.deleteGeneration(v.id)
        store.deleteEditRow(edit.id)
      })()
      for (const v of trash) {
        for (const file of [v.filePath, v.thumbPath]) {
          if (file && existsSync(file)) await shell.trashItem(file).catch(() => {})
        }
      }
      let rewritten = takes.length > 0
      if (edit.folder) {
        const dir = join(libraryRoot(), FOLDERS.edits, edit.folder)
        if (existsSync(dir)) {
          // Only what nothing records any more goes to the trash with the folder.
          const rescued = await this.rescueRecorded(dir)
          rewritten ||= rescued.rewritten
          if (rescued.ok) {
            await shell.trashItem(dir).catch((err: unknown) => console.warn(`Could not trash ${dir}:`, err))
          }
        }
      }
      for (const v of trash) this.removed(v.id)
      for (const g of [...keep, ...takes]) this.changed(db.getGeneration(g.id))
      // Clips whose keyframes moved to Referensbilder (and generations whose params did) are read again.
      if (rewritten) this.pathsRewritten()
      this.notify(edit.id)
    })
  }

  // ── Versions ─────────────────────────────────────────────────────────────

  private versionOf(versionId: unknown): { edit: store.EditRow; version: db.StoredGeneration } {
    const g = db.getGeneration(store.safeId(versionId, 'versions-id'))
    const edit = g ? store.editOfVersion(g) : undefined
    if (!g || !edit) throw new Error('Versionen finns inte längre.')
    return { edit, version: g }
  }

  setCurrent(editId: unknown, versionId: unknown): Edit {
    const edit = store.requireEditRow(editId)
    const id = store.safeId(versionId, 'versions-id')
    if (!store.listVersions(edit).some((v) => v.id === id)) throw new Error('Versionen hör inte till redigeringen.')
    if (edit.current_generation_id !== id) {
      store.setEditCurrent(edit.id, id)
      this.notify(edit.id)
    }
    return this.get(edit.id)
  }

  /**
   * Versions that inherit a transcript from a version about to go (`gone`) get a copy of their own first: the
   * transcript was paid for (and may hold the user's corrections), and transcripts go with their generation.
   */
  private keepInheritedTranscripts(gone: ReadonlySet<string>, survivors: readonly string[]): void {
    for (const id of survivors) {
      if (gone.has(id)) continue
      const t = transcriptFor(id)
      if (!t?.inheritedFrom || !gone.has(t.inheritedFrom)) continue
      store.saveTranscript({
        generationId: id,
        segments: t.segments,
        source: store.storedTranscript(t.inheritedFrom)?.source ?? 'venice',
        model: t.model,
        language: t.language,
        createdAt: t.createdAt
      })
    }
  }

  /** Whether Redigera keeps the generation: a version (or export copy) of an edit, or the film an edit started from. */
  keeps(id: string): boolean {
    const g = db.getGeneration(id)
    return !!g && !!store.editOfVersion(g)
  }

  /**
   * Before a generation is deleted outside Redigera (the feed's Radera, a take list's): throws (Swedish) when
   * Redigera's rules keep it – a running operation works on it (or is putting it, a paid take, into a film), an edit
   * started from it, it is a version Redigera itself wouldn't delete, or a stopped job that has paid for parts builds on
   * it – and otherwise hands its transcript to the versions that inherit it.
   */
  beforeGenerationDelete(id: string): void {
    const g = db.getGeneration(id)
    if (!g) return
    if (store.runningJobsOnBase(id).length) {
      throw new Error('En pågående åtgärd i Redigera utgår från filmen. Vänta tills den är klar och försök igen.')
    }
    // A paid AI take being put into its edit's film right now.
    if (g.status === 'completed' && store.jobForTake(id)?.status === 'running') {
      throw new Error('Tagningen sätts in i en redigering just nu. Vänta tills den är klar och försök igen.')
    }
    const startedFrom = store.editsStartedFrom(id)[0]
    if (startedFrom) {
      throw new Error(`Filmen är originalet i redigeringen ”${startedFrom.name}”. Radera redigeringen först.`)
    }
    const edit = g.editId && g.source !== 'generated' ? store.getEditRow(g.editId) : undefined
    if (edit) {
      const refused = this.keepReason(edit, g)
      if (refused) throw new Error(refused)
    }
    // Outside Redigera nothing says so: the version is deleted there, where its confirm names what is lost.
    const paused = this.pausedPaidJob(id)
    if (paused) {
      throw new Error(
        `Ett avbrutet jobb i Redigera (”${paused.label}”) utgår från filmen och har redan betalat ` +
          `${formatPrice(paused.costUsd)}. Tryck Fortsätt på jobbet, eller radera versionen i Redigera.`
      )
    }
    this.keepInheritedTranscripts(new Set([id]), store.childrenOf(id))
  }

  /**
   * A stopped (failed or cancelled) job that builds on the version and has already paid for parts that "Fortsätt"
   * would use: they can't be used once the version is gone. Picture jobs don't count – their paid take stays among
   * the edit's takes whatever happens to the version.
   */
  private pausedPaidJob(versionId: string): EditJob | undefined {
    for (const job of store.jobsOnBase(versionId)) {
      if ((job.status !== 'failed' && job.status !== 'cancelled') || isPictureOp(job.op)) continue
      const view = this.ops.jobView(job)
      if (view.canResume && view.costUsd > 0) return view
    }
    return undefined
  }

  /** Why a version can't be removed, or undefined. */
  private keepReason(edit: store.EditRow, v: db.StoredGeneration): string | undefined {
    if (v.id === edit.origin_generation_id) return 'Originalet kan inte raderas.'
    const used = store.usedBy(v.id)[0]
    if (used) return `Versionen används i ”${used.sequenceName}” (klipp ${used.clipNumber}).`
    const other = store.editsStartedFrom(v.id, edit.id)[0]
    if (other) return `Versionen är original i redigeringen ”${other.name}”.`
    if (store.runningJobsOnBase(v.id).length) return 'En pågående åtgärd utgår från versionen.'
    return undefined
  }

  deleteVersion(versionId: unknown): Promise<Edit> {
    return this.fileTask(async () => {
      const { edit, version } = this.versionOf(versionId)
      const refused = this.keepReason(edit, version)
      if (refused) throw new Error(refused)
      const parent =
        version.parentId && db.getGeneration(version.parentId) ? version.parentId : edit.origin_generation_id
      db.getDb().transaction(() => {
        this.keepInheritedTranscripts(new Set([version.id]), store.childrenOf(version.id))
        // Its children hang under its parent, so the tree stays whole.
        store.reparentChildren(version.id, parent ?? null)
        if (edit.current_generation_id === version.id) store.setEditCurrent(edit.id, parent ?? null)
        else store.touchEdit(edit.id)
        db.deleteGeneration(version.id)
      })()
      for (const file of [version.filePath, version.thumbPath]) {
        if (file && existsSync(file)) await shell.trashItem(file).catch(() => {})
      }
      this.removed(version.id)
      this.notify(edit.id)
      return this.get(edit.id)
    })
  }

  /**
   * What "Rensa versioner…" removes: not v1, the current one or its ancestors, nor versions in use or that a stopped,
   * partly paid job builds on.
   */
  private prunable(edit: store.EditRow): db.StoredGeneration[] {
    const versions = store.listVersions(edit)
    const byId = new Map(versions.map((v) => [v.id, v]))
    const current = this.currentOf(edit, versions)
    const ancestors = new Set<string>()
    for (let g = current; g && !ancestors.has(g.id); g = g.parentId ? byId.get(g.parentId) : undefined) {
      ancestors.add(g.id)
    }
    // Nor what a stopped job that has paid for parts builds on: a clean-up must not make them unusable unasked.
    return versions.filter(
      (v) =>
        v.editId === edit.id &&
        v.source === 'edit' &&
        !ancestors.has(v.id) &&
        !this.keepReason(edit, v) &&
        !this.pausedPaidJob(v.id)
    )
  }

  prune(editId: unknown, dryRun: unknown): Promise<{ count: number; bytes: number }> {
    const work = async (): Promise<{ count: number; bytes: number }> => {
      const edit = store.requireEditRow(editId)
      const doomed = this.prunable(edit)
      let bytes = 0
      for (const v of doomed) {
        if (v.filePath) bytes += await stat(v.filePath).then((s) => s.size, () => 0)
      }
      if (dryRun !== false || !doomed.length) return { count: doomed.length, bytes }
      const gone = new Set(doomed.map((v) => v.id))
      const versions = store.listVersions(edit)
      const byId = new Map(versions.map((v) => [v.id, v]))
      db.getDb().transaction(() => {
        // Read while the doomed versions are still there: what a kept version inherits through them.
        this.keepInheritedTranscripts(gone, versions.map((v) => v.id))
        // Kept versions hang under their nearest kept ancestor.
        const update = db.getDb().prepare('UPDATE generations SET parent_id = ? WHERE id = ?')
        for (const v of versions) {
          if (gone.has(v.id) || !v.parentId || !gone.has(v.parentId)) continue
          let p: string | undefined = v.parentId
          const seen = new Set<string>()
          while (p && gone.has(p) && !seen.has(p)) {
            seen.add(p)
            p = byId.get(p)?.parentId
          }
          update.run(p ?? edit.origin_generation_id, v.id)
        }
        for (const v of doomed) db.deleteGeneration(v.id)
        store.touchEdit(edit.id)
      })()
      for (const v of doomed) {
        for (const file of [v.filePath, v.thumbPath]) {
          if (file && existsSync(file)) await shell.trashItem(file).catch(() => {})
        }
        this.removed(v.id)
      }
      this.notify(edit.id)
      return { count: doomed.length, bytes }
    }
    return dryRun === false ? this.fileTask(work) : work()
  }

  // ── Timeline ─────────────────────────────────────────────────────────────

  async timeline(generationId: unknown): Promise<EditTimeline> {
    const g = db.getGeneration(store.safeId(generationId))
    if (!g?.filePath || !existsSync(g.filePath)) throw new Error('Videofilen saknas (flyttad eller raderad i Finder).')
    const info = await probe(g.filePath)
    const cache = await this.timelineCache(g.filePath, info.hasAudio, info.duration)
    const recorded = g.recipe?.cuts
    const cuts = recorded?.length ? recorded : cache.scenes
    // A version plays its recipe's mix; anything else (an edit's v1) its own sound.
    const mix = g.source === 'edit' && g.recipe?.mix ? mixes.mixOf(g, false) : mixes.defaultMix(g.id)
    const transcript = transcriptFor(g.id)
    return {
      generationId: g.id,
      duration: info.duration,
      fps: info.fps,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
      filmstrip: cache.filmstrip,
      waveform: cache.waveform,
      cuts,
      cutsSource: recorded?.length ? 'export' : cache.scenes.length ? 'scenes' : 'none',
      layers: mixes.layerBars(mix),
      muted: mixes.mutedSpans(mix, info.duration),
      ...(transcript ? { transcript } : {})
    }
  }

  /** Filmstrip, waveform and scene cuts of a file, cached in .studio/tidslinje by its identity. */
  private async timelineCache(path: string, hasAudio: boolean, duration: number): Promise<TimelineCache> {
    const s = await stat(path)
    // The "2": waveforms are placed by time over the film since this was added; older entries are made again.
    const key = createKey(`${toStoredPath(path)}\n${s.size}\n${Math.round(s.mtimeMs)}\n2`)
    const running = this.timelines.get(key)
    if (running) return running
    const job = (async (): Promise<TimelineCache> => {
      const root = appDataDir(APP_DATA.timeline)
      const json = join(root, `${key}.json`)
      try {
        const cached = JSON.parse(await readFile(json, 'utf8')) as TimelineCache
        if (cached.filmstrip.every((f) => existsSync(f.path))) {
          // Touched for the LRU pruning at the next library open.
          await utimes(json, new Date(), new Date()).catch(() => {})
          return cached
        }
      } catch {
        // Not cached yet.
      }
      this.timelineWork++
      try {
        const count = Math.min(60, Math.max(10, Math.ceil(duration / 2)))
        const buckets = Math.min(4000, Math.max(400, Math.ceil(duration * 25)))
        const frames = await filmstrip(path, join(root, key), count)
        const silent = (): number[] => new Array<number>(buckets).fill(0)
        // Drawn across the film: the sound's peaks at the film's times (sound shorter or longer than the picture).
        const peaks = hasAudio ? await waveform(path, buckets, { duration }).catch(silent) : silent()
        const scenes = await sceneCuts(path).catch(() => [] as number[])
        const result: TimelineCache = { filmstrip: frames, waveform: peaks, scenes }
        await writeFile(json, JSON.stringify(result)).catch(() => {})
        return result
      } finally {
        this.timelineWork--
      }
    })()
    this.timelines.set(key, job)
    try {
      return await job
    } finally {
      this.timelines.delete(key)
    }
  }

  // ── Transcripts ──────────────────────────────────────────────────────────

  transcript(generationId: unknown): Transcript | null {
    return transcriptFor(store.safeId(generationId))
  }

  updateTranscript(generationId: unknown, patch: unknown): Transcript {
    const id = store.safeId(generationId)
    const t = transcriptFor(id)
    if (!t) throw new Error('Det finns ingen transkription att ändra.')
    const changes = (Array.isArray(patch) ? patch : []).filter(
      (p): p is { segmentId: string; text: string } =>
        !!p && typeof p === 'object' && typeof (p as { segmentId?: unknown }).segmentId === 'string' &&
        typeof (p as { text?: unknown }).text === 'string'
    )
    const segments = t.segments.map((s) => ({ ...s }))
    for (const c of changes) {
      const seg = segments.find((s) => s.id === c.segmentId)
      if (!seg) throw new Error('Repliken finns inte i transkriptionen.')
      const text = c.text.replace(/\s+/gu, ' ').trim()
      if (!text) throw new Error('En replik kan inte vara tom.')
      if (text !== seg.text) {
        seg.text = text
        seg.edited = true
        delete seg.words
      }
    }
    // An inherited transcript is copied first, so the ancestor's own stays as it was.
    store.saveTranscript({
      generationId: id,
      segments,
      source: 'edited',
      model: t.model,
      language: t.language,
      ...(t.inheritedFrom ? {} : { cost: t.costUsd }),
      createdAt: t.createdAt
    })
    const g = db.getGeneration(id)
    const edit = g ? store.editOfVersion(g) : undefined
    if (edit) this.notify(edit.id)
    return transcriptFor(id)!
  }

  async saveSubtitles(e: IpcMainInvokeEvent, generationId: unknown): Promise<string> {
    const id = store.safeId(generationId)
    const t = transcriptFor(id)
    if (!t?.segments.length) throw new Error('Det finns ingen transkription att spara.')
    const g = db.getGeneration(id)
    const title = safeName(g ? generationTitle(g, 80) : 'Undertexter', { max: 80, fallback: 'Undertexter' })
    const options: Electron.SaveDialogOptions = {
      defaultPath: join(app.getPath('downloads'), `${title}.srt`),
      filters: [{ name: 'Undertexter', extensions: ['srt'] }]
    }
    const win = e?.sender ? BrowserWindow.fromWebContents(e.sender) : null
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (res.canceled || !res.filePath) return ''
    await writeFile(res.filePath, toSrt(t.segments), 'utf8')
    return res.filePath
  }

  // ── Audio of an edit ─────────────────────────────────────────────────────

  addAudio(editId: unknown, paths: unknown): Promise<EditMedia[]> {
    return this.fileTask(async () => {
      const edit = store.requireEditRow(editId)
      const sources = [
        ...new Set((Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === 'string' && p !== ''))
      ]
      const allowed = new Set(AUDIO_FILE_TYPES.map((t) => `.${t}`))
      const files = sources.filter((p) => allowed.has(extname(p).toLowerCase()))
      if (!files.length) {
        if (sources.length) {
          throw new Error('Bara ljudfiler i MP3, WAV, M4A, AAC, AIFF, FLAC eller OGG kan läggas till.')
        }
        return []
      }
      // Every file is checked before anything is copied.
      const probed: { path: string; duration: number }[] = []
      for (const path of files) {
        const name = path.split('/').pop() ?? path
        let duration: number
        try {
          ;({ duration } = await probeAudio(path))
        } catch (err) {
          throw new Error(`${name}: ${errorText(err)}`)
        }
        if (!(duration > 0.05)) throw new Error(`Det finns inget ljud i ${name}.`)
        probed.push({ path, duration })
      }
      const added: EditMedia[] = []
      for (const p of probed) {
        const ext = extname(p.path)
        const label = (p.path.split('/').pop() ?? 'Ljud').slice(0, -ext.length || undefined)
        const media = await this.ops.addMediaFile(edit, p.path, { kind: 'audio', label, duration: p.duration })
        added.push(mediaView(media))
      }
      this.notify(edit.id)
      return added
    })
  }

  // ── Sending a version to a sequence ──────────────────────────────────────

  async send(versionId: unknown, target: unknown): Promise<{ sequenceId: string; segmentId: string }> {
    const { edit, version } = this.versionOf(versionId)
    if (version.status !== 'completed' || !version.filePath || !existsSync(version.filePath)) {
      throw new Error('Versionens videofil saknas (flyttad eller raderad i Finder).')
    }
    const t = (target && typeof target === 'object' ? target : {}) as Partial<SendTarget> & Record<string, unknown>
    const sequenceRow = (id: string): { id: string; kind: string; name: string } | undefined =>
      db.getDb().prepare('SELECT id, kind, name FROM sequences WHERE id = ?').get(id) as
        | { id: string; kind: string; name: string }
        | undefined
    const check = (sequenceId: string): void => {
      const row = sequenceRow(sequenceId)
      if (!row) throw new Error('Sekvensen finns inte längre.')
      if (row.kind === 'storyboard') throw new Error('Versioner kan bara skickas till sekvenser.')
      if (this.deps.sequences.get(sequenceId).running) {
        throw new Error('”Generera saknade” pågår för sekvensen. Vänta tills den är klar och försök igen.')
      }
    }
    let result: { sequenceId: string; segmentId: string }
    if (typeof t.segmentId === 'string') {
      const seg = db
        .getDb()
        .prepare('SELECT sequence_id FROM segments WHERE id = ?')
        .pluck()
        .get(store.safeId(t.segmentId)) as string | undefined
      if (!seg) throw new Error('Klippet finns inte längre.')
      check(seg)
      const res = await this.deps.sequences.addTakeFrom(t.segmentId, version.id, { select: true })
      result = { sequenceId: res.sequenceId, segmentId: res.segmentId }
    } else if (typeof t.sequenceId === 'string') {
      check(store.safeId(t.sequenceId))
      const res = await this.deps.sequences.insertSegment(t.sequenceId, {
        fromGenerationId: version.id,
        ...(typeof t.afterSegmentId === 'string' ? { afterSegmentId: t.afterSegmentId } : {})
      })
      result = { sequenceId: t.sequenceId, segmentId: res.segmentId }
    } else {
      throw new Error('Välj en sekvens att skicka versionen till.')
    }
    this.changed(db.getGeneration(version.id))
    this.notify(edit.id)
    return result
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  resume(): void {
    this.timelines.clear()
    this.ops.resumeAll()
    void pruneTimelineCache()
  }

  stop(): void {
    this.ops.stop()
  }

  onGenerationDeleted(id: string, deleted?: Partial<Pick<Generation, 'parentId' | 'editId'>>): void {
    if (!db.isDbOpen()) return
    const touched = new Set<string>()
    // An edit whose current version it was falls back on its parent, else v1, else its newest version.
    for (const edit of store.editsWithCurrent(id)) {
      store.setEditCurrent(edit.id, null)
      touched.add(edit.id)
    }
    const orphaned = db
      .getDb()
      .prepare('SELECT * FROM edits WHERE current_generation_id IS NULL')
      .all() as store.EditRow[]
    for (const edit of orphaned) {
      const versions = store.listVersions(edit)
      const parent = deleted?.parentId && versions.some((v) => v.id === deleted.parentId) ? deleted.parentId : undefined
      const fallback = parent ?? edit.origin_generation_id ?? versions[versions.length - 1]?.id ?? null
      if (fallback) store.setEditCurrent(edit.id, fallback)
      touched.add(edit.id)
    }
    // Versions built on it hang under its parent (or v1), so the tree stays whole.
    if (deleted?.editId) {
      const edit = store.getEditRow(deleted.editId)
      if (edit) {
        const parent =
          deleted.parentId && db.getGeneration(deleted.parentId) ? deleted.parentId : edit.origin_generation_id
        db.getDb()
          .prepare(
            `UPDATE generations SET parent_id = ?
             WHERE edit_id = ? AND source = 'edit' AND parent_id IS NULL AND id != ?`
          )
          .run(parent, edit.id, parent ?? '')
        touched.add(edit.id)
      }
    }
    for (const editId of store.listEditRows().filter((e) => e.origin_generation_id === null).map((e) => e.id)) {
      touched.add(editId)
    }
    this.ops.takeDeleted()
    for (const editId of touched) this.notify(editId)
  }
}

interface TimelineCache {
  filmstrip: { time: number; path: string }[]
  waveform: number[]
  scenes: number[]
}

/** Keeps .studio/tidslinje under TIMELINE_CACHE_BYTES, least recently used films first out. Never throws. */
async function pruneTimelineCache(cap = TIMELINE_CACHE_BYTES): Promise<void> {
  try {
    const root = appDataDir(APP_DATA.timeline)
    const entries: { json: string; dir: string; bytes: number; used: number }[] = []
    for (const name of await readdir(root)) {
      if (!name.endsWith('.json')) continue
      const json = join(root, name)
      const dir = join(root, name.slice(0, -'.json'.length))
      const info = await stat(json).catch(() => undefined)
      if (!info) continue
      let bytes = info.size
      for (const file of await readdir(dir).catch(() => [] as string[])) {
        bytes += (await stat(join(dir, file)).catch(() => undefined))?.size ?? 0
      }
      entries.push({ json, dir, bytes, used: info.mtimeMs })
    }
    let total = entries.reduce((sum, e) => sum + e.bytes, 0)
    for (const e of entries.sort((a, b) => a.used - b.used)) {
      if (total <= cap) break
      await rm(e.json, { force: true })
      await rm(e.dir, { recursive: true, force: true })
      total -= e.bytes
    }
  } catch (err) {
    console.warn('Pruning the timeline cache failed:', err)
  }
}

function createKey(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/**
 * Registers every edits:*, audio:* and voices:* channel. Handlers that only the user may use refuse an agent's call
 * (a second line of defence behind the agents' tool list).
 */
export function registerEditIpc(deps: EditDeps): EditServiceHandle {
  const service = new EditService(deps)
  const ops = service.ops
  const userOnly = (e: IpcMainInvokeEvent): void => {
    if (isAgentCall(e)) throw new Error(USER_ONLY)
  }

  ipcMain.handle('edits:list', (): EditSummary[] => service.list())
  ipcMain.handle('edits:get', (_e, id: unknown): Edit => service.get(id))
  ipcMain.handle('edits:create', (_e, source: unknown, name?: unknown): Promise<Edit> => service.create(source, name))
  ipcMain.handle('edits:rename', (_e, id: unknown, name: unknown): Promise<Edit> => service.rename(id, name))
  ipcMain.handle('edits:delete', (e, id: unknown): Promise<void> => {
    userOnly(e)
    return service.delete(id)
  })
  ipcMain.handle('edits:setCurrent', (_e, editId: unknown, versionId: unknown): Edit =>
    service.setCurrent(editId, versionId)
  )
  ipcMain.handle('edits:deleteVersion', (e, versionId: unknown): Promise<Edit> => {
    userOnly(e)
    return service.deleteVersion(versionId)
  })
  ipcMain.handle('edits:prune', (e, editId: unknown, dryRun: unknown): Promise<{ count: number; bytes: number }> => {
    userOnly(e)
    return service.prune(editId, dryRun)
  })
  ipcMain.handle('edits:timeline', (_e, generationId: unknown): Promise<EditTimeline> => service.timeline(generationId))
  ipcMain.handle('edits:plan', (_e, editId: unknown, op: unknown, baseId?: unknown): Promise<EditPlan> =>
    ops.plan(editId, op, baseId)
  )
  ipcMain.handle(
    'edits:run',
    (_e, editId: unknown, op: unknown, opts?: EditRunOptions): Promise<EditRunResult> =>
      ops.run(editId, op as EditOperation, (opts && typeof opts === 'object' ? opts : {}) as EditRunOptions)
  )
  ipcMain.handle('edits:cancel', (_e, jobId: unknown): void => ops.cancel(jobId))
  ipcMain.handle(
    'edits:resume',
    (_e, jobId: unknown, expectedPriceUsd?: unknown, expectedPartial?: unknown): Promise<EditJob> =>
      ops.resume(jobId, expectedPriceUsd, expectedPartial)
  )
  ipcMain.handle('edits:transcript', (_e, generationId: unknown): Transcript | null => service.transcript(generationId))
  ipcMain.handle('edits:updateTranscript', (_e, generationId: unknown, patch: unknown): Transcript =>
    service.updateTranscript(generationId, patch)
  )
  ipcMain.handle('edits:srt', (e, generationId: unknown): Promise<string> => {
    userOnly(e)
    return service.saveSubtitles(e, generationId)
  })
  ipcMain.handle('edits:addAudio', (e, editId: unknown, paths: unknown): Promise<EditMedia[]> => {
    userOnly(e)
    return service.addAudio(editId, paths)
  })
  ipcMain.handle('edits:send', (_e, versionId: unknown, target: unknown) => service.send(versionId, target))
  ipcMain.handle('audio:models', (_e, force?: unknown): Promise<AudioCatalog> => ops.catalog(force === true))
  ipcMain.handle('audio:separation', (): Promise<SeparationStatus> => separationStatus())
  ipcMain.handle('voices:plan', (_e, req: unknown): Promise<EditPlan> => ops.planVoiceDesign(req))
  ipcMain.handle('voices:design', (_e, req: unknown, expectedPriceUsd?: unknown): Promise<EditJob> =>
    ops.designVoice(req, expectedPriceUsd)
  )
  ipcMain.handle('voices:consent', async (e, audioId: unknown, consent: unknown) => {
    userOnly(e)
    const asset = await setVoiceCloneConsent(audioId as string, consent === true)
    // Withdrawn: the handles made with it go too (lines already planned are refused before they are sent).
    if (consent !== true && typeof audioId === 'string') {
      try {
        store.forgetClones(audioId)
      } catch (err) {
        console.warn('Forgetting the clones of a voice failed:', err)
      }
    }
    // Other open views (Generera's pickers, Redigera's clone picker, an approval dialog) show the consent too.
    deps.libraryChanged?.()
    return asset
  })

  return {
    isBusy: () => service.isBusy(),
    keeps: (id) => service.keeps(id),
    beforeGenerationDelete: (id) => service.beforeGenerationDelete(id),
    resume: () => service.resume(),
    onGenerationDeleted: (id, deleted) => service.onGenerationDeleted(id, deleted),
    stop: () => service.stop()
  }
}
