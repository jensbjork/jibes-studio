import { useId, useMemo, useState } from 'react'
import { composeDirection, mergeAvoid, resolvedDirectorOf, resolveDirector, withDirection } from '@shared/direction'
import { DEFAULT_MODEL, paramsForSubmit } from '@shared/models'
import type { GenerationParams } from '@shared/types'
import type { DirectorEntry } from '../../lib/directors'
import { KIND_TONE, VIDEO_TONE } from '../pickers/assetKinds'
import { usePromptLanguage } from '../prompt/usePromptLanguage'

/**
 * A clip as the preview imagines it: the app's reference model, with sound and no references of its own, so every
 * style frame and video is sent (@Image1 …, @Video1 …). In a real clip they come after its own.
 */
const SAMPLE: GenerationParams = {
  model: DEFAULT_MODEL['reference-to-video'],
  prompt: '…',
  duration: '8s',
  aspectRatio: '16:9',
  resolution: '480p',
  audio: true
}

/**
 * The Direction section as a clip it directs gets it after its prompt and References legend, in the prompt language
 * (the shared composeDirection that main sends with), and what its `avoid` adds to the negative prompt. Folded to its
 * header until "Show the text": the fields above already say it part by part. Live: it follows the editor as it is
 * typed.
 */
export default function DirectionPreview({ entry }: { entry: DirectorEntry }) {
  const language = usePromptLanguage()
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const director = useMemo(
    () =>
      entry.preset
        ? resolveDirector(entry.id, [])
        : resolvedDirectorOf({
            id: entry.id,
            kind: 'director',
            name: entry.name,
            images: entry.asset?.images ?? [],
            direction: entry.direction
          }),
    [entry]
  )
  const composed = useMemo(
    () => (director ? composeDirection(paramsForSubmit(withDirection(SAMPLE, director)), director, { language }) : undefined),
    [director, language]
  )
  const avoid = director ? mergeAvoid(undefined, director.direction.avoid) : undefined
  const sections = composed?.section.replace(/^\s+/, '').split('\n') ?? []

  return (
    <section aria-label="Preview" className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className={`flex items-baseline gap-2 px-3 py-2 ${open ? 'border-b border-line/60' : ''}`}>
        <h2 className="text-[12px] font-medium">Added to the prompt</h2>
        <span className="text-[11px] text-muted" title="Settings → Generation → Prompt language">
          · {language === 'sv' ? 'Swedish' : 'English'}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="text-[11px] text-muted transition hover:text-text"
        >
          {open ? 'Hide the text' : 'Show the text'}
        </button>
      </div>
      {open && (
        <div id={bodyId}>
          {sections.length ? (
            <div className="px-3 py-2.5 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-text/90 select-text">
              {sections.map((line, i) => (
                <p key={i} className={i === 0 ? 'mb-0.5 font-medium' : 'pl-3 -indent-3'}>
                  <Tokens text={line} />
                </p>
              ))}
            </div>
          ) : (
            <p className="px-3 py-3 text-[12px] leading-relaxed text-muted">
              Nothing yet. Write a part – the look, the camera, the light … – and it shows here as a clip gets it.
            </p>
          )}
          {avoid && (
            <div className="border-t border-line/60 px-3 py-2 text-[11px] leading-snug">
              <span className="text-muted">Added to the negative prompt: </span>
              <span className="text-text/90 select-text">{avoid}</span>
            </div>
          )}
          <p className="border-t border-line/60 px-3 py-2 text-[11px] leading-snug text-muted">
            Sound only for clips made with sound; style frames only in reference mode, numbered after the clip’s own
            images. When a prompt is long, parts are left out from the end to fit the model’s limit.
          </p>
        </div>
      )}
    </section>
  )
}

/** The section's tokens coloured as the prompt shows them: style frames in the directors' colour, videos as videos. */
function Tokens({ text }: { text: string }) {
  return (
    <>
      {text.split(/(@(?:Image|Video)\d+)/g).map((part, i) =>
        i % 2 ? (
          <span
            key={i}
            className={`rounded-[3px] px-0.5 ${part.startsWith('@Video') ? VIDEO_TONE.token : KIND_TONE.director.token}`}
          >
            {part}
          </span>
        ) : (
          part
        )
      )}
    </>
  )
}
