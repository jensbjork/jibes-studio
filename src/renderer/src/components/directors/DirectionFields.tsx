import { useId, useRef, useState } from 'react'
import { PROMPT_BLOCK_GROUPS } from '@shared/prompt-blocks'
import type { Direction } from '@shared/types'
import { DIRECTION_FIELDS, FIELD_COPY, fieldText, type DirectionField } from '../../lib/directors'
import Popover from '../pickers/Popover'
import PromptField from '../prompt/PromptField'
import { blockInsertion } from '../prompt/blocks'
import { replaceRange } from '../prompt/textareaDom'
import { PlusIcon } from '../sequences/icons'
import { onMenuKeyDown } from '../ui/menu'

interface Props {
  direction: Omit<Direction, 'videos'>
  onChange: (field: DirectionField, text: string) => void
  onBlur: () => void
}

/**
 * A field per part of a direction – editing, look, camera, light, framing, rhythm, performance, sound and what it
 * avoids – each a prompt field like every other ("/" searches the building blocks, ⌘⇧F writes it in a larger window;
 * what it avoids offers the negative ones), with what it is about as its label's tooltip and, where the building
 * blocks have a group for it, a quick-add chip that puts a ready-made phrase in at the caret (comma-separated, as the
 * prompt fields do).
 */
export default function DirectionFields({ direction, onChange, onBlur }: Props) {
  return (
    <div className="grid gap-x-5 gap-y-4 @min-[34rem]/fields:grid-cols-2">
      {DIRECTION_FIELDS.map((field) => (
        <PartField
          key={field}
          field={field}
          value={fieldText(direction, field)}
          onChange={(text) => onChange(field, text)}
          onBlur={onBlur}
        />
      ))}
    </div>
  )
}

function PartField({
  field,
  value,
  onChange,
  onBlur
}: {
  field: DirectionField
  value: string
  onChange: (text: string) => void
  onBlur: () => void
}) {
  const copy = FIELD_COPY[field]
  const id = useId()
  const hintId = useId()
  const textarea = useRef<HTMLTextAreaElement>(null)
  // Where the caret was when the field was last left: a phrase picked from the chip goes there (else at the end).
  const caret = useRef<{ start: number; end: number }>(undefined)

  const insert = (text: string) => {
    const el = textarea.current
    if (!el) return
    const at = caret.current ?? { start: el.value.length, end: el.value.length }
    const edit = blockInsertion(el.value, at.start, at.end, text)
    el.focus()
    if (!replaceRange(el, edit.start, edit.end, edit.text)) {
      onChange(el.value.slice(0, edit.start) + edit.text + el.value.slice(edit.end))
    }
    const pos = edit.start + edit.text.length
    caret.current = { start: pos, end: pos }
    requestAnimationFrame(() => el.setSelectionRange(pos, pos))
  }

  return (
    <div className={field === 'avoid' ? '@min-[34rem]/fields:col-span-2' : undefined}>
      {/* What the part is about is the label's tooltip (and read with the field); only a short rule shows. */}
      <div className="mb-1 flex items-baseline gap-2">
        <label htmlFor={id} title={copy.hint} className="font-medium">
          {copy.label}
        </label>
        <span id={hintId} className="sr-only">
          {copy.hint}
        </span>
        {copy.note && <span className="text-[11px] text-muted">{copy.note}</span>}
        <span className="flex-1" />
        {copy.blocks && <BlockChip group={copy.blocks} onPick={insert} />}
      </div>
      <PromptField
        id={id}
        textareaRef={textarea}
        value={value}
        onChange={onChange}
        placeholder={copy.placeholder}
        context={field === 'avoid' ? 'negative' : 'video'}
        bare
        minRows={2}
        maxRows={8}
        title={copy.label}
        focusHint={copy.hint}
        ariaDescribedBy={hintId}
        onBlur={() => {
          const el = textarea.current
          if (el) caret.current = { start: el.selectionStart, end: el.selectionEnd }
          onBlur()
        }}
      />
    </div>
  )
}

/** "＋ Camera": the building blocks of one group, a click puts one in (↑ ↓ and Enter from the keyboard). */
function BlockChip({ group, onPick }: { group: string; onPick: (text: string) => void }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const g = PROMPT_BLOCK_GROUPS.find((x) => x.id === group)
  if (!g) return null
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Add a ready-made ${g.label.toLowerCase()} phrase (building blocks) – or type / in the field`}
        className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition ${
          open ? 'border-sky-400/50 bg-sky-400/10 text-text' : 'border-line text-muted hover:border-white/20 hover:text-text'
        }`}
      >
        <PlusIcon size={9} />
        {g.label}
      </button>
      <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} align="end" width={300} maxHeight={360} label={g.label}>
        <div role="menu" aria-label={g.label} onKeyDown={onMenuKeyDown} className="min-h-0 overflow-y-auto p-1">
          {g.blocks.map((b, i) => (
            <button
              key={b.label}
              type="button"
              role="menuitem"
              data-menu-item
              autoFocus={i === 0}
              onClick={() => {
                setOpen(false)
                onPick(b.text)
              }}
              className="block w-full rounded-md px-2.5 py-1.5 text-left outline-none transition hover:bg-raised focus-visible:bg-raised"
            >
              <span className="block text-[12px]">{b.label}</span>
              <span className="block truncate text-[11px] text-muted">{b.text}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}

/** The parts as plain text, for a ready-made director (read-only: nothing that looks like a field). */
export function DirectionText({ direction }: { direction: Direction }) {
  const written = DIRECTION_FIELDS.filter((f) => fieldText(direction, f).trim())
  if (!written.length) return <p className="text-[12px] text-muted">Nothing written.</p>
  return (
    <dl className="grid gap-x-5 gap-y-3 @min-[34rem]/fields:grid-cols-2">
      {written.map((f) => (
        <div key={f} className={f === 'avoid' ? '@min-[34rem]/fields:col-span-2' : undefined}>
          <dt className="mb-0.5 flex items-baseline gap-2">
            <span title={FIELD_COPY[f].hint} className="font-medium">
              {FIELD_COPY[f].label}
            </span>
            {FIELD_COPY[f].note && <span className="text-[11px] text-muted">{FIELD_COPY[f].note}</span>}
          </dt>
          <dd className="text-[13px] leading-relaxed text-text/90 select-text">{fieldText(direction, f)}</dd>
        </div>
      ))}
    </dl>
  )
}
