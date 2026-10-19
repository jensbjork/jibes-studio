import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type BrowserWindowConstructorOptions,
  type MenuItemConstructorOptions,
  type OpenDialogOptions
} from 'electron'
import type {
  EditProgress,
  ExportProgress,
  Generation,
  GenerationParams,
  ImportProgress,
  VideoModel,
  WorkSummary
} from '@shared/types'
import { variantsPrice } from '@shared/variants'
import { AgentService, recordIpcHandlers, registerAgentIpc } from './agent'
import { isAgentCall } from './agent/local-ipc'
import { assertWithinBudget } from './budget'
import * as db from './db'
import { registerEditIpc, type EditServiceHandle } from './edits'
import { ffmpegStatus, stopAllFfmpeg } from './ffmpeg'
import { registerImportIpc, VIDEO_FILE_TYPES, type ImportService } from './imports'
import { JobManager, prepareSubmission, toPublic } from './jobs'
import { assetWorkBusy, AUDIO_FILE_TYPES, registerLibraryIpc } from './library'
import { archiveBusyReason, registerArchiveIpc, stopLibraryArchive } from './library-archive'
import { prepareLibrary, registerLibraryRootIpc } from './library-root'
import { isInsideRoot, libraryOperationSettled, removeDayFolderIfEmpty, toStoredPath } from './paths'
import { handleMediaProtocol, registerMediaScheme } from './media-protocol'
import { IS_MAC, IS_WINDOWS } from './platform'
import { attachReviewSummary, registerReviewIpc } from './reviews'
import { registerSessionIpc } from './session'
import { registerSpendingIpc } from './spending'
import { reselectTransitionTake } from './sequence-store'
import { registerSequenceIpc, type SequenceService } from './sequences'
import { registerSongIpc, type SongService } from './song'
import { registerSongSyncIpc } from './song-sync'
import { registerStoryboardIpc, type StoryboardService } from './storyboards'
import { setTaskbarBadge, showTaskbarBadgeOn } from './taskbar'
import { acceptConsent, getApiKey, getSettings, setApiKey, setImageSafeMode, setPromptLanguage } from './settings'
import {
  activeStills,
  importStillFile,
  registerStillsIpc,
  saveFrameAsStill,
  setStillWorkListener,
  stillWorkBusy
} from './stills'
import { VeniceClient } from './venice'
import { VeniceAudio } from './venice-audio'
import { sendOptionsOf, sendVariants } from './variants'
import { separationStatus } from './voice-separation'
import { registerWorkIpc, WorkStatus } from './work'

// `npm run dev` runs as "Studio Dev": its own settings (API key, chosen base folder) and suggested base folder
// (~/Movies/Studio Dev), so what we try out while developing never touches the library Studio.app uses — and both
// can run at the same time. `npm run dev:real` leaves this unset and runs against the real profile.
if (process.env.STUDIO_DEV_PROFILE) {
  app.setName('Studio Dev')
  app.setPath('userData', join(app.getPath('appData'), 'Studio Dev'))
}

// For trying things out without touching the real profile: STUDIO_PROFILE_DIR=/tmp/x npm run dev keeps settings
// (incl. the chosen base folder) and the default library location under that folder.
if (process.env.STUDIO_PROFILE_DIR) {
  app.setPath('userData', join(process.env.STUDIO_PROFILE_DIR, 'userData'))
  app.setPath('videos', join(process.env.STUDIO_PROFILE_DIR, 'Movies'))
}

/** electron-builder.yml's appId, put in at build time (electron.vite.config.ts). */
declare const __STUDIO_APP_ID__: string

// Windows groups the taskbar button, notifications and the Start menu shortcut by this id: the appId, which the
// installer gives the shortcut. Studio Dev gets its own, so the two never share a button.
if (IS_WINDOWS) app.setAppUserModelId(process.env.STUDIO_DEV_PROFILE ? `${__STUDIO_APP_ID__}.dev` : __STUDIO_APP_ID__)

// Studio.app and `npm run dev` share settings and the library. Two instances would both poll and download the
// same paid Venice jobs, so a second launch only brings the running one to the front.
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

registerMediaScheme()
// The agent connection's tools call the same handlers as the window; they are recorded as they are registered.
recordIpcHandlers()

const venice = new VeniceClient(getApiKey)
/** Venice's speech, music, transcription and voice endpoints (the Editor and voice design). */
const audio = new VeniceAudio(getApiKey)
// Submits read the models' prompt limits (for the descriptions appended to a prompt) from main's cached list.
const jobs = new JobManager(venice, () => loadVideoModels())
let modelCache: { at: number; models: VideoModel[] } | undefined
/** Exports and "generate all" runs (of sequences and storyboards); set once their handlers are registered. */
let sequencesBusy: () => string | undefined = () => undefined
/** Imports of own clips (Egna klipp); set once their handlers are registered. */
let importsService: { isBusy(): string | undefined; stop(): void; service: ImportService } | undefined
/** The Editor: edits, versions and their paid jobs; set once its handlers are registered. */
let editsService: EditServiceHandle | undefined
/** Sequences (their clips and takes); set once their handlers are registered. */
let sequenceService: SequenceService | undefined
/** Storyboards (their boards, transitions and runs); set once their handlers are registered. */
let storyboardService: StoryboardService | undefined
/** Songs of sequences (their files, vocals, lyrics and analysis); set once their handlers are registered. */
let songService: SongService | undefined
/**
 * Activity: what runs and what finished unseen, pushed to the windows. Created once every service it reads
 * is registered; until then (and the agent connection, made before it, reads it lazily) nothing is observed.
 */
let work: WorkStatus | undefined
/** The number on the Dock icon: finished and failed work the user hasn't looked at. */
let dockBadge = 0

/** Second line of defence behind the agents' tool list: what only the user may do in Studio. */
const USER_ONLY = 'Only you can do this in Studio.'

/**
 * macOS: the content runs up under the title bar, the traffic lights inset into it. Windows (and Linux): the system's
 * own frame, dark on Windows (see whenReady), without a menu bar (see windowsMenu).
 */
const WINDOW_CHROME: BrowserWindowConstructorOptions = IS_MAC
  ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } }
  : {}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0b0d',
    ...WINDOW_CHROME,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.on('ready-to-show', () => win.show())
  if (IS_WINDOWS) {
    // The menu's shortcuts work, its bar is never shown: not auto-hidden either, since Alt (Alt+click, Alt+drag in
    // Studio's lists and timelines) would bring an auto-hidden bar up whenever it is let go.
    win.setMenuBarVisibility(false)
    // Windows draws the badge per window, once its taskbar button is there.
    win.once('show', () => showTaskbarBadgeOn(win))
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Dropping a file outside a drop target would otherwise navigate the whole window to that file.
  win.webContents.on('will-navigate', (e) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && e.url.startsWith(devUrl)) return
    e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

/**
 * Sends an event to every open window. Every service announces its changes here, so the status summary hears of them
 * here too (it pushes its own 'work:change' through it as well).
 */
function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
  if (channel !== 'work:change') work?.observe(channel, payload)
}

/** A new status summary: to the windows, and its count of new and failed work onto the Dock icon (taskbar button). */
function sendWork(summary: WorkSummary): void {
  broadcast('work:change', summary)
  const count = summary.total.unseen + summary.total.failed
  if (count === dockBadge) return
  dockBadge = count
  try {
    if (IS_WINDOWS) setTaskbarBadge(count)
    else app.dock?.setBadge(count ? String(count) : '')
  } catch (err) {
    console.warn('Could not set the Dock badge:', err)
  }
}

/**
 * Sends a changed generation to the feed with the user's rating and its review count: rows carry neither, and
 * an update without them would wipe the rating off its card.
 */
function broadcastGeneration(g: Generation): void {
  broadcast('generation:update', attachReviewSummary([g])[0])
}

/**
 * A generation the import or edit service inserted or changed (completed rows that never pass the job manager):
 * given as the row or its id, it is read again and sent to the feed, sequences and frame pickers.
 */
function generationChanged(g: Generation | string): void {
  if (!db.isDbOpen()) return
  const row = db.getGeneration(typeof g === 'string' ? g : g.id)
  if (row) broadcastGeneration(toPublic(row))
}

/**
 * The MCP server the user's own agents connect to (off until they switch it on in Settings). Uploads coming in and
 * approved requests being carried out broadcast nothing of their own: they tell the status summary directly.
 */
const agent = new AgentService({ broadcast, workChanged: (kind) => work?.touch(kind) })

/**
 * Why the library folder can't be switched or tidied right now; undefined when idle. Files of
 * running jobs, exports and runs would otherwise end up in the wrong place (or the wrong library).
 */
function libraryBusyReason(): string | undefined {
  if (jobs.hasActiveJobs()) return 'Generations are running. Wait until they are done and try again.'
  // An approved request (a batch of deletes, say) works through the library item by item: never across a switch.
  if (agent.approvals.executing().length) {
    return "An agent's request is being carried out right now. Wait until it is done and try again."
  }
  // An import copying a film in, or an edit job (a half-sent paid job's runner must never be carried into another
  // library), would otherwise write into the wrong folder. An export of the whole library (Export och import) reads
  // every file: it is last, so the export itself can still ask whether anything else runs.
  return (
    sequencesBusy() ??
    songService?.isBusy() ??
    importsService?.isBusy() ??
    editsService?.isBusy() ??
    assetWorkBusy() ??
    stillWorkBusy() ??
    archiveBusyReason()
  )
}

/** The video model list, fetched at most every ten minutes unless forced (GET /models is free). */
async function loadVideoModels(force = false): Promise<VideoModel[]> {
  if (!force && modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models
  modelCache = { at: Date.now(), models: await venice.listVideoModels() }
  return modelCache.models
}

/**
 * A sequence or a storyboard changed: each has its own view, listening on its own channel. A row that is gone
 * (just deleted) is announced as a sequence; the storyboard service announces its own deletes.
 */
function broadcastSequenceChange(id: string): void {
  const kind = db.isDbOpen() ? db.getDb().prepare('SELECT kind FROM sequences WHERE id = ?').pluck().get(id) : undefined
  broadcast(kind === 'storyboard' ? 'storyboard:change' : 'sequence:change', id)
}

/**
 * Every sequence and storyboard refetches: image paths in segment params, board images or take paths may have been
 * rewritten.
 */
function broadcastAllSequences(): void {
  if (!db.isDbOpen()) return
  const rows = db.getDb().prepare('SELECT id, kind FROM sequences').all() as { id: string; kind: string }[]
  for (const r of rows) broadcast(r.kind === 'storyboard' ? 'storyboard:change' : 'sequence:change', r.id)
}

/**
 * Re-sends to the feed the generations whose stored paths were rewritten (db.takeRewrittenGenerations) and any
 * others given: the feed loads its list once, so it would go on filtering by, showing and reusing old paths.
 */
function broadcastRewrittenGenerations(more: readonly string[] = []): void {
  if (!db.isDbOpen()) return
  const moved = [...new Set([...more, ...db.takeRewrittenGenerations()])].flatMap((id) => {
    const g = db.getGeneration(id)
    return g ? [toPublic(g)] : []
  })
  for (const g of attachReviewSummary(moved)) broadcast('generation:update', g)
}

/** Stills whose paths a rewrite changed (a renamed asset folder they were made from, say): every strip refetches. */
function broadcastRewrittenStills(): void {
  if (db.isDbOpen() && db.takeRewrittenStills()) broadcast('stills:change')
}

/** After "Tidy up" files may live elsewhere: views refetch, and moved generations are re-sent to the feed. */
function broadcastLibraryReorganized(movedGenerationIds: string[]): void {
  broadcast('library:change')
  broadcastAllSequences()
  broadcastRewrittenGenerations(movedGenerationIds)
  db.takeRewrittenStills()
  broadcast('stills:change')
}

function registerIpc(): void {
  // A finished or failed video is news until the user looks at it (Activity). An edit's AI take isn't: the
  // version its job makes of it is. Registered before any library opens, so a job settled at resume counts too.
  jobs.on('settled', (g: Generation) => {
    if (!g.editId) db.addUnseen({ generationId: g.id })
  })
  // A take uploading to Venice broadcasts nothing until Venice has it.
  jobs.on('sending', () => work?.touch('structure'))
  setStillWorkListener(() => work?.touch('structure'))
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:setApiKey', (_e, key: string) => setApiKey(key))
  ipcMain.handle('settings:setPromptLanguage', (_e, lang: unknown) => setPromptLanguage(lang))
  ipcMain.handle('settings:setImageSafeMode', (_e, on: unknown) => {
    setImageSafeMode(on)
    // Settings and the image dialogs each show it: the others follow a change made in one of them.
    broadcast('settings:change')
  })
  // Settings → Spending: what was paid for (also get_spending) and the budget, which only the user sets.
  registerSpendingIpc(() => broadcast('settings:change'))
  ipcMain.handle('settings:testApiKey', async () => {
    try {
      const balances = await venice.balances()
      const summary = Object.entries(balances)
        .map(([k, v]) => `${k}: ${Number(v).toFixed(2)}`)
        .join(' · ')
      return { ok: true, message: summary ? `The key works. Balance: ${summary}` : 'The key works.' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('ffmpeg:status', () => ffmpegStatus())

  ipcMain.handle('models:list', (_e, force?: boolean) => loadVideoModels(force === true))

  ipcMain.handle('video:quote', (_e, params: GenerationParams) => venice.quote(params))
  // `opts`: GenerateOptions – the variants (1–4 takes of the same form, each its own generation) and the
  // over-budget confirmation; resolves with the first take, the others reach the window as generation updates.
  // `sentPrompt`: an agent's approved request only (see below).
  ipcMain.handle('video:generate', async (e, params: GenerationParams, opts?: unknown, sentPrompt?: unknown) => {
    const { count, confirmOverBudget, onSent } = sendOptionsOf(opts)
    // Counted as on its way from the start: a library switch must not close the database while the price
    // is quoted, or the job would be paid for and then have nowhere to be recorded.
    const release = jobs.holdSubmit()
    try {
      // Checked, canonicalised and its audio clips measured before the quote: a voice that turns out too long
      // is refused here rather than after a network round trip (submit checks again; it is idempotent).
      const p = await prepareSubmission(params)
      const quote = await venice.quote(p).catch(() => undefined)
      // Every variant together, before any of them is sent.
      assertWithinBudget(variantsPrice(quote, count), { confirmed: confirmOverBudget })
      // An agent's approved request sends the composed prompt the user approved (and its check compared just
      // now), not one composed again after the quote's round trip from descriptions that may have changed since.
      const approved = isAgentCall(e) && typeof sentPrompt === 'string' ? { sentPrompt } : {}
      const [first] = await sendVariants(count, () => jobs.submit(p, { quote, ...approved }), onSent)
      return first
    } finally {
      release()
    }
  })

  ipcMain.handle('consent:accept', (_e, flow: string, version: string) => acceptConsent(flow, version))
  // A finished video that is gone (moved or deleted in Finder) is flagged, so pickers leave it out and views say so.
  ipcMain.handle('generations:list', () =>
    attachReviewSummary(
      db.listGenerations().map((g) => {
        const pub = toPublic(g)
        return g.status === 'completed' && g.filePath && !existsSync(g.filePath) ? { ...pub, fileMissing: true } : pub
      })
    )
  )
  ipcMain.handle('generations:delete', async (_e, id: string, from?: unknown) => {
    // Not while "Tidy up" or a switch moves files: the video could be moved away from the path trashed here.
    await libraryOperationSettled()
    const g = db.getGeneration(id)
    if (!g) return
    // A take list (a sequence clip's or a storyboard transition's): a film the Editor keeps (a version sent as a take, an
    // edit's original) is only taken off the clip; deleting it would take it out of its edit (and an edit's original
    // away from all its versions). So is one the list offered "Remove" for (`release`: it showed the take as kept,
    // which may have changed since), so the click never does more than the button said.
    const { segmentId, release } = (from && typeof from === 'object' ? from : {}) as {
      segmentId?: unknown
      release?: unknown
    }
    if (typeof segmentId === 'string' && sequenceService && (release === true || editsService?.keeps(id))) {
      await sequenceService.releaseTake(segmentId, id)
      return
    }
    // The Editor's rules hold here too: nothing a running (paid) operation or a stopped one that has paid for parts works
    // on, no edit's original, no version the Editor itself would refuse to delete. Throws; the caller shows the message.
    editsService?.beforeGenerationDelete(id)
    // Deleting a take changes the sequence it belongs to (FKs clear segment selections).
    const sequenceIds = db
      .getDb()
      .prepare('SELECT DISTINCT sequence_id FROM segments WHERE id = ? OR selected_generation_id = ?')
      .pluck()
      .all(g.segmentId ?? null, id) as string[]
    // Storyboard transitions that use it as their take fall back on another of theirs (reselectTransitionTake).
    const transitions = db
      .getDb()
      .prepare('SELECT id FROM segments WHERE selected_generation_id = ? AND from_board_id IS NOT NULL')
      .pluck()
      .all(id) as string[]
    // The row goes in the same tick as the read: a video that is being moved or saved right now then finds
    // its row gone and is trashed by whoever moves it, rather than landing somewhere untracked.
    db.deleteGeneration(id)
    for (const segmentId of transitions) reselectTransitionTake(segmentId)
    // Only the library's own copies: a path outside it (e.g. an old library copied elsewhere by hand) is
    // somebody else's file.
    for (const file of [g.filePath, g.thumbPath]) {
      if (file && isInsideRoot(file)) await shell.trashItem(file).catch(() => unlink(file).catch(() => {}))
    }
    // An import's untouched original (its file is then a working copy), unless another row still records it (a
    // copy of the take in another clip shares the original): otherwise a multi-GB file stays behind untracked.
    const original = g.originalPath
    if (original && isInsideRoot(original) && !db.isStoredPathRecorded(toStoredPath(original))) {
      await shell.trashItem(original).catch(() => unlink(original).catch(() => {}))
      await removeDayFolderIfEmpty(dirname(original))
    }
    if (g.filePath) await removeDayFolderIfEmpty(dirname(g.filePath))
    // An edit whose current version this was falls back on its parent (or v1); versions built on it hang under its
    // parent. The row as it was tells the service where it sat.
    try {
      editsService?.onGenerationDeleted(id, { parentId: g.parentId, editId: g.editId })
    } catch (err) {
      console.error('Updating the edits after a deleted generation failed:', err)
    }
    // Every view drops it, also the feed when the take was deleted in the sequence editor.
    broadcast('generation:delete', id)
    for (const sequenceId of sequenceIds) broadcastSequenceChange(sequenceId)
  })

  ipcMain.handle('file:reveal', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('file:pickImages', async (e, multiple: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showOpenDialog(win, {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    })
    return res.canceled ? [] : res.filePaths
  })
  ipcMain.handle('file:pickAudio', async (e, multiple: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showOpenDialog(win, {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Audio', extensions: [...AUDIO_FILE_TYPES] }]
    })
    return res.canceled ? [] : res.filePaths
  })
  // Own clips: only the user picks files from disk (an agent imports what it uploaded, never a dialog's choice).
  ipcMain.handle('file:pickVideos', async (e, multiple: boolean) => {
    if (isAgentCall(e)) throw new Error(USER_ONLY)
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: OpenDialogOptions = {
      properties: multiple === true ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Videos', extensions: [...VIDEO_FILE_TYPES] }]
    }
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return res.canceled ? [] : res.filePaths
  })

  registerLibraryIpc(
    () => broadcast('library:change'),
    // A renamed asset folder (or a used photo or voice kept when its asset went) rewrote the image and audio paths
    // in segment and generation params: open segment editors refetch, and the feed gets those generations again.
    () => {
      broadcastAllSequences()
      broadcastRewrittenGenerations()
      broadcastRewrittenStills()
    }
  )
  // Reviews and learnings, from the window and from agents; changes go to every window. A review also changes
  // the rating and count its generation's card shows, so the generation is sent again too.
  registerReviewIpc((channel, payload) => {
    broadcast(channel, payload)
    if (channel !== 'review:change' || typeof payload !== 'string' || !db.isDbOpen()) return
    const g = db.getGeneration(payload)
    if (g) broadcastGeneration(toPublic(g))
  })
  const sequences = registerSequenceIpc({
    jobs,
    venice,
    // A storyboard's takes, folder and export run here too; its view hears about them on its own channel.
    notify: (sequenceId: string) => broadcastSequenceChange(sequenceId),
    exportProgress: (p: ExportProgress) => broadcast('export:progress', p),
    models: () => loadVideoModels(),
    // Keyframe slots that get a file or a frame make a still of the sequence (stills.ts announces it).
    stills: {
      importFile: (path, sequenceId) => importStillFile(path, sequenceId),
      saveFrame: (generationId, time, sequenceId) => saveFrameAsStill(generationId, time, sequenceId)
    },
    stillsChanged: (sequenceId) => broadcast('stills:change', sequenceId),
    // A take on its way to Venice, a run or an export started or stopped (nothing else announces a take's upload).
    workChanged: () => work?.touch('structure')
  })
  // Song clips: where a finished take sings against the song, and the cut that follows (songs:syncTake).
  registerSongSyncIpc({ jobs, sequences, notify: (sequenceId: string) => broadcastSequenceChange(sequenceId) })
  // Storyboards: boards and their transitions, which are segments the sequence service generates, keeps and exports.
  const storyboards = registerStoryboardIpc({
    sequences,
    notify: (storyboardId: string) => broadcast('storyboard:change', storyboardId),
    // A board that gets a file or a frame makes a still of the storyboard (stills.ts announces it).
    stills: {
      importFile: (path, storyboardId) => importStillFile(path, storyboardId),
      saveFrame: (generationId, time, storyboardId) => saveFrameAsStill(generationId, time, storyboardId)
    },
    models: () => loadVideoModels(),
    workChanged: () => work?.touch('structure')
  })
  sequencesBusy = () => sequences.isBusy() ?? storyboards.isBusy()
  sequenceService = sequences
  storyboardService = storyboards
  // A sequence's song: copied in, its vocals separated, its lyrics transcribed and its beat found, in the background
  // (the rules of its clips are the sequence service's). Its changes reach the sequence's view like any other.
  songService = registerSongIpc({
    sequences,
    audio,
    notify: (sequenceId: string) => broadcastSequenceChange(sequenceId),
    workChanged: () => work?.touch('structure')
  })
  // Own clips: films copied into Egna klipp and added to the feed, a sequence or a clip.
  importsService = registerImportIpc({
    sequences,
    progress: (p: ImportProgress) => broadcast('import:progress', p),
    generationChanged,
    notifySequence: (sequenceId: string) => broadcastSequenceChange(sequenceId)
  })
  // The Editor: edits, their versions and paid jobs, transcripts, audio models, voice design and clone consent.
  editsService = registerEditIpc({
    jobs,
    venice,
    audio,
    sequences,
    models: () => loadVideoModels(),
    notify: (editId: string) => broadcast('edit:change', editId),
    progress: (p: EditProgress) => broadcast('edit:progress', p),
    generationChanged,
    // A version or an export clone the service removed: every list drops it, as after generations:delete.
    generationDeleted: (id: string) => broadcast('generation:delete', id),
    // A deleted edit's files that clips still used moved to Referensbilder: sequences and the feed read them again.
    pathsRewritten: () => {
      broadcastAllSequences()
      broadcastRewrittenGenerations()
      broadcastRewrittenStills()
    },
    // A designed voice added to a character, or clone consent changed: asset lists and pickers refetch.
    libraryChanged: () => broadcast('library:change')
  })
  // Images and stills for storyboards. A deleted still that clips or generations still use is kept in
  // Referensbilder, which rewrites their paths: views showing them refetch.
  registerStillsIpc(
    (sequenceId) => broadcast('stills:change', sequenceId),
    () => {
      broadcastAllSequences()
      broadcastRewrittenGenerations()
      broadcastRewrittenStills()
    }
  )

  // Activity: reads every service above (and the agent connection's requests and uploads).
  const status = new WorkStatus({
    jobs,
    sequences: () => sequenceService,
    storyboards: () => storyboardService,
    edits: () => editsService,
    imports: () => importsService?.service,
    stills: activeStills,
    songs: () => songService?.activeWork() ?? [],
    approvals: () => ({ executing: agent.approvals.executing(), decided: agent.approvals.list() }),
    uploads: () => agent.uploads.active(),
    send: sendWork
  })
  work = status
  registerWorkIpc(status)

  registerLibraryRootIpc({
    busy: libraryBusyReason,
    onOpened: () => {
      jobs.resume()
      // Picks up edit jobs: parts already sent are fetched, nothing paid is sent (a job waits for "Continue").
      try {
        editsService?.resume()
      } catch (err) {
        console.error('Resuming the edits failed:', err)
      }
      agent.libraryOpened()
      // Another library: its own unseen work, and nothing of the previous one's.
      status.reset()
    },
    // No library: the windows and the Dock badge hear that nothing runs and nothing is new any more.
    onClosed: () => status.reset(),
    onReorganized: broadcastLibraryReorganized,
    beforeClose: async () => {
      await jobs.pauseBackfill()
      // Uploads still coming in stop before the folder they write into is switched or moved; not when the switch is
      // about to be refused anyway (something else still runs).
      if (!libraryBusyReason()) agent.libraryClosing()
    }
  })

  // Export och import: the whole library to a zip and back, only from the window (agents are refused).
  registerArchiveIpc({ busy: libraryBusyReason })
  registerSessionIpc()

  registerAgentIpc(agent)
}

/**
 * Windows' menu, never shown (createWindow hides its bar), only for its shortcuts: Ctrl+0, Ctrl+= and Ctrl+- zoom,
 * F11 full screen and, in development only, Ctrl+R reload and Ctrl+Shift+I the developer tools. No Edit menu: text
 * fields copy, paste and undo by themselves on Windows. macOS keeps Electron's default menu.
 */
function windowsMenu(): Menu {
  const view: MenuItemConstructorOptions[] = [
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]
  if (!app.isPackaged) view.push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' })
  return Menu.buildFromTemplate([{ label: 'View', submenu: view }])
}

void app.whenReady().then(async () => {
  if (!isPrimaryInstance) return
  if (IS_WINDOWS) {
    // The native title bar follows the app's dark look rather than the system's light one.
    nativeTheme.themeSource = 'dark'
    Menu.setApplicationMenu(windowsMenu())
  }
  handleMediaProtocol()
  jobs.on('update', (g: Generation) => broadcastGeneration(g))
  registerIpc()
  // Opens the chosen base folder (converting an old layout, clearing scratch files) and resumes pending
  // jobs. Without a usable folder the window still opens, on the library setup screen.
  try {
    await prepareLibrary()
  } catch (err) {
    console.error('Preparing the library failed:', err)
  }
  createWindow()
  // Asks the voice separation helper once in the background (free, local), so Settings and the Editor's sound
  // cards know at once whether removing the voice and keeping only the background can be offered.
  void separationStatus().catch((err: unknown) => console.warn('Checking voice separation failed:', err))
  // Agents can connect from now on; tools that need the library say so while none is open.
  void agent.startIfEnabled().catch((err: unknown) => console.error('Starting the agent connection failed:', err))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  // No agent may start anything while the app shuts down.
  agent.shutdown()
  // Imports and edit jobs stop where they are: an interrupted paid job waits for "Continue" at the next start.
  for (const service of [importsService, editsService]) {
    try {
      service?.stop()
    } catch (err) {
      console.error('Stopping a service failed:', err)
    }
  }
  // Exports and frame grabs must not outlive the app or leave their half-written files behind; nor may a library
  // export or import (its partial zip or unpacked folder goes).
  stopAllFfmpeg()
  stopLibraryArchive()
  // Folds the WAL back into studio.db, leaving a single file in .studio.
  db.closeDb()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
