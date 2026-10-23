import type { KeyboardEvent, RefObject } from 'react'
import { shortcut } from '../../lib/platform'
import { CloseIcon } from '../sequences/icons'
import { SearchIcon } from './icons'

/**
 * The search field of Media's tabs and the clip feed, in the same place on each: Esc clears it, ↓ hands the keyboard
 * to the list, Enter opens the first match. ⌘F (useFindShortcut) is the view's to wire.
 */
export default function SearchField({
  value,
  onChange,
  placeholder,
  inputRef,
  onArrowDown,
  onEnter
}: {
  value: string
  onChange: (value: string) => void
  /** Also the field's name and its tooltip, without the "…". */
  placeholder: string
  inputRef: RefObject<HTMLInputElement | null>
  onArrowDown?: () => void
  onEnter?: () => void
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing) return
    if (e.key === 'Escape' && value) {
      e.preventDefault()
      e.stopPropagation()
      onChange('')
    } else if (e.key === 'ArrowDown' && onArrowDown) {
      e.preventDefault()
      onArrowDown()
    } else if (e.key === 'Enter' && onEnter) {
      e.preventDefault()
      onEnter()
    }
  }
  const label = placeholder.replace(/…$/, '')
  return (
    <div className="no-drag relative min-w-36 max-w-72 flex-1">
      <SearchIcon size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={label}
        title={`${label} (${shortcut('⌘F')})`}
        className="h-7 w-full rounded-md border border-line bg-raised pl-7 pr-7 text-[12px] outline-none focus:border-muted"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
          aria-label="Clear the search"
          title="Clear the search"
          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-line hover:text-text"
        >
          <CloseIcon size={9} />
        </button>
      )}
    </div>
  )
}

export { SearchField }
