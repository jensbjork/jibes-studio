import type { ResolvedDirector } from '@shared/direction'
import { pathKey } from '@shared/generation-filter'
import { maxReferenceImages, referenceVideoLimits, referenceVideosOf } from '@shared/models'
import type { GenerationParams } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import AssetIcon from '../assets/AssetIcon'
import { KIND_TONE, VIDEO_TONE } from '../pickers/assetKinds'
import VideoWindowPreview from '../pickers/VideoWindowPreview'

interface Props {
  /** The params as sent (withDirection's): where the style frames and videos ended up, and which of them are sent. */
  sent: GenerationParams
  director: ResolvedDirector
  /** Opens the director (to change its style frames and videos). */
  onOpen?: () => void
}

/** The 1-based place of each path among the first `max` of `list` (by pathKey); 0 where it isn't there. */
function places(paths: readonly string[], list: readonly string[], max: number): number[] {
  const at = new Map(list.slice(0, max).map((p, i) => [pathKey(p), i + 1]))
  return paths.map((p) => at.get(pathKey(p)) ?? 0)
}

function Heading({ name, what, onOpen }: { name: string; what: string; onOpen?: () => void }) {
  return (
    <p className="mb-1 flex items-center gap-1.5 text-[11px] text-muted">
      <span className={`flex ${KIND_TONE.director.text}`}>
        <AssetIcon kind="director" />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {what} from the director {name}
      </span>
      {onOpen && (
        <button type="button" onClick={onOpen} className="shrink-0 transition hover:text-text hover:underline">
          Change
        </button>
      )}
    </p>
  )
}

/**
 * The director's style frames under the form's reference images: sent after them with the numbers they get
 * (@Image4 …), not part of the form – they can't be removed or moved here, only in the director. Those that don't fit
 * the model's places are dimmed.
 */
export function StyleFramesFromDirector({ sent, director, onOpen }: Props) {
  const frames = director.styleFrames
  if (!frames.length) return null
  const numbers = places(frames, sent.referenceImages ?? [], maxReferenceImages(sent.model))
  return (
    <div className="mt-2">
      <Heading name={director.name} what={frames.length === 1 ? 'Style frame' : 'Style frames'} onOpen={onOpen} />
      <div className="flex flex-wrap gap-1.5">
        {frames.map((path, i) => {
          const n = numbers[i]
          return (
            <div
              key={path}
              title={
                n
                  ? `@Image${n} – the clip matches its look (grade, light, texture), never its people, places or objects`
                  : 'Not sent: no place left among the reference images'
              }
              className={`relative h-12 w-16 overflow-hidden rounded ring-1 ${KIND_TONE.director.ring} ${n ? '' : 'opacity-35'}`}
            >
              <img src={mediaUrl(path)} alt="" draggable={false} className="h-full w-full object-cover" />
              <span
                className={`absolute left-0.5 top-0.5 rounded px-0.5 text-[9px] leading-[13px] ${
                  n ? 'bg-black/70 text-indigo-200' : 'bg-black/80 text-accent'
                }`}
              >
                {n ? `@Image${n}` : 'not sent'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The director's style videos under the form's reference videos, as StyleFramesFromDirector. */
export function StyleVideosFromDirector({ sent, director, onOpen }: Props) {
  const videos = director.styleVideos
  if (!videos.length) return null
  const limits = referenceVideoLimits(sent.model)
  const numbers = places(
    videos.map((v) => v.path),
    referenceVideosOf(sent).map((v) => v.path),
    limits?.maxVideos ?? 0
  )
  return (
    <div className="mt-2">
      <Heading name={director.name} what={videos.length === 1 ? 'Style video' : 'Style videos'} onOpen={onOpen} />
      <div className="flex flex-wrap gap-1.5">
        {videos.map((v, i) => {
          const n = numbers[i]
          return (
            <div
              key={v.path}
              title={
                n
                  ? `@Video${n} – the clip follows its camera movement only, not its people or places`
                  : limits
                    ? `Not sent: ${limits.family} takes no more reference videos (count or seconds)`
                    : 'Not sent: the model takes no reference videos'
              }
              className={`relative aspect-video w-20 overflow-hidden rounded bg-raised ring-1 ${KIND_TONE.director.ring} ${n ? '' : 'opacity-35'}`}
            >
              <VideoWindowPreview path={v.path} start={v.start ?? 0} length={v.length ?? 5} playing={false} />
              <span
                className={`absolute left-0.5 top-0.5 rounded px-0.5 text-[9px] leading-[13px] ${
                  n ? `bg-black/70 ${VIDEO_TONE.text}` : 'bg-black/80 text-accent'
                }`}
              >
                {n ? `@Video${n}` : 'not sent'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
