import { useEffect, useId, useRef, type ReactNode } from 'react'
import type { WorkView } from '@shared/types'
import { ASSET_COPY, ASSET_VIEW, LIBRARY_KINDS } from '../lib/assets'
import type { View } from '../lib/navigation'
import { isMac, shortcut } from '../lib/platform'
import { useRunning, useUnseen, useViewWork } from '../lib/work'
import DevBadge, { VariantBadge } from './DevBadge'
import AgentIndicator from './agent/AgentIndicator'
import AssetIcon from './assets/AssetIcon'
import { ScissorsIcon } from './editor/icons'
import { SearchIcon } from './feed/icons'
import { FilmIcon, GearIcon, MediaIcon, QuoteIcon, SidebarIcon } from './icons'
import { fade, IconBox, rowClass, useRailTooltip } from './RailTooltip'
import { openCommandPalette } from './search/CommandPalette'
import { SparkleIcon } from './sequences/icons'
import { StoryboardIcon } from './storyboards/icons'
import { StatusDot, StatusMark } from './work/StatusMark'
import WorkIndicator from './work/WorkIndicator'
import { viewStatusText } from './work/workText'

/** The id of the sidebar element, for the toggle's aria-controls. */
export const SIDEBAR_ID = 'studio-sidebar'

/** The width of the sidebar: expanded (labels) and collapsed (the icon rail). Workspace sets --sidebar-w from it. */
export const SIDEBAR_WIDTH = { expanded: 208, collapsed: 72 } as const

interface Item {
  id: View
  label: string
  icon: ReactNode
  /** Its shortcut, joined Mac glyphs ("⌘,"): in its tooltip. */
  keys?: string
}

const CREATE: Item[] = [
  { id: 'generate', label: 'Generate', icon: <SparkleIcon size={16} /> },
  { id: 'sequences', label: 'Sequences', icon: <FilmIcon /> },
  { id: 'storyboards', label: 'Storyboards', icon: <StoryboardIcon size={16} /> },
  { id: 'editor', label: 'Editor', icon: <ScissorsIcon size={16} /> }
]

// Media (everything made: videos, pictures, films), every asset kind in the app's order (Characters, Environments,
// Products, Outfits, Poses, then Directors), then the prompt library.
const LIBRARY: Item[] = [
  { id: 'media', label: 'Media', icon: <MediaIcon /> },
  ...LIBRARY_KINDS.map((kind) => ({
    id: ASSET_VIEW[kind],
    label: ASSET_COPY[kind].plural,
    icon: <AssetIcon kind={kind} size={16} />
  })),
  { id: 'prompts', label: 'Prompts', icon: <QuoteIcon /> }
]

const SETTINGS: Item = { id: 'settings', label: 'Settings', icon: <GearIcon />, keys: '⌘,' }

const WORK_VIEWS = new Set<View>([
  'generate',
  'media',
  'sequences',
  'storyboards',
  'editor',
  'characters',
  'environments',
  'products',
  'outfits',
  'poses'
])

function workViewOf(view: View): WorkView | undefined {
  return WORK_VIEWS.has(view) ? (view as WorkView) : undefined
}

interface RowProps {
  item: Item
  active: boolean
  collapsed: boolean
  onSelect: (v: View) => void
  /** Something there needs the user (Settings without an API key): an accent dot, and the words as its status. */
  attention?: string
}

function Row({ item, active, collapsed, onSelect, attention }: RowProps) {
  const workView = workViewOf(item.id)
  const counts = useViewWork(workView ?? 'generate')
  // Uploads have no view; rows without one (Prompts, Settings) must not pick them up.
  const running = useRunning((w) => workView !== undefined && w.view === workView)
  const unseen = useUnseen((w) => workView !== undefined && w.view === workView)
  const status = (workView ? viewStatusText(workView, counts, running, unseen) : undefined) || attention
  const shown = workView ? counts : undefined
  const dot = !shown && !!attention
  const name = item.keys ? shortcut(`${item.label} (${item.keys})`) : item.label
  const { trigger, tooltip } = useRailTooltip(collapsed, name, status)

  return (
    <>
      <button
        onClick={() => onSelect(item.id)}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? (status ? `${item.label}: ${status}` : item.label) : undefined}
        title={collapsed ? undefined : [item.keys && name, status].filter(Boolean).join(' · ') || undefined}
        className={rowClass(active, collapsed)}
        {...trigger}
      >
        <IconBox>
          {item.icon}
          {collapsed && shown && (
            <StatusMark variant="badge" running={shown.running} fresh={shown.unseen} failed={shown.failed} />
          )}
          {collapsed && dot && (
            <StatusDot failed className="absolute -right-1 -top-1 ring-2 ring-[var(--row-bg,var(--color-panel))]" />
          )}
        </IconBox>
        <span className={`min-w-0 flex-1 truncate ${fade(collapsed)}`}>{item.label}</span>
        {!collapsed && shown && (
          <StatusMark variant="inline" running={shown.running} fresh={shown.unseen} failed={shown.failed} />
        )}
        {!collapsed && dot && (
          <>
            <StatusDot failed className="mr-1" />
            <span className="sr-only">: {attention}</span>
          </>
        )}
      </button>
      {tooltip}
    </>
  )
}

interface GroupProps {
  title: string
  items: Item[]
  view: View
  collapsed: boolean
  onSelect: (v: View) => void
}

/**
 * A titled group. The heading is quieter than the wordmark and isn't a button; in the rail it cross-fades to a
 * short divider of the same height, so the rows below don't move either.
 */
function Group({ title, items, view, collapsed, onSelect }: GroupProps) {
  const headingId = useId()
  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-0.5">
      <div className="relative h-8 shrink-0 short:h-6">
        <div id={headingId} className={`section-label absolute inset-x-0 bottom-1 px-4 ${fade(collapsed)}`}>
          {title}
        </div>
        <div
          aria-hidden
          className={`absolute bottom-3 left-1/2 h-px w-8 -translate-x-1/2 bg-line ${fade(!collapsed)}`}
        />
      </div>
      {items.map((item) => (
        <Row key={item.id} item={item} active={item.id === view} collapsed={collapsed} onSelect={onSelect} />
      ))}
    </div>
  )
}

interface Props {
  view: View
  onChange: (v: View) => void
  /** Shows a "Dev" badge so the development version can't be mistaken for JIBES Studio.app. */
  devProfile?: boolean
  /** Shows the variant's badge ("Test") for Studio Test, likewise. */
  variant?: string
  /** The icon rail instead of the full sidebar. */
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Which panel next to the sidebar is open: Agent or Activity. */
  panel?: 'agent' | 'work'
  onTogglePanel: (panel: 'agent' | 'work') => void
  /** Settings needs the user (no API key yet): its row carries an accent dot and says why. */
  settingsAttention?: string
}

/**
 * The window's navigation: Create (the places that make things) and Library (what was made, and what it is made
 * from), each row with what runs there and what is new. At the bottom, under one rule, the slim status rows – Activity,
 * and the agent connection while it has something to say – and Settings (⌘,) as the last row, with an accent dot while
 * there is no API key. By the wordmark, search (⌘K, the command palette) and the toggle. Collapses to a 72 px icon rail
 * (⌃⌘S) whose rows keep their status as badges and explain themselves in tooltips. On a short window the rows and
 * headings tighten up; should the navigation still not fit, it scrolls without a scrollbar, its bottom fading out.
 */
export default function Sidebar({
  view,
  onChange,
  devProfile = false,
  variant,
  collapsed,
  onToggleCollapsed,
  panel,
  onTogglePanel,
  settingsAttention
}: Props) {
  const toggleLabel = shortcut(collapsed ? 'Expand the sidebar (⌃⌘S)' : 'Collapse the sidebar (⌃⌘S)')
  const toggleTip = useRailTooltip(collapsed, toggleLabel)
  const searchLabel = shortcut('Search (⌘K)')
  const searchTip = useRailTooltip(collapsed, searchLabel)
  const badge = devProfile ? <DevBadge /> : variant ? <VariantBadge name={variant} /> : null
  const nav = useOverflowMark<HTMLElement>()

  return (
    <aside
      id={SIDEBAR_ID}
      aria-label="Sidebar"
      style={{ width: 'var(--sidebar-w)' }}
      className={`drag relative flex shrink-0 flex-col overflow-hidden border-r border-line bg-panel px-3 pb-3 transition-[width] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${isMac ? 'pt-12' : 'pt-2.5'}`}
    >
      {/* The top 48 px stay a plain drag strip for the traffic lights, in both widths. Windows has its own title bar
          above the window: there the row sits in the middle of the views' 48 px top bars. */}
      <div className="relative h-7 shrink-0">
        <div
          className={`flex h-full items-center gap-2 whitespace-nowrap pl-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted ${fade(collapsed)}`}
          aria-hidden={collapsed}
        >
          JIBES Studio
        </div>
        {/* Search (⌘K) and the toggle follow the moving edge while expanded and end side by side, centred under
            the traffic lights, in the rail. */}
        <button
          onClick={openCommandPalette}
          aria-label={searchLabel}
          aria-haspopup="dialog"
          title={collapsed ? undefined : searchLabel}
          style={{ left: collapsed ? -2 : 'calc(var(--sidebar-w) - 80px)' }}
          className="no-drag absolute top-0.5 flex h-6 w-6 items-center justify-center rounded-md text-muted transition-[left,color,background-color] duration-200 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-raised hover:text-text motion-reduce:transition-none"
          {...searchTip.trigger}
        >
          <SearchIcon size={15} />
        </button>
        {searchTip.tooltip}
        <button
          onClick={onToggleCollapsed}
          aria-label={toggleLabel}
          title={collapsed ? undefined : toggleLabel}
          aria-expanded={!collapsed}
          aria-controls={SIDEBAR_ID}
          style={{ left: collapsed ? 26 : 'calc(var(--sidebar-w) - 52px)' }}
          className="no-drag absolute top-0.5 flex h-6 w-6 items-center justify-center rounded-md text-muted transition-[left,color,background-color] duration-200 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-raised hover:text-text motion-reduce:transition-none"
          {...toggleTip.trigger}
        >
          <SidebarIcon size={15} />
        </button>
        {toggleTip.tooltip}
      </div>
      {/* The badge gets a row of its own under the wordmark: beside it, it would run under search. */}
      {badge && (
        <div className={`flex h-6 shrink-0 items-center ${collapsed ? 'justify-center' : 'pl-4'}`}>{badge}</div>
      )}

      {/* Scrolls when the window is too short, so the bottom stack is never pushed out: without a scrollbar, which
          would narrow the rows, and with the bottom fading out while more is below. */}
      <nav
        ref={nav}
        aria-label="Navigation"
        className="no-drag -mx-3 mb-2 flex min-h-0 flex-col gap-1 overflow-y-auto overflow-x-hidden px-3 [scrollbar-width:none] data-overflow:[mask-image:linear-gradient(to_bottom,black_calc(100%_-_24px),transparent)]"
      >
        <Group title="Create" items={CREATE} view={view} collapsed={collapsed} onSelect={onChange} />
        <Group title="Library" items={LIBRARY} view={view} collapsed={collapsed} onSelect={onChange} />
      </nav>

      <div className="no-drag mt-auto flex shrink-0 flex-col border-t border-line pt-2">
        {/* Status, not places: slimmer rows that open their panel beside the sidebar. */}
        <div role="group" aria-label="Status" className="flex flex-col gap-0.5 pb-1">
          <WorkIndicator collapsed={collapsed} active={panel === 'work'} onClick={() => onTogglePanel('work')} />
          <AgentIndicator collapsed={collapsed} active={panel === 'agent'} onClick={() => onTogglePanel('agent')} />
        </div>
        <Row
          item={SETTINGS}
          active={view === 'settings'}
          collapsed={collapsed}
          onSelect={onChange}
          attention={settingsAttention}
        />
      </div>
    </aside>
  )
}

/**
 * Marks a scroller with data-overflow while more of it is below the visible part: when it or its content changes
 * size, and as it scrolls.
 */
function useOverflowMark<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      el.toggleAttribute('data-overflow', el.scrollTop + el.clientHeight < el.scrollHeight - 1)
    }
    const resize = new ResizeObserver(update)
    resize.observe(el)
    for (const child of el.children) resize.observe(child)
    el.addEventListener('scroll', update, { passive: true })
    update()
    return () => {
      resize.disconnect()
      el.removeEventListener('scroll', update)
    }
  }, [])
  return ref
}
