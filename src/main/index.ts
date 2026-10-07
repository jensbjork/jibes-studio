import { dirname, join } from 'node:path'
import { unlink } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { ExportProgress, Generation, GenerationParams, VideoModel } from '@shared/types'
import { AgentService, recordIpcHandlers, registerAgentIpc } from './agent'
import * as db from './db'
import { ffmpegStatus, stopAllFfmpeg } from './ffmpeg'
import { JobManager, prepareSubmission, toPublic } from './jobs'
import { assetWorkBusy, AUDIO_FILE_TYPES, registerLibraryIpc } from './library'
import { prepareLibrary, registerLibraryRootIpc } from './library-root'
import { isInsideRoot, libraryOperationSettled, removeDayFolderIfEmpty } from './paths'
import { handleMediaProtocol, registerMediaScheme } from './media-protocol'
import { attachReviewSummary, registerReviewIpc } from './reviews'
import { registerSequenceIpc } from './sequences'
import { acceptConsent, getApiKey, getSettings, setApiKey, setPromptLanguage } from './settings'
import { VeniceClient } from './venice'

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
const jobs = new JobManager(venice)
let modelCache: { at: number; models: VideoModel[] } | undefined
/** Exports and "generate all" runs; set once the sequence handlers are registered. */
let sequencesBusy: () => string | undefined = () => undefined

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0b0d',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.on('ready-to-show', () => win.show())
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

/** Sends an event to every open window. */
function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

/**
 * Sends a changed generation to the feed with the user's stars and its review count: rows carry neither, and
 * an update without them would wipe the rating off its card.
 */
function broadcastGeneration(g: Generation): void {
  broadcast('generation:update', attachReviewSummary([g])[0])
}

/** The MCP server the user's own agents connect to (off until they switch it on in Settings). */
const agent = new AgentService({ broadcast })

/**
 * Why the library folder can't be switched or tidied right now, in Swedish; undefined when idle. Files of
 * running jobs, exports and runs would otherwise end up in the wrong place (or the wrong library).
 */
function libraryBusyReason(): string | undefined {
  if (jobs.hasActiveJobs()) return 'Det pågår genereringar. Vänta tills de är klara och försök igen.'
  return sequencesBusy() ?? assetWorkBusy()
}

/** Every sequence refetches: image paths in segment params (or take paths) may have been rewritten. */
function broadcastAllSequences(): void {
  if (!db.isDbOpen()) return
  for (const id of db.getDb().prepare('SELECT id FROM sequences').pluck().all() as string[]) {
    broadcast('sequence:change', id)
  }
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

/** After "Städa upp" files may live elsewhere: views refetch, and moved generations are re-sent to the feed. */
function broadcastLibraryReorganized(movedGenerationIds: string[]): void {
  broadcast('library:change')
  broadcastAllSequences()
  broadcastRewrittenGenerations(movedGenerationIds)
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:setApiKey', (_e, key: string) => setApiKey(key))
  ipcMain.handle('settings:setPromptLanguage', (_e, lang: unknown) => setPromptLanguage(lang))
  ipcMain.handle('settings:testApiKey', async () => {
    try {
      const balances = await venice.balances()
      const summary = Object.entries(balances)
        .map(([k, v]) => `${k}: ${Number(v).toFixed(2)}`)
        .join(' · ')
      return { ok: true, message: summary ? `Nyckeln fungerar. Saldo: ${summary}` : 'Nyckeln fungerar.' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('ffmpeg:status', () => ffmpegStatus())

  ipcMain.handle('models:list', async (_e, force?: boolean) => {
    if (!force && modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models
    modelCache = { at: Date.now(), models: await venice.listVideoModels() }
    return modelCache.models
  })

  ipcMain.handle('video:quote', (_e, params: GenerationParams) => venice.quote(params))
  ipcMain.handle('video:generate', async (_e, params: GenerationParams) => {
    // Counted as on its way from the start: a library switch must not close the database while the price
    // is quoted, or the job would be paid for and then have nowhere to be recorded.
    const release = jobs.holdSubmit()
    try {
      // Checked, canonicalised and its audio clips measured before the quote: a voice that turns out too long
      // is refused here rather than after a network round trip (submit checks again; it is idempotent).
      const p = await prepareSubmission(params)
      const quote = await venice.quote(p).catch(() => undefined)
      return await jobs.submit(p, { quote })
    } finally {
      release()
    }
  })

  ipcMain.handle('consent:accept', (_e, flow: string, version: string) => acceptConsent(flow, version))
  ipcMain.handle('generations:list', () => attachReviewSummary(db.listGenerations().map(toPublic)))
  ipcMain.handle('generations:delete', async (_e, id: string) => {
    // Not while "Städa upp" or a switch moves files: the video could be moved away from the path trashed here.
    await libraryOperationSettled()
    const g = db.getGeneration(id)
    if (!g) return
    // Deleting a take changes the sequence it belongs to (FKs clear segment selections).
    const sequenceIds = db
      .getDb()
      .prepare('SELECT DISTINCT sequence_id FROM segments WHERE id = ? OR selected_generation_id = ?')
      .pluck()
      .all(g.segmentId ?? null, id) as string[]
    // The row goes in the same tick as the read: a video that is being moved or saved right now then finds
    // its row gone and is trashed by whoever moves it, rather than landing somewhere untracked.
    db.deleteGeneration(id)
    // Only the library's own copies: a path outside it (e.g. an old library copied elsewhere by hand) is
    // somebody else's file.
    for (const file of [g.filePath, g.thumbPath]) {
      if (file && isInsideRoot(file)) await shell.trashItem(file).catch(() => unlink(file).catch(() => {}))
    }
    if (g.filePath) await removeDayFolderIfEmpty(dirname(g.filePath))
    // Every view drops it, also the feed when the take was deleted in the sequence editor.
    broadcast('generation:delete', id)
    for (const sequenceId of sequenceIds) broadcast('sequence:change', sequenceId)
  })

  ipcMain.handle('file:reveal', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('file:pickImages', async (e, multiple: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showOpenDialog(win, {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Bilder', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    })
    return res.canceled ? [] : res.filePaths
  })
  ipcMain.handle('file:pickAudio', async (e, multiple: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showOpenDialog(win, {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Ljud', extensions: [...AUDIO_FILE_TYPES] }]
    })
    return res.canceled ? [] : res.filePaths
  })

  registerLibraryIpc(
    () => broadcast('library:change'),
    // A renamed asset folder (or a used photo or voice kept when its asset went) rewrote the image and audio paths
    // in segment and generation params: open segment editors refetch, and the feed gets those generations again.
    () => {
      broadcastAllSequences()
      broadcastRewrittenGenerations()
    }
  )
  // Reviews and learnings, from the window and from agents; changes go to every window. A review also changes
  // the stars and count its generation's card shows, so the generation is sent again too.
  registerReviewIpc((channel, payload) => {
    broadcast(channel, payload)
    if (channel !== 'review:change' || typeof payload !== 'string' || !db.isDbOpen()) return
    const g = db.getGeneration(payload)
    if (g) broadcastGeneration(toPublic(g))
  })
  const sequences = registerSequenceIpc({
    jobs,
    venice,
    notify: (sequenceId: string) => broadcast('sequence:change', sequenceId),
    exportProgress: (p: ExportProgress) => broadcast('export:progress', p)
  })
  sequencesBusy = () => sequences.isBusy()

  registerLibraryRootIpc({
    busy: libraryBusyReason,
    onOpened: () => {
      jobs.resume()
      agent.libraryOpened()
    },
    onReorganized: broadcastLibraryReorganized,
    beforeClose: () => jobs.pauseBackfill()
  })

  registerAgentIpc(agent)
}

void app.whenReady().then(async () => {
  if (!isPrimaryInstance) return
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
  // Agents can connect from now on; tools that need the library say so while none is open.
  void agent.startIfEnabled().catch((err: unknown) => console.error('Starting the agent connection failed:', err))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  // No agent may start anything while the app shuts down.
  agent.shutdown()
  // Exports and frame grabs must not outlive the app or leave their half-written files behind.
  stopAllFfmpeg()
  // Folds the WAL back into studio.db, leaving a single file in .studio.
  db.closeDb()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
