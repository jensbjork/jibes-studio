import type { ReactNode } from 'react'
import { fade, useRailTooltip } from '../RailTooltip'

// The sidebar's status rows above Settings: Activity and the agent connection. Slimmer than the
// navigation rows (28 px, 12 px text) so they read as status rather than places, with the icon in the same 16 px
// column at x = 36 as every other row, expanded or collapsed. In the icon rail a row is its icon with badges, and
// its words go into the accessible name and the rail tooltip.

interface Props {
  /** The sidebar is the icon rail. */
  collapsed: boolean
  /** Its panel is open. */
  active: boolean
  onClick: () => void
  /** At most 14 px; centred in the 16 px icon column. */
  icon: ReactNode
  /** Rail only: marks on the icon's corners (a StatusMark badge, a count). */
  badge?: ReactNode
  /** The row's name: the rail tooltip's first line and the start of the accessible name. */
  label: string
  /** What the expanded row shows; the label when left out. */
  text?: ReactNode
  /** Something is going on: the text takes the text colour. */
  lit?: boolean
  /** Expanded only: right-aligned marks (counts). */
  trailing?: ReactNode
  /** What is going on, in words: the rail tooltip's second line and part of the accessible name. */
  status?: string
  /** The native tooltip of the expanded row. */
  title: string
  /** The panel it opens is a dialog. */
  dialog?: boolean
  /** Expanded only: read out politely when it changes (visually hidden). */
  live?: string
}

export default function StatusRow({
  collapsed,
  active,
  onClick,
  icon,
  badge,
  label,
  text,
  lit = false,
  trailing,
  status,
  title,
  dialog = false,
  live
}: Props) {
  const { trigger, tooltip } = useRailTooltip(collapsed, label, status)
  const size = collapsed ? 'mx-1 w-10 pl-3' : 'w-full pl-4 pr-2'
  // --row-bg: badges on the icon cut their ring out of the row's own background.
  const tone = active
    ? 'bg-raised text-text [--row-bg:var(--color-raised)]'
    : `${lit ? 'text-text' : 'text-muted'} hover:bg-raised/60 hover:text-text`

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-haspopup={dialog ? 'dialog' : undefined}
        aria-expanded={active}
        aria-label={status ? `${label}: ${status}` : label}
        title={collapsed ? undefined : title}
        className={`relative flex h-7 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap rounded-md text-left text-[12px] transition-colors ${size} ${tone}`}
        {...trigger}
      >
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
          {icon}
          {collapsed && badge}
        </span>
        <span className={`min-w-0 flex-1 truncate ${fade(collapsed)}`}>{text ?? label}</span>
        {/* A little closer to the text than the icon is: the text keeps a few more pixels in the 208 px sidebar. */}
        {!collapsed && trailing && <span className="-ml-1 flex shrink-0 items-center">{trailing}</span>}
        {!collapsed && live !== undefined && (
          <span className="sr-only" aria-live="polite">
            {live}
          </span>
        )}
      </button>
      {tooltip}
    </>
  )
}
