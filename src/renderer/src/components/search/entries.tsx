import type { ReactNode } from 'react'
import { generationTitle } from '@shared/generation-label'
import type {
  Asset,
  AssetKind,
  EditSummary,
  ExportSummary,
  Generation,
  SavedPrompt,
  Sequence,
  SequenceSummary,
  Still,
  Storyboard,
  StoryboardSummary
} from '@shared/types'
import { ASSET_COPY, ASSET_VIEW, LIBRARY_KINDS } from '../../lib/assets'
import { directorSummary, presetEntries, styleFrameCount, styleVideoCount } from '../../lib/directors'
import { requestCreate } from '../../lib/createRequest'
import type { Navigate, View } from '../../lib/navigation'
import { ARCHIVE_UNAVAILABLE, shortcut } from '../../lib/platform'
import AssetIcon from '../assets/AssetIcon'
import { fileName, formatLength, originLabel, summaryLine } from '../editor/editorUtils'
import { ScissorsIcon } from '../editor/icons'
import { FilmIcon, GearIcon, MediaIcon, PictureIcon, QuoteIcon, SidebarIcon, TrayIcon } from '../icons'
import { NoteIcon, PlusIcon, SparkleIcon } from '../sequences/icons'
import { SETTINGS_SECTION, showSettingsSection, type SettingsSectionId } from '../settings/SettingsLayout'
import { StoryboardIcon } from '../storyboards/icons'
import { flatten } from './match'

// What ⌘K can find, as entries: the places and actions of the window (always there) and what the library holds
// (built from the lists loaded when the palette opens). Every entry opens its place through the same navigation
// intents the rest of the app uses.

export type GroupId =
  | 'recent'
  | 'goto'
  | 'actions'
  | AssetKind
  | 'prompts'
  | 'sequences'
  | 'storyboards'
  | 'edits'
  | 'clips'
  | 'images'
  | 'films'

/** What an entry can do besides navigating. */
export interface PaletteActions {
  /** Navigates like the sidebar does (an open panel beside it closes). */
  navigate: Navigate
  openPanel: (panel: 'agent' | 'work') => void
  toggleSidebar: () => void
}

export interface Entry {
  /** Unique within its group. */
  key: string
  group: GroupId
  title: string
  /** After the title, quieter: where a command leads ("Settings", "Media"), or what a recent item is. */
  context?: string
  /** Searched after the title and shown, cut around the match, when it matched: a description, a prompt, notes. */
  detail?: string
  /** Searched like the title but never shown: other words for a place ("API key" for Service). */
  keywords?: string
  /** The second line when the detail didn't match. */
  meta?: string
  /** At the right: what Enter does when it isn't just opening the place ("Use in Generate"), or a shortcut. */
  hint?: string
  icon: ReactNode
  /** Absolute path of a picture shown instead of the icon. */
  thumb?: string
  /** For "newest first" (Clips, Images, Films, Recent) and as the tie-breaker elsewhere. */
  time?: number
  /** The title is free text (a clip's or an image's prompt): a word inside it counts like one in a detail. */
  proseTitle?: boolean
  /** Listed only when a word of the query is in the detail (a clip by its notes, not by its sequence's name). */
  needsDetail?: boolean
  /** Listed while the query is empty (the main New … actions; Recent comes first, the places only when typed for). */
  initial?: boolean
  /** The focus goes back where it was (the action changes nothing on screen that wants it). */
  keepsFocus?: boolean
  run: (actions: PaletteActions) => void
}

export interface GroupInfo {
  label: string
  /** How many rows it shows at most. */
  cap: number
  /** Newest first, whatever matched better (Clips, Images, Films). */
  newestFirst?: boolean
}

/** The groups, in the order they are listed when their best matches are equally good. */
export const GROUP_ORDER: readonly GroupId[] = [
  'recent',
  'goto',
  'actions',
  ...LIBRARY_KINDS,
  'prompts',
  'sequences',
  'storyboards',
  'edits',
  'clips',
  'images',
  'films'
]

export const GROUPS: Record<GroupId, GroupInfo> = {
  recent: { label: 'Recent', cap: 6, newestFirst: true },
  goto: { label: 'Go to', cap: 8 },
  actions: { label: 'Actions', cap: 6 },
  character: { label: ASSET_COPY.character.plural, cap: 5 },
  environment: { label: ASSET_COPY.environment.plural, cap: 5 },
  product: { label: ASSET_COPY.product.plural, cap: 5 },
  outfit: { label: ASSET_COPY.outfit.plural, cap: 5 },
  pose: { label: ASSET_COPY.pose.plural, cap: 5 },
  director: { label: ASSET_COPY.director.plural, cap: 8 },
  prompts: { label: 'Prompts', cap: 5 },
  sequences: { label: 'Sequences', cap: 6 },
  storyboards: { label: 'Storyboards', cap: 6 },
  edits: { label: 'Edits', cap: 5 },
  clips: { label: 'Clips', cap: 8, newestFirst: true },
  images: { label: 'Images', cap: 6, newestFirst: true },
  films: { label: 'Films', cap: 4, newestFirst: true }
}

// ── The window's places and actions ─────────────────────────────────────────

interface Place {
  view: View
  title: string
  icon: ReactNode
  keywords?: string
  /** Its shortcut, at the right. */
  hint?: string
}

// The sidebar's rows, in its order.
const PLACES: Place[] = [
  { view: 'generate', title: 'Generate', icon: <SparkleIcon size={16} />, keywords: 'create make new video clip' },
  { view: 'sequences', title: 'Sequences', icon: <FilmIcon />, keywords: 'clips timeline film' },
  { view: 'storyboards', title: 'Storyboards', icon: <StoryboardIcon size={16} />, keywords: 'boards transitions' },
  { view: 'editor', title: 'Editor', icon: <ScissorsIcon size={16} />, keywords: 'edits cut trim versions' },
  { view: 'media', title: 'Media', icon: <MediaIcon />, keywords: 'videos images films clips feed' },
  ...LIBRARY_KINDS.map((kind) => ({
    view: ASSET_VIEW[kind],
    title: ASSET_COPY[kind].plural,
    icon: <AssetIcon kind={kind} size={16} />,
    keywords: kind === 'director' ? 'library direction style look camera editing ready-made' : 'library'
  })),
  { view: 'prompts', title: 'Prompts', icon: <QuoteIcon />, keywords: 'saved library learnings' },
  { view: 'settings', title: 'Settings', icon: <GearIcon />, keywords: 'preferences options', hint: shortcut('⌘,') }
]

const MEDIA_TABS = [
  { tab: 'videos', title: 'Clips', keywords: 'videos feed own clips' },
  { tab: 'pictures', title: 'Images', keywords: 'pictures stills frames' },
  { tab: 'films', title: 'Films', keywords: 'exports exported' }
] as const

// Every pane of Settings, in its order (a new pane must be named here, or the type check fails).
const SETTINGS_SECTIONS: Record<keyof typeof SETTINGS_SECTION, { title: string; keywords: string }> = {
  service: { title: 'Service', keywords: 'venice fal api key account provider' },
  spending: { title: 'Spending', keywords: 'budget cost money spent price' },
  generation: { title: 'Generation', keywords: 'prompt language safe mode images descriptions' },
  library: { title: 'Library', keywords: 'folder base tidy up change move' },
  agent: { title: 'Agent connection', keywords: 'mcp token claude code hermes openclaw connect' },
  // The pane is "About"; here the longer name, as in the macOS app menu.
  about: { title: 'About JIBES Studio', keywords: 'version updates studio tools ffmpeg voice separation' }
}

/** Export & import lives in Settings → Library ("Move to another computer"), but is found by its own name. */
const ARCHIVE_ENTRY = { title: 'Export & import', keywords: 'zip backup archive library move computer' }

/** The places (views, Media's tabs, Settings' sections, the two panels) and the actions ("New …"). */
export function commandEntries(sidebarCollapsed: boolean): Entry[] {
  const places: Entry[] = PLACES.map((p) => ({
    key: p.view,
    group: 'goto',
    title: p.title,
    keywords: p.keywords,
    icon: p.icon,
    hint: p.hint,
    run: ({ navigate }) => navigate(p.view)
  }))
  const tabs: Entry[] = MEDIA_TABS.map((t) => ({
    key: `media:${t.tab}`,
    group: 'goto',
    title: t.title,
    context: 'Media',
    keywords: t.keywords,
    icon: t.tab === 'pictures' ? <PictureIcon /> : t.tab === 'films' ? <FilmIcon /> : <MediaIcon />,
    run: ({ navigate }) => navigate('media', { type: 'open-media', tab: t.tab })
  }))
  const section = (key: string, title: string, keywords: string, id: SettingsSectionId): Entry => ({
    key: `settings:${key}`,
    group: 'goto',
    title,
    context: 'Settings',
    keywords,
    icon: <GearIcon />,
    run: ({ navigate }) => {
      // Settings already open shows that pane at once; otherwise it opens on it.
      showSettingsSection(id)
      navigate('settings')
    }
  })
  const sections: Entry[] = (Object.keys(SETTINGS_SECTIONS) as (keyof typeof SETTINGS_SECTION)[]).map((key) =>
    section(key, SETTINGS_SECTIONS[key].title, SETTINGS_SECTIONS[key].keywords, SETTINGS_SECTION[key])
  )
  // Left out where it can't run (Library only says so there).
  if (!ARCHIVE_UNAVAILABLE) {
    sections.push(section('archive', ARCHIVE_ENTRY.title, ARCHIVE_ENTRY.keywords, SETTINGS_SECTION.library))
  }
  const panels: Entry[] = [
    {
      key: 'panel:work',
      group: 'goto',
      title: 'Activity',
      context: 'Panel',
      keywords: 'running progress new results failed jobs',
      icon: <TrayIcon size={14} />,
      keepsFocus: true,
      run: ({ openPanel }) => openPanel('work')
    },
    {
      key: 'panel:agent',
      group: 'goto',
      title: 'Agent',
      context: 'Panel',
      keywords: 'mcp requests approvals activity connected',
      icon: <AgentDot />,
      keepsFocus: true,
      run: ({ openPanel }) => openPanel('agent')
    }
  ]

  // "＋ New …" in the view's list, pressed for you (lib/createRequest.ts). A view with two lists (Prompts: prompts
  // and learnings) is told which by the target.
  const create = (key: string, title: string, view: View, initial = false, target?: string): Entry => ({
    key: `new:${key}`,
    group: 'actions',
    title,
    keywords: 'create add',
    icon: <PlusIcon size={12} />,
    initial,
    run: ({ navigate }) => {
      navigate(view)
      requestCreate(target)
    }
  })
  const actions: Entry[] = [
    create('sequence', 'New sequence', 'sequences', true),
    {
      key: 'new:sequence-from-song',
      group: 'actions',
      title: 'New sequence from a song…',
      keywords: 'create add music video audio song lyrics singing',
      icon: <NoteIcon size={13} />,
      run: ({ navigate }) => navigate('sequences', { type: 'new-sequence-from-song' })
    },
    create('storyboard', 'New storyboard', 'storyboards', true),
    create('edit', 'New edit', 'editor', true),
    ...LIBRARY_KINDS.map((kind) => create(kind, ASSET_COPY[kind].newName, ASSET_VIEW[kind], kind === 'character')),
    create('prompt', 'New prompt', 'prompts', false, 'prompts'),
    create('learning', 'New learning', 'prompts', false, 'learnings'),
    {
      key: 'sidebar',
      group: 'actions',
      title: sidebarCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar',
      keywords: 'rail toggle hide show',
      hint: shortcut('⌃⌘S'),
      icon: <SidebarIcon size={15} />,
      keepsFocus: true,
      run: ({ toggleSidebar }) => toggleSidebar()
    }
  ]
  return [...places, ...tabs, ...sections, ...panels, ...actions]
}

/** The agent's mark in the sidebar is a status dot; here a quiet one. */
function AgentDot() {
  return <span aria-hidden className="h-2 w-2 rounded-full border border-current" />
}

// ── The library ─────────────────────────────────────────────────────────────

/** What the palette loads when it opens; undefined until that list has arrived. */
export interface PaletteData {
  assets?: Asset[]
  prompts?: SavedPrompt[]
  sequences?: SequenceSummary[]
  /** The newest sequences in full, for their clips' notes and prompts. */
  sequenceDetails?: Sequence[]
  storyboards?: StoryboardSummary[]
  /** The newest storyboards in full, for their boards' notes and transitions' prompts. */
  storyboardDetails?: Storyboard[]
  edits?: EditSummary[]
  generations?: Generation[]
  stills?: Still[]
  exports?: ExportSummary[]
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const DAY_AND_YEAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/** "18 Oct", or "18 Oct 2025" for another year. */
function day(ms: number): string {
  return (new Date(ms).getFullYear() === new Date().getFullYear() ? DAY : DAY_AND_YEAR).format(ms)
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** "Notes — prompt", without empty parts or the same text twice. */
function joined(...parts: (string | undefined)[]): string {
  const texts = parts.map((p) => p?.trim() ?? '').filter(Boolean)
  return [...new Set(texts)].join(' — ')
}

function assetEntry(a: Asset): Entry {
  const copy = ASSET_COPY[a.kind]
  // The kind is the group's heading (and the context in Recent).
  const meta =
    a.kind === 'director'
      ? [styleFrameCount(a.images.length), styleVideoCount(a.direction?.videos?.length ?? 0)]
      : [plural(a.images.length, 'image')]
  if (a.audio.length && copy.audio) meta.push(copy.audio.listLabel)
  return {
    key: a.id,
    group: a.kind,
    title: a.name,
    detail: a.description,
    meta: meta.join(' · '),
    icon: <AssetIcon kind={a.kind} size={16} />,
    thumb: a.images[0]?.path,
    time: a.updatedAt,
    run: ({ navigate }) => navigate(ASSET_VIEW[a.kind], { type: 'open-asset', assetId: a.id })
  }
}

function promptEntry(p: SavedPrompt): Entry {
  return {
    key: p.id,
    group: 'prompts',
    title: p.title.trim() || flatten(p.body).slice(0, 80) || 'Untitled prompt',
    detail: joined(p.body, p.negativePrompt),
    keywords: p.tags.join(' '),
    meta: flatten(p.body),
    hint: 'Use in Generate',
    icon: <QuoteIcon />,
    time: p.lastUsedAt ?? p.updatedAt,
    run: ({ navigate }) => navigate('generate', { type: 'use-prompt', promptId: p.id })
  }
}

function sequenceEntry(s: SequenceSummary): Entry {
  const meta = [plural(s.segmentCount, 'clip')]
  if (s.totalDuration > 0) meta.push(formatLength(s.totalDuration))
  return {
    key: s.id,
    group: 'sequences',
    title: s.name || 'Untitled sequence',
    meta: meta.join(' · '),
    icon: <FilmIcon />,
    thumb: s.thumbPath,
    time: s.updatedAt,
    run: ({ navigate }) => navigate('sequences', { type: 'open-sequence', sequenceId: s.id })
  }
}

/** The take a clip shows: its chosen one, else the newest. */
function shownTake(takes: Generation[], selectedId: string | undefined): Generation | undefined {
  return takes.find((t) => t.id === selectedId) ?? takes[0]
}

/** A sequence's clips, found by their notes and prompts; opened on that clip. */
function clipEntries(s: Sequence): Entry[] {
  const name = s.name || 'Untitled sequence'
  return s.segments.flatMap((segment, i): Entry[] => {
    const detail = joined(segment.notes, segment.params.prompt)
    if (!detail) return []
    return [
      {
        key: `${s.id}:${segment.id}`,
        group: 'sequences',
        title: `Clip ${i + 1} in “${name}”`,
        detail,
        needsDetail: true,
        icon: <FilmIcon />,
        thumb: shownTake(segment.takes, segment.selectedGenerationId)?.thumbPath,
        time: s.updatedAt,
        run: ({ navigate }) =>
          navigate('sequences', { type: 'open-sequence', sequenceId: s.id, segmentId: segment.id })
      }
    ]
  })
}

function storyboardEntry(s: StoryboardSummary): Entry {
  const meta = [plural(s.boardCount, 'board')]
  if (s.transitionCount) meta.push(`${s.doneCount} of ${plural(s.transitionCount, 'transition')} done`)
  return {
    key: s.id,
    group: 'storyboards',
    title: s.name || 'Untitled storyboard',
    meta: meta.join(' · '),
    icon: <StoryboardIcon size={16} />,
    thumb: s.coverPath,
    time: s.updatedAt,
    run: ({ navigate }) => navigate('storyboards', { type: 'open-storyboard', storyboardId: s.id })
  }
}

/** A storyboard's boards (by their notes) and transitions (by their prompts); opened there. */
function boardEntries(s: Storyboard): Entry[] {
  const name = s.name || 'Untitled storyboard'
  const boards = s.boards.flatMap((b, i): Entry[] =>
    b.note.trim()
      ? [
          {
            key: `${s.id}:${b.id}`,
            group: 'storyboards',
            title: `Board ${i + 1} in “${name}”`,
            detail: b.note,
            needsDetail: true,
            icon: <StoryboardIcon size={16} />,
            thumb: b.imagePath,
            time: s.updatedAt,
            run: ({ navigate }) =>
              navigate('storyboards', { type: 'open-storyboard', storyboardId: s.id, boardId: b.id })
          }
        ]
      : []
  )
  const transitions = s.transitions.flatMap((t, i): Entry[] =>
    t.params.prompt?.trim()
      ? [
          {
            key: `${s.id}:${t.id}`,
            group: 'storyboards',
            title: `Transition ${i + 1} in “${name}”`,
            detail: t.params.prompt,
            needsDetail: true,
            icon: <StoryboardIcon size={16} />,
            thumb: shownTake(t.takes, t.selectedGenerationId)?.thumbPath,
            time: s.updatedAt,
            run: ({ navigate }) =>
              navigate('storyboards', { type: 'open-storyboard', storyboardId: s.id, transitionId: t.id })
          }
        ]
      : []
  )
  return [...boards, ...transitions]
}

function editEntry(e: EditSummary): Entry {
  const origin = originLabel(e.origin)
  return {
    key: e.id,
    group: 'edits',
    title: e.name || 'Untitled edit',
    keywords: origin,
    meta: `${origin} · ${summaryLine(e)}`,
    icon: <ScissorsIcon size={16} />,
    thumb: e.posterPath,
    time: e.updatedAt,
    run: ({ navigate }) => navigate('editor', { type: 'open-editor', editId: e.id })
  }
}

function clipMeta(g: Generation): string {
  const parts = [day(g.createdAt)]
  if (g.source === 'import') parts.push('Own clip')
  else if (g.source === 'edit') parts.push('Version')
  else if (g.segmentId) parts.push('Take')
  if (g.videoDuration) parts.push(formatLength(g.videoDuration))
  if (g.status === 'failed') parts.push('Failed')
  else if (g.status !== 'completed') parts.push('Generating')
  return parts.join(' · ')
}

function generationEntry(g: Generation): Entry {
  // Named by its title (an own clip's file, a version's "<edit> v3") when it has one; the prompt is searched too.
  const titled = !!g.title?.trim()
  return {
    key: g.id,
    group: 'clips',
    title: generationTitle(g),
    proseTitle: !titled,
    detail: titled ? g.prompt : undefined,
    meta: clipMeta(g),
    hint: 'Media',
    icon: <FilmIcon />,
    thumb: g.thumbPath,
    time: g.createdAt,
    run: ({ navigate }) => navigate('media', { type: 'open-media', generationId: g.id })
  }
}

function stillEntry(s: Still): Entry {
  return {
    key: s.id,
    group: 'images',
    title: s.prompt,
    proseTitle: true,
    meta: [day(s.createdAt), s.model].filter(Boolean).join(' · '),
    hint: 'Media',
    icon: <PictureIcon />,
    thumb: s.path,
    time: s.createdAt,
    run: ({ navigate }) => navigate('media', { type: 'open-media', stillId: s.id })
  }
}

function exportEntry(e: ExportSummary): Entry {
  const meta = [e.sequenceKind === 'storyboard' ? 'Storyboard film' : 'Film', day(e.createdAt)]
  if (e.duration) meta.push(formatLength(e.duration))
  if (!e.exists) meta.push('File missing')
  return {
    key: e.id,
    group: 'films',
    title: e.sequenceName ?? fileName(e.path),
    keywords: fileName(e.path),
    meta: meta.join(' · '),
    hint: 'Media',
    icon: <FilmIcon />,
    time: e.createdAt,
    run: ({ navigate }) => navigate('media', { type: 'open-media', exportId: e.id })
  }
}

/** The ready-made directors (always there): opened in Directors, where "Copy to edit" makes one to change. */
function presetDirectorEntries(): Entry[] {
  return presetEntries().map((d) => ({
    key: d.id,
    group: 'director',
    title: d.name,
    context: 'Ready-made',
    detail: directorSummary(d),
    keywords: 'director ready-made preset style',
    icon: <AssetIcon kind="director" size={16} />,
    run: ({ navigate }) => navigate('directors', { type: 'open-asset', assetId: d.id })
  }))
}

/** Everything the loaded lists hold, as entries. */
export function libraryEntries(data: PaletteData): Entry[] {
  return [
    ...(data.assets ?? []).map(assetEntry),
    ...presetDirectorEntries(),
    ...(data.prompts ?? []).map(promptEntry),
    ...(data.sequences ?? []).map(sequenceEntry),
    ...(data.sequenceDetails ?? []).flatMap(clipEntries),
    ...(data.storyboards ?? []).map(storyboardEntry),
    ...(data.storyboardDetails ?? []).flatMap(boardEntries),
    ...(data.edits ?? []).map(editEntry),
    ...(data.generations ?? []).map(generationEntry),
    // Uploaded pictures and saved frames have no prompt: nothing to find them by.
    ...(data.stills ?? []).filter((s) => s.prompt.trim()).map(stillEntry),
    ...(data.exports ?? []).map(exportEntry)
  ]
}

const RECENT_KINDS: Partial<Record<GroupId, string>> = {
  sequences: 'Sequence',
  storyboards: 'Storyboard',
  edits: 'Edit',
  ...Object.fromEntries(LIBRARY_KINDS.map((kind) => [kind, capitalized(ASSET_COPY[kind].singular)]))
}

/** For the empty query: the sequences, storyboards, edits and assets changed last. */
export function recentEntries(entries: readonly Entry[]): Entry[] {
  return entries
    .filter((e) => RECENT_KINDS[e.group] && !e.needsDetail && e.time !== undefined)
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    .slice(0, GROUPS.recent.cap)
    .map((e) => ({ ...e, key: `${e.group}:${e.key}`, group: 'recent', context: RECENT_KINDS[e.group] }))
}
