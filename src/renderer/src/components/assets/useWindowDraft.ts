import { useCallback, useEffect, useRef, useState } from 'react'
import type { Asset, AssetAudio } from '@shared/types'
import { assetAudio } from '../../lib/assets'
import { ipcErrorMessage } from '../../lib/hooks'
import { sameWindow, windowOf, type ClipWindow } from './audioUtils'

// Keyboard nudges come in bursts; save once they pause.
const SAVE_DELAY_MS = 450
// How long main's answer stands in for the clip when the asset handed down hasn't caught up with it.
const CATCH_UP_MS = 3000

export interface WindowDraft {
  /** What to show: the edit under way, else what main answered last, else the clip's stored window. */
  value: ClipWindow
  /** A drag started: outside changes wait until it ends. */
  begin: () => void
  /** Shows the window while dragging, without saving. */
  preview: (w: ClipWindow) => void
  /** A drag ended without changing anything (a click). */
  end: () => void
  /** Sets the window and saves it, at once or after a short pause (keyboard nudges). */
  change: (w: ClipWindow, when: 'now' | 'soon') => void
  /** A change is waiting to be saved or being saved, or a drag is under way. */
  busy: boolean
  saving: boolean
  /** Why the last save failed (the stored window is shown again). */
  error?: string
}

/**
 * Local edits of one clip's reference window, saved through updateAssetAudio. Main clamps what it stores and
 * answers with the asset, which goes up through onUpdated; until the clip handed down reflects it, the answer
 * is shown, so the window doesn't flick back. A change made elsewhere (an agent's update_asset_audio) is taken
 * in whenever no edit of ours is under way. Mount one per clip; a pending save is sent when it unmounts.
 */
export function useWindowDraft(clip: AssetAudio, onUpdated: (a: Asset) => void): WindowDraft {
  const stored = windowOf(clip)
  const [draft, setDraftState] = useState<ClipWindow>()
  const [saving, setSaving] = useState(0)
  const [scheduled, setScheduled] = useState(false)
  const [dragging, setDraggingState] = useState(false)
  const [error, setError] = useState<string>()

  const draftRef = useRef<ClipWindow | undefined>(undefined)
  const draggingRef = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seq = useRef(0)
  const onUpdatedRef = useRef(onUpdated)
  useEffect(() => {
    onUpdatedRef.current = onUpdated
  })

  const setDraft = (w: ClipWindow | undefined) => {
    draftRef.current = w
    setDraftState(w)
  }
  const setDragging = (on: boolean) => {
    draggingRef.current = on
    setDraggingState(on)
  }

  const send = useCallback(
    (w: ClipWindow) => {
      clearTimeout(timer.current)
      timer.current = undefined
      setScheduled(false)
      const id = ++seq.current
      setSaving((n) => n + 1)
      window.studio.updateAssetAudio(clip.id, { clipStart: w.start, clipLength: w.length }).then(
        (asset) => {
          setSaving((n) => n - 1)
          onUpdatedRef.current(asset)
          // A newer edit (or a drag that has moved on) owns the draft.
          if (id !== seq.current || draftRef.current !== w) return
          const saved = assetAudio(asset).find((c) => c.id === clip.id)
          setDraft(saved ? windowOf(saved) : w)
          setError(undefined)
        },
        (e: unknown) => {
          setSaving((n) => n - 1)
          if (id !== seq.current) return
          if (draftRef.current === w) setDraft(undefined)
          setError(ipcErrorMessage(e))
        }
      )
    },
    [clip.id]
  )

  const begin = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    setScheduled(false)
    setDragging(true)
  }, [])

  const preview = useCallback((w: ClipWindow) => setDraft(w), [])

  const end = useCallback(() => setDragging(false), [])

  const change = useCallback(
    (w: ClipWindow, when: 'now' | 'soon') => {
      setDraft(w)
      setDragging(false)
      setError(undefined)
      if (when === 'now') {
        send(w)
        return
      }
      clearTimeout(timer.current)
      setScheduled(true)
      timer.current = setTimeout(() => {
        timer.current = undefined
        if (draftRef.current) send(draftRef.current)
      }, SAVE_DELAY_MS)
    },
    [send]
  )

  const busy = saving > 0 || scheduled || dragging

  // The stored window changed: our own save has landed, or someone else changed it. Either way it is the
  // truth now, unless an edit of ours is still on its way.
  useEffect(() => {
    if (!busy) setDraft(undefined)
  }, [stored.start, stored.length])

  // Main answered but the asset handed down never caught up (or answered with what was already stored).
  useEffect(() => {
    if (busy || !draft) return
    const t = setTimeout(() => setDraft(undefined), CATCH_UP_MS)
    return () => clearTimeout(t)
  }, [busy, draft])

  // Leaving the asset must not lose a nudge that was about to be saved, nor a drag cut short.
  const sendRef = useRef(send)
  const storedRef = useRef(stored)
  useEffect(() => {
    sendRef.current = send
    storedRef.current = stored
  })
  useEffect(
    () => () => {
      const w = draftRef.current
      if (w && (timer.current || draggingRef.current) && !sameWindow(w, storedRef.current)) {
        clearTimeout(timer.current)
        sendRef.current(w)
      }
    },
    []
  )

  return { value: draft ?? stored, begin, preview, end, change, busy, saving: saving > 0, error }
}
