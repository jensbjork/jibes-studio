import { useMemo, useState } from 'react'
import { MAX_STYLE_VIDEOS } from '@shared/direction'
import {
  DEFAULT_MODEL,
  MIN_VIDEO_CLIP_SECONDS,
  referenceVideoLimits,
  type ReferenceVideoLimits
} from '@shared/models'
import type { ReferenceVideo } from '@shared/types'
import { moveItem } from '../pickers/reorder'
import ReferenceVideos, { type VideoRowWording } from '../pickers/ReferenceVideos'
import { useVideoFacts, videoFactsNow } from '../pickers/videoFacts'
import { formVideos, videoFits, videosKey, withVideoWindow } from '../pickers/videoRefs'

const STYLE_WORDING: VideoRowWording = {
  title: 'Style videos',
  badge: (n) => `Style ${n}`,
  addTitle: 'Add a video whose camera movement the clips follow',
  hint:
    'Hover a video to play the part that is sent – click it to choose the part. Clips follow their camera movement ' +
    'only, never their people or places.',
  empty:
    'Videos whose camera movement the clips follow – never their people or places. Sent after a clip’s own reference ' +
    'videos, to Seedance 2.x reference models, as many as the clip’s model still takes'
}

/**
 * What a director's style videos keep to: up to MAX_STYLE_VIDEOS, each a window of 2–15 s – Seedance 2.0's per-video
 * limit, so every window fits both families (main fits them the same way) – and Seedance 2.5's 30 s together. A clip
 * sends as many as its own model's family still takes after its own reference videos.
 */
export function styleVideoLimits(): ReferenceVideoLimits {
  const base = referenceVideoLimits(DEFAULT_MODEL['reference-to-video'])
  return {
    family: 'Seedance 2.x',
    maxVideos: MAX_STYLE_VIDEOS,
    minSeconds: MIN_VIDEO_CLIP_SECONDS,
    maxSeconds: 15,
    maxTotalSeconds: base?.maxTotalSeconds ?? 30
  }
}

interface Props {
  videos: ReferenceVideo[]
  /** Copies files (from disk, Media, a take or a film) into the director's folder, each with its window. */
  onAdd: (paths: string[]) => void
  /** The videos in another order, with another window or without one. */
  onChange: (videos: ReferenceVideo[]) => void
}

const LIMITS = styleVideoLimits()

/**
 * A director's style videos, as the form's reference videos look (tiles that play their window on hover, a click
 * for the window, drag to reorder), added from a file, Media, a take or a film: main copies each into the director's
 * folder.
 */
export default function StyleVideos({ videos: refs, onAdd, onChange }: Props) {
  const limits = LIMITS
  const facts = useVideoFacts(refs.map((v) => v.path))
  const key = videosKey(refs)
  const videos = useMemo(() => formVideos(refs, facts, limits), [key, facts])
  const [note, setNote] = useState<string>()

  return (
    <ReferenceVideos
      wording={STYLE_WORDING}
      videos={videos}
      limits={limits}
      onAdd={(candidates) => onAdd(candidates.map((c) => c.path))}
      onRemove={(index) => onChange(refs.filter((_, i) => i !== index - 1))}
      onMove={(from, to) => onChange(moveItem(refs, from, to))}
      onWindow={(index, w) => onChange(withVideoWindow(refs, index, w))}
      fits={(path, duration) => videoFits(refs, { path, duration }, videoFactsNow(), limits)}
      note={note}
      onNote={setNote}
    />
  )
}
