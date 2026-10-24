import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AgentActivity,
  ArchiveProgress,
  AgentCommand,
  AgentStatus,
  ApprovalRequest,
  EditProgress,
  ExportProgress,
  Generation,
  ImportProgress,
  StudioApi,
  WorkSummary
} from '@shared/types'

// Many views listen to the same few events (a sequence's clips, pickers and hover cards each follow library changes),
// so Node's leak warning at 11 listeners per channel would fire on an ordinary screen. Every listener unsubscribes.
ipcRenderer.setMaxListeners(50)

/** Subscribes to a main → renderer event and returns an unsubscribe function. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: StudioApi = {
  platform: process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'darwin',

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setApiKey: (key, provider) => ipcRenderer.invoke('settings:setApiKey', key, provider),
  testApiKey: (provider) => ipcRenderer.invoke('settings:testApiKey', provider),
  // Read once as the window loads (lib/initProvider.ts); a switch reloads the window.
  initialProvider: ipcRenderer.sendSync('settings:providerSync'),
  setProvider: (provider) => ipcRenderer.invoke('settings:setProvider', provider),
  ffmpegStatus: () => ipcRenderer.invoke('ffmpeg:status'),
  setPromptLanguage: (lang) => ipcRenderer.invoke('settings:setPromptLanguage', lang),
  setBudget: (budget) => ipcRenderer.invoke('settings:setBudget', budget),
  // Updates
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateProgress: (cb) => on('updates:progress', cb),
  onUpdateAvailable: (cb) => on('updates:available', cb),
  setAutoUpdateCheck: (on_) => ipcRenderer.invoke('settings:setAutoUpdateCheck', on_),
  // Claude Desktop
  claudeDesktopStatus: () => ipcRenderer.invoke('claude:status'),
  addToClaudeDesktop: (opts) => ipcRenderer.invoke('claude:addExtension', opts),
  getSpending: () => ipcRenderer.invoke('spending:get'),
  setImageSafeMode: (on) => ipcRenderer.invoke('settings:setImageSafeMode', on),
  onSettingsChange: (cb) => on<void>('settings:change', () => cb()),
  onOpenSettings: (cb) => on<void>('app:open-settings', () => cb()),

  // Generation
  listModels: (force) => ipcRenderer.invoke('models:list', force),
  quote: (params) => ipcRenderer.invoke('video:quote', params),
  probeReferenceVideo: (path, at) => ipcRenderer.invoke('referenceVideos:probe', path, at),
  generate: (params, opts) => ipcRenderer.invoke('video:generate', params, opts),
  acceptConsent: (flow, version) => ipcRenderer.invoke('consent:accept', flow, version),
  listGenerations: () => ipcRenderer.invoke('generations:list'),
  deleteGeneration: (id, from) => ipcRenderer.invoke('generations:delete', id, from),
  onGenerationUpdate: (cb) => on<Generation>('generation:update', cb),
  onGenerationDelete: (cb) => on<string>('generation:delete', cb),

  // Reviews and learnings
  listReviews: (generationId) => ipcRenderer.invoke('reviews:list', generationId),
  setUserReview: (generationId, input) => ipcRenderer.invoke('reviews:setUser', generationId, input),
  deleteReview: (reviewId) => ipcRenderer.invoke('reviews:delete', reviewId),
  listLearnings: () => ipcRenderer.invoke('learnings:list'),
  saveLearning: (input) => ipcRenderer.invoke('learnings:save', input),
  deleteLearning: (id) => ipcRenderer.invoke('learnings:delete', id),
  listExports: () => ipcRenderer.invoke('exports:list'),
  getSession: () => ipcRenderer.invoke('app:session'),
  onReviewChange: (cb) => on<string>('review:change', cb),
  onLearningsChange: (cb) => on<void>('learnings:change', () => cb()),

  // Assets (characters, environments, products, outfits, poses)
  listAssets: (kind) => ipcRenderer.invoke('assets:list', kind),
  saveAsset: (input) => ipcRenderer.invoke('assets:save', input),
  copyDirectorPreset: (presetId) => ipcRenderer.invoke('directors:copyPreset', presetId),
  addDirectorVideos: (assetId, paths) => ipcRenderer.invoke('directors:addVideos', assetId, paths),
  deleteAsset: (id) => ipcRenderer.invoke('assets:delete', id),
  addAssetImages: (assetId, paths) => ipcRenderer.invoke('assets:addImages', assetId, paths),
  removeAssetImage: (imageId) => ipcRenderer.invoke('assets:removeImage', imageId),
  reorderAssetImages: (assetId, imageIds) => ipcRenderer.invoke('assets:reorderImages', assetId, imageIds),
  addAssetAudio: (assetId, paths) => ipcRenderer.invoke('assets:addAudio', assetId, paths),
  removeAssetAudio: (audioId) => ipcRenderer.invoke('assets:removeAudio', audioId),
  updateAssetAudio: (audioId, patch) => ipcRenderer.invoke('assets:updateAudio', audioId, patch),
  reorderAssetAudio: (assetId, audioIds) => ipcRenderer.invoke('assets:reorderAudio', assetId, audioIds),

  // Prompt library
  listPrompts: () => ipcRenderer.invoke('prompts:list'),
  savePrompt: (input) => ipcRenderer.invoke('prompts:save', input),
  deletePrompt: (id) => ipcRenderer.invoke('prompts:delete', id),
  markPromptUsed: (id) => ipcRenderer.invoke('prompts:markUsed', id),
  onLibraryChange: (cb) => on<void>('library:change', () => cb()),

  // Sequences
  listSequences: () => ipcRenderer.invoke('sequences:list'),
  getSequence: (id) => ipcRenderer.invoke('sequences:get', id),
  createSequence: (name) => ipcRenderer.invoke('sequences:create', name),
  updateSequence: (id, patch) => ipcRenderer.invoke('sequences:update', id, patch),
  applyCastToSegment: (segmentId) => ipcRenderer.invoke('segments:useCast', segmentId),
  deleteSequence: (id) => ipcRenderer.invoke('sequences:delete', id),
  addSegment: (sequenceId, init) => ipcRenderer.invoke('segments:add', sequenceId, init),
  updateSegment: (segmentId, patch) => ipcRenderer.invoke('segments:update', segmentId, patch),
  deleteSegment: (segmentId, opts) => ipcRenderer.invoke('segments:delete', segmentId, opts),
  moveSegment: (segmentId, toIndex) => ipcRenderer.invoke('segments:move', segmentId, toIndex),
  generateSegment: (segmentId, opts) => ipcRenderer.invoke('segments:generate', segmentId, opts),
  // The second argument is an approval's guard (in-process calls only); the window's options come after it.
  generateAllSegments: (sequenceId, opts) => ipcRenderer.invoke('sequences:generateAll', sequenceId, undefined, opts),
  stopGenerateAll: (sequenceId) => ipcRenderer.invoke('sequences:stopGenerateAll', sequenceId),
  exportSequence: (sequenceId) => ipcRenderer.invoke('sequences:export', sequenceId),
  onSequenceChange: (cb) => on<string>('sequence:change', cb),
  // Songs
  createSequenceFromSong: (path, opts) => ipcRenderer.invoke('songs:createSequence', path, opts),
  setSequenceSong: (sequenceId, path, opts) => ipcRenderer.invoke('songs:set', sequenceId, path, opts),
  songOverview: (sequenceId) => ipcRenderer.invoke('songs:overview', sequenceId),
  suggestSongSections: (sequenceId, targetSeconds) =>
    ipcRenderer.invoke('songs:suggestSections', sequenceId, targetSeconds),
  setSongSections: (sequenceId, boundaries) => ipcRenderer.invoke('songs:setSections', sequenceId, boundaries),
  quoteSongLyrics: (sequenceId, model) => ipcRenderer.invoke('songs:quoteLyrics', sequenceId, model),
  transcribeSong: (sequenceId, opts) => ipcRenderer.invoke('songs:transcribe', sequenceId, opts),
  editSongLyricLine: (sequenceId, lineIndex, text) =>
    ipcRenderer.invoke('songs:editLyricLine', sequenceId, lineIndex, text),
  separateSongVocals: (sequenceId) => ipcRenderer.invoke('songs:separate', sequenceId),
  syncSongTake: (generationId) => ipcRenderer.invoke('songs:syncTake', generationId),
  onExportProgress: (cb) => on<ExportProgress>('export:progress', cb),

  // Keyframes and "Redo between neighbours" (sequence clips)
  setSegmentImage: (segmentId, slot, source) => ipcRenderer.invoke('segments:setImage', segmentId, slot, source),
  previewSegmentFrames: (segmentId) => ipcRenderer.invoke('segments:previewFrames', segmentId),
  bridgeSegment: (segmentId) => ipcRenderer.invoke('segments:bridge', segmentId),

  // Storyboards
  listStoryboards: () => ipcRenderer.invoke('storyboards:list'),
  getStoryboard: (id) => ipcRenderer.invoke('storyboards:get', id),
  createStoryboard: (name, aspectRatio) => ipcRenderer.invoke('storyboards:create', name, aspectRatio),
  updateStoryboard: (id, patch) => ipcRenderer.invoke('storyboards:update', id, patch),
  deleteStoryboard: (id) => ipcRenderer.invoke('storyboards:delete', id),
  addBoard: (storyboardId, init) => ipcRenderer.invoke('boards:add', storyboardId, init),
  updateBoard: (boardId, patch) => ipcRenderer.invoke('boards:update', boardId, patch),
  moveBoard: (boardId, toIndex) => ipcRenderer.invoke('boards:move', boardId, toIndex),
  deleteBoard: (boardId) => ipcRenderer.invoke('boards:delete', boardId),
  updateTransition: (transitionId, patch) => ipcRenderer.invoke('transitions:update', transitionId, patch),
  generateTransition: (transitionId, opts) => ipcRenderer.invoke('transitions:generate', transitionId, opts),
  generateStoryboard: (storyboardId, opts) =>
    ipcRenderer.invoke('storyboards:generateAll', storyboardId, undefined, opts),
  stopStoryboard: (storyboardId) => ipcRenderer.invoke('storyboards:stop', storyboardId),
  exportStoryboard: (storyboardId) => ipcRenderer.invoke('storyboards:export', storyboardId),
  convertStoryboardToSequence: (storyboardId) => ipcRenderer.invoke('storyboards:toSequence', storyboardId),
  onStoryboardChange: (cb) => on<string>('storyboard:change', cb),

  // Images and stills
  listImageModels: () => ipcRenderer.invoke('images:models'),
  quoteStill: (params) => ipcRenderer.invoke('images:quote', params),
  generateStill: (params, opts) => ipcRenderer.invoke('images:generate', params, opts),
  listStills: (sequenceId) => ipcRenderer.invoke('stills:list', sequenceId),
  deleteStill: (id) => ipcRenderer.invoke('stills:delete', id),
  saveFrameAsStill: (generationId, time, sequenceId) =>
    ipcRenderer.invoke('stills:saveFrame', generationId, time, sequenceId),
  // undefined (not null) when no sequence is named, as the type says.
  onStillsChange: (cb) => on<string | undefined>('stills:change', (id) => cb(id ?? undefined)),

  // Library folder
  libraryStatus: () => ipcRenderer.invoke('library:status'),
  exportLibraryArchive: () => ipcRenderer.invoke('archive:export'),
  importLibraryArchive: () => ipcRenderer.invoke('archive:import'),
  cancelLibraryArchive: () => ipcRenderer.invoke('archive:cancel'),
  onArchiveProgress: (cb) => on<ArchiveProgress>('archive:progress', cb),
  chooseLibraryFolder: () => ipcRenderer.invoke('library:choose'),
  inspectLibraryFolder: (path) => ipcRenderer.invoke('library:inspect', path),
  setLibraryRoot: (path, mode) => ipcRenderer.invoke('library:setRoot', path, mode),
  reorganizeLibrary: () => ipcRenderer.invoke('library:reorganize'),
  revealLibraryFolder: (target, id) => ipcRenderer.invoke('library:reveal', target, id),

  // Agent connection (MCP server)
  getAgentStatus: () => ipcRenderer.invoke('agent:status'),
  setAgentEnabled: (enabled) => ipcRenderer.invoke('agent:setEnabled', enabled),
  setAgentPort: (port) => ipcRenderer.invoke('agent:setPort', port),
  restartAgent: () => ipcRenderer.invoke('agent:restart'),
  getAgentToken: () => ipcRenderer.invoke('agent:token'),
  regenerateAgentToken: () => ipcRenderer.invoke('agent:regenerateToken'),
  listAgentActivity: () => ipcRenderer.invoke('agent:activity:list'),
  listApprovals: () => ipcRenderer.invoke('agent:approvals:list'),
  resolveApproval: (id, approve, reason) => ipcRenderer.invoke('agent:approvals:resolve', id, approve, reason),
  verifyApproval: (id) => ipcRenderer.invoke('agent:verifyApproval', id),
  onAgentStatus: (cb) => on<AgentStatus>('agent:status', cb),
  onAgentActivity: (cb) => on<AgentActivity>('agent:activity', cb),
  onApproval: (cb) => on<ApprovalRequest>('agent:approval', cb),
  onAgentCommand: (cb) => on<AgentCommand>('agent:command', cb),
  replyAgentCommand: (id, reply) => ipcRenderer.send('agent:reply', id, reply),

  // Own clips
  pickVideos: (multiple) => ipcRenderer.invoke('file:pickVideos', multiple),
  inspectVideoFiles: (paths) => ipcRenderer.invoke('imports:inspect', paths),
  importVideoFiles: (paths, target) => ipcRenderer.invoke('imports:import', paths, target),
  cancelImports: (path) => ipcRenderer.invoke('imports:cancel', path),
  onImportProgress: (cb) => on<ImportProgress>('import:progress', cb),

  // The Editor (edits and versions)
  listEdits: () => ipcRenderer.invoke('edits:list'),
  getEdit: (id) => ipcRenderer.invoke('edits:get', id),
  createEdit: (source, name) => ipcRenderer.invoke('edits:create', source, name),
  renameEdit: (id, name) => ipcRenderer.invoke('edits:rename', id, name),
  deleteEdit: (id) => ipcRenderer.invoke('edits:delete', id),
  setCurrentVersion: (editId, versionId) => ipcRenderer.invoke('edits:setCurrent', editId, versionId),
  deleteVersion: (versionId) => ipcRenderer.invoke('edits:deleteVersion', versionId),
  pruneVersions: (editId, dryRun) => ipcRenderer.invoke('edits:prune', editId, dryRun),
  editTimeline: (generationId) => ipcRenderer.invoke('edits:timeline', generationId),
  planEditOperation: (editId, op, baseId) => ipcRenderer.invoke('edits:plan', editId, op, baseId),
  runEditOperation: (editId, op, opts) => ipcRenderer.invoke('edits:run', editId, op, opts),
  cancelEditJob: (jobId) => ipcRenderer.invoke('edits:cancel', jobId),
  resumeEditJob: (jobId, expectedPriceUsd, expectedPartial, opts) =>
    ipcRenderer.invoke('edits:resume', jobId, expectedPriceUsd, expectedPartial, opts),
  getTranscript: (generationId) => ipcRenderer.invoke('edits:transcript', generationId),
  updateTranscript: (generationId, patch) => ipcRenderer.invoke('edits:updateTranscript', generationId, patch),
  saveSubtitles: (generationId) => ipcRenderer.invoke('edits:srt', generationId),
  addEditAudio: (editId, paths) => ipcRenderer.invoke('edits:addAudio', editId, paths),
  sendEditToSequence: (versionId, target) => ipcRenderer.invoke('edits:send', versionId, target),
  listAudioModels: (force) => ipcRenderer.invoke('audio:models', force),
  separationStatus: () => ipcRenderer.invoke('audio:separation'),
  planVoiceDesign: (req) => ipcRenderer.invoke('voices:plan', req),
  designVoice: (req, expectedPriceUsd, opts) => ipcRenderer.invoke('voices:design', req, expectedPriceUsd, opts),
  setVoiceCloneConsent: (audioId, consent) => ipcRenderer.invoke('voices:consent', audioId, consent),
  onEditChange: (cb) => on<string>('edit:change', cb),
  onEditProgress: (cb) => on<EditProgress>('edit:progress', cb),

  // Status: Activity
  getWorkSummary: () => ipcRenderer.invoke('work:summary'),
  markSeen: (keys) => ipcRenderer.invoke('work:markSeen', keys),
  markAllSeen: (scope) => ipcRenderer.invoke('work:markAllSeen', scope),
  undoMarkAllSeen: (token) => ipcRenderer.invoke('work:undoSeen', token),
  onWorkChange: (cb) => on<WorkSummary>('work:change', cb),

  // Files
  revealFile: (path) => ipcRenderer.invoke('file:reveal', path),
  pickImages: (multiple) => ipcRenderer.invoke('file:pickImages', multiple),
  pickAudio: (multiple) => ipcRenderer.invoke('file:pickAudio', multiple),
  pathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('studio', api)
