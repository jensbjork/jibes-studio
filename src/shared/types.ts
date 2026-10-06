// Types shared between the main process, preload and renderer.

import type { PromptIssue } from './prompt-refs'

export type VideoModelType = 'text-to-video' | 'image-to-video' | 'reference-to-video' | 'video-to-video' | 'other'

export interface VideoModel {
  id: string
  name: string
  /** Derived from the model id, since Venice reports R2V models as "image-to-video". */
  kind: VideoModelType
  privacy: string
  offline: boolean
  aspectRatios: string[]
  resolutions: string[]
  durations: string[]
  audio: boolean
  audioConfigurable: boolean
  promptCharacterLimit?: number
  modelSets: string[]
}

export interface GenerationParams {
  model: string
  prompt: string
  negativePrompt?: string
  duration: string
  resolution?: string
  aspectRatio?: string
  audio?: boolean
  /** Absolute paths to local images; converted to data URLs before sending. */
  startImage?: string
  endImage?: string
  referenceImages?: string[]
}

export type GenerationStatus = 'queued' | 'processing' | 'completed' | 'failed'

export interface Generation {
  id: string
  createdAt: number
  model: string
  prompt: string
  params: GenerationParams
  status: GenerationStatus
  queueId?: string
  filePath?: string
  error?: string
  quote?: number
  /** Milliseconds, as reported by Venice while polling. */
  averageExecutionTime?: number
  executionDuration?: number
  completedAt?: number
  /** Set when the generation is a take of a sequence segment. */
  segmentId?: string
  /** Poster frame (JPEG) extracted with ffmpeg once the video is saved. */
  thumbPath?: string
  /** Actual video length in seconds, from ffprobe. */
  videoDuration?: number
  /**
   * Set on the takes of a loaded sequence when the completed video is no longer on disk (e.g. deleted in
   * Finder). Such a take can't be cut or continued from, so "generate all" makes a new one.
   */
  fileMissing?: boolean
}

export interface Settings {
  hasApiKey: boolean
  /** The current base folder (grundmapp), or '' while no library is open. */
  libraryDir: string
  /** Running as "Studio Dev" (npm run dev) with its own settings and library, separate from Studio.app. */
  devProfile: boolean
  /**
   * "Promptspråk": the language video prompts are written in. Decides the words the prompt editor inserts
   * between references (en: "Anna (@Image1) wearing …", sv: "Anna (@Image1) i …") and what agents are told.
   */
  promptLanguage: PromptLanguage
}

export type PromptLanguage = 'en' | 'sv'

// ── Library folder (grundmapp) ───────────────────────────────────────────────

/**
 * unconfigured: no base folder chosen yet. missing: the chosen folder can't be reached (or opened).
 * switching: a switch or move is under way (started from another window, or before a reload); every window
 * reloads when it is done.
 */
export type LibraryState = 'unconfigured' | 'ready' | 'missing' | 'switching'

export interface LibraryStatus {
  state: LibraryState
  /** The configured base folder (also when it is missing). */
  root?: string
  /** Proposed base folder for a first run (~/Movies/Studio). */
  suggested: string
  /**
   * A library from before the base folder could be chosen, which 'move' takes along. Only while not ready.
   * oldLayout: it is in the layout of an earlier Studio version (studio.db directly in the folder), which is
   * reorganized into the new folders when it is opened or moved; otherwise it already has the new layout.
   */
  legacy?: { path: string; hasContent: boolean; oldLayout: boolean }
  /** Why the configured folder couldn't be opened, when it exists but opening failed. */
  error?: string
}

export interface FolderInspection {
  path: string
  exists: boolean
  /** Nothing in it (Finder's .DS_Store aside). */
  empty: boolean
  /** Contains a Studio library ('open' works). */
  hasLibrary: boolean
  /** The library there is in the layout of an earlier Studio version; opening it reorganizes its files. */
  oldLayout: boolean
  /** Is the current base folder. */
  isCurrent: boolean
  /**
   * Lies inside the current base folder (or the library 'move' would take along) and can't be chosen. A
   * library kept there outside the library's own folders is not counted: it can be opened.
   */
  insideCurrent: boolean
  /** In iCloud Drive, Dropbox, Google Drive or OneDrive: SQLite databases can get corrupted there. */
  cloudSynced: boolean
  writable: boolean
  /** Non-empty top-level folders that 'move' would collide with (e.g. "Karaktärer"). */
  conflicts: string[]
}

export interface ReorganizeReport {
  /** Files moved to their proper place. */
  moved: number
  /** Files the library knows about that are no longer on disk. */
  missing: number
  foldersCreated: number
  /** Swedish messages for files or folders that couldn't be handled. */
  errors: string[]
}

/** move: take the current library along. open: use the library already in the folder. new: start empty. */
export type LibraryMode = 'move' | 'open' | 'new'

export type LibraryFolderTarget =
  | 'root'
  | 'characters'
  | 'environments'
  | 'outfits'
  | 'references'
  | 'generations'
  | 'sequences'

export interface FfmpegStatus {
  ok: boolean
  path?: string
  version?: string
  message?: string
}

/** Venice asks for provider policy attestation on some models (HTTP 409 needs_consent). */
export interface ConsentRequest {
  flow: string
  version: string
  policyText: string
}

/** Prefix on error messages that carry a ConsentRequest as JSON. */
export const NEEDS_CONSENT = 'NEEDS_CONSENT:'

// ── Assets: characters, environments, outfits ────────────────────────────────

/**
 * character: who is in the shot (Karaktärer). environment: where it takes place (Miljöer). outfit: what a
 * character wears (Kläder). All three are a name, a description and reference photos in a folder of their own.
 */
export type AssetKind = 'character' | 'environment' | 'outfit'

export const ASSET_KINDS: readonly AssetKind[] = ['character', 'environment', 'outfit']

export interface AssetImage {
  id: string
  /** Absolute path to the copy stored in the library (e.g. Karaktärer/<name>/). */
  path: string
}

export interface Asset {
  id: string
  kind: AssetKind
  name: string
  /** Free text (looks, place, clothes…); can be inserted into prompts. */
  description: string
  /** Ordered; the first image is the cover. */
  images: AssetImage[]
  /** Characters only: the outfit (an asset of kind 'outfit') the character wears unless told otherwise. */
  defaultOutfitId?: string
  createdAt: number
  updatedAt: number
}

export interface AssetInput {
  /** Omit to create a new asset. */
  id?: string
  /** Fixed once created: ignored when updating. */
  kind: AssetKind
  name: string
  description: string
  /**
   * Characters only; must be the id of an outfit. null clears it; omitted (undefined) keeps the current one
   * when updating.
   */
  defaultOutfitId?: string | null
}

// ── Prompt library ───────────────────────────────────────────────────────────

export interface SavedPrompt {
  id: string
  title: string
  body: string
  negativePrompt?: string
  tags: string[]
  favorite: boolean
  useCount: number
  lastUsedAt?: number
  createdAt: number
  updatedAt: number
}

export interface PromptInput {
  /** Omit to create a new prompt. */
  id?: string
  title: string
  body: string
  negativePrompt?: string
  tags: string[]
  favorite: boolean
}

// ── Sequences ────────────────────────────────────────────────────────────────

/** One shot in a sequence. Each generation for it is a "take"; one take is selected for the cut. */
export interface Segment {
  id: string
  sequenceId: string
  /** 0-based order within the sequence. */
  position: number
  /** Template for new takes. When continueFromPrevious is set, startImage is filled in at generation time. */
  params: GenerationParams
  /** Use the previous segment's (trimmed) last frame as this segment's start image. */
  continueFromPrevious: boolean
  selectedGenerationId?: string
  /** Seconds cut from the start / end of the selected take in the final cut. */
  trimStart: number
  trimEnd: number
  /** All takes for this segment, newest first. */
  takes: Generation[]
  createdAt: number
}

export interface Sequence {
  id: string
  name: string
  /** Params used to seed new segments (model, duration, resolution, aspect ratio, audio). */
  defaults: Partial<GenerationParams>
  segments: Segment[]
  /** "Generate all" is running for this sequence. */
  running: boolean
  /** Last error from "generate all", cleared when a new run starts. */
  runError?: string
  createdAt: number
  updatedAt: number
}

export interface SequenceSummary {
  id: string
  name: string
  segmentCount: number
  /** Seconds, summed over selected completed takes after trims. */
  totalDuration: number
  /** Thumbnail of the first segment's selected take, if any. */
  thumbPath?: string
  updatedAt: number
}

export interface SegmentInit {
  /** Insert after this segment; default is at the end. */
  afterSegmentId?: string
  /** Start from these params; default is the sequence defaults (or the previous segment's params). */
  params?: GenerationParams
  /** Use an existing generation as the first (selected) take; its params seed the segment. */
  fromGenerationId?: string
  continueFromPrevious?: boolean
}

export interface SegmentPatch {
  params?: GenerationParams
  continueFromPrevious?: boolean
  trimStart?: number
  trimEnd?: number
  /** null clears the selection. */
  selectedGenerationId?: string | null
}

export interface ExportProgress {
  sequenceId: string
  /** 0–1 */
  progress: number
  done?: boolean
  path?: string
  error?: string
}

// ── Agent connection (MCP server for the user's own agents) ──────────────────

/** An MCP client (e.g. an OpenClaw or Hermes Agent agent, or Claude Desktop) with an open session. */
export interface AgentClientInfo {
  /** The name the client gave when it connected (its clientInfo), e.g. "My agent". */
  name: string
  version?: string
  /** The address it connects from, e.g. "100.x.y.z" (another device over Tailscale) or "127.0.0.1". */
  address: string
  /** Epoch ms of its latest request. */
  lastSeen: number
}

export interface AgentStatus {
  /** Switched on in Settings (off by default). */
  enabled: boolean
  /** Listening right now (enabled and the port could be opened). */
  running: boolean
  port: number
  /** Where it listens, "host:port": always 127.0.0.1, plus the Tailscale address when Tailscale is up. */
  addresses: string[]
  /** This Mac's Tailscale IPv4 (100.64.0.0/10); undefined when Tailscale isn't running. */
  tailscaleAddress?: string
  /** This Mac's MagicDNS name, e.g. "<your-mac>.<tailnet>.ts.net", when it can be found. */
  tailscaleDnsName?: string
  /** Clients with an open session, most recently seen first. */
  clients: AgentClientInfo[]
  /** Swedish, e.g. why the port couldn't be opened. */
  error?: string
}

/** One tool call by an agent, for the activity log ("19:42 My agent satte prompten"). */
export interface AgentActivity {
  id: string
  at: number
  /** The agent's name. */
  client: string
  /** The MCP tool, e.g. "set_form". */
  tool: string
  /** What it did, in Swedish, without the agent's name: "satte prompten", "vill generera – väntar på ditt OK". */
  summary: string
  ok: boolean
  /** Set when the call created (or found) an approval request. */
  approvalId?: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'failed'

/**
 * A paid generation an agent asked for. Nothing is sent to Venice until the user approves it in Studio; main
 * then submits exactly what is described here (refusing if the clip changed meanwhile).
 */
export interface ApprovalRequest {
  id: string
  createdAt: number
  /** Epoch ms after which it can no longer be approved (30 minutes after it was made). */
  expiresAt?: number
  /** The agent's name. */
  client: string
  /** The agent's note to the user, e.g. why it wants this generation. */
  note?: string
  /** generation: the Generate form. segment: one sequence clip. generate-all: every clip still missing a take. */
  kind: 'generation' | 'segment' | 'generate-all'
  /**
   * What will be generated: the form for 'generation', the clip's settings for 'segment' (a clip continuing
   * from the previous one gets that clip's last frame as its start image when it is generated).
   */
  params?: GenerationParams
  sequenceId?: string
  sequenceName?: string
  /** 'segment': the clip; 'generate-all': the clips that will be generated, in order. */
  segmentIds?: string[]
  /** 1-based clip numbers of segmentIds, as Studio shows them ("Klipp 3"). */
  clipNumbers?: number[]
  /** USD; for 'generate-all' the sum over the clips. Undefined when Venice couldn't quote it. */
  priceUsd?: number
  status: ApprovalStatus
  /** Why it failed or expired (Swedish). */
  error?: string
  /** The user's reason when they declined. */
  reason?: string
  /** The generations it started once approved ('generate-all' starts them one by one, so it has none). */
  generationIds?: string[]
}

/** Commands main sends to the window's agent bridge (see StudioApi.onAgentCommand). */
export type AgentFormCommand = 'get_form' | 'set_form' | 'set_references' | 'open'

export interface AgentCommand {
  id: string
  /**
   * When main stops waiting for the answer (Date.now() time; both processes share the clock). A command still
   * queued after it has been answered as failed already, so it must not be applied.
   */
  deadline?: number
  command: AgentFormCommand
  /** get_form: none. set_form: AgentSetFormArgs. set_references: AgentSetReferencesArgs. open: AgentOpenArgs. */
  args: unknown
}

export interface AgentCommandReply {
  ok: boolean
  /** get_form, set_form and set_references: AgentFormState. open: AgentOpenResult. */
  result?: unknown
  /** Swedish. */
  error?: string
}

/** One reference image of the Generate form, as the bridge reports it. */
export interface AgentFormReference {
  /** "@Image1" for the first reference image. */
  token: string
  assetId?: string
  assetName?: string
  kind?: AssetKind
  /** 1-based position of the photo within its asset. */
  photoNumber?: number
  /** Absolute. */
  path: string
}

/** What get_form (and set_form, set_references) answer with. */
export interface AgentFormState {
  /** The view Studio shows, e.g. 'generate' or 'sequences'. */
  view: string
  /** The sequence and clip open in the sequence editor, if any. */
  sequenceId?: string
  segmentId?: string
  /** The Generate form. */
  params: GenerationParams
  references: AgentFormReference[]
  issues: PromptIssue[]
  /** What the window adjusted on its own (Swedish), e.g. a mode switch or images that didn't fit. */
  notes?: string[]
}

/**
 * set_form: the agent's set_form tool input, already checked by main against the model's options. Fields
 * left out stay as they are. When only `mode` is given, main has picked the model for it (`model` is set).
 */
export interface AgentSetFormArgs {
  mode?: 'text-to-video' | 'image-to-video' | 'reference-to-video'
  model?: string
  duration?: string
  resolution?: string
  aspect_ratio?: string
  audio?: boolean
  /** Tokens already canonical ("@Image3"). */
  prompt?: string
  negative_prompt?: string
  /** Absolute path of the start image (main resolved the agent's asset photo). */
  start_image?: string
}

/** set_references: photo paths (main resolved the agent's asset ids), in order. */
export interface AgentSetReferencesArgs {
  paths: string[]
  /** replace: these become the reference images. append: added after the ones there (duplicates skipped). */
  mode: 'replace' | 'append'
}

/** open: brings a place in Studio to the front. */
export interface AgentOpenArgs {
  view: 'generate' | 'sequences'
  sequenceId?: string
  segmentId?: string
}

/** What the window shows after an open command. */
export interface AgentOpenResult {
  view: 'generate' | 'sequences'
  sequenceId?: string
  sequenceName?: string
  /** The clip actually on screen (normally the one asked for). */
  segmentId?: string
  /** Swedish, when the window couldn't show exactly what was asked for. */
  note?: string
}

// ── IPC surface exposed on window.studio ─────────────────────────────────────

export interface StudioApi {
  // Settings
  getSettings(): Promise<Settings>
  setApiKey(key: string): Promise<void>
  testApiKey(): Promise<{ ok: boolean; message: string }>
  ffmpegStatus(): Promise<FfmpegStatus>
  setPromptLanguage(lang: PromptLanguage): Promise<void>

  // Generation
  listModels(force?: boolean): Promise<VideoModel[]>
  quote(params: GenerationParams): Promise<number>
  generate(params: GenerationParams): Promise<Generation>
  acceptConsent(flow: string, version: string): Promise<void>
  listGenerations(): Promise<Generation[]>
  deleteGeneration(id: string): Promise<void>
  onGenerationUpdate(cb: (g: Generation) => void): () => void

  // Assets (characters, environments, outfits)
  /** Sorted by name; every kind when kind is omitted. */
  listAssets(kind?: AssetKind): Promise<Asset[]>
  /** Creates (no id) or updates an asset. Rejects with a Swedish message (empty name, unknown outfit…). */
  saveAsset(input: AssetInput): Promise<Asset>
  /** Moves its folder to the Trash; characters wearing a deleted outfit by default lose that default. */
  deleteAsset(id: string): Promise<void>
  /** Copies the files into the asset's folder (JPG, PNG and WebP only), after the images it has. */
  addAssetImages(assetId: string, paths: string[]): Promise<Asset>
  removeAssetImage(imageId: string): Promise<Asset>
  /** The given images first, in that order; any others keep their order after them. */
  reorderAssetImages(assetId: string, imageIds: string[]): Promise<Asset>

  // Prompt library
  listPrompts(): Promise<SavedPrompt[]>
  savePrompt(input: PromptInput): Promise<SavedPrompt>
  deletePrompt(id: string): Promise<void>
  markPromptUsed(id: string): Promise<void>

  /** Fires after any asset or prompt change. */
  onLibraryChange(cb: () => void): () => void

  // Sequences
  listSequences(): Promise<SequenceSummary[]>
  getSequence(id: string): Promise<Sequence>
  createSequence(name: string): Promise<Sequence>
  updateSequence(id: string, patch: { name?: string; defaults?: Partial<GenerationParams> }): Promise<Sequence>
  deleteSequence(id: string): Promise<void>
  addSegment(sequenceId: string, init?: SegmentInit): Promise<Sequence>
  updateSegment(segmentId: string, patch: SegmentPatch): Promise<Sequence>
  deleteSegment(segmentId: string): Promise<Sequence>
  moveSegment(segmentId: string, toIndex: number): Promise<Sequence>
  /** Queues a new take for the segment (extracting the previous segment's last frame if continuing). */
  generateSegment(segmentId: string): Promise<Generation>
  /**
   * Starts generating every segment lacking a completed selected take, in order, waiting for each one.
   * Resolves once started; progress arrives via onSequenceChange and errors via Sequence.runError.
   */
  generateAllSegments(sequenceId: string): Promise<void>
  stopGenerateAll(sequenceId: string): Promise<void>
  /** Renders the cut with ffmpeg; resolves with the output path. */
  exportSequence(sequenceId: string): Promise<string>
  /** Fires with the sequence id whenever a sequence, its segments or their takes change. */
  onSequenceChange(cb: (sequenceId: string) => void): () => void
  onExportProgress(cb: (p: ExportProgress) => void): () => void

  // Library folder
  libraryStatus(): Promise<LibraryStatus>
  /** Directory dialog; null when cancelled. */
  chooseLibraryFolder(): Promise<string | null>
  inspectLibraryFolder(path: string): Promise<FolderInspection>
  /**
   * Switches the base folder (see LibraryMode). Rejects with a Swedish message when refused (busy, folder
   * inside the current library, conflicts, not writable). After it resolves every window reloads.
   */
  setLibraryRoot(path: string, mode: LibraryMode): Promise<void>
  /** "Städa upp": moves every file the library knows about to its proper folder. */
  reorganizeLibrary(): Promise<ReorganizeReport>
  /**
   * Opens the folder in Finder (created if needed). With an id: that sequence's folder for 'sequences', and
   * for any other target an asset's own folder (whatever its kind).
   */
  revealLibraryFolder(target: LibraryFolderTarget, id?: string): Promise<void>

  // Agent connection (MCP server)
  getAgentStatus(): Promise<AgentStatus>
  /** Starts or stops the server; resolves with the new status (status.error says why it couldn't start). */
  setAgentEnabled(enabled: boolean): Promise<AgentStatus>
  /** 1024–65535; restarts a running server on the new port. Rejects with a Swedish message. */
  setAgentPort(port: number): Promise<AgentStatus>
  /**
   * Looks for Tailscale again (a running server), or starts a server that couldn't start. Pending approval
   * requests stay, unlike switching the connection off and on.
   */
  restartAgent(): Promise<AgentStatus>
  /** The bearer token agents connect with (created the first time it is asked for). */
  getAgentToken(): Promise<string>
  /** A new token; agents using the old one are disconnected. */
  regenerateAgentToken(): Promise<string>
  /** The latest tool calls (up to 200), newest first. */
  listAgentActivity(): Promise<AgentActivity[]>
  /** Pending requests and the most recently decided ones, oldest first. */
  listApprovals(): Promise<ApprovalRequest[]>
  /**
   * Approves (main then submits the generation) or declines. Resolves with the updated request: approved,
   * declined, expired or failed (with error). Rejects with "NEEDS_CONSENT:…" when Venice asks for consent:
   * the request stays pending, so accept the consent and approve again.
   */
  resolveApproval(id: string, approve: boolean, reason?: string): Promise<ApprovalRequest>
  onAgentStatus(cb: (s: AgentStatus) => void): () => void
  onAgentActivity(cb: (a: AgentActivity) => void): () => void
  /** A request was created or changed. */
  onApproval(cb: (a: ApprovalRequest) => void): () => void
  /** The renderer's side of the agent bridge: apply the command and answer with replyAgentCommand. */
  onAgentCommand(cb: (cmd: AgentCommand) => void): () => void
  replyAgentCommand(id: string, reply: AgentCommandReply): void

  // Files
  revealFile(path: string): Promise<void>
  pickImages(multiple: boolean): Promise<string[]>
  /** Absolute path of a file dropped onto the window. */
  pathForFile(file: File): string
}
