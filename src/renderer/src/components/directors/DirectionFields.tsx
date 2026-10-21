import { useId, useRef, useState } from 'react'
import { PROMPT_BLOCK_GROUPS } from '@shared/prompt-blocks'
import type { Direction } from '@shared/types'
import { DIRECTION_FIELDS, FIELD_COPY, fieldText, type DirectionField } from '../../lib/directors'
import Popover from '../pickers/Popover'
import { promptFrame, useAutoGrow } from '../prompt/PromptField'
import { blockInsertion } from '../prompt/blocks'
import { replaceRange } from '../prompt/textareaDom'

interface Props {
  direction: Omit<Direction, 'videos'>
  onChange: (field: DirectionField, text: string) => void
  onBlur: () => void
}

/**
 * A field per part of a direction – editing, look, camera, light, framing, rhythm, performance, sound and what it
 * avoids – each with what it is about and, where the building blocks have a group for it, a quick-add chip that puts a
 * ready-made phrase in at the caret (comma-separated, as the prompt fields do).
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
  const textarea = useRef<HTMLTextAreaElement>(null)
  // Where the caret was when the field was last left: a phrase picked from the chip goes there (else at the end).
  const caret = useRef<{ start: number; end: number }>(undefined)
  useAutoGrow(textarea, value, 2, 8)

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
      <div className="mb-1 flex items-baseline gap-2">
        <label htmlFor={id} className="font-medium">
          {copy.label}
        </label>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={copy.hint}>
          {copy.hint}
        </span>
        {copy.blocks && <BlockChip group={copy.blocks} onPick={insert} />}
      </div>
      <textarea
        ref={textarea}
        id={id}
        value={value}
        rows={2}
        spellCheck={false}
        placeholder={copy.placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          caret.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd }
          onBlur()
        }}
        className={`block w-full resize-none rounded-lg border bg-raised px-3 py-2 text-[13.5px] leading-[1.6] text-text outline-none transition-[border-color,box-shadow] placeholder:text-muted/70 ${promptFrame()}`}
      />
    </div>
  )
}

/** "＋ Camera": the building blocks of one group, a click puts one in. */
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
        title={`Building blocks: ${g.label.toLowerCase()}`}
        className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] transition ${
          open ? 'border-sky-400/50 bg-sky-400/10 text-text' : 'border-line text-muted hover:border-white/20 hover:text-text'
        }`}
      >
        ＋ {g.label}
      </button>
      <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} align="end" width={300} maxHeight={360} label={g.label}>
        <div role="menu" aria-label={g.label} className="p-1">
          {g.blocks.map((b) => (
            <button
              key={b.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onPick(b.text)
              }}
              className="block w-full rounded-md px-2.5 py-1.5 text-left transition hover:bg-raised"
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

/** The parts as text, for a ready-made director (read-only). */
export function DirectionText({ direction }: { direction: Direction }) {
  const written = DIRECTION_FIELDS.filter((f) => fieldText(direction, f).trim())
  if (!written.length) return <p className="text-[12px] text-muted">Nothing written.</p>
  return (
    <dl className="grid gap-x-5 gap-y-3 @min-[34rem]/fields:grid-cols-2">
      {written.map((f) => (
        <div key={f} className={f === 'avoid' ? '@min-[34rem]/fields:col-span-2' : undefined}>
          <dt className="mb-0.5 flex items-baseline gap-2">
            <span className="font-medium">{FIELD_COPY[f].label}</span>
            <span className="truncate text-[11px] text-muted">{FIELD_COPY[f].hint}</span>
          </dt>
          <dd className="rounded-lg border border-line bg-panel px-3 py-2 text-[13px] leading-relaxed text-text/90 select-text">
            {fieldText(direction, f)}
          </dd>
        </div>
      ))}
    </dl>
  )
}
