import { useId, useState, type FormEvent } from 'react'
import { aspectValue, DEFAULT_STORYBOARD_ASPECT, STORYBOARD_ASPECTS } from './storyboardUtils'
import { primaryButton } from './ui'

const LAST_ASPECT_KEY = 'storyboards:lastAspect'

function rememberedAspect(): string {
  try {
    const value = localStorage.getItem(LAST_ASPECT_KEY)
    return value && (STORYBOARD_ASPECTS as readonly string[]).includes(value) ? value : DEFAULT_STORYBOARD_ASPECT
  } catch {
    return DEFAULT_STORYBOARD_ASPECT
  }
}

function rememberAspect(aspect: string): void {
  try {
    localStorage.setItem(LAST_ASPECT_KEY, aspect)
  } catch {
    // Remembering the last format is only a convenience.
  }
}

const SHAPE_NAMES: Record<string, string> = {
  '16:9': 'Landscape',
  '9:16': 'Portrait',
  '1:1': 'Square',
  '4:3': 'Landscape',
  '3:4': 'Portrait',
  '21:9': 'Wide'
}

interface Props {
  creating: boolean
  onCreate: (name: string, aspectRatio: string) => void
  /** Focus the name field when shown (in the popover). */
  autoFocus?: boolean
}

/**
 * A new storyboard: a name (optional, main names it otherwise) and the film's format, chosen from the shapes the
 * image-to-video models make. The last format chosen is offered first next time.
 */
export default function CreateStoryboardForm({ creating, onCreate, autoFocus = false }: Props) {
  const [name, setName] = useState('')
  const [aspect, setAspect] = useState(rememberedAspect)
  const nameId = useId()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (creating) return
    rememberAspect(aspect)
    onCreate(name.trim(), aspect)
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label htmlFor={nameId} className="block">
        <span className="mb-1.5 block text-muted">Name</span>
        <input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus={autoFocus}
          spellCheck={false}
          placeholder="For example “Morning by the sea”"
          className="w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
        />
      </label>

      <fieldset>
        <legend className="mb-1.5 text-muted">Format</legend>
        <div role="radiogroup" aria-label="Format" className="grid grid-cols-3 gap-1.5">
          {STORYBOARD_ASPECTS.map((a) => {
            const ratio = aspectValue(a)
            // The shape drawn inside a 30 × 22 box.
            const w = ratio >= 30 / 22 ? 30 : Math.round(22 * ratio)
            const h = ratio >= 30 / 22 ? Math.round(30 / ratio) : 22
            const chosen = a === aspect
            return (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={chosen}
                onClick={() => setAspect(a)}
                title={`${a} – ${SHAPE_NAMES[a]?.toLowerCase() ?? ''}`}
                className={`flex flex-col items-center gap-1.5 rounded-md border px-1 pb-1.5 pt-2.5 text-[11px] transition ${
                  chosen
                    ? 'border-accent/70 bg-accent/10 text-text'
                    : 'border-line text-muted hover:border-muted hover:text-text'
                }`}
              >
                <span className="flex h-[22px] items-center justify-center">
                  <span
                    className={`block rounded-[3px] border ${chosen ? 'border-accent bg-accent/20' : 'border-muted/70'}`}
                    style={{ width: w, height: h }}
                  />
                </span>
                <span className="tabular-nums">{a}</span>
              </button>
            )
          })}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          New images are created in this format. You can change it later.
        </p>
      </fieldset>

      <button type="submit" disabled={creating} className={`${primaryButton} w-full py-2`}>
        {creating ? 'Creating…' : 'Create storyboard'}
      </button>
    </form>
  )
}
