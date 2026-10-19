import { useState } from 'react'
import { CopyButton } from '../prompts/controls'
import { splitComposedPrompt } from '../prompt/descriptions'
import HighlightedPrompt from './HighlightedPrompt'
import type { AudioReference, ImageReference, VideoReference } from './references'

interface Props {
  /** The user's prompt, as the generation stores it. */
  prompt: string
  /** What was actually sent: the prompt with the References legend of the assets' descriptions appended. */
  sentPrompt: string
  images: readonly ImageReference[]
  audios: readonly AudioReference[]
  videos?: readonly VideoReference[]
  highlighted?: string
  onHover?: (token: string | undefined) => void
}

/**
 * "Skickad prompt": the prompt exactly as Venice got it, when Studio appended something to the user's text (the
 * descriptions of the referenced assets, as they were then). The user's own part is shown above it already, so
 * here it is folded to two lines and the appended legend is set apart below it; both keep their tokens coloured.
 */
export default function SentPrompt({ prompt, sentPrompt, images, audios, videos, highlighted, onHover }: Props) {
  const [expanded, setExpanded] = useState(false)
  const { body, legend } = splitComposedPrompt(prompt, sentPrompt)
  // Only offer to unfold text that can be folded: more than a couple of lines' worth.
  const foldable = body.length > 140 || body.split('\n').length > 2
  const added = sentPrompt.length - body.length

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate text-[11px] text-muted">Sent prompt</h4>
        {legend && (
          <span
            className="shrink-0 text-[11px] text-muted tabular-nums"
            title="The descriptions of the references were added after the prompt when the clip was sent"
          >
            +{added} {added === 1 ? 'character' : 'characters'}
          </span>
        )}
        <CopyButton text={sentPrompt} />
      </div>
      {legend ? (
        <div className="rounded-md border border-line/70 bg-raised/40 px-2.5 py-2">
          <HighlightedPrompt
            text={body}
            images={images}
            audios={audios}
            videos={videos}
            highlighted={highlighted}
            onHover={onHover}
            className={`text-[12px] text-muted ${expanded || !foldable ? '' : 'line-clamp-2'}`}
          />
          {foldable && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
              className="mt-0.5 text-[11px] text-muted transition hover:text-text hover:underline"
            >
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
          <div className="mt-2 border-t border-dashed border-line pt-2">
            <HighlightedPrompt
              text={legend}
              images={images}
              audios={audios}
              videos={videos}
              highlighted={highlighted}
              onHover={onHover}
              className="text-[12px]"
            />
          </div>
        </div>
      ) : (
        <HighlightedPrompt
          text={sentPrompt}
          images={images}
          audios={audios}
          videos={videos}
          highlighted={highlighted}
          onHover={onHover}
          className="text-[12px]"
        />
      )}
    </div>
  )
}
