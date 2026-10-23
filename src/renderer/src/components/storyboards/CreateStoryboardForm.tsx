import { useState, type FormEvent } from 'react'
import { buttonClass } from '../ui/button'
import { rovingKeyDown } from '../ui/roving'
import { aspectLabel, aspectValue, DEFAULT_STORYBOARD_ASPECT, STORYBOARD_ASPECTS } from './storyboardUtils'

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

interface Props {
  creating: boolean
  onCreate: (aspectRatio: string) => void
  /** Focus the button when shown (in the popover): Enter then creates one in the format offered. */
  autoFocus?: boolean
}

/**
 * A new storyboard: the film's format, chosen from the shapes the image-to-video models make (the last one chosen is
 * offered first next time). The name is given afterwards in the header, which has the cursor, as for a new sequence.
 * The tiles are one radio group: Tab reaches the chosen one, the arrow keys choose another.
 */
export default function CreateStoryboardForm({ creating, onCreate, autoFocus = false }: Props) {
  const [aspect, setAspect] = useState(rememberedAspect)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (creating) return
    rememberAspect(aspect)
    onCreate(aspect)
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset>
        <legend className="mb-1.5 text-muted">Format</legend>
        <div
          role="radiogroup"
          aria-label="Format"
          onKeyDown={(e) => rovingKeyDown(e, STORYBOARD_ASPECTS, aspect, setAspect, { vertical: true })}
          className="grid grid-cols-3 gap-1.5"
        >
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
                data-roving-id={a}
                tabIndex={chosen ? 0 : -1}
                onClick={() => setAspect(a)}
                title={aspectLabel(a)}
                className={`flex flex-col items-center gap-1.5 rounded-md border px-1 pb-1.5 pt-2.5 text-[11px] outline-none transition focus-visible:ring-1 focus-visible:ring-muted ${
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

      <button
        type="submit"
        autoFocus={autoFocus}
        disabled={creating}
        className={`${buttonClass('primary', 'lg')} w-full`}
      >
        {creating ? 'Creating…' : 'Create storyboard'}
      </button>
    </form>
  )
}
