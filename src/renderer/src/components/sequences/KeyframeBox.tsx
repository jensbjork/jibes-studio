import type { ReactNode } from 'react'
import { endImageVariant, supportsEndImage } from '@shared/models'
import type { Segment, Sequence, VideoModel } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { BridgeIcon } from './icons'
import { bridgeDescription, continuationMismatch, endMismatch, formatFrameTime, readyTake } from './sequenceUtils'
import { hasAutomaticFrames, useFramePreview } from './useFramePreview'

interface Props {
  sequence: Sequence
  segment: Segment
  index: number
  models: VideoModel[]
  /** The model in the editor right now (the draft), which decides whether an end image can be sent. */
  model: string
  ffmpegOk: boolean
  /** A switch or "Gör om mellan grannarna" is being saved. */
  busy: boolean
  /** "Gör om mellan grannarna" just configured this clip: say what to do next. */
  justBridged: boolean
  onContinue: (on: boolean) => void
  onEndFromNext: (on: boolean) => void
  onBridge: () => void
}

/**
 * The segment editor's start and end frames from the neighbours: "Startbild från föregående klipp" and
 * "Slutbild från nästa klipp", each with a live preview of the exact frame main will send (previewSegmentFrames),
 * what stands in the way, and "Gör om mellan grannarna", which sets both and picks a model that takes an end image.
 */
export default function KeyframeBox({
  sequence,
  segment,
  index,
  models,
  model,
  ffmpegOk,
  busy,
  justBridged,
  onContinue,
  onEndFromNext,
  onBridge
}: Props) {
  const count = sequence.segments.length
  const previous = index > 0 ? sequence.segments[index - 1] : undefined
  const next = sequence.segments[index + 1]
  const startOn = segment.continueFromPrevious && !!previous
  const endOn = segment.endFromNext && !!next
  const { preview, loading, error } = useFramePreview(sequence, index, hasAutomaticFrames(segment, index, count))
  const bridge = bridgeDescription(index, count)
  // Already set up as far as the neighbours allow: the button would change nothing.
  const bridged = (startOn || !previous) && (endOn || !next)

  const modelName = (id: string) => models.find((m) => m.id === id)?.name ?? id
  // Turning "Slutbild från nästa klipp" on makes main switch to a model that takes an end image; say which.
  const endModel = supportsEndImage(model) ? undefined : endImageVariant(model, models.map((m) => m.id))
  // …and drops the clip's references (image-to-video can't send them), their @ tokens with them.
  const hasReferences = !!(segment.params.referenceImages?.length || segment.params.referenceAudios?.length)
  const dropsReferences = hasReferences ? ' Referenserna tas bort, eftersom bild-till-video inte kan skicka dem.' : ''

  const startText = !previous
    ? 'Det första klippet startar från din prompt och dina egna bilder.'
    : !ffmpegOk && !startOn
      ? 'Kräver ffmpeg (brew install ffmpeg).'
      : startOn
        ? `Startbilden hämtas från slutet av klipp ${index}${previous.trimEnd > 0 ? ' (efter trim)' : ''} när tagningen genereras, så övergången blir sömlös.`
        : `Använd sista bildrutan i klipp ${index} som startbild för en sömlös övergång.`

  const endText = !next
    ? 'Det sista klippet har inget nästa klipp att sluta i.'
    : !ffmpegOk && !endOn
      ? 'Kräver ffmpeg (brew install ffmpeg).'
      : endOn
        ? `Slutbilden hämtas från början av klipp ${index + 2}${next.trimStart > 0 ? ' (efter trim)' : ''}, så klippet slutar exakt där nästa börjar.`
        : endModel
          ? `Låt klippet sluta exakt där klipp ${index + 2} börjar. ${modelName(model)} tar ingen slutbild, så modellen byts till ${modelName(endModel)}.${dropsReferences}`
          : `Låt klippet sluta exakt där klipp ${index + 2} börjar.${dropsReferences}`

  const start = preview?.start?.source === 'previous' ? preview.start : undefined
  const end = preview?.end?.source === 'next' ? preview.end : undefined
  const startMismatch = continuationMismatch(segment, previous)
  const endChanged = endMismatch(segment, next)
  // A missing neighbour take is already said beside the frame it would give.
  const problems = (preview?.problems ?? []).filter(
    (p) => !(startOn && !start && p.startsWith(`Klipp ${index} `)) && !(endOn && !end && p.startsWith(`Klipp ${index + 2} `))
  )

  return (
    <div className="mb-5 rounded-lg border border-line bg-panel">
      <ToggleRow
        label="Startbild från föregående klipp"
        description={startText}
        on={startOn}
        // Turning it off must stay possible without ffmpeg; turning it on needs ffmpeg for the frame grab.
        disabled={!previous || busy || (!startOn && !ffmpegOk)}
        onChange={onContinue}
      >
        {startOn && (
          <FramePreview
            path={start?.path}
            loading={loading}
            caption={
              start
                ? `Startbild: sista bildrutan från klipp ${start.fromClip ?? index}${start.time !== undefined ? ` (${formatFrameTime(start.time)})` : ''}`
                : previous && !readyTake(previous)
                  ? `Klipp ${index} behöver en färdig vald tagning innan det här klippet kan genereras.`
                  : loading
                    ? 'Hämtar bildrutan…'
                    : 'Bildrutan kunde inte tas fram.'
            }
          />
        )}
      </ToggleRow>

      <div className="border-t border-line" />

      <ToggleRow
        label="Slutbild från nästa klipp"
        description={endText}
        on={endOn}
        disabled={!next || busy || (!endOn && !ffmpegOk)}
        onChange={onEndFromNext}
      >
        {endOn && (
          <FramePreview
            path={end?.path}
            loading={loading}
            caption={
              end
                ? `Slutbild: första bildrutan från klipp ${end.fromClip ?? index + 2}${end.time ? ` (${formatFrameTime(end.time)})` : ''}`
                : next && !readyTake(next)
                  ? `Klipp ${index + 2} behöver en färdig vald tagning innan det här klippet kan genereras.`
                  : loading
                    ? 'Hämtar bildrutan…'
                    : 'Bildrutan kunde inte tas fram.'
            }
          />
        )}
      </ToggleRow>

      {(problems.length > 0 || error || startMismatch || endChanged || justBridged || (bridge && !bridged)) && (
        <div className="space-y-2 border-t border-line p-3">
          {justBridged && (
            <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] leading-snug text-emerald-200">
              Klippet görs nu om mellan grannarna. Kontrollera bildrutorna ovan och prompten, och tryck sedan på
              Generera. Den gamla tagningen finns kvar under Tagningar.
            </p>
          )}
          {problems.map((p) => (
            <p key={p} className="text-[11px] leading-snug text-amber-300">
              {p}
            </p>
          ))}
          {error && <p className="text-[11px] leading-snug text-muted">Bildrutorna kunde inte visas: {error}</p>}
          {startMismatch && (
            <Warning>
              Den valda tagningen börjar inte där klipp {index} slutar nu. Generera en ny tagning för en sömlös övergång.
            </Warning>
          )}
          {endChanged && (
            <Warning>
              Den valda tagningen slutar inte där klipp {index + 2} börjar nu. Generera en ny tagning för en sömlös
              övergång.
            </Warning>
          )}
          {bridge && !bridged && (
            <button
              onClick={onBridge}
              disabled={busy}
              title={bridge}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] transition hover:bg-raised disabled:opacity-40"
            >
              <BridgeIcon size={13} />
              Gör om mellan grannarna
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ToggleRow({
  label,
  description,
  on,
  disabled,
  onChange,
  children
}: {
  label: string
  description: string
  on: boolean
  disabled: boolean
  onChange: (on: boolean) => void
  children?: ReactNode
}) {
  return (
    <div className="p-3">
      <div
        className={`flex items-start gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
        onClick={() => !disabled && onChange(!on)}
      >
        <button
          role="switch"
          aria-checked={on}
          aria-label={label}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation()
            onChange(!on)
          }}
          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition ${on ? 'bg-accent' : 'bg-line'}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] ${on ? 'left-[18px]' : 'left-0.5'}`}
          />
        </button>
        <span className="min-w-0">
          <span className="block">{label}</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted">{description}</span>
        </span>
      </div>
      {children}
    </div>
  )
}

function FramePreview({ path, loading, caption }: { path?: string; loading: boolean; caption: string }) {
  return (
    <div className="mt-3 flex items-center gap-3 pl-12">
      <div className="aspect-video w-28 shrink-0 overflow-hidden rounded bg-black">
        {path ? (
          <img src={mediaUrl(path)} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <div className={`h-full w-full bg-raised ${loading ? 'animate-pulse' : ''}`} />
        )}
      </div>
      <p className="text-[11px] leading-snug text-muted">{caption}</p>
    </div>
  )
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-snug text-amber-300">
      {children}
    </p>
  )
}
