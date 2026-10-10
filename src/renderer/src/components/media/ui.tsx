import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import { SearchIcon } from '../feed/icons'
import { CloseIcon } from '../sequences/icons'

// The Mediabank's shared pieces: the header Bilder and Filmer use (laid out like the clip feed's, so the tabs stay
// put when switching), its search field, and the notice row under it.

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

/** The count at the right end of the second row: "42 bilder", "3 av 42 bilder". */
export function CountLine({ text }: { text: string }) {
  return (
    <span className="ml-auto min-w-0 truncate pl-2 text-[12px] text-muted tabular-nums" title={text} aria-live="polite">
      {text}
    </span>
  )
}

/** A search field like the clip feed's: Esc clears it, ↓ hands the keyboard to the list. */
export function SearchField({
  value,
  onChange,
  placeholder,
  inputRef,
  onArrowDown
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  inputRef: RefObject<HTMLInputElement | null>
  onArrowDown?: () => void
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && value) {
      e.preventDefault()
      e.stopPropagation()
      onChange('')
    } else if (e.key === 'ArrowDown' && onArrowDown) {
      e.preventDefault()
      onArrowDown()
    }
  }
  return (
    <div className="no-drag relative min-w-36 max-w-72 flex-1">
      <SearchIcon size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder.replace(/…$/, '')}
        title={`${placeholder.replace(/…$/, '')} (⌘ F)`}
        className="h-7 w-full rounded-md border border-line bg-raised pl-7 pr-7 text-[12px] outline-none focus:border-muted"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
          title="Rensa sökningen"
          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-line hover:text-text"
        >
          <CloseIcon size={9} />
        </button>
      )}
    </div>
  )
}

/** A note under the header (a filter lifted, an item that is gone), closed with ✕. */
export function NoticeRow({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="flex items-start gap-2 border-b border-line/60 bg-raised/50 px-6 py-2 text-[12px] text-text">
      <span className="min-w-0 flex-1 select-text">{text}</span>
      <button type="button" onClick={onClose} className="shrink-0 hover:text-text" title="Stäng">
        ✕
      </button>
    </div>
  )
}
