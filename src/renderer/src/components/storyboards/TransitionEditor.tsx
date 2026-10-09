import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { audioForModel, pickOption, PREFERRED, supportsEndImage } from '@shared/models'
import { workKey, type Generation, type Storyboard, type StoryboardTransition, type VideoModel } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { formatSeconds, formatUsd, mediaUrl } from '../../lib/media'
import { markSeen } from '../../lib/work'
import { pauseOthers } from '../feed/playback'
import ConfirmButton from '../sequences/ConfirmButton'
import { ArrowRightIcon, CloseIcon } from '../sequences/icons'
import { useDraft, useRegisterFlush, type FlushRegistry } from '../sequences/useDraft'
import { useClipQuote } from '../sequences/useTotalQuote'
import TakeStrip, { type PickedBy } from '../takes/TakeStrip'
import { pendingPhase } from '../takes/takeText'
import { KEY_SELECT_DELAY, useTakeSelection } from '../takes/useTakeSelection'
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
  /** Why the last Generera failed. */
  error?: string
  onDismissError: () => void
  onGenerate: () => void
  /** Makes the take the transition's (main's answer applied); rejects with main's refusal. */
  onCommitTake: (transitionId: string, takeId: string) => Promise<void>
  onDeleteTake: (take: Generation) => void
  /** "Redigera tagningen…": opens the take in Redigera. */
  onEditTake?: (take: Generation) => void
  /** A refusal to show above the storyboard (choosing a take failed). */
  onError: (message: string) => void
  onClose: () => void
}

/**
 * One transition in full, beside the boards: the two pictures it goes between, the take in use (or the one
 * being looked at) in a player with every take in a strip right under it – a click makes a take the one in use and
 * plays it –, "Vad händer?" with Föreslå, length, resolution, sound and the model (only those that can end on a
 * picture), the price and Generera. Edits are saved by themselves; Generera saves first, so the take is made from
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
  if (model?.offline) problems.push('Modellen är offline – välj en annan')
  const blocked = problems[0]
  const quote = useClipQuote(t.ready ? params : undefined)

  // ── "Föreslå" ──────────────────────────────────────────────────────────────

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

  /** "Välj den" (under the player, or in the banner about earlier pictures): choosing on purpose, without replaying. */
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
          ruta {fromNumber} → {toNumber}
        </span>
        <span className="ml-auto text-[11px] text-muted" aria-live="polite">
          {draft.error ? (
            <span className="text-accent" title={draft.error}>
              Kunde inte spara
            </span>
          ) : draft.status !== 'idle' ? (
            'Sparar…'
          ) : (
            ''
          )}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Stäng (Esc)"
          aria-label="Stäng"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-raised hover:text-text"
        >
          <CloseIcon size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {/* From one picture to the next. */}
        <div className="flex items-center gap-2">
          <BoardThumb path={from?.imagePath} label={`Ruta ${fromNumber}`} aspect={aspect} />
          <ArrowRightIcon size={14} className="shrink-0 text-muted" />
          <BoardThumb path={to?.imagePath} label={`Ruta ${toNumber}`} aspect={aspect} />
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
                  ? 'Inget klipp än. Skriv vad som händer och generera.'
                  : 'Lägg en bild i båda rutorna, så kan klippet mellan dem genereras.'}
              </div>
            )}
          </div>
          {viewing && (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] text-muted">
              {viewing.id === selection.activeId ? (
                <span>Valt klipp · {formatLength(takeSeconds(viewing))}</span>
              ) : (
                <>
                  <span>Tagning från {formatTakeTime(viewing.createdAt)} – inte vald</span>
                  <span aria-hidden>·</span>
                  <button
                    type="button"
                    onClick={() => chooseShown(viewing)}
                    className="rounded px-1 py-0.5 text-text transition hover:bg-raised"
                  >
                    Välj den
                  </button>
                  {preview && ready && (
                    <>
                      <span aria-hidden>·</span>
                      <button
                        type="button"
                        onClick={() => setPreviewId(undefined)}
                        title="Tillbaka till den valda tagningen (Esc)"
                        className="rounded px-1 py-0.5 text-text transition hover:bg-raised"
                      >
                        Visa vald
                      </button>
                    </>
                  )}
                </>
              )}
            </p>
          )}
          {t.staleTake && ready && (
            <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-200">
              Det valda klippet gjordes med en tidigare bild i någon av rutorna.{' '}
              {currentTake ? (
                <>
                  Det finns en tagning med bilderna som ligger där nu.{' '}
                  <button
                    type="button"
                    onClick={() => chooseShown(currentTake)}
                    className="rounded px-1 font-medium text-amber-100 underline underline-offset-2 hover:text-white"
                  >
                    Välj den
                  </button>
                </>
              ) : (
                'Generera igen om klippet ska följa de bilder som ligger där nu – det nya klippet väljs när det är klart.'
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
              Vad händer?
            </label>
            {value.prompt.trim() && suggestion && value.prompt.trim() !== suggestion ? (
              <ConfirmButton
                question="Ersätta texten?"
                confirmLabel="Ersätt"
                onConfirm={() => set('prompt', suggestion)}
                title="Skriv en enkel prompt utifrån vad rutorna visar (ersätter texten)"
                className="rounded px-1.5 py-0.5 text-[12px] text-muted transition hover:bg-raised hover:text-text"
              >
                Föreslå
              </ConfirmButton>
            ) : (
              <button
                type="button"
                onClick={() => suggestion && set('prompt', suggestion)}
                disabled={!suggestion || value.prompt.trim() === suggestion}
                title={
                  suggestion
                    ? 'Skriv en enkel prompt utifrån vad rutorna visar'
                    : 'Skriv först under bilderna vad de visar, så kan en prompt föreslås'
                }
                className="rounded px-1.5 py-0.5 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Föreslå
              </button>
            )}
          </div>
          <textarea
            id={promptId}
            value={value.prompt}
            onChange={(e) => set('prompt', e.target.value)}
            onBlur={() => void draft.flush()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !blocked && !submitting) {
                e.preventDefault()
                onGenerate()
              }
            }}
            rows={5}
            spellCheck={false}
            placeholder="The camera slowly pushes in as she turns from the window and walks towards the door."
            className="block max-h-72 min-h-28 w-full resize-none rounded-md border border-line bg-raised px-3 py-2 leading-relaxed outline-none transition [field-sizing:content] placeholder:text-muted/60 focus:border-muted"
          />
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            Beskriv rörelsen från den första bilden till den andra – skriv gärna på engelska. Klippet börjar exakt på
            ruta {fromNumber} och slutar exakt på ruta {toNumber}.
          </p>
          {/* An agent can give a transition a negative prompt (update_transition); it is sent with every take. */}
          {t.params.negativePrompt && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-line px-3 py-2 text-[12px] leading-relaxed">
              <p className="min-w-0 flex-1 text-muted select-text" title="Skickas med klippet: det modellen ska undvika">
                <span className="text-text/80">Undvik:</span> {t.params.negativePrompt}
              </p>
              <button
                type="button"
                onClick={() => void clearNegative()}
                title="Ta bort texten, så skickas den inte med nästa tagning"
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-accent"
              >
                Ta bort
              </button>
            </div>
          )}
          {negativeError && <p className="mt-1 text-[11px] text-accent select-text">{negativeError}</p>}
        </section>

        {/* Length, resolution, sound, model. */}
        <section className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label>
              <span className="mb-1.5 block text-muted">Längd</span>
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
                <span className="mb-1.5 block text-muted">Upplösning</span>
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
              <span>Generera ljud</span>
            </label>
          )}
          <label className="block">
            <span className="mb-1.5 flex items-baseline justify-between gap-2 text-muted">
              Modell
              <span className="text-[11px]">bara modeller som kan sluta på en bild</span>
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
          <button
            type="button"
            onClick={onGenerate}
            disabled={!!blocked || submitting}
            title={blocked ?? 'Skickar klippet till Venice (⌘ + Enter i prompten)'}
            className={`${primaryButton} w-full py-2`}
          >
            {submitting ? (
              'Skickar…'
            ) : blocked ? (
              blocked
            ) : (
              <>
                {ready || t.takes.length ? 'Generera igen' : 'Generera'}
                <span className="opacity-80">· {formatUsd(quote)}</span>
              </>
            )}
          </button>
          {error && (
            <p className="flex items-start gap-2 text-[12px] leading-relaxed text-accent select-text">
              <span className="min-w-0 flex-1">{error}</span>
              <button type="button" onClick={onDismissError} title="Stäng" className="mt-1 shrink-0 opacity-60 hover:opacity-100">
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
            Ingen bild
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
        {take.averageExecutionTime ? ` av ~${formatSeconds(take.averageExecutionTime)}` : ''}
      </span>
    </div>
  )
}
