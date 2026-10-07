import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { audioForModel, pickOption, PREFERRED, supportsEndImage } from '@shared/models'
import type { Generation, Storyboard, StoryboardTransition, VideoModel } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { formatSeconds, formatUsd, mediaUrl } from '../../lib/media'
import ConfirmButton from '../sequences/ConfirmButton'
import { ArrowRightIcon, CloseIcon } from '../sequences/icons'
import { useDraft, useRegisterFlush, type FlushRegistry } from '../sequences/useDraft'
import { useClipQuote } from '../sequences/useTotalQuote'
import {
  aspectValue,
  boardNumber,
  durationLabel,
  formatLength,
  formatTakeTime,
  isPending,
  madeFromOtherImages,
  playable,
  readyTake,
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
  onSelectTake: (take: Generation) => void
  onDeleteTake: (take: Generation) => void
  onClose: () => void
}

/**
 * One transition in full, beside the boards: the two pictures it goes between, the take in use (or the one
 * being looked at) in a player, "Vad händer?" with Föreslå, length, resolution, sound and the model (only those
 * that can end on a picture), the price and Generera, and every take with Välj and Radera. Edits are saved by
 * themselves; Generera saves first, so the take is made from what is on screen.
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
  onSelectTake,
  onDeleteTake,
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
  const ready = readyTake(t)

  // ── "Föreslå" ──────────────────────────────────────────────────────────────

  const suggestion = suggestPrompt(from?.note, to?.note)
  const promptId = useId()

  // ── The take in the player ─────────────────────────────────────────────────

  const [viewingId, setViewingId] = useState<string>()
  const viewing =
    t.takes.find((g) => g.id === viewingId && playable(g)) ?? ready ?? t.takes.find((g) => playable(g))
  // Looking at another take is only for a while: a new selection shows the selected take again.
  useEffect(() => setViewingId(undefined), [t.selectedGenerationId])
  const pending = t.takes.find(isPending)
  // The newest take made from the pictures the boards hold now, for a selected take made from earlier ones.
  const currentTake = t.staleTake ? t.takes.find((g) => playable(g) && !madeFromOtherImages(g, t)) : undefined

  const aspect = aspectValue(storyboard.aspectRatio)

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(e) => {
        const inField = (e.target as HTMLElement).closest('textarea, input, select')
        if (e.key === 'Escape' && !e.defaultPrevented && !inField) {
          e.preventDefault()
          onClose()
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

        {/* The take in use, or the one picked below. */}
        <section>
          <div className="overflow-hidden rounded-lg bg-black" style={{ aspectRatio: aspect }}>
            {viewing?.filePath ? (
              <video
                key={viewing.id}
                src={mediaUrl(viewing.filePath)}
                poster={viewing.thumbPath ? mediaUrl(viewing.thumbPath) : undefined}
                controls
                preload="metadata"
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
            <p className="mt-1.5 flex items-center gap-2 text-[11px] text-muted">
              {viewing.id === t.selectedGenerationId ? (
                <span>Valt klipp · {formatLength(takeSeconds(viewing))}</span>
              ) : (
                <>
                  <span>Tagning från {formatTakeTime(viewing.createdAt)} – inte vald</span>
                  <button
                    type="button"
                    onClick={() => onSelectTake(viewing)}
                    className="rounded px-1.5 py-0.5 text-text transition hover:bg-raised"
                  >
                    Välj den
                  </button>
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
                    onClick={() => onSelectTake(currentTake)}
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

        <TakeList
          transition={t}
          viewingId={viewing?.id}
          onView={(g) => setViewingId(g.id)}
          onSelect={onSelectTake}
          onDelete={onDeleteTake}
        />
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
      <span className="animate-pulse">{take.status === 'queued' ? 'I kö…' : 'Genererar…'}</span>
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

/** Every take of the transition, newest first: look at one, choose the one the film uses, delete the rest. */
function TakeList({
  transition: t,
  viewingId,
  onView,
  onSelect,
  onDelete
}: {
  transition: StoryboardTransition
  viewingId?: string
  onView: (take: Generation) => void
  onSelect: (take: Generation) => void
  onDelete: (take: Generation) => void
}) {
  if (!t.takes.length) return null
  return (
    <section>
      <h3 className="mb-2 flex items-baseline gap-2">
        <span className="font-medium">Tagningar</span>
        <span className="text-[12px] text-muted">{t.takes.length} st</span>
      </h3>
      <ul className="space-y-1.5">
        {t.takes.map((take) => {
          const selected = take.id === t.selectedGenerationId
          const pending = isPending(take)
          const canPlay = playable(take)
          const older = take.status === 'completed' && madeFromOtherImages(take, t)
          return (
            <li
              key={take.id}
              className={`flex items-center gap-2.5 rounded-lg border p-1.5 transition ${
                selected ? 'border-accent/60 bg-accent/5' : take.id === viewingId ? 'border-muted/50' : 'border-line'
              }`}
            >
              <button
                type="button"
                onClick={() => canPlay && onView(take)}
                disabled={!canPlay}
                title={canPlay ? 'Visa i spelaren ovan' : undefined}
                className="relative h-10 w-[72px] shrink-0 overflow-hidden rounded bg-black"
              >
                {take.thumbPath && canPlay ? (
                  <img src={mediaUrl(take.thumbPath)} alt="" draggable={false} className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[10px] text-muted">
                    {pending ? (take.status === 'queued' ? 'I kö' : 'Genererar') : take.status === 'failed' ? 'Fel' : null}
                  </span>
                )}
              </button>
              <div className="min-w-0 flex-1 text-[11px] leading-snug">
                <p className="truncate text-text/90">
                  {formatTakeTime(take.createdAt)}
                  {take.status === 'completed' && <span className="text-muted"> · {formatLength(takeSeconds(take))}</span>}
                  <span className="text-muted"> · {formatUsd(take.quote)}</span>
                </p>
                {take.status === 'failed' ? (
                  <p className="truncate text-accent" title={take.error}>
                    {take.error ?? 'Misslyckades'}
                  </p>
                ) : take.fileMissing ? (
                  <p className="truncate text-muted">Videofilen finns inte längre</p>
                ) : older ? (
                  <p className="truncate text-amber-300/90" title="Gjord med en tidigare bild i någon av rutorna">
                    Gjord med en tidigare bild
                  </p>
                ) : (
                  <p className="truncate text-muted" title={take.prompt}>
                    {take.prompt || 'Ingen prompt'}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 text-[11px]">
                {selected ? (
                  <span className="px-1.5 font-medium text-accent">Vald</span>
                ) : (
                  canPlay && (
                    <button
                      type="button"
                      onClick={() => onSelect(take)}
                      className="rounded-md bg-raised px-2 py-0.5 font-medium text-text transition hover:bg-accent hover:text-white"
                    >
                      Välj
                    </button>
                  )
                )}
                {!pending && (
                  <ConfirmButton
                    question="Radera?"
                    onConfirm={() => onDelete(take)}
                    title="Radera tagningen och videofilen"
                    className="rounded px-1.5 py-0.5 text-muted transition hover:bg-raised hover:text-accent"
                  >
                    Radera
                  </ConfirmButton>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
