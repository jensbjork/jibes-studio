import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { workKey, type EditRange, type VideoModel } from '@shared/types'
import { ipcErrorMessage, useAudioCatalog, useSeparationStatus } from '../../lib/hooks'
import type { Navigate } from '../../lib/navigation'
import { markSeen } from '../../lib/work'
import { useReportOpenEdit } from '../../lib/workspace'
import ConsentDialog from '../ConsentDialog'
import { Banner, ConfirmDialog } from '../storyboards/ui'
import ActionsPanel from './ActionsPanel'
import EditHeader from './EditHeader'
import { EditorContext, type EditorContextValue, type EditorTab } from './EditorContext'
import { clampRange, fileName, formatPrice, markedIn, markedOut, newestChild, priceText } from './editorUtils'
import { focusedWithKeyboard, trackFocusOrigin } from './focusOrigin'
import { PlayerController } from './playerController'
import Player from './Player'
import Timeline from './Timeline'
import { useEdit, useTimeline, useTranscript } from './useEdit'
import { useRunner, type PendingConfirm } from './useEditOps'
import VersionsPanel from './VersionsPanel'

// One edit open: the header, the player and the timeline on the left, Åtgärder above Versioner on the right.
// Operations work on the current version; the player can show another one beside it (Jämför ⇄). Keys: space, J/K/L,
// ← → (frames, with ⇧ seconds), I/O, Esc, ⌘Z/⌘⇧Z.

interface Notice {
  tone: 'error' | 'success'
  text: ReactNode
}

const TAB_KEY = 'editor:tab'

function loadTab(): EditorTab {
  try {
    const t = localStorage.getItem(TAB_KEY)
    return t === 'bild' || t === 'ljud' || t === 'rost' || t === 'musik' || t === 'text' ? t : 'bild'
  } catch {
    return 'bild'
  }
}

/** Show this version in the player once the edit has loaded ("Gå dit" in Pågår och klart, an agent's open_in_studio). */
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
  onBack: () => void
  /** The edit is gone (deleted here or elsewhere). */
  onClosed: (editId: string) => void
  showVersion?: ShowVersionRequest
}

export default function EditWorkspace({
  editId,
  models,
  modelsError,
  hasApiKey,
  navigate,
  onBack,
  onClosed,
  showVersion
}: Props) {
  const { edit, error, progress, refresh, setEdit } = useEdit(editId, onClosed)
  const player = useMemo(() => new PlayerController(), [])
  useEffect(() => () => player.destroy(), [player])
  const audio = useAudioCatalog()
  const separation = useSeparationStatus()
  const [notice, setNotice] = useState<Notice>()
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

  // Good news (sent, saved) goes away by itself; errors stay until dismissed.
  useEffect(() => {
    if (notice?.tone !== 'success') return
    const t = setTimeout(() => setNotice(undefined), 8000)
    return () => clearTimeout(t)
  }, [notice])

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
        setNotice({ tone: 'error', text: ipcErrorMessage(e) })
      }
    },
    [editId, setEdit]
  )
  const parentId = current?.parentId && edit?.versions.some((v) => v.id === current.parentId) ? current.parentId : undefined
  const redoTarget = edit && current ? newestChild(edit.versions, current.id) : undefined
  const undo = () => parentId && void setCurrent(parentId)
  const redo = () => redoTarget && void setCurrent(redoTarget.id)

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
      setNotice({ tone: 'error', text: ipcErrorMessage(e) })
    }
  }

  // ── Keyboard ──

  // The consent dialog has no aria-modal of its own, so open dialogs of this view are named here too.
  const dialogOpen = !!runner.confirm || !!runner.consent
  const keys = useRef({ undo, redo, selection, duration, dialogOpen })
  keys.current = { undo, redo, selection, duration, dialogOpen }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return
      // Space and Enter on a button reached with the keyboard (a version row, Använd, a tab) press that button. One
      // that only has focus because it was clicked leaves Space to the player, as before (see focusOrigin.ts: a key
      // press turns :focus-visible on, so it can't tell).
      if (
        (e.key === ' ' || e.key === 'Enter') &&
        target?.closest('button, [role="button"], [role="tab"], a[href]') &&
        focusedWithKeyboard(target)
      ) {
        return
      }
      const k = keys.current
      if (k.dialogOpen || document.querySelector('[aria-modal="true"], [role="alertdialog"]')) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) k.redo()
        else k.undo()
        return
      }
      if (mod || e.altKey) return
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
          {error ?? 'Laddar redigeringen…'}
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
    setNotice({
      tone: 'success',
      text: (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Skickad till {sent.where}.</span>
          <button
            type="button"
            onClick={() => navigate('sequences', { type: 'open-sequence', sequenceId: sent.sequenceId, segmentId: sent.segmentId })}
            className="rounded border border-emerald-400/40 px-2 py-0.5 font-medium hover:bg-emerald-400/10"
          >
            Öppna sekvensen
          </button>
        </span>
      )
    })

  const onSubtitlesSaved = (path: string) =>
    setNotice({
      tone: 'success',
      text: (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            Undertexterna sparades: <span className="font-mono">{fileName(path)}</span>
          </span>
          <button
            type="button"
            onClick={() => window.studio.revealFile(path)}
            className="rounded border border-emerald-400/40 px-2 py-0.5 font-medium hover:bg-emerald-400/10"
          >
            Visa i Finder
          </button>
        </span>
      )
    })

  const onError = (text: string) => setNotice({ tone: 'error', text })

  return (
    <EditorContext.Provider value={context}>
      <div className="flex h-full flex-col">
        <EditHeader
          edit={edit}
          current={current}
          hasTranscript={!!transcript?.segments.length}
          onBack={onBack}
          onRename={(name) => void rename(name)}
          onSent={onSent}
          onDeleted={() => onClosed(editId)}
          onError={onError}
          onChanged={() => void refresh()}
          onSubtitlesSaved={onSubtitlesSaved}
        />
        {notice && (
          <Banner tone={notice.tone} onDismiss={() => setNotice(undefined)}>
            {notice.text}
          </Banner>
        )}
        {error && (
          <Banner tone="error">
            Redigeringen kunde inte läsas in på nytt: {error}
          </Banner>
        )}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <Player
              current={current}
              other={other}
              comparing={comparing && !!other}
              onCompare={() => setComparing((c) => !c)}
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
          <aside className="flex w-[380px] shrink-0 flex-col border-l border-line @min-[83rem]/main:w-[440px]">
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
    ? 'Venice anger inget pris för det här i förväg. Det dras från ditt saldo hos Venice när det skickas.'
    : pending.check.partial
      ? `Det kostar minst ${price}. ${pending.priceNote ? `${pending.priceNote.replace(/\.$/, '')}.` : 'En del anger Venice inget pris för i förväg.'}`
      : `Det här kostar ${price}.`
  return (
    <ConfirmDialog
      title={`${pending.label}?`}
      confirmLabel={pending.check.expensive && price ? `Fortsätt · ${price}` : 'Fortsätt'}
      onConfirm={() => onAnswer(true)}
      onCancel={() => onAnswer(false)}
    >
      {text} Fortsätt?
    </ConfirmDialog>
  )
}
