import { useMemo, useState } from 'react'
import { composeDirection, imageDirection, withDirection, type ResolvedDirector } from '@shared/direction'
import { paramsForSubmit } from '@shared/models'
import type { GenerationParams } from '@shared/types'
import AssetIcon from '../assets/AssetIcon'
import { KIND_TONE } from '../pickers/assetKinds'
import { usePromptLanguage } from '../prompt/usePromptLanguage'

interface Props {
  /** The params as the clip is sent without its director. */
  params: GenerationParams
  director: ResolvedDirector
  /** Whose director it is: "the storyboard's". */
  whose: string
  onOpen?: () => void
}

/**
 * "Directed by Noir – the storyboard's": under a prompt that a director it doesn't choose itself directs (a
 * storyboard's transitions), what it adds – the parts as one line, what it avoids – and the Direction section as it is
 * sent, on request.
 */
export default function DirectedByNote({ params, director, whose, onOpen }: Props) {
  const language = usePromptLanguage()
  const [open, setOpen] = useState(false)
  const composed = useMemo(
    () => composeDirection(paramsForSubmit(withDirection(params, director)), director, { language }),
    [params, director, language]
  )
  const parts = composed.lines.filter((l) => l.part !== 'styleFrames' && l.part !== 'styleVideo').length
  const section = composed.section.replace(/^\s+/, '')
  return (
    <div className="mt-2 rounded-md border border-line px-3 py-2 text-[11px] leading-relaxed">
      <p className="flex items-start gap-1.5">
        <span className={`mt-[3px] flex ${KIND_TONE.director.text}`}>
          <AssetIcon kind="director" />
        </span>
        <span className="min-w-0 flex-1">
          Directed by <span className="text-text">{director.name}</span> – {whose}.{' '}
          <span className="text-muted">
            {parts ? `Adds ${parts} ${parts === 1 ? 'line' : 'lines'} after the prompt` : 'Adds nothing to the prompt'}
            {director.direction.avoid ? ' and what it avoids to the negative prompt.' : '.'}
          </span>
        </span>
      </p>
      <div className="mt-1 flex gap-3 pl-[21px]">
        {section && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-text hover:underline">
            {open ? 'Hide the text' : 'Show the text'}
          </button>
        )}
        {onOpen && (
          <button type="button" onClick={onOpen} className="text-muted transition hover:text-text hover:underline">
            Open the director
          </button>
        )}
      </div>
      {open && section && (
        <p className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-raised/60 px-2 py-1.5 text-muted select-text">
          {section}
          {director.direction.avoid && `\n\nAvoid: ${director.direction.avoid}`}
        </p>
      )}
      {composed.notes.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-[21px] text-amber-300">
          {composed.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Create image… for a storyboard or a sequence with a director: which look the picture gets. Image prompts carry no
 * tokens, so only its look, light and framing go along as text after the prompt, and what it avoids as the negative
 * prompt's addition (direction.ts imageDirection); style frames and videos don't.
 */
export function ImageDirectionNote({ director, whose }: { director: ResolvedDirector; whose: string }) {
  const { text, avoid } = imageDirection(director)
  return (
    <div className="rounded-md border border-line px-3 py-2 text-[11px] leading-relaxed">
      <p className="flex items-start gap-1.5">
        <span className={`mt-[3px] flex ${KIND_TONE.director.text}`}>
          <AssetIcon kind="director" />
        </span>
        <span className="min-w-0 flex-1">
          In the look of <span className="text-text">{director.name}</span> – {whose} director.{' '}
          <span className="text-muted">
            {text
              ? `Its look, light and framing are added after the prompt${avoid ? ', and what it avoids to the negative prompt' : ''}.`
              : avoid
                ? 'What it avoids is added to the negative prompt.'
                : 'It has no look, light or framing written, so nothing is added.'}
          </span>
        </span>
      </p>
      {text && <p className="mt-1 pl-[21px] text-muted select-text">{text}</p>}
    </div>
  )
}
