import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import type { PromptBlockContext } from '@shared/prompt-blocks'
import { isFocusModeKey, isMac, isSubmitKey, shortcut } from '../../lib/platform'
import { ExpandIcon } from '../feed/icons'
import FocusDialog from './FocusDialog'
import { caretRect, replaceRange } from './textareaDom'
import { ALL, useBlockMenu, type BlockMenuControls } from './useBlockMenu'

/** The text style of every prompt field: larger than the UI's 13 px and airy, so a long prompt reads easily. */
export const PROMPT_TEXT = 'text-[14.5px] leading-[1.65]'
/** In focus mode. */
export const PROMPT_TEXT_LARGE = 'text-[16px] leading-[1.7]'

/** The frame of a prompt field, with a clear focus state (the app's focus colour, as on every other field). */
export function promptFrame(invalid?: boolean): string {
  return invalid
    ? 'border-accent/50 focus:border-accent/80 focus:ring-2 focus:ring-accent/20'
    : 'border-white/12 hover:border-white/20 focus:border-muted'
}

/**
 * Grows a textarea with its text between `minRows` and `maxRows` lines (then it scrolls); `fill` lets it take its
 * container's height instead (focus mode).
 */
export function useAutoGrow(
  el: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  minRows: number,
  maxRows: number,
  fill = false
): void {
  useLayoutEffect(() => {
    const t = el.current
    if (!t || fill) return
    const style = getComputedStyle(t)
    const line = parseFloat(style.lineHeight) || 22
    const chrome =
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom) +
      parseFloat(style.borderTopWidth) +
      parseFloat(style.borderBottomWidth)
    t.style.height = 'auto'
    const wanted = t.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
    const height = Math.min(Math.max(wanted, minRows * line + chrome), maxRows * line + chrome)
    t.style.height = `${Math.ceil(height)}px`
  }, [el, value, minRows, maxRows, fill])
}

/**
 * The chips shown under a field: the first few groups (the scene template and the rest are under "More…"). Three,
 * so they fit on one line in Generate's and a clip's form column.
 */
const PRIMARY_CHIPS = 3

function primaryChips(chips: { id: string; label: string }[]): { id: string; label: string }[] {
  return chips.filter((c) => c.id !== 'scene').slice(0, PRIMARY_CHIPS)
}

function Chip({ id, label, blocks, title }: { id: string; label: string; blocks: BlockMenuControls; title?: string }) {
  const open = blocks.openChipId === id
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => blocks.openChip(id, e.currentTarget)}
      aria-expanded={open}
      className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
        open ? 'border-sky-400/50 bg-sky-400/10 text-text' : 'border-line text-muted hover:border-white/20 hover:text-text'
      }`}
    >
      {label}
    </button>
  )
}

interface ToolbarProps {
  blocks?: BlockMenuControls
  /** Characters typed, against the model's limit when there is one. */
  count?: { length: number; limit?: number }
  onExpand?: () => void
  /** What's left of the bar, e.g. the prompt editor's own notes. */
  children?: ReactNode
}

/**
 * The strip under a prompt field: the building-block chips (each opens the menu for its group), the character
 * count (only against a limit) and the focus mode button.
 */
export function PromptToolbar({ blocks, count, onExpand, children }: ToolbarProps) {
  const over = count?.limit !== undefined && count.length > count.limit
  return (
    <div className="mt-1.5 flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {blocks && blocks.chips.length > 0 && (
          <div
            role="group"
            aria-label="Building blocks"
            title="Type / in the text to search the building blocks"
            className="flex flex-wrap items-center gap-1"
          >
            {primaryChips(blocks.chips).map((c) => (
              <Chip key={c.id} id={c.id} label={`＋ ${c.label}`} blocks={blocks} />
            ))}
            {blocks.chips.length > primaryChips(blocks.chips).length && (
              <Chip id={ALL} label="More…" blocks={blocks} title="All building blocks, your prompts and learnings" />
            )}
          </div>
        )}
        {children}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {count && (count.length > 0 || count.limit !== undefined) && (
          <span
            className={`text-[11px] tabular-nums ${over ? 'text-danger' : 'text-muted'}`}
            title={count.limit !== undefined ? `${count.length} of at most ${count.limit} characters` : `${count.length} characters`}
          >
            {count.limit !== undefined ? `${count.length}/${count.limit}` : `${count.length} ${count.length === 1 ? 'character' : 'characters'}`}
          </span>
        )}
        {onExpand && (
          <button
            type="button"
            onClick={onExpand}
            aria-label="Write in a larger window"
            title={`Write in a larger window (${shortcut('⌘⇧F')})`}
            className="flex h-5 w-5 items-center justify-center rounded text-muted transition hover:bg-raised hover:text-text"
          >
            <ExpandIcon size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

export interface PromptFieldProps {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Which building blocks the field offers ("/" and the chips); none when left out. */
  context?: PromptBlockContext
  /** Lines it shows empty, and grows to before it scrolls. */
  minRows?: number
  maxRows?: number
  /** ⌘↵ (Ctrl+Enter). */
  onSubmit?: () => void
  /** The model's character limit: the count is shown against it (and only with one). */
  limit?: number
  /** Focus mode's heading, e.g. "What happens?"; also the field's accessible name when no label points at it. */
  title: string
  /** Focus mode's line under the heading. */
  focusHint?: string
  ariaLabel?: string
  ariaDescribedBy?: string
  /** Off by default: prompts are mostly English and the spell checker follows the Swedish system. */
  spellCheck?: boolean
  autoFocus?: boolean
  disabled?: boolean
  invalid?: boolean
  textareaRef?: Ref<HTMLTextAreaElement>
  onFocus?: () => void
  onBlur?: () => void
  /** Shown between the field and its toolbar. */
  belowInput?: ReactNode
  /** No toolbar: no chips, count or focus mode button ("/" and ⌘⇧F still work). */
  bare?: boolean
  /** Inside focus mode (internal). */
  inFocus?: boolean
}

/**
 * A prompt field: a textarea with larger text that grows with what is written, a clear frame, building blocks
 * ("/" or the chips), the character count against a limit and focus mode (the expand button, ⌘⇧F) – the same help
 * in every place a prompt is written. The reference-aware prompt editor (Generate, Sequences) has the same look and
 * tools.
 */
export default function PromptField(props: PromptFieldProps) {
  const {
    id,
    value,
    onChange,
    placeholder,
    context,
    minRows = 3,
    maxRows = 14,
    onSubmit,
    limit,
    title,
    focusHint,
    ariaLabel,
    ariaDescribedBy,
    spellCheck = false,
    autoFocus,
    disabled,
    invalid,
    textareaRef,
    onFocus,
    onBlur,
    belowInput,
    bare,
    inFocus
  } = props
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const [expanded, setExpanded] = useState(false)

  const setRefs = useCallback(
    (el: HTMLTextAreaElement | null) => {
      textarea.current = el
      if (typeof textareaRef === 'function') textareaRef(el)
      else if (textareaRef) (textareaRef as React.RefObject<HTMLTextAreaElement | null>).current = el
    },
    [textareaRef]
  )

  useAutoGrow(textarea, value, minRows, maxRows, inFocus)

  // Focus mode opens with the caret at the end of the text, ready to go on writing.
  useEffect(() => {
    const el = textarea.current
    if (!inFocus || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.scrollTop = el.scrollHeight
  }, [inFocus])

  const edit = (start: number, end: number, text: string): void => {
    const el = textarea.current
    if (!el) return
    if (!replaceRange(el, start, end, text)) {
      onChange(el.value.slice(0, start) + text + el.value.slice(end))
      const pos = start + text.length
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(pos, pos)
      })
    }
  }

  const blocks = useBlockMenu({
    context: context ?? 'video',
    textarea,
    edit,
    measure: (index) => (textarea.current ? caretRect(textarea.current, index) : undefined)
  })
  const withBlocks = !!context

  const expand = (): void => {
    blocks.onBlur()
    setExpanded(true)
  }
  const collapse = useCallback(() => {
    setExpanded(false)
    requestAnimationFrame(() => textarea.current?.focus())
  }, [])

  return (
    <div className={inFocus ? 'flex min-h-0 flex-1 flex-col' : undefined}>
      <textarea
        ref={setRefs}
        id={id}
        value={value}
        placeholder={placeholder}
        rows={minRows}
        autoFocus={autoFocus && !inFocus}
        disabled={disabled}
        aria-label={ariaLabel ?? (id ? undefined : title)}
        aria-invalid={invalid || undefined}
        aria-describedby={ariaDescribedBy}
        aria-keyshortcuts={onSubmit ? (isMac ? 'Meta+Enter' : 'Control+Enter') : undefined}
        spellCheck={spellCheck}
        aria-autocomplete={withBlocks ? 'list' : undefined}
        aria-controls={blocks.slashOpen ? blocks.menuId : undefined}
        aria-activedescendant={blocks.activeId}
        onChange={(e) => {
          onChange(e.target.value)
          if (withBlocks) blocks.onInput(e.currentTarget)
        }}
        onSelect={(e) => withBlocks && blocks.onSelect(e.currentTarget)}
        onKeyDown={(e) => {
          if (withBlocks && blocks.onKeyDown(e)) return
          if (onSubmit && isSubmitKey(e)) {
            e.preventDefault()
            onSubmit()
            return
          }
          if (isFocusModeKey(e)) {
            e.preventDefault()
            if (inFocus) return
            expand()
          }
        }}
        onFocus={onFocus}
        onBlur={() => {
          blocks.onBlur()
          onBlur?.()
        }}
        className={`block w-full resize-none rounded-lg border bg-raised px-3.5 py-2.5 text-text outline-none transition-[border-color,box-shadow] placeholder:text-muted/80 disabled:opacity-60 ${
          inFocus ? `min-h-0 flex-1 ${PROMPT_TEXT_LARGE}` : PROMPT_TEXT
        } ${promptFrame(invalid)}`}
      />
      {belowInput}
      {!bare && (
        <PromptToolbar
          blocks={withBlocks ? blocks : undefined}
          count={limit !== undefined ? { length: value.length, limit } : undefined}
          onExpand={inFocus ? undefined : expand}
        />
      )}
      {withBlocks && blocks.menu}
      {expanded && !inFocus && (
        <FocusDialog title={title} subtitle={focusHint} onClose={collapse}>
          <PromptField
            {...props}
            id={undefined}
            textareaRef={undefined}
            ariaDescribedBy={undefined}
            autoFocus
            inFocus
            belowInput={undefined}
          />
        </FocusDialog>
      )}
    </div>
  )
}
