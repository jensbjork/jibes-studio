import { useRef, useState, type KeyboardEvent } from 'react'
import { isSubmitKey } from '../../lib/platform'
import { CloseIcon } from '../sequences/icons'
import { addTags, fold, parseTags } from './prompt-utils'

interface Props {
  /** The text field's, for a label pointing at it. */
  id?: string
  value: string[]
  onChange: (tags: string[]) => void
  /** Existing tags across the library, most used first. */
  suggestions: string[]
  onBlur?: () => void
}

/** Tags as chips; typing a comma (or pasting a comma separated list) turns the text into chips. */
export default function TagInput({ id, value, onChange, suggestions, onBlur }: Props) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const add = (tags: string[]) => {
    const next = addTags(value, tags)
    if (next.length !== value.length) onChange(next)
  }

  const onInput = (input: string) => {
    if (!/[,\n]/.test(input)) {
      setText(input)
      return
    }
    // Everything before the last comma is complete; the rest is still being typed.
    const parts = input.split(/[,\n]/)
    const rest = parts.pop() ?? ''
    add(parseTags(parts.join(',')))
    setText(rest.trimStart())
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // ⌘↵ goes on to the form it is in (Generate with the prompt), with what was typed made a tag first.
      if (!isSubmitKey(e)) e.preventDefault()
      add(parseTags(text))
      setText('')
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1))
    } else if (e.key === 'Escape') {
      if (text) setText('')
      else inputRef.current?.blur()
    }
  }

  const needle = fold(text)
  const present = new Set(value.map(fold))
  const matches = suggestions.filter((s) => !present.has(fold(s)) && fold(s).includes(needle)).slice(0, 10)

  return (
    <div className="relative">
      <div
        onClick={() => inputRef.current?.focus()}
        className={`flex min-h-9 cursor-text flex-wrap items-center gap-1.5 rounded-md border bg-raised px-2 py-1.5 transition ${
          focused ? 'border-muted' : 'border-line'
        }`}
      >
        {value.map((tag) => (
          <span key={fold(tag)} className="flex items-center gap-0.5 rounded bg-line py-0.5 pl-2 pr-0.5 text-[12px]">
            {tag}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onChange(value.filter((t) => t !== tag))
              }}
              title={`Remove the tag ${tag}`}
              aria-label={`Remove the tag ${tag}`}
              className="flex h-4 w-4 items-center justify-center rounded text-muted hover:bg-bg hover:text-text"
            >
              <CloseIcon size={8} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          value={text}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            add(parseTags(text))
            setText('')
            setFocused(false)
            onBlur?.()
          }}
          placeholder={value.length ? 'Add a tag…' : 'Tags, separated by commas'}
          className="min-w-24 flex-1 bg-transparent py-0.5 outline-none placeholder:text-muted/70"
        />
      </div>
      {focused && matches.length > 0 && (
        <div className="absolute inset-x-0 top-full z-10 mt-1 flex flex-wrap items-center gap-1 rounded-md border border-line bg-panel p-2 shadow-xl shadow-black/40">
          <span className="mr-1 text-[11px] text-muted">{text ? 'Existing:' : 'Suggestions:'}</span>
          {matches.map((s) => (
            <button
              key={s}
              type="button"
              // Keep focus in the input so several tags can be picked in a row.
              onMouseDown={(e) => {
                e.preventDefault()
                add([s])
                setText('')
              }}
              className="rounded border border-line px-1.5 py-0.5 text-[12px] text-muted hover:border-muted hover:text-text"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
