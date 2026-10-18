import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { audioForModel, pickOption, PREFERRED, supportsEndImage } from '@shared/models'
import { workKey, type Generation, type Storyboard, type StoryboardTransition, type VideoModel } from '@shared/types'
import { variantsPrice } from '@shared/variants'
import { ipcErrorMessage } from '../../lib/hooks'
import { formatSeconds, formatUsd, mediaUrl } from '../../lib/media'
import { useVariantCount, withVariants } from '../../lib/variants'
import { markSeen } from '../../lib/work'
import VariantPicker from '../VariantPicker'
import { pauseOthers } from '../feed/playback'
import ConfirmButton from '../sequences/ConfirmButton'
import { ArrowRightIcon, CloseIcon } from '../sequences/icons'
import { useDraft, useRegisterFlush, type FlushRegistry } from '../sequences/useDraft'
import { useClipQuote } from '../sequences/useTotalQuote'
import TakeStrip, { type PickedBy } from '../takes/TakeStrip'
import { pendingPhase } from '../takes/takeText'
import { KEY_SELECT_DELAY, useTakeSelection } from '../takes/useTakeSelection'
import PromptField from '../prompt/PromptField'
import { Spinner } from '../work/StatusMark'
import {
  aspectValue,
  boardNumber,
  durationLabel,
  formatLength,
  formatTakeTime,
  isPending,
  madeFromOtherImages,
  playable,
  suggestPrompt,
  takeProgress,
  takeSeconds,
  transitionLabel,
  transitionProblems
} from './storyboardUtils'
import type { StoryboardStore } from './useStoryboard'
import { primaryButton } from './ui'

/** Width of the editor beside the boards. */
export const EDITOR_WIDTH = 400

/** Storyboards default to five seconds per clip; otherwise the app's usual preferences. */
const DURATIONS = ['5s', ...PREFERRED.durations]

/** What the editor changes of a transition (the rest of its params belong to main: the two board pictures). */
interface TransitionDraft {
  prompt: string
  duration: string
  resolution?: string
  audio?: boolean
  model: string
}

function draftOf(t: StoryboardTransition): TransitionDraft {
  const { prompt, duration, resolution, audio, model } = t.params
  return { prompt, duration, resolution, audio, model }
}

const select = 'w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted disabled:opacity-50'

interface Props {
  storyboard: Storyboard
  transition: StoryboardTransition
  models: VideoModel[]
  modelsError?: string
  store: StoryboardStore
  flushers: FlushRegistry
  /** A take is being sent to Venice. */
  submitting: boolean
  /** Why the last Generate failed. */
  error?: string
  onDismissError: () => void
  /** Sends `count` takes of the transition (the variants chosen beside the button). */
  onGenerate: (count: number) => void
  /** Makes the take the transition's (main's answer applied); rejects with main's refusal. */
  onCommitTake: (transitionId: string, takeId: string) => Promise<void>
  onDeleteTake: (take: Generation) => void
  /** "Edit take…": opens the take in the Editor. */
  onEditTake?: (take: Generation) => void
  /** A refusal to show above the storyboard (choosing a take failed). */
  onError: (message: string) => void
  onClose: () => void
}

/**
 * One transition in full, beside the boards: the two pictures it goes between, the take in use (or the one
 * being looked at) in a player with every take in a strip right under it – a click makes a take the one in use and
 * plays it –, "What happens?" with Suggest, length, resolution, sound and the model (only those that can end on a
 * picture), the price and Generate. Edits are saved by themselves; Generate saves first, so the take is made from
 * what is on screen.
 */
export default function TransitionEditor({
  storyboard,
  transition: t,
  models,
  modelsError,
  store,
  flushers,
  submitting,
  error,
  onDismissError,
  onGenerate,
  onCommitTake,
  onDeleteTake,
  onEditTake,
  onError,
  onClose
}: Props) {
  const { mutate } = store
  const transitionId = t.id
  const save = useCallback(
    (v: TransitionDraft) =>
      mutate(() =>
        window.studio.updateTransition(transitionId, {
          prompt: v.prompt,
          duration: v.duration,
          resolution: v.resolution,
          audio: v.audio,
          model: v.model
        })
      ),
    [mutate, transitionId]
  )
  const draft = useDraft<TransitionDraft>(draftOf(t), save, 600)
  useRegisterFlush(flushers, draft.flush)
  const value = draft.value
  const set = <K extends keyof TransitionDraft>(key: K, v: TransitionDraft[K]) =>
    draft.setValue((d) => ({ ...d, [key]: v }))

  // The negative prompt isn't part of the draft (only an agent sets one); it can be removed here.
  const [negativeError, setNegativeError] = useState<string>()
  const clearNegative = async () => {
    setNegativeError(undefined)
    try {
      await mutate(() => window.studio.updateTransition(transitionId, { negativePrompt: '' }))
    } catch (e) {
      setNegativeError(ipcErrorMessage(e))
    }
  }

  const from = storyboard.boards.find((b) => b.id === t.fromBoardId)
  const to = storyboard.boards.find((b) => b.id === t.toBoardId)
  const fromNumber = boardNumber(storyboard, t.fromBoardId)
  const toNumber = boardNumber(storyboard, t.toBoardId)

  // ── Model and options ──────────────────────────────────────────────────────

  // Only image-to-video models that take an end image can go from one picture to the next (main checks the same).
  const endModels = useMemo(
    () =>
      models
        .filter((m) => m.kind === 'image-to-video' && supportsEndImage(m.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [models]
  )
  const model = models.find((m) => m.id === value.model)

  const chooseModel = (id: string) => {
    const next = models.find((m) => m.id === id)
    draft.setValue((d) => ({
      ...d,
      model: id,
      ...(next
        ? {
            duration: pickOption(next.durations, d.duration, DURATIONS) ?? d.duration,
            resolution: pickOption(next.resolutions, d.resolution, PREFERRED.resolutions),
            audio: audioForModel(next, d.audio)
          }
        : {})
    }))
  }

  // ── Price and what stands in the way ───────────────────────────────────────

  const params = { ...t.params, ...value }
  const problems = transitionProblems(storyboard, t, value.prompt)
  if (model?.offline) problems.push('The model is offline – choose another')
  const blocked = problems[0]
  const quote = useClipQuote(t.ready ? params : undefined)
  // ×1–×4 beside Generate (⌘+Enter in the prompt sends as many): each variant becomes a take of the transition.
  const [count, setCount] = useVariantCount('transition')

  // ── "Suggest" ──────────────────────────────────────────────────────────────

  const suggestion = suggestPrompt(from?.note, to?.note)
  const promptId = useId()

  // ── The take in use, and the one in the player ─────────────────────────────

  // Optimistic: a click or an arrow moves the ring at once; main hears of the keyboard's choice once it rests.
  const selection = useTakeSelection(t.id, t.selectedGenerationId, onCommitTake)
  const active = t.takes.find((g) => g.id === selection.activeId)
  const ready = active && playable(active) ? active : undefined
  // A take shown without being chosen (⌥-click, the menu, ⌥← / ⌥→).
  const [previewId, setPreviewId] = useState<string>()
  const preview = previewId ? t.takes.find((g) => g.id === previewId && playable(g)) : undefined
  // Without a usable chosen take, the newest finished one is shown (not chosen) so there is something to look at.
  const viewing = preview ?? ready ?? t.takes.find((g) => playable(g))
  // Looking at another take is only for a while: a new choice (here, by main or by an agent) shows the chosen one.
  useEffect(() => setPreviewId(undefined), [t.selectedGenerationId])
  const pending = t.takes.find(isPending)
  // The newest take made from the pictures the boards hold now, for a selected take made from earlier ones.
  const currentTake = t.staleTake ? t.takes.find((g) => playable(g) && !madeFromOtherImages(g, t)) : undefined

  // ── Playing: a click on a take plays it from the start, with sound ──────────

  const video = useRef<HTMLVideoElement>(null)
  const [playRequest, setPlayRequest] = useState<{ id: string; n: number }>()
  const playCount = useRef(0)
  const pendingPlay = useRef(false)
  const requestPlay = (id: string) => setPlayRequest({ id, n: ++playCount.current })
  const playFromStart = useCallback(() => {
    const el = video.current
    if (!el) return
    if (el.readyState < 1) {
      pendingPlay.current = true
      return
    }
    el.currentTime = 0
    void el.play().catch(() => undefined)
  }, [])
  const handledPlay = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!playRequest || playRequest.id !== viewing?.id || handledPlay.current === playRequest.n) return
    handledPlay.current = playRequest.n
    playFromStart()
  }, [playRequest, viewing?.id, playFromStart])

  const chooseTake = (take: Generation, by: PickedBy) => {
    setPreviewId(undefined)
    if (take.id === selection.activeId) {
      if (by === 'click') requestPlay(take.id)
      return
    }
    selection.choose(take.id, by === 'click' ? 0 : KEY_SELECT_DELAY).then(
      () => {
        if (by === 'click') requestPlay(take.id)
      },
      (e: unknown) => onError(ipcErrorMessage(e))
    )
  }

  const previewTake = (take: Generation, by: PickedBy) => {
    if (take.id === selection.activeId) {
      setPreviewId(undefined)
      return
    }
    setPreviewId(take.id)
    if (by === 'click') requestPlay(take.id)
  }

  /** "Use this take" (under the player, or in the banner about earlier pictures): choosing on purpose, without replaying. */
  const chooseShown = (take: Generation) => {
    setPreviewId(undefined)
    markSeen([workKey.generation(take.id)])
    selection.choose(take.id, 0).catch((e: unknown) => onError(ipcErrorMessage(e)))
  }

  const aspect = aspectValue(storyboard.aspectRatio)

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(e) => {
        const inField = (e.target as HTMLElement).closest('textarea, input, select')
        if (e.key === 'Escape' && !e.defaultPrevented && !inField) {
          e.preventDefault()
          // A preview goes first: Esc shows the chosen take again, the next one closes the editor.
          if (preview) setPreviewId(undefined)
          else onClose()
        }
      }}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
        <h2 className="font-medium">{transitionLabel(storyboard, t)}</h2>
        <span className="text-[12px] text-muted">
          board {fromNumber} → {toNumber}
        </span>
        <span className="ml-auto text-[11px] text-muted" aria-live="polite">
          {draft.error ? (
            <span className="text-accent" title={draft.error}>
              Couldn’t save
            </span>
          ) : draft.status !== 'idle' ? (
            'Saving…'
          ) : (
            ''
          )}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-raised hover:text-text"
        >
          <CloseIcon size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {/* From one picture to the next. */}
        <div className="flex items-center gap-2">
          <BoardThumb path={from?.imagePath} label={`Board ${fromNumber}`} aspect={aspect} />
          <ArrowRightIcon size={14} className="shrink-0 text-muted" />
          <BoardThumb path={to?.imagePath} label={`Board ${toNumber}`} aspect={aspect} />
        </div>

        {/* The take in use, or the one being previewed. */}
        <section>
          <div className="overflow-hidden rounded-lg bg-black" style={{ aspectRatio: aspect }}>
            {viewing?.filePath ? (
              <video
                key={viewing.id}
                ref={video}
                src={mediaUrl(viewing.filePath)}
                poster={viewing.thumbPath ? mediaUrl(viewing.thumbPath) : undefined}
                controls
                preload="metadata"
                onLoadedMetadata={(e) => {
                  if (!pendingPlay.current) return
                  pendingPlay.current = false
                  void e.currentTarget.play().catch(() => undefined)
                }}
                onPlay={(e) => pauseOthers(e.currentTarget)}
                className="h-full w-full object-contain"
              />
            ) : pending ? (
              <PendingView take={pending} />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-[12px] leading-relaxed text-muted">
                {t.ready
                  ? 'No clip yet. Write what happens and generate.'
                  : 'Add an image to both boards, and the clip between them can be generated.'}
              </div>
            )}
          </div>
          {viewing && (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] text-muted">
              {viewing.id === selection.activeId ? (
                <span>Selected clip · {formatLength(takeSeconds(viewing))}</span>
              ) : (
                <>
                  <span>Take from {formatTakeTime(viewing.createdAt)} – not selected</span>
                  <span aria-hidden>·</span>
                  <button
                    type="button"
                    onClick={() => chooseShown(viewing)}
                    className="rounded px-1 py-0.5 text-text transition hover:bg-raised"
                  >
                    Use this take
                  </button>
                  {preview && ready && (
                    <>
                      <span aria-hidden>·</span>
                      <button
                        type="button"
                        onClick={() => setPreviewId(undefined)}
                        title="Back to the selected take (Esc)"
                        className="rounded px-1 py-0.5 text-text transition hover:bg-raised"
                      >
                        Show selected
                      </button>
                    </>
                  )}
                </>
              )}
            </p>
          )}
          {t.staleTake && ready && (
            <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-200">
              The selected clip was made with an earlier image on one of the boards.{' '}
              {currentTake ? (
                <>
                  There is a take with the images that are there now.{' '}
                  <button
                    type="button"
                    onClick={() => chooseShown(currentTake)}
                    className="rounded px-1 font-medium text-amber-100 underline underline-offset-2 hover:text-white"
                  >
                    Use this take
                  </button>
                </>
              ) : (
                'Generate again if the clip should follow the images there now – the new clip is selected when it’s done.'
              )}
            </p>
          )}
        </section>

        {/* Every take, right under the player: a click makes one the transition's and plays it. */}
        {t.takes.length > 0 && (
          <TakeStrip
            owner="storyboard"
            takes={t.takes}
            activeId={selection.activeId}
            previewId={preview?.id}
            aspect={aspect}
            models={models}
            // main chooses a finished take by itself while the transition has no usable one, or only one made from
            // earlier pictures (autoSelect).
            autoSelects={!ready || !!t.staleTake}
            madeFromEarlierPictures={(g) => madeFromOtherImages(g, t)}
            promptDiffers={(g) => g.prompt.trim() !== value.prompt.trim()}
            onChoose={chooseTake}
            onPreview={previewTake}
            onLeavePreview={() => setPreviewId(undefined)}
            onTogglePlay={() => {
              const el = video.current
              if (!el) return
              if (el.paused) void el.play().catch(() => undefined)
              else el.pause()
            }}
            onPlayFromStart={playFromStart}
            onDelete={(take) => {
              if (take.id === previewId) setPreviewId(undefined)
              onDeleteTake(take)
            }}
            onUsePrompt={(g) => set('prompt', g.prompt)}
            onEdit={onEditTake}
          />
        )}

        {/* What happens. */}
        <section>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <label htmlFor={promptId} className="text-muted">
              What happens?
            </label>
            {value.prompt.trim() && suggestion && value.prompt.trim() !== suggestion ? (
              <ConfirmButton
                question="Replace the text?"
                confirmLabel="Replace"
                onConfirm={() => set('prompt', suggestion)}
                title="Write a simple prompt from what the boards show (replaces the text)"
                className="rounded px-1.5 py-0.5 text-[12px] text-muted transition hover:bg-raised hover:text-text"
              >
                Suggest
              </ConfirmButton>
            ) : (
              <button
                type="button"
                onClick={() => suggestion && set('prompt', suggestion)}
                disabled={!suggestion || value.prompt.trim() === suggestion}
                title={
                  suggestion
                    ? 'Write a simple prompt from what the boards show'
                    : 'First write under the images what they show, and a prompt can be suggested'
                }
                className="rounded px-1.5 py-0.5 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Suggest
              </button>
            )}
          </div>
          <PromptField
            id={promptId}
            value={value.prompt}
            onChange={(v) => set('prompt', v)}
            onBlur={() => void draft.flush()}
            onSubmit={() => {
              if (!blocked && !submitting) onGenerate(count)
            }}
            context="video"
            minRows={4}
            maxRows={14}
            title="What happens?"
            focusHint={`The motion from board ${fromNumber} to board ${toNumber} – ideally in English. Type / for a building block.`}
            placeholder="The camera slowly pushes in as she turns from the window and walks towards the door."
          />
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            Describe the motion from the first image to the second – ideally in English. The clip starts exactly on
            board {fromNumber} and ends exactly on board {toNumber}.
          </p>
          {/* An agent can give a transition a negative prompt (update_transition); it is sent with every take. */}
          {t.params.negativePrompt && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-line px-3 py-2 text-[12px] leading-relaxed">
              <p className="min-w-0 flex-1 text-muted select-text" title="Sent with the clip: what the model should avoid">
                <span className="text-text/80">Avoid:</span> {t.params.negativePrompt}
              </p>
              <button
                type="button"
                onClick={() => void clearNegative()}
                title="Remove the text, so it isn’t sent with the next take"
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-accent"
              >
                Remove
              </button>
            </div>
          )}
          {negativeError && <p className="mt-1 text-[11px] text-accent select-text">{negativeError}</p>}
        </section>

        {/* Length, resolution, sound, model. */}
        <section className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label>
              <span className="mb-1.5 block text-muted">Length</span>
              <select value={value.duration} onChange={(e) => set('duration', e.target.value)} className={select}>
                {(model?.durations.length ? model.durations : [value.duration]).map((d) => (
                  <option key={d} value={d}>
                    {durationLabel(d)}
                  </option>
                ))}
              </select>
            </label>
            {(!!model?.resolutions.length || !!value.resolution) && (
              <label>
                <span className="mb-1.5 block text-muted">Resolution</span>
                <select
                  value={value.resolution ?? ''}
                  onChange={(e) => set('resolution', e.target.value || undefined)}
                  className={select}
                >
                  {(model?.resolutions.length ? model.resolutions : [value.resolution ?? '']).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {model?.audio && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={value.audio ?? true}
                disabled={!model.audioConfigurable}
                onChange={(e) => set('audio', e.target.checked)}
                className="accent-accent"
              />
              <span>Generate sound</span>
            </label>
          )}
          <label className="block">
            <span className="mb-1.5 flex items-baseline justify-between gap-2 text-muted">
              Model
              <span className="text-[11px]">only models that can end on an image</span>
            </span>
            {modelsError ? (
              <p className="text-[12px] text-accent select-text">{modelsError}</p>
            ) : (
              <select value={value.model} onChange={(e) => chooseModel(e.target.value)} className={select}>
                {/* The current model stays listed while the list loads (or if Venice no longer offers it). */}
                {!endModels.some((m) => m.id === value.model) && (
                  <option value={value.model}>{model?.name ?? value.model}</option>
                )}
                {endModels.map((m) => (
                  <option key={m.id} value={m.id} disabled={m.offline}>
                    {m.name}
                    {m.offline ? ' (offline)' : ''}
                  </option>
                ))}
              </select>
            )}
          </label>
        </section>

        {/* Generate. */}
        <section className="space-y-2">
          {/* The first reason is on the button; any others are listed above it. */}
          {problems.length > 1 && (
            <ul className="space-y-1 text-[12px] leading-snug text-amber-200">
              {problems.slice(1).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="flex items-stretch gap-2">
            <VariantPicker count={count} onChange={setCount} each={quote} />
            <button
              type="button"
              onClick={() => onGenerate(count)}
              disabled={!!blocked || submitting}
              title={
                blocked ??
                (count > 1
                  ? `Sends ${count} takes of the clip to Venice at once (⌘ + Enter in the prompt)`
                  : 'Sends the clip to Venice (⌘ + Enter in the prompt)')
              }
              className={`${primaryButton} min-w-0 flex-1 py-2`}
            >
              {submitting ? (
                'Sending…'
              ) : blocked ? (
                <span className="truncate">{blocked}</span>
              ) : (
                <>
                  {withVariants(ready || t.takes.length ? 'Generate again' : 'Generate', count)}
                  <span className="opacity-80">· {formatUsd(variantsPrice(quote, count))}</span>
                </>
              )}
            </button>
          </div>
          {error && (
            <p className="flex items-start gap-2 text-[12px] leading-relaxed text-accent select-text">
              <span className="min-w-0 flex-1">{error}</span>
              <button type="button" onClick={onDismissError} title="Close" className="mt-1 shrink-0 opacity-60 hover:opacity-100">
                <CloseIcon size={10} />
              </button>
            </p>
          )}
        </section>
      </div>
    </div>
  )
}

function BoardThumb({ path, label, aspect }: { path?: string; label: string; aspect: number }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="overflow-hidden rounded-md bg-black" style={{ aspectRatio: aspect }}>
        {path ? (
          <img src={mediaUrl(path)} alt={label} draggable={false} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center border border-dashed border-line text-[11px] text-muted">
            No image
          </div>
        )}
      </div>
      <p className="mt-1 text-[11px] text-muted">{label}</p>
    </div>
  )
}

function PendingView({ take }: { take: Generation }) {
  const progress = takeProgress(take)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-10 text-muted">
      <span className="flex items-center gap-1.5">
        <Spinner />
        {pendingPhase(take)}
      </span>
      <div className="h-1 w-full max-w-48 overflow-hidden rounded bg-raised">
        <div className="h-full bg-accent transition-all duration-1000" style={{ width: `${(progress ?? 0.03) * 100}%` }} />
      </div>
      <span className="text-[11px]">
        {formatSeconds(take.executionDuration)}
        {take.averageExecutionTime ? ` of ~${formatSeconds(take.averageExecutionTime)}` : ''}
      </span>
    </div>
  )
}
