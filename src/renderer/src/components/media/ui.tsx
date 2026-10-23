import type { ReactNode } from 'react'
import { CloseIcon } from '../sequences/icons'

// Media's shared pieces: the header Images and Films use (laid out like the clip feed's, so the tabs and the search
// stay put when switching), the card shell of their grids, and the notice row under the header.

export { default as SearchField } from '../feed/SearchField'

/** A card of a Media grid (a film, an image; the clip cards look the same): framed, the picture full-bleed on top. */
export const MEDIA_CARD = 'group min-w-0 overflow-hidden rounded-lg border border-line bg-panel'

/** The text under a card's picture: a 13 px title, then an 11 px muted line of facts. */
export const MEDIA_CAPTION = 'px-3 py-2.5'

/**
 * The header: the tabs and anything else on the first row (a drag strip, like every view's top), then the filters
 * and the count line.
 */
export function MediaToolbar({
  tabs,
  children,
  trailing,
  below
}: {
  tabs: ReactNode
  /** After the tabs on the first row (the search field). */
  children?: ReactNode
  /** Right end of the first row. */
  trailing?: ReactNode
  /** The second row: filters on the left, the count on the right. */
  below: ReactNode
}) {
  return (
    <div className="shrink-0 border-b border-line/60 px-6 pb-2.5">
      <div className="drag flex h-12 items-center gap-3">
        {tabs}
        {children}
        <span className="flex-1" />
        {trailing}
      </div>
      <div className="flex min-h-7 flex-wrap items-center gap-1.5">{below}</div>
    </div>
  )
}

/** The count at the right end of the second row: "42 images", "3 of 42 images". */
export function CountLine({ text }: { text: string }) {
  return (
    <span className="ml-auto min-w-0 truncate pl-2 text-[12px] text-muted tabular-nums" title={text} aria-live="polite">
      {text}
    </span>
  )
}

const NOTICE_TONE = {
  info: 'bg-raised/50 text-text',
  /** A side remark ("2 clips are generating but hidden by the filters"). */
  quiet: 'bg-raised/50 text-muted',
  error: 'bg-accent/10 text-danger'
} as const

/**
 * A strip under a Media header (a filter lifted, an item that is gone, an import's outcome, an error), across the
 * whole width and never cut short: the text keeps its line breaks and can be selected. Errors are announced at once,
 * the rest politely. `leading` goes before the text (a spinner), `action` after it (an underlined text button).
 */
export function NoticeRow({
  children,
  tone = 'info',
  onClose,
  action,
  leading
}: {
  children: ReactNode
  tone?: keyof typeof NOTICE_TONE
  onClose?: () => void
  action?: { label: string; onClick: () => void }
  leading?: ReactNode
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex shrink-0 items-start gap-2 border-b border-line/60 px-6 py-2 text-[12px] ${NOTICE_TONE[tone]}`}
    >
      {leading && <span className="flex h-[1lh] shrink-0 items-center">{leading}</span>}
      <span className="min-w-0 flex-1 whitespace-pre-line select-text">{children}</span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="shrink-0 text-text underline-offset-2 hover:underline"
        >
          {action.label}
        </button>
      )}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="flex h-[1lh] shrink-0 items-center opacity-60 transition hover:opacity-100"
        >
          <CloseIcon size={11} />
        </button>
      )}
    </div>
  )
}
