import { useState } from 'react'
import type { DirectorEntry } from '../../lib/directors'
import { mediaUrl } from '../../lib/media'
import AssetIcon from '../assets/AssetIcon'

/**
 * A director's picture: its first style frame (the cover), else a clapperboard on the directors' colour – a
 * ready-made one always (it has no style frames).
 */
export default function DirectorAvatar({ entry, className }: { entry: DirectorEntry; className: string }) {
  const cover = entry.asset?.images[0]
  const [failedPath, setFailedPath] = useState<string>()
  if (cover && failedPath !== cover.path) {
    return (
      <img
        src={mediaUrl(cover.path)}
        alt=""
        draggable={false}
        decoding="async"
        onError={() => setFailedPath(cover.path)}
        className={`${className} shrink-0 bg-raised object-cover`}
      />
    )
  }
  return (
    <div
      aria-hidden
      className={`${className} flex shrink-0 items-center justify-center ${
        entry.preset ? 'bg-indigo-400/10 text-indigo-300' : 'bg-raised text-muted'
      }`}
    >
      <AssetIcon kind="director" size="45%" />
    </div>
  )
}
