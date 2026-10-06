import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AgentActivity,
  AgentCommand,
  AgentStatus,
  ApprovalRequest,
  ExportProgress,
  Generation,
  StudioApi
} from '@shared/types'

/** Subscribes to a main → renderer event and returns an unsubscribe function. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: StudioApi = {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', key),
  testApiKey: () => ipcRenderer.invoke('settings:testApiKey'),
  ffmpegStatus: () => ipcRenderer.invoke('ffmpeg:status'),
  setPromptLanguage: (lang) => ipcRenderer.invoke('settings:setPromptLanguage', lang),

  // Generation
  listModels: (force) => ipcRenderer.invoke('models:list', force),
  quote: (params) => ipcRenderer.invoke('video:quote', params),
  generate: (params) => ipcRenderer.invoke('video:generate', params),
  acceptConsent: (flow, version) => ipcRenderer.invoke('consent:accept', flow, version),
  listGenerations: () => ipcRenderer.invoke('generations:list'),
  deleteGeneration: (id) => ipcRenderer.invoke('generations:delete', id),
  onGenerationUpdate: (cb) => on<Generation>('generation:update', cb),

  // Assets (characters, environments, outfits)
  listAssets: (kind) => ipcRenderer.invoke('assets:list', kind),
  saveAsset: (input) => ipcRenderer.invoke('assets:save', input),
  deleteAsset: (id) => ipcRenderer.invoke('assets:delete', id),
  addAssetImages: (assetId, paths) => ipcRenderer.invoke('assets:addImages', assetId, paths),
  removeAssetImage: (imageId) => ipcRenderer.invoke('assets:removeImage', imageId),
  reorderAssetImages: (assetId, imageIds) => ipcRenderer.invoke('assets:reorderImages', assetId, imageIds),

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
  deleteSequence: (id) => ipcRenderer.invoke('sequences:delete', id),
  addSegment: (sequenceId, init) => ipcRenderer.invoke('segments:add', sequenceId, init),
  updateSegment: (segmentId, patch) => ipcRenderer.invoke('segments:update', segmentId, patch),
  deleteSegment: (segmentId) => ipcRenderer.invoke('segments:delete', segmentId),
  moveSegment: (segmentId, toIndex) => ipcRenderer.invoke('segments:move', segmentId, toIndex),
  generateSegment: (segmentId) => ipcRenderer.invoke('segments:generate', segmentId),
  generateAllSegments: (sequenceId) => ipcRenderer.invoke('sequences:generateAll', sequenceId),
  stopGenerateAll: (sequenceId) => ipcRenderer.invoke('sequences:stopGenerateAll', sequenceId),
  exportSequence: (sequenceId) => ipcRenderer.invoke('sequences:export', sequenceId),
  onSequenceChange: (cb) => on<string>('sequence:change', cb),
  onExportProgress: (cb) => on<ExportProgress>('export:progress', cb),

  // Library folder
  libraryStatus: () => ipcRenderer.invoke('library:status'),
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
  onAgentStatus: (cb) => on<AgentStatus>('agent:status', cb),
  onAgentActivity: (cb) => on<AgentActivity>('agent:activity', cb),
  onApproval: (cb) => on<ApprovalRequest>('agent:approval', cb),
  onAgentCommand: (cb) => on<AgentCommand>('agent:command', cb),
  replyAgentCommand: (id, reply) => ipcRenderer.send('agent:reply', id, reply),

  // Files
  revealFile: (path) => ipcRenderer.invoke('file:reveal', path),
  pickImages: (multiple) => ipcRenderer.invoke('file:pickImages', multiple),
  pathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('studio', api)
