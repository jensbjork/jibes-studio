import { useEffect, useRef, useState, type Ref } from 'react'

interface Props {
  /** The saved name. */
  value: string
  /** A changed, non-empty name, when the field is left (Enter or a click elsewhere). */
  onRename: (name: string) => void
  /** "Untitled sequence". */
  placeholder: string
  /** "Sequence name". */
  ariaLabel: string
  /** Focus and select it (a new item, "Rename" in ⋯); onAutoFocused says it happened, so the parent can clear it. */
  autoFocus?: boolean
  onAutoFocused?: () => void
  /** Added to the field's classes. */
  className?: string
  inputRef?: Ref<HTMLInputElement>
}

/**
 * The name at the start of a document view's header (Sequences, Storyboards, the Editor): it looks like a title and
 * edits in place. Enter or leaving it renames; Esc puts the saved name back. Its tooltip is the whole name, which
 * a narrow header cuts short.
 */
export default function NameInput({
  value,
  onRename,
  placeholder,
  ariaLabel,
  autoFocus,
  onAutoFocused,
  className = '',
  inputRef
}: Props) {
  const [text, setText] = useState(value)
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    if (!focused) setText(value)
  }, [value, focused])

  useEffect(() => {
    if (!autoFocus) return
    input.current?.focus()
    input.current?.select()
    onAutoFocused?.()
  }, [autoFocus])

  const commit = () => {
    const next = text.trim()
    if (!next || next === value) setText(value)
    else onRename(next)
  }

  return (
    <input
      ref={(el) => {
        input.current = el
        if (typeof inputRef === 'function') inputRef(el)
        else if (inputRef) inputRef.current = el
      }}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        if (cancelled.current) cancelled.current = false
        else commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
        if (e.key === 'Escape') {
          cancelled.current = true
          setText(value)
          e.currentTarget.blur()
        }
      }}
      spellCheck={false}
      placeholder={placeholder}
      title={value ? `${value} – click to rename` : 'Rename'}
      aria-label={ariaLabel}
      className={`no-drag min-w-0 max-w-sm flex-1 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-[15px] font-semibold outline-none transition hover:border-line focus:border-muted focus:bg-raised @min-[67rem]/main:min-w-28 ${className}`}
    />
  )
}

export { NameInput }
