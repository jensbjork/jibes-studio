// Types shared between the main process, preload and renderer.

import type { PromptIssue } from './prompt-refs'
import type { GenerateSession, MediaTab } from './session'

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
  /**
   * Accepts reference audio clips (`reference_audio_urls`, referred to as @Audio1… in the prompt): Venice's
   * `constraints.audio_input`. Not the same as `audio`, which is whether the model can generate sound.
   */
  audioInput: boolean
  promptCharacterLimit?: number
  modelSets: string[]
  /**
   * Takes a source video (`video_url`): Venice's `constraints.video_input`. These are the video-to-video edit
   * models and the upscalers; their kind is 'video-to-video'. Only the Editor uses them: the Generate form never
   * offers them.
   */
  videoInput: boolean
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
  /**
   * Reference audio (voices, sound) for reference-to-video models with audio input; @Audio1… in the prompt
   * refer to these in order. Absolute paths over IPC, stored relative like the images. Only the window
   * (start/length) of each file is sent.
   */
  referenceAudios?: ReferenceAudio[]
  /**
   * "Include descriptions": the descriptions of the assets whose photos and audio clips are sent are appended to
   * the prompt as a References legend when it is sent (src/shared/prompt-compose.ts). On unless false, also for
   * params from before it existed. The legend is never written into `prompt` itself.
   */
  includeDescriptions?: boolean
  /** Assets (ids) whose description is left out of the legend, each switched off in the editor on its own. */
  excludedDescriptionAssetIds?: string[]
  /**
   * Who wears each outfit among the references ("worn by"): outfit asset id → character asset id, null = nobody. An
   * outfit left out wears its default: the character among the references whose default outfit it is, else the only
   * character there (shared/outfits.ts). The References legend says it ("Red dress (@Image3), worn by Anna
   * (@Image1)"). Only choices that differ from that default need be stored.
   */
  outfitWearers?: Record<string, string | null>
  /**
   * Video-to-video edit and upscale models: the source clip (an H.264 proxy ≤22 MB in the edit's Underlag/),
   * sent as `video_url`. Absolute over IPC, stored relative like the images.
   */
  sourceVideo?: string
  /**
   * Seedance 2.x reference-to-video: reference videos, "<Video 1>"… in the prompt; sent as
   * `reference_video_urls`. Absolute over IPC, stored relative like the images.
   */
  referenceVideos?: string[]
  /** Seedance 2.5 R2V `omni_reference_task_type`. */
  referenceTask?: 'edit' | 'extend' | 'reference' | 'auto'
  /** Upscale models: `upscale_factor` on the queue, `resolution: "<n>x"` (and upscale_factor) on the quote. */
  upscaleFactor?: 1 | 2 | 4
}

/** One reference audio clip of a generation: the part of the file from `start` that lasts `length` seconds. */
export interface ReferenceAudio {
  /** Absolute path to a local audio file (normally an asset's voice or soundscape clip). */
  path: string
  /** Seconds into the file; default 0. */
  start?: number
  /**
   * Seconds; default min(rest of the file, 10 s) (referenceAudioWindow in models.ts). Not clamped: a window
   * outside Venice's 2–15 s is reported by the prompt checks instead of being changed quietly.
   */
  length?: number
}

export type GenerationStatus = 'queued' | 'processing' | 'completed' | 'failed'

/**
 * Where a generation's video came from. generated: made by Venice (the only kind that is ever pending). import:
 * the user's own file ("Own clips"). edit: a version made in the Editor from another one.
 */
export type GenerationSource = 'generated' | 'import' | 'edit'

export interface Generation {
  id: string
  createdAt: number
  source: GenerationSource
  /**
   * Imports: the file's name; versions: "<edit name> v3". The feed/take/frame-picker title (generationTitle in
   * src/shared/generation-label.ts). Undefined for Venice generations, which are named by their prompt.
   */
  title?: string
  /** A version's base version. */
  parentId?: string
  /** Versions and AI takes made in the Editor: the edit they belong to. */
  editId?: string
  /** How an import or a version was made (ids only, never file paths). */
  recipe?: EditRecipe
  /** Imports with a working copy: the untouched original (absolute). `filePath` is then the working copy. */
  originalPath?: string
  model: string
  /** The user's prompt (canonical tokens), as params.prompt: what "Use again" puts back in the editor. */
  prompt: string
  /**
   * The prompt exactly as it was sent to Venice: `prompt` with the References legend of the referenced assets'
   * descriptions appended (equal to `prompt` when nothing was appended). Undefined for generations made before
   * prompts were composed.
   */
  sentPrompt?: string
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
  /**
   * Set on the takes of a loaded sequence or storyboard when the Editor keeps the film (a version of an edit, or the film
   * an edit started from): the take list's "Remove" then only takes it off the clip, and that is what main does.
   */
  keptByEdit?: boolean
  /** The user's own rating (a RatingValue: -1 = thumbs down, 1–3 stars), if they have rated it. */
  rating?: number
  /** Reviews recorded for it: the user's (when it has a rating, note or tags) and agents'. */
  reviewCount: number
  /** Of those, the agents' reviews (what the feed's review badge counts; the user's own is shown as stars). */
  agentReviewCount: number
}

// ── Reviews and learnings ────────────────────────────────────────────────────

/**
 * Every grade in Studio (the user's rating, an agent's review): tumme ner, or one to three stars. Stored as these
 * numbers; migration 13 turned the old 1–5 stars into them (1–2 → -1, 3 → 1, 4 → 2, 5 → 3).
 */
export type RatingValue = -1 | 1 | 2 | 3
export const THUMBS_DOWN = -1
export const RATING_VALUES: readonly RatingValue[] = [-1, 1, 2, 3]
export const MAX_STARS = 3

/**
 * What someone thought of a generation: the user's own (author 'user', at most one per generation) or an
 * agent's (author = the MCP client's name, any number).
 */
export interface GenerationReview {
  id: string
  generationId: string
  /** 'user', or the agent's name. */
  author: string
  /** A RatingValue: -1 = thumbs down, 1–3 stars. */
  rating?: number
  /** E.g. "prompt-followed", "identity-drift" (see the suggested vocabulary in the agent guide). */
  tags: string[]
  note: string
  createdAt: number
  updatedAt: number
}

/** A short insight about prompting, distilled from reviewed results ("Learnings"). */
export interface Learning {
  id: string
  title: string
  insight: string
  /** The model it applies to; undefined for every model. */
  model?: string
  tags: string[]
  /** Ids of the generations it is based on. */
  evidence: string[]
  /** 'user', or the agent's name. */
  author: string
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export interface LearningInput {
  /** Omit to create a new learning. */
  id?: string
  title: string
  insight: string
  /** null clears it. */
  model?: string | null
  tags?: string[]
  evidence?: string[]
  pinned?: boolean
}

/** A finished film exported from a sequence. */
export interface ExportSummary {
  id: string
  /** Undefined when the sequence has been deleted since. */
  sequenceId?: string
  sequenceName?: string
  /** Whether it was exported from a sequence or a storyboard; undefined when that is deleted. */
  sequenceKind?: 'sequence' | 'storyboard'
  /** Absolute. */
  path: string
  createdAt: number
  /** Seconds, when the file could be probed. */
  duration?: number
  /** The file is still on disk. */
  exists: boolean
  /**
   * Where the clips meet in the film (seconds; the start of every clip after the first), recorded at export.
   * Undefined for exports made before they were recorded.
   */
  cuts?: number[]
}

/** Which generations the clip feed (and the agents' list_generations) shows, and in what order. */
export interface GenerationFilter {
  /** Words that must all appear in the prompt (or negative prompt), letter case ignored. */
  query?: string
  /** 'pending': queued or processing. */
  status?: GenerationStatus | 'pending'
  model?: string
  /** Generations whose params use this asset's photos or audio. */
  assetId?: string
  /** The user's rating is at least this many stars. */
  minRating?: number
  /** Not rated by the user. */
  unrated?: boolean
  /** Created at or after this time (epoch ms). */
  since?: number
  /** standalone: not a take of a sequence clip. sequence: a take. */
  placement?: 'standalone' | 'sequence'
  /** Has at least one review (the user's or an agent's). */
  hasReviews?: boolean
  /** Default 'newest'. */
  sort?: 'newest' | 'oldest' | 'rating' | 'cost' | 'length'
  /** Only generations of this source ("Source"): Venice's, the user's own clips, or versions made in the Editor. */
  source?: GenerationSource
  /** "New": finished and not looked at yet (needs FilterableGeneration.unseen; rows without it never match). */
  unseen?: boolean
}

export interface Settings {
  hasApiKey: boolean
  /** The current base folder (grundmapp), or '' while no library is open. */
  libraryDir: string
  /** Running as "Studio Dev" (npm run dev) with its own settings and library, separate from Studio.app. */
  devProfile: boolean
  /**
   * "Prompt language": the language video prompts are written in. Decides the words the prompt editor inserts
   * between references (en: "Anna (@Image1) wearing …", sv: "Anna (@Image1) i …") and what agents are told.
   */
  promptLanguage: PromptLanguage
  /**
   * "Safe mode for images": stills are generated with Venice's `safe_mode`, which blurs adult content. On by
   * default, like Venice's own default.
   */
  imageSafeMode: boolean
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
  /** Messages for files or folders that couldn't be handled. */
  errors: string[]
}

/** move: take the current library along. open: use the library already in the folder. new: start empty. */
export type LibraryMode = 'move' | 'open' | 'new'

export type LibraryFolderTarget =
  | 'root'
  | 'characters'
  | 'environments'
  | 'products'
  | 'outfits'
  | 'poses'
  | 'references'
  | 'generations'
  | 'sequences'
  | 'storyboards'
  /** Own clips: the user's own imported films. */
  | 'ownClips'
  /** Redigeringar; with an id, that edit's own folder. */
  | 'edits'

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

// ── Assets: characters, environments, products, outfits, poses ───────────────

/**
 * character: who is in the shot (folder Karaktärer/). environment: where it takes place (Miljöer/). product: a specific
 * item to show in the film (Produkter/), e.g. a package, a bottle or a gadget. outfit: what a character wears (Kläder/).
 * pose: how people stand and where, relative to each other (Poser/). Each is a name, a description and reference
 * photos in a folder of their own; characters and environments can also have audio clips (a voice, a soundscape).
 */
export type AssetKind = 'character' | 'environment' | 'product' | 'outfit' | 'pose'

/** Every kind, in the order the UI lists them (picker tabs, chips, the feed's filter); nothing stored depends on it. */
export const ASSET_KINDS = [
  'character',
  'environment',
  'product',
  'outfit',
  'pose'
] as const satisfies readonly AssetKind[]

/** Who added a photo or a sound clip when it wasn't the user (set only from an agent's call). */
export interface AssetFileOrigin {
  /** The agent's name (its MCP clientInfo name). */
  agent: string
  /** The host the file was fetched from, when it came from a URL. Never the URL itself (it may carry tokens). */
  host?: string
  /** Epoch ms when it was added. */
  at: number
}

export interface AssetImage {
  id: string
  /** Absolute path to the copy stored in the library (e.g. Karaktärer/<name>/). */
  path: string
  /** An agent added it (undefined: the user did). */
  origin?: AssetFileOrigin
}

/**
 * An audio clip of an asset: a character's voice ("Voice") or an environment's soundscape ("Soundscape"). Only
 * the reference window (clipStart, clipLength) is sent to Venice.
 */
export interface AssetAudio {
  id: string
  /** Absolute path to the copy stored in the asset's folder. */
  path: string
  /** Seconds, the whole file. */
  duration: number
  /** Seconds into the file where the reference window starts. */
  clipStart: number
  /** Seconds; always resolved (the default is min(duration, 10)), 2–15 and inside the file where possible. */
  clipLength: number
  /**
   * "May be cloned for new lines": the user has confirmed they may use this voice, so the Editor may clone it for
   * new spoken lines. Set only by the user in Studio (never by an agent).
   */
  cloneConsent: boolean
  /** An agent added it (undefined: the user did, or Studio made it). */
  origin?: AssetFileOrigin
}

export interface Asset {
  id: string
  kind: AssetKind
  name: string
  /** Free text (looks, place, clothes…); can be inserted into prompts. */
  description: string
  /** Ordered; the first image is the cover. */
  images: AssetImage[]
  /** Ordered; the first clip is the one the Generate form adds along with the asset. [] for kinds without audio. */
  audio: AssetAudio[]
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

// ── Composed prompts: asset descriptions appended as a References legend ────
// See src/shared/prompt-compose.ts (composePrompt), which re-exports these.

/** An asset as the prompt composer reads it: what it is called, its description and the files that are its own. */
export interface DescribedAsset {
  id: string
  kind: AssetKind
  name: string
  /** Free text; an empty (or blank) description adds nothing. */
  description: string
  /** Absolute paths of its photos (AssetImage.path). */
  imagePaths: string[]
  /** Absolute paths of its audio clips (AssetAudio.path). */
  audioPaths: string[]
  /** Characters: the outfit it wears unless told otherwise (Asset.defaultOutfitId). */
  defaultOutfitId?: string
}

export interface ComposeOptions {
  /** The prompt language (Settings.promptLanguage): the legend's heading and words ("References:" / "Referenser:"). */
  language: 'en' | 'sv'
  /** false: no legend at all (GenerationParams.includeDescriptions). */
  include: boolean
  /** Assets whose description is left out (GenerationParams.excludedDescriptionAssetIds). */
  excludedAssetIds?: string[]
  /**
   * The model's prompt limit (VideoModel.promptCharacterLimit): descriptions are shortened so the composed prompt
   * fits, or the legend is dropped when not even names and tokens fit. Omitted: no limit.
   */
  characterLimit?: number
  /** The same as characterLimit, under the VideoModel field's name; characterLimit wins when both are given. */
  promptCharacterLimit?: number
}

/** One asset's line in the legend: "- Anna (@Image1, @Image2; voice @Audio1): <description>". */
export interface DescriptionEntry {
  assetId: string
  kind: AssetKind
  /** The name as the legend writes it. */
  name: string
  /** Its @ImageN tokens in reference order, then its @AudioN tokens. */
  tokens: string[]
  /**
   * The description as the legend writes it: whitespace collapsed, shortened (ending in "…") when the model's
   * limit asked for it, '' when not even its first word fitted.
   */
  description: string
  /** Its description was shortened (or left out) to fit the model's limit. */
  shortened?: boolean
  /** An outfit: the character wearing it in this generation, as the legend names it ("worn by Anna (@Image1)"). */
  wornBy?: { assetId: string; name: string; tokens: string[] }
}

export interface ComposedPrompt {
  /** What is sent: the user's prompt (trailing whitespace trimmed) followed by the legend; just the prompt without one. */
  prompt: string
  /** "\n\nReferences:\n- …", or '' when nothing is appended. */
  legend: string
  /**
   * The described assets among the sent references, ordered by their first token. Also listed when the legend
   * was dropped (`dropped`) or the prompt is blank (nothing is appended to a blank prompt).
   */
  entries: DescriptionEntry[]
  /** Descriptions were shortened (or some left out) so the prompt fits the model's limit. */
  truncated: boolean
  /** The legend was left out entirely: not even the names and tokens fit within the model's limit. */
  dropped: boolean
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

/**
 * One shot in a sequence. Each generation for it is a "take"; one take is selected for the cut. It may have
 * keyframes (start and end image) and notes. A storyboard's transitions are segments too (StoryboardTransition).
 */
export interface Segment {
  id: string
  sequenceId: string
  /** 0-based order within the sequence. */
  position: number
  /**
   * Template for new takes. startImage / endImage are the clip's keyframes when it has explicit ones; when
   * continueFromPrevious / endFromNext is set, that image is filled in from the neighbour at generation time.
   */
  params: GenerationParams
  /** Use the previous segment's (trimmed) last frame as this segment's start image. Never set on the first clip. */
  continueFromPrevious: boolean
  /**
   * How a continuing clip starts on that frame (only meaningful with continueFromPrevious):
   * 'references' (default) – sent in reference mode with the carried reference images and voices plus the last frame
   * as one more reference the composed prompt says to start on; 'exact' – image-to-video from the frame itself
   * (exact first frame, no references), as before.
   */
  continueMode: ContinueMode
  /**
   * "End on the next clip's first frame": use the next segment's first displayed frame (its selected take at its
   * trimStart) as this segment's end image. Never set on the last clip. Together with continueFromPrevious the
   * clip is regenerated "between its neighbours", which stay untouched.
   */
  endFromNext: boolean
  /** "What happens": the user's or an agent's free-text notes about the shot (any language). */
  notes: string
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
  /**
   * "Export format": the exported film's height in pixels (480, 720 or 1080); the width follows the first clip's
   * aspect. null/undefined: Automatiskt (the first clip's own size).
   */
  exportHeight?: number | null
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

/** See Segment.continueMode. */
export type ContinueMode = 'references' | 'exact'

export interface SegmentInit {
  /** Insert after this segment; default is at the end. */
  afterSegmentId?: string
  /**
   * Start from these params; default is the sequence defaults (or the previous segment's settings, without its
   * prompt and keyframes).
   */
  params?: GenerationParams
  /** Use an existing generation as the first (selected) take; its params seed the segment. */
  fromGenerationId?: string
  continueFromPrevious?: boolean
  continueMode?: ContinueMode
  /** Refused for a clip added at the end (it has no next clip). */
  endFromNext?: boolean
  notes?: string
}

export interface SegmentPatch {
  params?: GenerationParams
  continueFromPrevious?: boolean
  continueMode?: ContinueMode
  /** Refused for the last clip. Turning it on switches the clip to an image-to-video model that takes an end image. */
  endFromNext?: boolean
  notes?: string
  trimStart?: number
  trimEnd?: number
  /** null clears the selection. */
  selectedGenerationId?: string | null
}

/** A clip's keyframe slots: the image it starts from and the one it ends on. */
export type SegmentImageSlot = 'start' | 'end'

/** What to put in a keyframe slot (StudioApi.setSegmentImage). */
export type SegmentImageSource =
  /** An image file from outside Studio (picked or dropped): copied into the sequence's Storyboard folder as a still. */
  | { kind: 'file'; path: string }
  /** A photo of an asset of any kind (AssetImage.id), used where it is. */
  | { kind: 'asset-image'; imageId: string }
  /** A still of the sequence (generated, uploaded or a saved frame). */
  | { kind: 'still'; stillId: string }
  /** The frame of a take at `time` seconds: extracted and saved as a still (source 'frame'). */
  | { kind: 'frame'; generationId: string; time: number }
  /** Automatic, start slot only: the previous clip's last frame (sets continueFromPrevious). */
  | { kind: 'previous' }
  /** Automatic, end slot only: the next clip's first frame (sets endFromNext). */
  | { kind: 'next' }

/**
 * The images a clip would be generated from right now (StudioApi.previewSegmentFrames): automatic frames are
 * extracted from the neighbours' selected takes (cached, free), explicit keyframes are given as they are.
 */
export interface SegmentFramePreview {
  start?: {
    /** Absolute: the extracted frame (PNG) or the keyframe image. */
    path: string
    source: 'previous' | 'image'
    /** 1-based number of the clip the frame comes from ('previous'). */
    fromClip?: number
    /** Seconds into that clip's selected take where the frame is (where its end trim cuts). */
    time?: number
  }
  end?: {
    path: string
    source: 'next' | 'image'
    /** 1-based number of the clip the frame comes from ('next'). */
    fromClip?: number
    /** Seconds into that clip's selected take (its trimStart). */
    time?: number
  }
  /** Why the clip can't be generated as it stands, e.g. "Clip 4 has no finished selected take yet." */
  problems: string[]
}

// ── Storyboards: milestone images and the transitions between them ──────────
// A storyboard is a sequence of kind 'storyboard' (main reuses the sequence machinery: takes, folders, export,
// approvals), but it is its own workflow with its own view and list: one image per board, and between every two
// adjacent boards a transition — the clip that goes from the first board's image to the second's.

/** What a row of the sequences table is: a sequence (Sequences) or a storyboard (Storyboards). */
export type SequenceKind = 'sequence' | 'storyboard'

/** The formats a storyboard can have: what the default image-to-video model's pictures are practically made in. */
export const STORYBOARD_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const
export const DEFAULT_STORYBOARD_ASPECT_RATIO = '16:9'

/** One milestone of the film: a single image (empty while planning) and a short note of what it shows. */
export interface StoryboardBoard {
  id: string
  /** 0-based order within the storyboard. */
  position: number
  /** Absolute. Undefined while the board is empty. */
  imagePath?: string
  /** The still the image is, when it is one (generated, uploaded, a saved frame); not for a library photo. */
  stillId?: string
  /** "What does the image show?": free text, any language. */
  note: string
  /** The image's shape differs noticeably from the storyboard's aspect ratio (a clip takes the image's shape). */
  aspectMismatch?: boolean
}

/**
 * The clip between two adjacent boards: generated image-to-video from the first board's image (`image_url`) to
 * the second's (`end_image_url`). Its id is the id of the segment behind it, so takes and approvals work as for
 * sequence clips.
 */
export interface StoryboardTransition {
  /** The segment id. */
  id: string
  /** 0-based: transition i goes from board i to board i+1. */
  position: number
  fromBoardId: string
  toBoardId: string
  /** The template for new takes: prompt ("What happens?"), model, duration … and the two board images. */
  params: GenerationParams
  selectedGenerationId?: string
  /** Newest first. */
  takes: Generation[]
  /** Both boards have images, so it can be generated (other problems may still stand in the way, see problems). */
  ready: boolean
  /** The selected take was made from other images than the boards have now ("made with an earlier image"). */
  staleTake?: boolean
  /** Why it can't be generated as it stands, e.g. "Board 2 has no image."; [] when it can. */
  problems: string[]
}

export interface Storyboard {
  id: string
  name: string
  /** The format of the film and of new board images, e.g. "16:9". */
  aspectRatio: string
  boards: StoryboardBoard[]
  /** boards.length − 1 of them (none for fewer than two boards), in order. */
  transitions: StoryboardTransition[]
  /** "Generate missing" is sending the missing transitions to Venice. */
  running: boolean
  /** Why the last "Generate missing" stopped ("Transition 2: …"); cleared when a new run starts. */
  runError?: string
  createdAt: number
  updatedAt: number
}

export interface StoryboardSummary {
  id: string
  name: string
  boardCount: number
  transitionCount: number
  /** Transitions with a finished selected take. */
  doneCount: number
  /** The first board image, if any board has one. */
  coverPath?: string
  updatedAt: number
}

/** What to put on a board (StudioApi.addBoard / updateBoard): a keyframe source without the neighbour frames. */
export type BoardImageSource = Exclude<SegmentImageSource, { kind: 'previous' } | { kind: 'next' }>

/** A change to a transition (StudioApi.updateTransition); fields left out stay as they are. */
export interface TransitionPatch {
  prompt?: string
  /** '' clears it. */
  negativePrompt?: string
  duration?: string
  resolution?: string
  audio?: boolean
  /** Must take an end image (supportsEndImage); the other options are fitted to it. */
  model?: string
  /** One of the transition's takes; null clears the selection. */
  selectedGenerationId?: string | null
}

// ── Images and stills (storyboard keyframes) ─────────────────────────────────

/** A Venice image model: text-to-image (`edit` false) or an edit model that combines reference images (`edit` true). */
export interface ImageModel {
  id: string
  name: string
  /** Takes reference images (Venice's inpaint/edit models with `combineImages`); false for text-to-image. */
  edit: boolean
  /** How many reference images an edit model takes (Venice's maxInputImages, 3 when it doesn't say). */
  maxInputImages: number
  aspectRatios: string[]
  resolutions: string[]
  qualities: string[]
  privacy: string
  offline: boolean
}

/** What a still is generated from ("Create image…"). */
export interface StillParams {
  /**
   * The sequence (Sekvenser/<name>/Storyboard/) or storyboard (Storyboards/<name>/Bilder/) the still belongs to and
   * is saved with; none: Referensbilder. A storyboard's aspect ratio is the still's default format.
   */
  sequenceId?: string
  prompt: string
  /** Text-to-image models only. */
  negativePrompt?: string
  model: string
  /** Absolute paths, in order; the first is the base image the edit model works from. Empty/none: text-to-image. */
  referenceImages?: string[]
  aspectRatio?: string
  resolution?: string
  quality?: string
  /**
   * The dialog's key while the picture is made, so its result or failure is announced (Activity) also after
   * the dialog closed. Informational: never sent to Venice and never stored; main reads it from the raw IPC input.
   */
  workToken?: string
  /**
   * Where the picture is meant to go, for its label in Activity ("Image for board 3 in …"). Informational like
   * workToken; an agent's request_image_generation passes its assign_to here too.
   */
  target?: { boardId?: string; segmentId?: string; slot?: SegmentImageSlot }
}

/** An image of a sequence or a storyboard: generated, uploaded, or a frame saved from a take. */
export interface Still {
  id: string
  /** The sequence or storyboard; undefined once it is deleted (the still then lives in Referensbilder). */
  sequenceId?: string
  /** Absolute. */
  path: string
  source: 'generated' | 'upload' | 'frame'
  /** For generated stills; '' otherwise. */
  prompt: string
  model?: string
  /** How a generated still was made (reference paths absolute). workToken and target are never stored. */
  params: Omit<StillParams, 'prompt' | 'model' | 'sequenceId' | 'workToken' | 'target'>
  /** USD, for generated stills. */
  costUsd?: number
  createdAt: number
}

export interface ExportProgress {
  /** The sequence or storyboard being exported. */
  sequenceId: string
  /** 0–1 */
  progress: number
  done?: boolean
  path?: string
  error?: string
}

// ── Own clips: the user's own films imported into the library ──────────────

/** What inspectVideoFiles found out about a file before it is imported (free; nothing is copied yet). */
export interface VideoFileInfo {
  /** Absolute, as given. */
  path: string
  /** The file's name with its extension. */
  name: string
  bytes: number
  /** It can be imported. */
  ok: boolean
  /** A refusal naming the file, e.g. "<name>: The file has no video track." */
  error?: string
  /** Seconds. */
  duration?: number
  /** As displayed (rotation applied). */
  width?: number
  height?: number
  fps?: number
  hasAudio?: boolean
  /** E.g. "hevc", "h264", "prores". */
  codec?: string
  hdr?: boolean
  bitDepth?: number
  variableFrameRate?: boolean
  /** Reduced "w:h", e.g. "16:9". */
  aspect?: string
  /** Why a working copy will be made (e.g. "HDR", "4K → 1080p"); [] = none needed. */
  workingCopy: string[]
  /** On the same APFS volume as the library: it is cloned (no extra space) instead of copied. */
  cloneable: boolean
  /** Generation id of an earlier import of the same file (same SHA-256) whose file still exists: it is reused. */
  duplicateOf?: string
}

/** Where imported files go. */
export type ImportTarget =
  /** The clip feed only. */
  | { kind: 'feed' }
  /** One new clip per file, in name order, after `afterSegmentId` (default: at the end). */
  | { kind: 'sequence'; sequenceId: string; afterSegmentId?: string; fit?: 'pad' | 'crop' }
  /** A take of that clip, selected. */
  | { kind: 'segment'; segmentId: string; fit?: 'pad' | 'crop' }

export interface ImportResult {
  /** The import rows (or the earlier ones reused), in the order the files were given. */
  generationIds: string[]
  /** Files that couldn't be imported (messages); the others were. */
  errors: { path: string; message: string }[]
  sequenceId?: string
  /** 'sequence' and 'segment' targets: the clips the files went to. */
  segmentIds?: string[]
}

export interface ImportProgress {
  path: string
  /** 0–1 */
  fraction: number
  sequenceId?: string
  segmentId?: string
  generationId?: string
  done?: boolean
  error?: string
}

// ── Audio models (GET /models?type=tts|music|asr, with the key when one is set) ─

/** A text-to-speech model: /audio/speech ('speech', synchronous) or /audio/queue ('queue', e.g. ElevenLabs). */
export interface SpeechModel {
  id: string
  name: string
  endpoint: 'speech' | 'queue'
  voices: string[]
  defaultVoice?: string
  /** Takes a provider voice id of the user's own. */
  customVoiceId: boolean
  /** Can clone a voice from a sample (/audio/voices). */
  cloning?: { minSampleSeconds: number; formats: string[]; retentionDays: number }
  /** Response formats it can give (Chatterbox: wav only). */
  formats: string[]
  maxCharacters: number
  usdPerThousandChars?: number
  /** Takes a style/tone prompt. */
  stylePrompt: boolean
  /** Takes language_code. */
  languageCode: boolean
  speed?: { min: number; max: number; default: number }
}

/** A music or sound-effect model (/audio/queue). */
export interface AudioGenModel {
  id: string
  name: string
  kind: 'music' | 'effect'
  minSeconds: number
  maxSeconds: number
  /** Only these durations are accepted (ACE-Step: 60…210). */
  durationOptions?: number[]
  defaultSeconds: number
  loop: boolean
  /** Takes force_instrumental. */
  instrumental: boolean
  promptLimit: number
  minPromptLength: number
  /** false: the model takes no duration_seconds (Lyria); min/max are then Studio's assumption (1–180 s). */
  durationControl: boolean
}

/** A speech-to-text model with timestamps (parakeet, which gives none, is left out). */
export interface AsrModel {
  id: string
  name: string
  usdPerSecond: number
  timestamps: 'word' | 'segment'
}

/** A speech-to-speech model (/audio/voice-changer/*): keeps the performance, changes the voice. */
export interface VoiceChangerModel {
  id: string
  name: string
  voices: string[]
  defaultVoice?: string
  customVoiceId: boolean
  /** Longest upload one request takes. */
  maxSourceSeconds: number
  /** accepted_audio_formats. */
  formats: string[]
  backgroundNoiseRemoval: boolean
  seed: boolean
}

export interface AudioCatalog {
  speech: SpeechModel[]
  music: AudioGenModel[]
  effects: AudioGenModel[]
  transcription: AsrModel[]
  /** Empty while Venice lists no voice changer (for this account). */
  voiceChangers: VoiceChangerModel[]
  /** Models that make a voice from a description (seed-audio, voice "Describe in prompt"). */
  voiceDesign: SpeechModel[]
  /** The list was fetched with the API key (some models are only listed to keyed accounts). */
  keyed: boolean
  fetchedAt: number
}

/** Whether this Mac can separate voice and background (the built-in AUSoundIsolation helper). */
export interface SeparationStatus {
  available: boolean
  quality?: 'high' | 'standard'
  /** Why, when not available. */
  message?: string
}

// ── Transcripts ──────────────────────────────────────────────────────────────

export interface TranscriptWord {
  text: string
  start: number
  end: number
}

export interface TranscriptSegment {
  id: string
  /** Seconds in the generation's own video. */
  start: number
  end: number
  text: string
  words?: TranscriptWord[]
  /** The text was changed by hand (or an agent). */
  edited?: boolean
}

export interface Transcript {
  generationId: string
  /** Inherited from this ancestor version (the timing is the same), not stored for this one. */
  inheritedFrom?: string
  language?: string
  model?: string
  segments: TranscriptSegment[]
  costUsd?: number
  createdAt: number
  updatedAt: number
}

// ── Edits (Editor): one film changed into versions ───────────────────────────

/** Seconds in the base version. */
export interface EditRange {
  start: number
  end: number
}

export type VoiceChoice =
  | { kind: 'preset'; voice: string }
  /** A provider voice id (customVoiceId models). */
  | { kind: 'custom'; voiceId: string }
  /** A character's voice clip (asset_audio id), cloned with tts-chatterbox-hd. */
  | { kind: 'clone'; audioId: string }

/** keep needs separation; duck = the original at −18 dB where the voice is replaced; remove = silence there. */
export type BackgroundChoice = 'keep' | 'duck' | 'remove'

/** Replaces that transcript line (segmentId), or a new line at `at` seconds. */
export interface SpeakLine {
  segmentId?: string
  at?: number
  text: string
}

export type EditOperation =
  // free, local
  | { op: 'trim'; keep: EditRange }
  | { op: 'cut'; range: EditRange }
  | { op: 'fade'; inSeconds?: number; outSeconds?: number }
  | { op: 'volume'; gainDb: number; range?: EditRange; target?: 'all' | 'voice' | 'background' }
  | { op: 'mute'; range?: EditRange; target: 'all' | 'voice' | 'background' }
  | { op: 'denoise'; strength: 'mild' | 'strong' }
  | { op: 'loudness'; lufs: -14 | -16 | -23 }
  | {
      op: 'add-audio'
      source: { mediaId: string } | { assetAudioId: string }
      at: number
      gainDb?: number
      duck?: boolean
      loop?: boolean
      length?: number
      fadeInSeconds?: number
      fadeOutSeconds?: number
      replaceBed?: boolean
    }
  | { op: 'layer'; layerId: string; gainDb?: number; at?: number; remove?: boolean }
  // paid
  | { op: 'transcribe'; model?: string; language?: string }
  | {
      op: 'change-voice'
      model: string
      voice: Exclude<VoiceChoice, { kind: 'clone' }>
      range?: EditRange
      segmentIds?: string[]
      background: BackgroundChoice
      removeNoise?: boolean
    }
  | {
      op: 'speak-lines'
      model: string
      voice: VoiceChoice
      lines: SpeakLine[]
      background: BackgroundChoice
      fit: 'tempo' | 'overlap'
      style?: string
      language?: string
    }
  | {
      op: 'music'
      model: string
      prompt: string
      range?: EditRange
      instrumental?: boolean
      gainDb?: number
      duck?: boolean
      fadeSeconds?: number
    }
  | { op: 'effect'; model: string; prompt: string; at: number; seconds: number; gainDb?: number }
  | { op: 'regenerate'; range: EditRange; prompt: string; model: string; resolution?: string; audio: 'keep' | 'model' }
  | {
      op: 'prompt-edit'
      range: EditRange
      prompt: string
      model: string
      resolution?: string
      referenceImageIds?: string[]
      audio: 'keep' | 'model'
    }
  | { op: 'extend'; seconds: number; prompt: string; model: string; resolution?: string; audio: 'model' | 'silence' }
  | { op: 'upscale'; factor: 2 | 4 }

/** What an operation would do and cost on a base version (planEditOperation; free). */
export interface EditPlan {
  /** Normalized: range snapped, defaults filled. */
  operation: EditOperation
  baseId: string
  paid: boolean
  /** USD, the total of the parts Venice prices; undefined = none of it can be priced. */
  priceUsd?: number
  /** true: priceUsd leaves out a part Venice doesn't price (a voice clone); the UI confirms. */
  partialPrice?: boolean
  /** E.g. "billed per started minute: 3 min", "Voice cloning: Venice doesn't state a price". */
  priceNote?: string
  steps: { label: string; seconds?: number; priceUsd?: number }[]
  /** Picture ops: cached PNG paths (absolute; free). */
  frames?: { start?: string; end?: string }
  resultSeconds?: number
  estimatedBytes?: number
  notes: string[]
  warnings: string[]
  /** Non-empty: it cannot run. */
  problems: string[]
  /** Base file identity + normalized op + price inputs: equal fingerprints mean the same work at the same price. */
  fingerprint: string
}

export interface EditRunOptions {
  /** Default: the edit's current version. */
  baseId?: string
  /** The price the user (or the approval) saw; the run refuses when it rose by more than $0.01. */
  expectedPriceUsd?: number
  /**
   * Whether that price was unknown or left a part out (a voice clone) when the user confirmed it. When it wasn't, a plan
   * that has become unknown or partial since (a clone handle that ran out meanwhile adds an unpriced clone) is refused
   * like a price that rose, so the extra question is asked first.
   */
  expectedPartial?: boolean
}

export interface EditRunResult {
  /** Paid (and long) operations run as a job. */
  jobId?: string
  /** Free operations: the version made. */
  versionId?: string
  /** Picture operations: the AI take submitted. */
  takeId?: string
}

export type GainSpan = {
  start: number
  end: number
  gainDb?: number
  mute?: boolean
  /** Seconds, default 0.02. */
  fade?: number
}

export type AudioSourceRef = { kind: 'generation'; id: string } | { kind: 'media'; id: string }

export interface AudioBed {
  source: AudioSourceRef | null
  gains: GainSpan[]
  stems?: {
    voice: AudioSourceRef | 'separated' | null
    voiceGains: GainSpan[]
    background: 'separated' | null
    backgroundGains: GainSpan[]
  }
}

export interface AudioLayer {
  id: string
  kind: 'speech' | 'voice' | 'music' | 'effect' | 'audio'
  mediaId?: string
  /** Kept only as a label: layers always play edit media (a library clip is copied into Ljud/ first). */
  assetAudioId?: string
  label: string
  /** Seconds in the film where it starts. */
  at: number
  /** Seconds into the media. */
  offset: number
  length: number
  gainDb: number
  fadeIn: number
  fadeOut: number
  duck: boolean
  loop: boolean
}

/** A version's sound as it was built, so later audio operations rebuild it instead of stacking on a mixdown. */
export interface AudioMix {
  bed: AudioBed
  layers: AudioLayer[]
  denoise?: 'mild' | 'strong'
  loudness?: number
  fadeIn?: number
  fadeOut?: number
}

/** How an import or a version was made. Ids only, never file paths. */
export interface EditRecipe {
  op: EditOperation['op'] | 'original' | 'import'
  operation?: EditOperation
  baseId?: string
  /** E.g. "Changed voice → Aria". */
  label: string
  costUsd?: number
  /**
   * Versions: N of "vN", stored at insert = 1 + the highest N among the edit's versions (v1 = 1), so deleting a
   * middle version renumbers nothing.
   */
  number?: number
  timing: 'same' | 'changed'
  /** timing 'changed': base [from, to) appears at `at`. */
  spans?: { from: number; to: number; at: number }[]
  /** The sound as built, for later audio ops to rebuild from. */
  mix: AudioMix
  /** Picture ops: the AI take spliced in. */
  takeId?: string
  /** Cut markers carried along. */
  cuts?: number[]
  import?: { name: string; bytes: number; sha256: string; workingCopy: string[]; fit?: 'pad' | 'crop' }
  export?: { exportId: string; sequenceName?: string }
}

/** What an edit was opened from. */
export interface EditOrigin {
  kind: 'generation' | 'take' | 'export' | 'import'
  generationId?: string
  exportId?: string
  sequenceId?: string
  sequenceName?: string
  segmentId?: string
  clipNumber?: number
  /** The origin is gone (deleted). */
  missing?: boolean
}

export interface EditSummary {
  id: string
  name: string
  origin: EditOrigin
  /** The current version's generation id. */
  currentId?: string
  posterPath?: string
  versionCount: number
  /** Seconds, of the current version. */
  duration?: number
  /** A job is running. */
  running: boolean
  totalCostUsd: number
  /** Every generation of the edit: its versions and AI takes. */
  generationIds: string[]
  updatedAt: number
}

export interface EditVersion {
  /** The generation id. */
  id: string
  number: number
  parentId?: string
  label: string
  op: EditRecipe['op']
  costUsd?: number
  current: boolean
  createdAt: number
  generation: Generation
  /** Sequence clips that use it (as a take). */
  usedBy: { sequenceId: string; sequenceName: string; segmentId: string; clipNumber: number }[]
}

export interface EditJob {
  id: string
  op: EditOperation['op'] | 'design-voice'
  label: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  baseId?: string
  /** 0–1 */
  fraction?: number
  stepsDone: number
  stepsTotal: number
  /** E.g. "part 2 of 3". */
  currentStep?: string
  /** USD sent so far. */
  costUsd: number
  quoteUsd?: number
  error?: string
  takeId?: string
  resultId?: string
  canCancel: boolean
  /**
   * "Continue": unsent or failed parts can be sent (paid again for those), or a picture operation's paid take can be
   * put into the film again after its finish failed (free).
   */
  canResume: boolean
  /** What "Continue" costs: the priced parts (0 when nothing is sent again); undefined when no part has a price. */
  resumePriceUsd?: number
  /** A part without a price (a voice clone, or a part whose quote failed) is left out of resumePriceUsd. */
  resumePartialPrice?: boolean
  /** Why resumePriceUsd leaves a part out, when every such part is a voice clone. */
  resumePriceNote?: string
  createdAt: number
  updatedAt: number
}

/** Paid or added audio of an edit (Redigeringar/<namn>/Ljud/). */
export interface EditMedia {
  id: string
  kind: 'voice' | 'speech' | 'music' | 'effect' | 'audio' | 'bake'
  label: string
  /** Absolute. */
  path: string
  durationSeconds?: number
  model?: string
  costUsd?: number
  createdAt: number
}

export interface Edit extends EditSummary {
  /** In creation order (v1 first). */
  versions: EditVersion[]
  /** Newest first. */
  jobs: EditJob[]
  media: EditMedia[]
  /** The AI takes made for picture operations. */
  takes: Generation[]
  createdAt: number
}

/** What the editor's timeline draws for a version (editTimeline; free, cached). */
export interface EditTimeline {
  generationId: string
  duration: number
  fps: number
  width: number
  height: number
  hasAudio: boolean
  /** Absolute JPEG paths. */
  filmstrip: { time: number; path: string }[]
  /** 0–1 peaks. */
  waveform: number[]
  /** Cut markers, seconds. */
  cuts: number[]
  cutsSource: 'export' | 'scenes' | 'none'
  layers: { id: string; kind: AudioLayer['kind']; label: string; start: number; end: number; gainDb: number }[]
  muted: { start: number; end: number; target: 'all' | 'voice' | 'background' }[]
  transcript?: Transcript
}

export interface EditProgress {
  editId?: string
  /** Voice design: the character. */
  assetId?: string
  jobId?: string
  /** 0–1 */
  fraction?: number
  label: string
  done?: boolean
  error?: string
}

/** "Design a voice with AI…": a new voice for a character from a description. */
export interface VoiceDesignRequest {
  assetId: string
  description: string
  sampleText: string
  /** Default seed-audio-1-0. */
  model?: string
}

/** Where a version goes: a new take of that clip, or a new clip in that sequence (after `afterSegmentId`). */
export type SendTarget = { segmentId: string } | { sequenceId: string; afterSegmentId?: string }

/** What an 'edit' or 'voice-design' approval request asks for. */
export interface ApprovalEditRequest {
  editId?: string
  editName?: string
  baseId?: string
  baseNumber?: number
  assetId?: string
  assetName?: string
  operation?: EditOperation
  voiceDesign?: VoiceDesignRequest
  /** A one-liner. */
  summary: string
  /** Picture ops: the start and end frames (absolute). */
  frames?: { start?: string; end?: string }
  /** speak-lines: old → new text, at seconds. */
  lines?: { old?: string; new: string; at: number }[]
  /** change-voice on chosen lines (segmentIds): the transcript lines that get the new voice, at seconds. */
  voiceLines?: { text: string; at: number }[]
  steps?: { label: string; priceUsd?: number }[]
  priceNote?: string
  /** A part has no price (a voice clone, a quote that failed): the request's price is what the other parts cost. */
  partialPrice?: boolean
  /** The voice must be cloned and the user hasn't confirmed they may use it: the dialog asks first. */
  needsCloneConsent?: { audioId: string; assetName: string }
  /** Once approved: the job it started and the version it made. */
  jobId?: string
  resultId?: string
  /** Resuming a stopped paid job ("Continue") instead of a new operation: that job's id. */
  resumeJobId?: string
}

// ── Status: Activity ─────────────────────────────────────────────────────────
// What runs right now and what finished that the user hasn't looked at yet, wherever it was started. Main builds the
// summary (src/main/work.ts) from the services' registries and the library's `unseen` table and pushes it whole on
// `work:change`; the renderer keeps one store of it (lib/work.ts) that the sidebar, the lists, the cards and the
// panel read.

/** The sidebar view an item counts under (the renderer's View ids). */
export type WorkView =
  | 'generate'
  /** Media: a picture with no sequence or storyboard, and Generate's work from an earlier session. */
  | 'media'
  | 'sequences'
  | 'storyboards'
  | 'editor'
  | 'characters'
  | 'environments'
  | 'products'
  | 'outfits'
  | 'poses'

/** Where "Go there" goes; the renderer maps it to navigate(view, intent). */
export interface WorkTarget {
  view: WorkView
  generationId?: string
  sequenceId?: string
  segmentId?: string
  storyboardId?: string
  transitionId?: string
  boardId?: string
  editId?: string
  versionId?: string
  jobId?: string
  assetId?: string
  audioId?: string
  exportId?: string
  stillId?: string
  /** An agent request being carried out: opens it in the approval dialog instead. */
  approvalId?: string
}

export type RunningKind =
  | 'video'
  | 'sending'
  | 'run'
  | 'still'
  | 'edit-job'
  | 'render'
  | 'voice-design'
  | 'export'
  | 'import'
  | 'approval'
  | 'upload'

/** Something under way right now. */
export interface RunningWork {
  /**
   * Stable while it runs: 'gen:<id>', 'send:<token>', 'run:<sequenceId>', 'still:<token>', 'job:<id>',
   * 'render:<token>', 'export:<sequenceId>', 'import:<path>', 'approval:<id>', 'upload:<id>'.
   */
  key: string
  kind: RunningKind
  /** Undefined: counted only in the panel and the totals (uploads). */
  view?: WorkView
  /** The sequence, storyboard, edit or asset it belongs to. */
  ownerId?: string
  /** The clip or transition it belongs to. */
  segmentId?: string
  /** E.g. "Clip 3 in “Beach scene”". */
  label: string
  /** The phase, e.g. "Generating 40%", "Queued at Venice". */
  detail?: string
  startedAt: number
  /** 0–1. */
  progress?: number
  /** Milliseconds left, as measured at measuredAt (the renderer counts down from there). */
  remainingMs?: number
  /** How long this kind of work usually takes, in milliseconds ("brukar ta ~3 min"). */
  typicalMs?: number
  measuredAt: number
  /** Absolute. */
  thumbPath?: string
  /** The agent whose approved request (or upload) it is. */
  via?: string
  generationId?: string
  target?: WorkTarget
}

export type FinishedKind = 'video' | 'version' | 'still' | 'export' | 'voice' | 'job' | 'failure'

/** Something that finished (or failed) and that the user hasn't looked at yet. */
export interface FinishedWork {
  /** 'gen:<id>' | 'still:<id>' | 'export:<id>' | 'audio:<id>' | 'job:<id>' | 'unseen:<row id>' (see workKey). */
  key: string
  kind: FinishedKind
  status: 'completed' | 'failed'
  view: WorkView
  ownerId?: string
  segmentId?: string
  label: string
  error?: string
  finishedAt: number
  /** Absolute. */
  thumbPath?: string
  /** Absolute: the video or sound whose playback marks it seen. */
  mediaPath?: string
  via?: string
  generationId?: string
  stillId?: string
  exportId?: string
  audioId?: string
  jobId?: string
  /** An error-only row ('unseen:<id>'): what failed. 'still' rows carry the dialog's workToken. */
  failureOf?: 'still' | 'export' | 'run'
  workToken?: string
  target: WorkTarget
}

/** `unseen` = finished fine and not seen; `failed` = failures not seen. Disjoint: the Dock badge is unseen + failed. */
export interface WorkCounts {
  running: number
  unseen: number
  failed: number
}

/**
 * An unseen item past the 200 the summary lists in full: enough for the window's seen rules – its "New" marks, the
 * playback rule (mediaPath) and a picture being on screen (picturePath). Paths absolute.
 */
export interface UnseenRef {
  key: string
  failed?: true
  mediaPath?: string
  picturePath?: string
}

export interface WorkSummary {
  running: RunningWork[]
  /** Finished and not seen yet, newest first, failures included; at most 200 (the counts are exact). */
  unseen: FinishedWork[]
  /** Every unseen item after those 200, newest first. */
  more: UnseenRef[]
  byView: Partial<Record<WorkView, WorkCounts>>
  /** By sequence, storyboard, segment (clip or transition), edit and asset id. */
  byOwner: Record<string, WorkCounts>
  total: WorkCounts
  /** Increases with every summary; an older one never replaces a newer one. */
  revision: number
}

/** What "Mark all as seen" covers: everything, one view, or one sequence, storyboard, edit or asset. */
export interface SeenScope {
  view?: WorkView
  ownerId?: string
}

/** The keys of the summary, built the same way everywhere. */
export const workKey = {
  generation: (id: string) => `gen:${id}`,
  still: (id: string) => `still:${id}`,
  export: (id: string) => `export:${id}`,
  audio: (id: string) => `audio:${id}`,
  job: (id: string) => `job:${id}`,
  row: (id: string) => `unseen:${id}`
} as const

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
  /** E.g. why the port couldn't be opened. */
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
  /** What it did, without the agent's name: "set the prompt", "wants to generate – waiting for your OK". */
  summary: string
  ok: boolean
  /** Set when the call created (or found) an approval request. */
  approvalId?: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'failed'

/** One reference picture of an image request, in the order it is sent (the first is the base the model edits). */
export interface ApprovalImageReference {
  /** Absolute. */
  path: string
  /** What it is: "Anna (photo 2)", "Still image: woman on the pier …". */
  label: string
  /** A short name for a small tile: "Anna", "Still image". */
  name?: string
  /** The asset's kind (for the colour of its tile), or 'still' for a still of a sequence. */
  kind?: AssetKind | 'still'
}

/** What an image request (kind 'image') asks for: one still for a storyboard, made with Venice's image models. */
export interface ApprovalImageRequest {
  /** Exactly what is generated (reference paths absolute, in the order they are sent). */
  params: StillParams
  modelName?: string
  references: ApprovalImageReference[]
  /** Where the still goes once it is made: a clip's start or end image (clipNumber as it was when asked). */
  assignTo?: { segmentId: string; slot: SegmentImageSlot; clipNumber: number }
  /** Or a storyboard's board: the still becomes its image (boardNumber 1-based, as it was when asked). */
  assignToBoard?: { boardId: string; storyboardId: string; boardNumber: number }
}

/** What a 'delete' request item removes (request_delete; every removal by an agent goes through one). */
export type DeleteTargetKind =
  | 'asset'
  | 'asset-image'
  | 'asset-audio'
  | 'prompt'
  | 'learning'
  | 'review'
  | 'sequence'
  | 'segment'
  | 'storyboard'
  | 'board'
  | 'board-move'
  | 'generation'
  | 'take'
  | 'still'
  | 'edit'
  | 'version'
  | 'prune-versions'

/** One thing a 'delete' request removes, as planned when the agent asked (and its outcome once approved). */
export interface ApprovalDeleteItem {
  kind: DeleteTargetKind
  /** The row's id (for prune-versions the edit's id; for board-move the board's). */
  id: string
  /** 'take': the clip or transition it is taken off. */
  segmentId?: string
  /** 'board-move': the 0-based place it moves to. */
  toIndex?: number
  /** E.g. "The character “Anna”", "Clip 4 in “Sommar”". */
  label: string
  /** Group heading, e.g. "Characters", "Clips". */
  group: string
  /** Absolute picture: the asset's cover, the photo, a poster, the still, the board picture. */
  preview?: string
  /** 'asset-audio': the clip's file (absolute) and its length in seconds, so the dialog can name it and play it. */
  sound?: { path: string; duration: number }
  assetKind?: AssetKind
  /** Prompts, learnings, reviews: a text excerpt (≤ 200 chars). */
  text?: string
  /** Lines: what else happens, e.g. "3 takes become ordinary clips in Media". */
  effects: string[]
  /** What goes to the Trash. */
  trash?: { files: number; bytes?: number }
  /** An asset, sequence, storyboard or edit (the dialog asks a second question). */
  container?: boolean
  /** Once approved: what happened to it. */
  outcome?: { status: 'deleted' | 'gone' | 'failed'; error?: string }
}

/** What a 'delete' request asks for. */
export interface ApprovalDeleteRequest {
  /** A one-liner, e.g. "Delete 3 items in “Sommar”". */
  summary: string
  items: ApprovalDeleteItem[]
  /** The second step's question when containers or more than 5 items go. */
  confirm?: string
}

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
  /**
   * generation: the Generate form. segment: one sequence clip. generate-all: every clip still missing a take.
   * image: one still for a storyboard ("Create image"). edit: a paid operation in the Editor (or resuming a stopped
   * one). voice-design: a new voice for a character ("Design a voice with AI"). delete: removing things (free, but
   * nothing an agent asks to remove goes without the user's OK).
   */
  kind: 'generation' | 'segment' | 'generate-all' | 'image' | 'edit' | 'voice-design' | 'delete'
  /**
   * What will be generated: the form for 'generation', the clip's settings for 'segment' (a clip continuing
   * from the previous one gets that clip's last frame as its start image when it is generated).
   */
  params?: GenerationParams
  /** 'image': what will be made. */
  image?: ApprovalImageRequest
  /** 'edit' and 'voice-design': what will be done. */
  edit?: ApprovalEditRequest
  /** 'delete': what will be removed (and, once approved, each item's outcome). */
  delete?: ApprovalDeleteRequest
  /** 'image', once approved: the still it made. */
  stillId?: string
  /** Approved, but something after the paid step didn't work out, e.g. the clip was gone. */
  notice?: string
  sequenceId?: string
  sequenceName?: string
  /**
   * 'storyboard' when sequenceId is a storyboard: a 'segment' request is then one transition (its segmentIds and
   * clipNumbers name the transition), 'generate-all' the storyboard's missing transitions. Absent: a sequence.
   */
  sequenceKind?: SequenceKind
  /** 'segment': the clip; 'generate-all': the clips that will be generated, in order. */
  segmentIds?: string[]
  /** 1-based clip numbers of segmentIds, as Studio shows them ("Clip 3"). */
  clipNumbers?: number[]
  /** USD; for 'generate-all' the sum over the clips. Undefined when Venice couldn't quote it. */
  priceUsd?: number
  status: ApprovalStatus
  /** Why it failed or expired. */
  error?: string
  /** The user's reason when they declined. */
  reason?: string
  /** The generations it started once approved ('generate-all' starts them one by one, so it has none). */
  generationIds?: string[]
  /**
   * 'generation' and 'segment': the prompt exactly as it will be sent – params.prompt with the References legend
   * of the referenced assets' descriptions appended (ComposedPrompt.prompt) – when something is appended. The
   * request lapses when it changes before the user approves (a description edited meanwhile).
   */
  composedPrompt?: string
  /** The appended legend alone (ComposedPrompt.legend), so the dialog can set it apart from the user's prompt. */
  descriptionLegend?: string
  /**
   * 'generate-all': each clip's appended legend when the request was made (segment id → ComposedPrompt.legend, ''
   * for none). The request lapses when one changes, so the dialog compares them with the legends composed now.
   */
  clipLegends?: Record<string, string>
}

/** Commands main sends to the window's agent bridge (see StudioApi.onAgentCommand). */
export type AgentFormCommand =
  | 'get_form'
  | 'set_form'
  | 'set_references'
  | 'reorder_references'
  | 'swap_reference'
  | 'open'

export interface AgentCommand {
  id: string
  /**
   * When main stops waiting for the answer (Date.now() time; both processes share the clock). A command still
   * queued after it has been answered as failed already, so it must not be applied.
   */
  deadline?: number
  command: AgentFormCommand
  /**
   * get_form: none. set_form: AgentSetFormArgs. set_references: AgentSetReferencesArgs. reorder_references:
   * AgentReorderReferencesArgs. swap_reference: the tool's input (agent/swap.ts). open: AgentOpenArgs.
   */
  args: unknown
}

export interface AgentCommandReply {
  ok: boolean
  /** get_form, set_form, set_references and reorder_references: AgentFormState. open: AgentOpenResult. */
  result?: unknown
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

/** One reference audio clip of the Generate form, as the bridge reports it. */
export interface AgentFormAudioReference {
  /** "@Audio1" for the first reference audio. */
  token: string
  assetId?: string
  assetName?: string
  kind?: AssetKind
  /** The asset's clip (AssetAudio.id), when it is one. */
  audioId?: string
  /** Absolute. */
  path: string
  /** The window sent to Venice, in seconds. */
  start?: number
  length?: number
}

/** What get_form (and set_form, set_references) answer with. */
export interface AgentFormState {
  /** The view Studio shows, e.g. 'generate', 'sequences' or 'storyboards'. */
  view: string
  /** The sequence and clip open in the sequence editor, if any (view 'sequences'). */
  sequenceId?: string
  segmentId?: string
  /** The storyboard open in Storyboards, if any (view 'storyboards'). */
  storyboardId?: string
  /** The edit open in the Editor, if any (view 'editor'). */
  editId?: string
  /** The Media tab on screen (view 'media'). */
  mediaTab?: MediaTab
  /** The Generate form. */
  params: GenerationParams
  references: AgentFormReference[]
  /**
   * Reference images in the form past the model's limit ("not sent" in the strip): not in `params` (which is
   * what a generation sends) and without a token, with their 1-based place in the form's list, so an agent can
   * see them and move one forward with reorder_references.
   */
  unsentReferences?: (Omit<AgentFormReference, 'token'> & { position: number })[]
  /** The reference audio clips (params.referenceAudios with their tokens and assets). */
  audioReferences?: AgentFormAudioReference[]
  issues: PromptIssue[]
  /** What the window adjusted on its own, e.g. a mode switch or images that didn't fit. */
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
  /** Absolute path of the start image (main resolved the agent's asset photo, still or upload); null clears it. */
  start_image?: string | null
  /** Absolute path of the end image, for a model that takes one (resolved like start_image); null clears it. */
  end_image?: string | null
  /** GenerationParams.includeDescriptions ("Include descriptions"). */
  include_descriptions?: boolean
  /** GenerationParams.excludedDescriptionAssetIds; [] switches every description back on. */
  excluded_description_asset_ids?: string[]
  /**
   * GenerationParams.outfitWearers as a whole (main merged the agent's choices into the form's and checked them);
   * null: no choices, every outfit worn by its default.
   */
  outfit_wearers?: Record<string, string | null> | null
}

/** set_references: photo paths (main resolved the agent's asset ids), in order. */
export interface AgentSetReferencesArgs {
  paths: string[]
  /**
   * Reference audio clips (main resolved the agent's audio ids and windows), in order; follows `mode` like the
   * photos. Omitted: replace clears the audio, append keeps it.
   */
  audios?: ReferenceAudio[]
  /** replace: these become the reference images. append: added after the ones there (duplicates skipped). */
  mode: 'replace' | 'append'
}

/**
 * reorder_references: the form's reference images and/or audio clips in a new order, each named by its token in
 * the current numbering ("@Image3", "@Audio2") or by its absolute path (main resolved the agent's ids and sends
 * paths, so a form the user changed meanwhile still gets the pictures named, or refuses if one is gone). Named ones
 * come first, the rest keep their order after them; the window applies it with reorderReferences
 * (src/shared/prompt-remap.ts), so the prompt's and the negative prompt's tokens follow, in one change of the form.
 */
export interface AgentReorderReferencesArgs {
  images?: string[]
  audios?: string[]
}

/** The library views of the five asset kinds (the renderer's View ids). */
export type AssetViewId = 'characters' | 'environments' | 'products' | 'outfits' | 'poses'

/** The views an agent can open. */
export type AgentOpenView = 'generate' | 'media' | 'sequences' | 'storyboards' | 'editor' | 'prompts' | AssetViewId

/** open: brings a place in Studio to the front. */
export interface AgentOpenArgs {
  view: AgentOpenView
  sequenceId?: string
  segmentId?: string
  /** For 'storyboards': the storyboard to open. */
  storyboardId?: string
  /** For 'storyboards': the transition to open in the transition editor. */
  transitionId?: string
  /** For 'editor': the edit to open (none: the list of edits). */
  editId?: string
  /** For 'editor': the version to show in the player. */
  versionId?: string
  /** For an asset view: the asset to open. */
  assetId?: string
  /** For 'generate': the clip to open in the clip drawer; for 'media': the clip to open in the Videos tab's drawer. */
  generationId?: string
  /** For 'media': the tab (none: the one an item is in, else the one it last showed). */
  tab?: MediaTab
  /** For 'media': the picture to open in Bilder. */
  stillId?: string
  /** For 'media': the film to open in Films. */
  exportId?: string
}

/** What the window shows after an open command. */
export interface AgentOpenResult {
  view: AgentOpenView
  sequenceId?: string
  sequenceName?: string
  /** The clip actually on screen (normally the one asked for). */
  segmentId?: string
  /** The storyboard on screen (view 'storyboards'). */
  storyboardId?: string
  storyboardName?: string
  /** The edit on screen (view 'editor'). */
  editId?: string
  editName?: string
  /** The version shown in the player (view 'editor'). */
  versionId?: string
  /** The transition open in the transition editor (view 'storyboards'). */
  transitionId?: string
  /** The asset on screen (asset views). */
  assetId?: string
  assetName?: string
  /** The clip open in the clip drawer (view 'generate', or Videos in view 'media'). */
  generationId?: string
  /** The Media tab on screen (view 'media'), and the picture or film opened in it. */
  tab?: MediaTab
  stillId?: string
  exportId?: string
  /** When the window couldn't show exactly what was asked for. */
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
  /** "Safe mode for images" (Venice blurs adult content in generated stills while it is on). */
  setImageSafeMode(on: boolean): Promise<void>
  /** Fires after a setting that several views show changed in one of them (so far "Safe mode for images"). */
  onSettingsChange(cb: () => void): () => void

  // Generation
  listModels(force?: boolean): Promise<VideoModel[]>
  quote(params: GenerationParams): Promise<number>
  generate(params: GenerationParams): Promise<Generation>
  acceptConsent(flow: string, version: string): Promise<void>
  /** Newest first, with the user's rating and the review count filled in. */
  listGenerations(): Promise<Generation[]>
  /**
   * Deletes the generation and its files. From a take list (`from.segmentId`: a sequence clip or a storyboard
   * transition), a film the Editor keeps (a version, an edit's original) is only taken off that clip instead, and so is
   * one the list offered "Remove" for (`from.release`: it showed the take as kept by the Editor). Refused when
   * the Editor's rules keep it: a running operation works on it, an edit started from it, a version the Editor wouldn't
   * delete, or a stopped job that has already paid for parts builds on it.
   */
  deleteGeneration(id: string, from?: { segmentId: string; release?: boolean }): Promise<void>
  onGenerationUpdate(cb: (g: Generation) => void): () => void
  /** Fires with the id of a generation that was deleted (from any view), so every list can drop it. */
  onGenerationDelete(cb: (id: string) => void): () => void

  // Reviews and learnings
  /** The generation's reviews: the user's first, then agents' newest first. */
  listReviews(generationId: string): Promise<GenerationReview[]>
  /**
   * Sets the user's own rating, note and tags (fields left out stay; rating null clears it). Resolves with
   * the review, or null when nothing is left of it (no rating, note or tags), in which case it is removed.
   */
  setUserReview(
    generationId: string,
    input: { rating?: number | null; note?: string; tags?: string[] }
  ): Promise<GenerationReview | null>
  deleteReview(reviewId: string): Promise<void>
  /** Pinned first, then most recently updated. */
  listLearnings(): Promise<Learning[]>
  /** Creates (no id; author 'user') or updates a learning. Rejects with a message. */
  saveLearning(input: LearningInput): Promise<Learning>
  deleteLearning(id: string): Promise<void>
  /** Exported films, newest first. */
  listExports(): Promise<ExportSummary[]>
  /**
   * This session (since Studio started; closing the window keeps it): Generate's list shows what was made there
   * since `startedAt` (ms) and what was still being made when it started (see shared/session.ts).
   */
  getSession(): Promise<GenerateSession>
  /** Fires with the generation id whenever its reviews change (also an agent's). */
  onReviewChange(cb: (generationId: string) => void): () => void
  onLearningsChange(cb: () => void): () => void

  // Assets (characters, environments, products, outfits, poses)
  /** Sorted by name; every kind when kind is omitted. */
  listAssets(kind?: AssetKind): Promise<Asset[]>
  /** Creates (no id) or updates an asset. Rejects with a message (empty name, unknown outfit…). */
  saveAsset(input: AssetInput): Promise<Asset>
  /** Moves its folder to the Trash; characters wearing a deleted outfit by default lose that default. */
  deleteAsset(id: string): Promise<void>
  /** Copies the files into the asset's folder (JPG, PNG and WebP only), after the images it has. */
  addAssetImages(assetId: string, paths: string[]): Promise<Asset>
  removeAssetImage(imageId: string): Promise<Asset>
  /** The given images first, in that order; any others keep their order after them. */
  reorderAssetImages(assetId: string, imageIds: string[]): Promise<Asset>
  /**
   * Copies audio files (MP3, WAV, M4A, AAC, AIFF, FLAC, OGG) into the asset's folder, after the clips it has.
   * Characters and environments only. Rejects with a message (wrong format, shorter than 1 s, …).
   */
  addAssetAudio(assetId: string, paths: string[]): Promise<Asset>
  /** Removes the clip (its copy goes to the Trash, or to Referensbilder when generations still use it). */
  removeAssetAudio(audioId: string): Promise<Asset>
  /** Moves or resizes the reference window; clamped to 2–15 s inside the file. */
  updateAssetAudio(audioId: string, patch: { clipStart?: number; clipLength?: number }): Promise<Asset>
  /** The given clips first, in that order; any others keep their order after them. */
  reorderAssetAudio(assetId: string, audioIds: string[]): Promise<Asset>

  // Prompt library
  listPrompts(): Promise<SavedPrompt[]>
  savePrompt(input: PromptInput): Promise<SavedPrompt>
  deletePrompt(id: string): Promise<void>
  markPromptUsed(id: string): Promise<void>

  /** Fires after any asset or prompt change. */
  onLibraryChange(cb: () => void): () => void

  // Sequences (never storyboards: those have their own list below; their ids are refused here with a pointer)
  listSequences(): Promise<SequenceSummary[]>
  getSequence(id: string): Promise<Sequence>
  createSequence(name: string): Promise<Sequence>
  /** exportHeight: the "Export format" (480/720/1080, null = Automatic). */
  updateSequence(
    id: string,
    patch: { name?: string; defaults?: Partial<GenerationParams>; exportHeight?: number | null }
  ): Promise<Sequence>
  deleteSequence(id: string): Promise<void>
  addSegment(sequenceId: string, init?: SegmentInit): Promise<Sequence>
  updateSegment(segmentId: string, patch: SegmentPatch): Promise<Sequence>
  /**
   * `onlyIfUntouched`: deleted only when nothing has been put in it (no takes or one on its way, prompt, pictures,
   * sounds, frame links or notes) – the empty first clip an import replaces, which may have been filled meanwhile.
   */
  deleteSegment(segmentId: string, opts?: { onlyIfUntouched?: boolean }): Promise<Sequence>
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

  // Keyframes and "Redo between neighbours" (sequence clips)
  /**
   * Puts an image in a clip's start or end slot (null empties it). An image switches the clip to the
   * image-to-video model of its family (one that takes an end image for the end slot); references it had are
   * dropped, since image-to-video can't take them. 'previous' / 'next' set continueFromPrevious / endFromNext.
   * Rejects with a message (the first clip has no previous clip, a file isn't an image, …).
   */
  setSegmentImage(segmentId: string, slot: SegmentImageSlot, source: SegmentImageSource | null): Promise<Sequence>
  /** The start and end images the clip would be generated from right now, with what stands in the way. Free. */
  previewSegmentFrames(segmentId: string): Promise<SegmentFramePreview>
  /**
   * "Redo between neighbours": sets the clip to start on the previous clip's last frame and end on the next
   * clip's first frame (whichever neighbours it has) with the end-capable image-to-video model of its family,
   * keeping its prompt, duration and audio. Free: it only configures the clip; generating is generateSegment.
   */
  bridgeSegment(segmentId: string): Promise<Sequence>

  // Storyboards: one image per board, a transition between every two adjacent boards
  /** Most recently changed first. */
  listStoryboards(): Promise<StoryboardSummary[]>
  getStoryboard(id: string): Promise<Storyboard>
  /** Creates it with its folder (Storyboards/<namn>/) and two empty boards. Aspect ratio default 16:9. */
  createStoryboard(name: string, aspectRatio?: string): Promise<Storyboard>
  /** A new name renames its folder; a new aspect ratio applies to its transitions and new board images. */
  updateStoryboard(id: string, patch: { name?: string; aspectRatio?: string }): Promise<Storyboard>
  /** Its takes become ordinary generations; stills still in use are kept in Referensbilder; exports stay. */
  deleteStoryboard(id: string): Promise<void>
  /**
   * Adds a board (at the end, or after/before the given one), optionally with a note and an image. The
   * transitions follow: one between every two adjacent boards.
   */
  addBoard(
    storyboardId: string,
    init?: { afterBoardId?: string; beforeBoardId?: string; note?: string; image?: BoardImageSource }
  ): Promise<Storyboard>
  /** A new note and/or image (null empties the board). The two neighbouring transitions get the new image. */
  updateBoard(boardId: string, patch: { note?: string; image?: BoardImageSource | null }): Promise<Storyboard>
  /** Moves the board to `toIndex` (0-based). Transitions between boards no longer adjacent are removed. */
  moveBoard(boardId: string, toIndex: number): Promise<Storyboard>
  /** Removes the board; its two transitions are replaced by one between its neighbours (takes are kept). */
  deleteBoard(boardId: string): Promise<Storyboard>
  updateTransition(transitionId: string, patch: TransitionPatch): Promise<Storyboard>
  /** Queues a new take of the transition (paid; the UI confirms with the price). */
  generateTransition(transitionId: string): Promise<Generation>
  /**
   * "Generate missing": sends every transition without a finished selected take (and none on its way) to Venice,
   * one after another without waiting for them to render. Resolves once started; progress arrives via
   * onStoryboardChange and errors via Storyboard.runError.
   */
  generateStoryboard(storyboardId: string): Promise<void>
  stopStoryboard(storyboardId: string): Promise<void>
  /**
   * Renders the selected takes in order into Storyboards/<namn>/; resolves with the film's path. Progress comes
   * through onExportProgress with sequenceId = the storyboard's id.
   */
  exportStoryboard(storyboardId: string): Promise<string>
  /**
   * "Turn into sequence": a new sequence "<name> (sequence)" with one clip per transition, each with a copy of
   * the transition's selected take selected. The storyboard stays as it is.
   */
  convertStoryboardToSequence(storyboardId: string): Promise<{ sequenceId: string }>
  /** Fires with the storyboard id whenever a storyboard, its boards, transitions or their takes change. */
  onStoryboardChange(cb: (storyboardId: string) => void): () => void

  // Images and stills
  /** Venice's text-to-image and edit models. */
  listImageModels(): Promise<ImageModel[]>
  /** USD for one still; undefined when the model's pricing doesn't say. */
  quoteStill(params: StillParams): Promise<number | undefined>
  /** Generates a still (paid; the UI confirms with the price) and saves it with the sequence. */
  generateStill(params: StillParams): Promise<Still>
  /** The sequence's stills, or every still when sequenceId is omitted; newest first. */
  listStills(sequenceId?: string): Promise<Still[]>
  /** Moves the still to the Trash (or to Referensbilder while clips or generations still use it). */
  deleteStill(id: string): Promise<void>
  /** Saves the frame of a take at `time` seconds as a still (source 'frame'). Free. */
  saveFrameAsStill(generationId: string, time: number, sequenceId?: string): Promise<Still>
  /** Fires with the sequence id (undefined: any or all) when stills are added, removed or moved. */
  onStillsChange(cb: (sequenceId?: string) => void): () => void

  // Library folder
  libraryStatus(): Promise<LibraryStatus>
  /** Directory dialog; null when cancelled. */
  chooseLibraryFolder(): Promise<string | null>
  inspectLibraryFolder(path: string): Promise<FolderInspection>
  /**
   * Switches the base folder (see LibraryMode). Rejects with a message when refused (busy, folder
   * inside the current library, conflicts, not writable). After it resolves every window reloads.
   */
  setLibraryRoot(path: string, mode: LibraryMode): Promise<void>
  /** "Tidy up": moves every file the library knows about to its proper folder. */
  reorganizeLibrary(): Promise<ReorganizeReport>
  /**
   * Opens the folder in Finder (created if needed). With an id: that sequence's folder for 'sequences', that
   * storyboard's for 'storyboards', and for any other target an asset's own folder (whatever its kind).
   */
  revealLibraryFolder(target: LibraryFolderTarget, id?: string): Promise<void>

  // Agent connection (MCP server)
  getAgentStatus(): Promise<AgentStatus>
  /** Starts or stops the server; resolves with the new status (status.error says why it couldn't start). */
  setAgentEnabled(enabled: boolean): Promise<AgentStatus>
  /** 1024–65535; restarts a running server on the new port. Rejects with a message. */
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
  /**
   * User only: checks a pending request again without carrying it out (the delete dialog asks every 2 s and on
   * focus). null: it can still be approved; else why not. Always null for kinds other than 'delete'.
   */
  verifyApproval(id: string): Promise<string | null>
  onAgentStatus(cb: (s: AgentStatus) => void): () => void
  onAgentActivity(cb: (a: AgentActivity) => void): () => void
  /** A request was created or changed. */
  onApproval(cb: (a: ApprovalRequest) => void): () => void
  /** The renderer's side of the agent bridge: apply the command and answer with replyAgentCommand. */
  onAgentCommand(cb: (cmd: AgentCommand) => void): () => void
  replyAgentCommand(id: string, reply: AgentCommandReply): void

  // Own clips
  /** File dialog for video files (mp4, mov, m4v, webm, mkv); [] when cancelled. */
  pickVideos(multiple: boolean): Promise<string[]>
  /** Probes the files before importing (free; nothing is copied). */
  inspectVideoFiles(paths: string[]): Promise<VideoFileInfo[]>
  /**
   * Copies the files into Egna klipp/<day>/ (an APFS clone when possible), makes working copies where needed and
   * adds them to the feed, a sequence (one new clip per file) or a clip (a selected take). User only.
   */
  importVideoFiles(paths: string[], target: ImportTarget): Promise<ImportResult>
  /**
   * "Cancel" on a file's card (`path`): stops that file (or skips it when it hasn't started), the half-made file is
   * removed and the other files go on. Without a path every running and queued import stops.
   */
  cancelImports(path?: string): Promise<void>
  onImportProgress(cb: (p: ImportProgress) => void): () => void

  // Editor (edits and versions)
  /** Newest first. */
  listEdits(): Promise<EditSummary[]>
  getEdit(id: string): Promise<Edit>
  /** Free. A generation is used where it is as v1; an export is cloned into the edit's folder as v1. */
  createEdit(source: { generationId: string } | { exportId: string }, name?: string): Promise<Edit>
  /** Renames the edit and its folder. */
  renameEdit(id: string, name: string): Promise<Edit>
  /** User only. Versions in use elsewhere are kept; the rest goes to the Trash. Refused while a job runs. */
  deleteEdit(id: string): Promise<void>
  setCurrentVersion(editId: string, versionId: string): Promise<Edit>
  /** User only. Refused for v1 and versions in use; its children move up to its parent. */
  deleteVersion(versionId: string): Promise<Edit>
  /** "Clean up versions…" (user only): dryRun counts what would go to the Trash. */
  pruneVersions(editId: string, dryRun: boolean): Promise<{ count: number; bytes: number }>
  /** Filmstrip, waveform, cuts, layers and transcript of a version (free, cached). */
  editTimeline(generationId: string): Promise<EditTimeline>
  /** What the operation would do and cost (free); baseId defaults to the current version. */
  planEditOperation(editId: string, op: EditOperation, baseId?: string): Promise<EditPlan>
  /**
   * Runs it (paid when the plan is). Refuses when the price rose above opts.expectedPriceUsd + $0.01. Rejects
   * with "NEEDS_CONSENT:…" when Venice asks for consent.
   */
  runEditOperation(editId: string, op: EditOperation, opts?: EditRunOptions): Promise<EditRunResult>
  /** "Cancel": parts not yet sent are cancelled; parts already sent finish. */
  cancelEditJob(jobId: string): Promise<void>
  /**
   * "Continue": sends the unsent or failed parts again (paid again for those) at a fresh price. Refused (PRICE_CHANGED)
   * when it rose above expectedPriceUsd + $0.01, or turned unknown or partial when `expectedPartial` was false.
   */
  resumeEditJob(jobId: string, expectedPriceUsd?: number, expectedPartial?: boolean): Promise<EditJob>
  /** The version's transcript, inherited from ancestors with the same timing; null when there is none. */
  getTranscript(generationId: string): Promise<Transcript | null>
  updateTranscript(generationId: string, patch: { segmentId: string; text: string }[]): Promise<Transcript>
  /** User only: a save dialog for the .srt; resolves with the path, or '' when cancelled. */
  saveSubtitles(generationId: string): Promise<string>
  /** User only: copies audio files into the edit's Ljud/. */
  addEditAudio(editId: string, paths: string[]): Promise<EditMedia[]>
  sendEditToSequence(versionId: string, target: SendTarget): Promise<{ sequenceId: string; segmentId: string }>
  /** Venice's speech, music, effect, transcription and voice models (free; cached 10 minutes). */
  listAudioModels(force?: boolean): Promise<AudioCatalog>
  /** Whether this Mac can separate voice and background. */
  separationStatus(): Promise<SeparationStatus>
  planVoiceDesign(req: VoiceDesignRequest): Promise<EditPlan>
  /** Paid: the result becomes a new voice clip of the character. */
  designVoice(req: VoiceDesignRequest, expectedPriceUsd?: number): Promise<EditJob>
  /** "May be cloned for new lines" (user only). */
  setVoiceCloneConsent(audioId: string, consent: boolean): Promise<Asset>
  /** Fires with the edit id whenever an edit, its versions, jobs or media change. */
  onEditChange(cb: (editId: string) => void): () => void
  onEditProgress(cb: (p: EditProgress) => void): () => void

  // Status: Activity
  /** What runs and what finished unseen; an empty summary while no library is open. */
  getWorkSummary(): Promise<WorkSummary>
  /** User only: the items (WorkSummary keys) were looked at. */
  markSeen(keys: string[]): Promise<void>
  /**
   * User only: "Mark all as seen" (everything, or one view or owner). undoToken undoes it with undoMarkAllSeen
   * for 10 seconds.
   */
  markAllSeen(scope?: SeenScope): Promise<{ count: number; undoToken?: string }>
  /** User only: "Undo" after markAllSeen; resolves with how many items came back (those that still exist). */
  undoMarkAllSeen(token: string): Promise<number>
  /** The whole summary, whenever something starts, moves on, finishes or is seen. */
  onWorkChange(cb: (s: WorkSummary) => void): () => void

  // Files
  revealFile(path: string): Promise<void>
  pickImages(multiple: boolean): Promise<string[]>
  /** File dialog for audio files; [] when cancelled. */
  pickAudio(multiple: boolean): Promise<string[]>

  // ── Export and import of the whole library (Settings) ──
  /**
   * Packs the open library – database snapshot and every file Studio keeps (no settings, API key or agent token) –
   * into one zip the user chooses with a save dialog. Resolves null when the dialog is cancelled. Refused (an
   * error) while something runs that writes to the library.
   */
  exportLibraryArchive(): Promise<ArchiveResult | null>
  /**
   * Opens a zip made by exportLibraryArchive: the user picks the zip and an empty folder (or a new one), Studio
   * unpacks it there, checks it, and opens it as the library (the library open before is left as it was). Resolves
   * null when a dialog is cancelled.
   */
  importLibraryArchive(): Promise<ArchiveResult | null>
  /** Stops a running export or import; partial files are removed. */
  cancelLibraryArchive(): Promise<void>
  onArchiveProgress(cb: (p: ArchiveProgress) => void): () => void
  /** Absolute path of a file dropped onto the window. */
  pathForFile(file: File): string
}

// ── Library archive (export / import) ────────────────────────────────────────

export interface ArchiveProgress {
  kind: 'export' | 'import'
  phase: 'preparing' | 'packing' | 'unpacking' | 'checking' | 'opening' | 'done' | 'failed' | 'cancelled'
  /** Bytes handled so far and in all, when known. */
  done?: number
  total?: number
  /** For the progress line or the error. */
  message?: string
}

export interface ArchiveResult {
  /** The zip written (export) or the folder the library was unpacked into (import). */
  path: string
  /** Bytes of the zip. */
  bytes: number
  /** What it holds, for the confirmation line. */
  counts: { generations: number; assets: number; sequences: number; edits: number }
}
