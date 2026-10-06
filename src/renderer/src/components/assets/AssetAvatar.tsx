import { useState } from 'react'
import type { Asset } from '@shared/types'
import { mediaUrl } from '../../lib/media'

/** The cover image (first image), or the initial when there is none or it can't be loaded. */
export default function AssetAvatar({ asset, className }: { asset: Asset; className: string }) {
  const cover = asset.images[0]
  const [failedPath, setFailedPath] = useState<string>()

  if (cover && failedPath !== cover.path) {
    return (
      <img
        src={mediaUrl(cover.path)}
        draggable={false}
        decoding="async"
        onError={() => setFailedPath(cover.path)}
        className={`${className} shrink-0 bg-raised object-cover`}
      />
    )
  }
  return (
    <div className={`${className} flex shrink-0 items-center justify-center bg-raised font-semibold text-muted`}>
      {asset.name.trim().charAt(0).toUpperCase() || '?'}
    </div>
  )
}
