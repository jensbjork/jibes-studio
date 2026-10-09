import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FinishedWork, RunningWork } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import type { Navigate } from '../../lib/navigation'
import { markSeen, useRunning, useUnseen } from '../../lib/work'

/** The export of one sequence or storyboard as its header and banners show it. */
export interface ExportStatus {
  /** 0–1 while the film is being made (also when the export was started elsewhere: an agent, before a view switch). */
  progress?: number
  /** The newest finished export the user hasn't acted on yet ("Filmen är klar"). */
  done?: FinishedWork
  /** Why the newest export failed, until the banner is closed. */
  failure?: string
  /** Starts an export (`start` resolves with the film's path); its outcome reaches the banners through the store. */
  run: (start: () => Promise<string>) => Promise<void>
  /** "Visa i Finder" on the done banner. */
  reveal: () => Promise<void>
  /** "Redigera" on the done banner: the film opened in Redigera. */
  edit: (navigate: Navigate) => void
  /** ✕ on the done banner. */
  dismissDone: () => void
  /** ✕ on the failure banner. */
  dismissFailure: () => void
}

/** Smoother progress than the store's (which is pushed at most once a second): main's own events, while mounted. */
const liveProgress = new Map<string, number>()
const liveListeners = new Set<() => void>()
let liveSubscribed = false

function subscribeLive(listener: () => void): () => void {
  if (!liveSubscribed) {
    liveSubscribed = true
    window.studio.onExportProgress((p) => {
      if (p.done) liveProgress.delete(p.sequenceId)
      else liveProgress.set(p.sequenceId, Math.max(liveProgress.get(p.sequenceId) ?? 0, p.progress))
      for (const l of liveListeners) l()
    })
  }
  liveListeners.add(listener)
  return () => {
    liveListeners.delete(listener)
  }
}

function useLiveProgress(ownerId: string | undefined): number | undefined {
  const [value, setValue] = useState(() => (ownerId ? liveProgress.get(ownerId) : undefined))
  useEffect(() => {
    if (!ownerId) return undefined
    setValue(liveProgress.get(ownerId))
    return subscribeLive(() => setValue(liveProgress.get(ownerId)))
  }, [ownerId])
  return value
}

/**
 * The export of a sequence or storyboard, from Pågår och klart's store: the bar while it runs and the banner when it
 * is done or failed survive leaving the view (and show an agent's export_film too). "Visa i Finder", "Redigera" and
 * ✕ on the done banner mark the export seen; a failure stays until its banner is closed.
 *
 * A refusal before anything started (no row in the store) is kept here, for this view, until it is closed.
 */
export function useExportStatus(ownerId: string | undefined): ExportStatus {
  const runningFilter = useCallback(
    (w: RunningWork) => w.kind === 'export' && !!ownerId && w.ownerId === ownerId,
    [ownerId]
  )
  const unseenFilter = useCallback(
    (w: FinishedWork) => !!ownerId && w.ownerId === ownerId && (w.kind === 'export' || w.failureOf === 'export'),
    [ownerId]
  )
  const running = useRunning(runningFilter)
  const unseen = useUnseen(unseenFilter)
  const live = useLiveProgress(ownerId)
  // Started here and not answered yet (the store hears of it a moment later), or refused before it began.
  const [local, setLocal] = useState<Record<string, { running: boolean; error?: string }>>({})

  const mine = ownerId ? local[ownerId] : undefined
  const storeRun = running[0]
  const exporting = !!storeRun || !!mine?.running
  const progress = exporting ? Math.max(storeRun?.progress ?? 0, live ?? 0) : undefined

  const finished = useMemo(
    () =>
      unseen
        .filter((w) => w.kind === 'export' && w.status === 'completed')
        .sort((a, b) => b.finishedAt - a.finishedAt),
    [unseen]
  )
  const failed = useMemo(
    () => unseen.filter((w) => w.failureOf === 'export' || (w.kind === 'export' && w.status === 'failed')),
    [unseen]
  )
  const storeFailure = [...failed].sort((a, b) => b.finishedAt - a.finishedAt)[0]
  // While it runs again, the last outcome is old news.
  const done = exporting ? undefined : finished[0]
  const failureText = exporting ? undefined : (storeFailure?.error ?? mine?.error)
  const failure =
    failureText && (failureText.startsWith('Exporten') ? failureText : `Exporten misslyckades: ${failureText}`)

  const run = useCallback(
    async (start: () => Promise<string>) => {
      if (!ownerId) return
      // A new export: whatever the last one came to has been looked at, in effect.
      const old = unseen.map((w) => w.key)
      if (old.length) markSeen(old)
      setLocal((m) => ({ ...m, [ownerId]: { running: true } }))
      try {
        await start()
        setLocal((m) => ({ ...m, [ownerId]: { running: false } }))
      } catch (e) {
        setLocal((m) => ({ ...m, [ownerId]: { running: false, error: ipcErrorMessage(e) } }))
      }
    },
    [ownerId, unseen]
  )

  const seeFinished = useCallback(() => {
    if (finished.length) markSeen(finished.map((w) => w.key))
  }, [finished])

  const reveal = useCallback(async () => {
    const item = finished[0]
    if (!item) return
    seeFinished()
    let path = item.mediaPath
    if (!path && item.exportId) {
      const exports = await window.studio.listExports().catch(() => [])
      path = exports.find((x) => x.id === item.exportId)?.path
    }
    if (path) await window.studio.revealFile(path)
  }, [finished, seeFinished])

  const edit = useCallback(
    (navigate: Navigate) => {
      const item = finished[0]
      if (!item?.exportId) return
      seeFinished()
      navigate('editor', { type: 'open-editor', exportId: item.exportId })
    },
    [finished, seeFinished]
  )

  const dismissFailure = useCallback(() => {
    if (failed.length) markSeen(failed.map((w) => w.key))
    if (ownerId) setLocal((m) => ({ ...m, [ownerId]: { running: !!m[ownerId]?.running } }))
  }, [failed, ownerId])

  return { progress, done, failure, run, reveal, edit, dismissDone: seeFinished, dismissFailure }
}
