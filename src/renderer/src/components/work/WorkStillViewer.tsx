import { useEffect, useState } from 'react'
import type { Still } from '@shared/types'
import { showWorkStill, useShownWorkStill } from '../../lib/work'
import StillViewer from '../images/StillViewer'

/**
 * A picture Activity opens on its own: one made for a sequence as a whole, or for nothing, which no board or
 * clip shows. The viewer's own rule marks it seen once it has been on screen a moment.
 */
export default function WorkStillViewer() {
  const shown = useShownWorkStill()
  const [still, setStill] = useState<Still>()
  const stillId = shown?.stillId
  useEffect(() => {
    setStill(undefined)
    if (!stillId) return
    let alive = true
    // Every still, not only the sequence's: the picture is found wherever it is now.
    window.studio.listStills().then(
      (list) => {
        if (!alive) return
        const found = list.find((s) => s.id === stillId)
        if (found) setStill(found)
        else showWorkStill(undefined)
      },
      () => {
        if (alive) showWorkStill(undefined)
      }
    )
    return () => {
      alive = false
    }
  }, [stillId])
  if (!still || still.id !== stillId) return null
  return <StillViewer still={still} onClose={() => showWorkStill(undefined)} />
}
