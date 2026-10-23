import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { workKey, type EditRange, type VideoModel } from '@shared/types'
import { isModalOpen } from '../../lib/dialogs'
import { focusedWithKeyboard, trackFocusOrigin } from '../../lib/focusOrigin'
import { ipcErrorMessage, useAudioCatalog, useSeparationStatus } from '../../lib/hooks'
import type { Navigate } from '../../lib/navigation'
import { isMac, isModKey } from '../../lib/platform'
import { markSeen } from '../../lib/work'
import { useReportOpenEdit } from '../../lib/workspace'
import ConsentDialog from '../ConsentDialog'
import { ConfirmDialog } from '../storyboards/ui'
import { Banner } from '../ui/Banner'
import ActionsPanel from './ActionsPanel'
import EditHeader from './EditHeader'
import { EditorContext, type EditorContextValue, type EditorTab } from './EditorContext'
import { clampRange, formatPrice, markedIn, markedOut, newestChild, priceText } from './editorUtils'
import { PlayerController } from './playerController'
import Player from './Player'
import Timeline from './Timeline'
import { useEdit, useTimeline, useTranscript } from './useEdit'
import { useRunner, type PendingConfirm } from './useEditOps'
import VersionsPanel from './VersionsPanel'

// One edit open, beside the Editor's list: the header, the player and the timeline, and Actions above Versions on the
// right. Operations work on the current version; the player can show another one beside it (Compare ⇄). Keys: space,
// J/K/L, ← → (frames, with ⇧ seconds), I/O, Esc, ⌘Z/⌘⇧Z (Ctrl+Z, Ctrl+Y on Windows). Its notices (sent, an error)
// float at the bottom of the Editor, where the view shows them all (onNotice).

/** A notice from the open edit, for the view to show. */
export interface EditorNotice {
  tone: 'error' | 'success'
  text: ReactNode
}

const TAB_KEY = 'editor:tab'

function loadTab(): EditorTab {
  try {
    const t = localStorage.getItem(TAB_KEY)
    // Music & effects was a tab of its own; its cards are under Sound now.
    if (t === 'musik') return 'ljud'
    return t === 'bild' || t === 'ljud' || t === 'rost' || t === 'text' ? t : 'bild'
  } catch {
    return 'bild'
  }
}

/** Show this version in the player once the edit has loaded ("Go there" in Activity, an agent's open_in_studio). */
export interface ShowVersionRequest {
  versionId: string
  /** An agent asked: showing it isn't the user choosing it, so it isn't marked seen (playing it still is). */
  byAgent: boolean
}

interface Props {
  editId: string
  models: VideoModel[]
  modelsError?: string
  hasApiKey: boolean
  navigate: Navigate
  /** "All edits" in the header: the overview in place of this edit. */
  onShowAll: () => void
  /** Delete… in the header's ⋯, after its question. */
  onDelete: () => Promise<void>
  /** The edit is gone (deleted elsewhere, or a remembered one from before). */
  onClosed: (editId: string) => void
  onNotice: (notice: EditorNotice) => void
  showVersion?: ShowVersionRequest
}

export default function EditWorkspace({
  editId,
  models,
  modelsError,
  hasApiKey,
  navigate,
  onShowAll,
  onDelete,
  onClosed,
  onNotice,
  showVersion
}: Props) {
  const { edit, error, progress, refresh, setEdit } = useEdit(editId, onClosed)
  const player = useMemo(() => new PlayerController(), [])
  useEffect(() => () => player.destroy(), [player])
  const audio = useAudioCatalog()
  const separation = useSeparationStatus()
  const [tab, setTabState] = useState<EditorTab>(loadTab)
  const [selection, setSelectionState] = useState<EditRange>()
  const [opRange, setOpRange] = useState<EditRange>()
  const [compareId, setCompareId] = useState<string>()
  const [comparing, setComparing] = useState(false)

  const current = edit?.versions.find((v) => v.current) ?? edit?.versions.find((v) => v.id === edit.currentId) ?? edit?.versions.at(-1)
  const currentId = current?.id
  const other = useMemo(() => {
    if (!edit || !current) return undefined
    const picked = compareId && compareId !== current.id ? edit.versions.find((v) => v.id === compareId) : undefined
    // The parent; for the original (after ⌘Z back to v1, say) the newest version made from it, else the newest other.
    return (
      picked ??
      edit.versions.find((v) => v.id === current.parentId) ??
      newestChild(edit.versions, current.id) ??
      [...edit.versions].sort((a, b) => b.number - a.number).find((v) => v.id !== current.id)
    )
  }, [edit, current, compareId])
  const shownId = comparing && other ? other.id : currentId
  useReportOpenEdit(editId, shownId)

  const { timeline, loading: timelineLoading, error: timelineError } = useTimeline(currentId)
  const { transcript, setTranscript } = useTranscript(currentId, edit?.updatedAt)
  // The timeline knows the exact length; until it has loaded for this version, the generation's probed length.
  const ownTimeline = timeline && timeline.generationId === currentId ? timeline : undefined
  const duration = ownTimeline?.duration ?? current?.generation.videoDuration ?? timeline?.duration ?? 0
  const fps = ownTimeline?.fps || timeline?.fps || 30
  const runner = useRunner(editId, currentId)

  useEffect(() => {
    player.duration = duration
    player.fps = fps
  }, [player, duration, fps])

  const setTab = useCallback((t: EditorTab) => {
    setTabState(t)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      // Remembering the tab is only a convenience.
    }
  }, [])

  const setSelection = useCallback((range: EditRange | undefined) => setSelectionState(range), [])
  const onError = (text: string) => onNotice({ tone: 'error', text })

  // A new current version: comparing starts over (against its parent), and a marking stays only while the film
  // keeps its length (a cut or an extension moves everything after it).
  const lastDuration = useRef<number>(undefined)
  useEffect(() => {
    setComparing(false)
    setCompareId(undefined)
  }, [currentId])
  useEffect(() => {
    if (!duration) return
    const before = lastDuration.current
    lastDuration.current = duration
    if (before !== undefined && Math.abs(before - duration) > 0.05) setSelectionState(undefined)
    else setSelectionState((s) => clampRange(s, duration))
  }, [duration])

  // ── Versions ──

  const setCurrent = useCallback(
    async (versionId: string) => {
      try {
        setEdit(await window.studio.setCurrentVersion(editId, versionId))
      } catch (e) {
        onNotice({ tone: 'error', text: ipcErrorMessage(e) })
      }
    },
    [editId, setEdit, onNotice]
  )
  const parentId = current?.parentId && edit?.versions.some((v) => v.id === current.parentId) ? current.parentId : undefined
  const redoTarget = edit && current ? newestChild(edit.versions, current.id) : undefined
  const undo = () => parentId && void setCurrent(parentId)
  const redo = () => redoTarget && void setCurrent(redoTarget.id)
  // Making a version the one operations work on is choosing it on purpose: it is seen from then on (as Use under
  // Versions).
  const chooseVersion = (versionId: string) => {
    markSeen([workKey.generation(versionId)])
    void setCurrent(versionId)
  }

  const show = (versionId: string) => {
    if (versionId === currentId) setComparing(false)
    else {
      setCompareId(versionId)
      setComparing(true)
    }
  }

  // A version asked for from elsewhere goes into the player once the edit is here; opened by the user, that is
  // choosing it on purpose, so it counts as seen.
  const shownRequest = useRef<ShowVersionRequest>(undefined)
  useEffect(() => {
    if (!showVersion || !edit || shownRequest.current === showVersion) return
    if (!edit.versions.some((v) => v.id === showVersion.versionId)) return
    // The current version only settles with the edit; showing before that would compare against nothing.
    if (!currentId) return
    shownRequest.current = showVersion
    show(showVersion.versionId)
    if (!showVersion.byAgent) markSeen([workKey.generation(showVersion.versionId)])
  }, [showVersion, edit, currentId])

  const rename = async (name: string) => {
    try {
      setEdit(await window.studio.renameEdit(editId, name))
    } catch (e) {
      onError(ipcErrorMessage(e))
    }
  }

  // ── Keyboard ──

  const keys = useRef({ undo, redo, selection, duration })
  keys.current = { undo, redo, selection, duration }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return
      // Space and Enter on a button reached with the keyboard (a version row, Use, a tab) press that button. One
      // that only has focus because it was clicked leaves Space to the player, as before (see focusOrigin.ts: a key
      // press turns :focus-visible on, so it can't tell).
      if (
        (e.key === ' ' || e.key === 'Enter') &&
        target?.closest('button, [role="button"], [role="tab"], a[href]') &&
        focusedWithKeyboard(target)
      ) {
        return
      }
      // A dialog over the view (the price question, consent, a picker) has the keys.
      if (isModalOpen()) return
      const k = keys.current
      if (isModKey(e) && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) k.redo()
        else k.undo()
        return
      }
      // Ctrl+Y is redo on Windows too (Ctrl+Shift+Z above works as well).
      if (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        k.redo()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key.toLowerCase()) {
        case ' ':
          e.preventDefault()
          player.toggle()
          break
        case 'j':
        case 'k':
        case 'l':
          e.preventDefault()
          player.shuttle(e.key.toLowerCase() as 'j' | 'k' | 'l')
          break
        case 'arrowleft':
        case 'arrowright': {
          e.preventDefault()
          const dir = e.key === 'ArrowLeft' ? -1 : 1
          if (e.shiftKey) player.stepSeconds(dir)
          else player.stepFrames(dir)
          break
        }
        case 'i':
          e.preventDefault()
          setSelectionState(markedIn(player.markInTime(), k.selection, k.duration))
          break
        case 'o':
          e.preventDefault()
          setSelectionState(markedOut(player.markOutTime(), k.selection))
          break
        case 'escape':
          if (k.selection) {
            e.preventDefault()
            setSelectionState(undefined)
          }
          break
      }
    }
    trackFocusOrigin()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [player])

  // ── Render ──

  if (!edit || !current) {
    return (
      <div className="flex h-full flex-col">
        <div className="drag h-12 shrink-0 border-b border-line" />
        <div className="flex flex-1 items-center justify-center text-muted">
          {error ?? 'Loading the edit…'}
        </div>
      </div>
    )
  }

  const context: EditorContextValue = {
    edit,
    current,
    timeline: ownTimeline,
    transcript,
    setTranscript,
    duration,
    fps,
    selection,
    setSelection,
    player,
    audio,
    separation,
    models,
    modelsError,
    hasApiKey,
    runner,
    setOpRange,
    showTab: setTab,
    navigate
  }

  const onSent = (sent: { sequenceId: string; segmentId: string; where: string }) =>
    onNotice({
      tone: 'success',
      text: (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Sent to {sent.where}.</span>
          <button
            type="button"
            onClick={() => navigate('sequences', { type: 'open-sequence', sequenceId: sent.sequenceId, segmentId: sent.segmentId })}
            className="rounded border border-emerald-400/40 px-2 py-0.5 font-medium hover:bg-emerald-400/10"
          >
            Open the sequence
          </button>
        </span>
      )
    })

  return (
    <EditorContext.Provider value={context}>
      <div className="flex h-full flex-col">
        <EditHeader
          edit={edit}
          current={current}
          onShowAll={onShowAll}
          onRename={(name) => void rename(name)}
          onSent={onSent}
          onDelete={onDelete}
          onError={onError}
          onChanged={() => void refresh()}
        />
        {/* The state of the edit, not a passing notice: it stays under the header. */}
        {error && (
          <Banner tone="error">
            The edit couldn’t be reloaded: {error}
          </Banner>
        )}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <Player
              current={current}
              other={other}
              comparing={comparing && !!other}
              onCompare={() => setComparing((c) => !c)}
              onUseOther={() => other && chooseVersion(other.id)}
              canUndo={!!parentId}
              canRedo={!!redoTarget}
              onUndo={undo}
              onRedo={redo}
            />
            <Timeline
              timeline={ownTimeline}
              loading={timelineLoading}
              error={timelineError}
              opRange={opRange}
            />
          </div>
          {/* Narrower in a narrow window, where the Editor's list beside it leaves the player little room. */}
          <aside className="flex w-[320px] shrink-0 flex-col border-l border-line @min-[61rem]/main:w-[380px] @min-[83rem]/main:w-[440px]">
            <ActionsPanel tab={tab} onTab={setTab} />
            <VersionsPanel
              edit={edit}
              current={current}
              shownId={comparing ? other?.id : undefined}
              progress={progress}
              runner={runner}
              onShow={show}
              onSetCurrent={(id) => void setCurrent(id)}
              onSent={onSent}
              onError={onError}
              onChanged={() => void refresh()}
            />
          </aside>
        </div>
      </div>
      {runner.confirm && <PriceConfirm pending={runner.confirm} onAnswer={runner.answerConfirm} />}
      {runner.consent && (
        <ConsentDialog
          request={runner.consent.request}
          cost={`${runner.consent.run.label}${
            runner.consent.run.plan?.paid
              ? ` · ${priceText(runner.consent.run.plan.priceUsd, { partial: runner.consent.run.plan.partialPrice })}`
              : ''
          }`}
          onAccept={() => runner.answerConsent(true)}
          onCancel={() => runner.answerConsent(false)}
        />
      )}
    </EditorContext.Provider>
  )
}

/** The extra question before a paid click whose price is above $5, unknown, or leaves a part out (D5). */
function PriceConfirm({ pending, onAnswer }: { pending: PendingConfirm; onAnswer: (yes: boolean) => void }) {
  const price = pending.priceUsd !== undefined ? formatPrice(pending.priceUsd) : undefined
  const text = pending.check.unknown
    ? 'Venice gives no price for this in advance. It’s charged to your Venice balance when it’s sent.'
    : pending.check.partial
      ? `It costs at least ${price}. ${pending.priceNote ? `${pending.priceNote.replace(/\.$/, '')}.` : 'Venice gives no price in advance for part of it.'}`
      : `This costs ${price}.`
  return (
    <ConfirmDialog
      title={`${pending.label}?`}
      confirmLabel={pending.check.expensive && price ? `Continue · ${price}` : 'Continue'}
      onConfirm={() => onAnswer(true)}
      onCancel={() => onAnswer(false)}
    >
      {text} Continue?
    </ConfirmDialog>
  )
}
