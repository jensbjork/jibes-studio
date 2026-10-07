import type { Generation, Segment, VideoModel } from '@shared/types'
import { formatSeconds, formatUsd, mediaUrl } from '../../lib/media'
import ConfirmButton from './ConfirmButton'
import { formatLength, formatTakeTime, isPending, takeDuration, takeProgress, takePromptsFor } from './sequenceUtils'

interface Props {
  segment: Segment
  number: number
  models: VideoModel[]
  /** The prompt currently in the editor, to mark takes made from another one. */
  currentPrompt: string
  onSelect: (take: Generation) => void
  onDelete: (take: Generation) => void
  onUsePrompt: (take: Generation) => void
}

const action = 'rounded px-1.5 py-0.5 transition hover:bg-raised hover:text-text'
const deleteAction = 'rounded px-1.5 py-0.5 transition hover:bg-raised hover:text-accent'

/** Every generation of the segment, newest first; one of them is the take used in the cut. */
export default function TakeList({ segment, number, models, currentPrompt, onSelect, onDelete, onUsePrompt }: Props) {
  const takes = segment.takes

  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="font-medium">Tagningar</h3>
        <span className="text-[12px] text-muted">
          klipp {number}
          {takes.length > 0 && ` · ${takes.length} st`}
        </span>
      </div>

      {takes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center leading-relaxed text-muted">
          Inga tagningar ännu. Skriv en prompt och klicka på <span className="text-text">Generera tagning</span>.
          <br />
          Varje försök sparas här, så att du kan välja det bästa till sekvensen.
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
          {takes.map((take) => (
            <TakeCard
              key={take.id}
              take={take}
              selected={take.id === segment.selectedGenerationId}
              modelName={models.find((m) => m.id === take.model)?.name ?? take.model}
              // Read with the clip's references now: a take whose prompt differs only by a reorder's renumbering
              // has nothing to bring back.
              promptChanged={takePromptsFor(take.params, segment.params).prompt.trim() !== currentPrompt.trim()}
              onSelect={() => onSelect(take)}
              onDelete={() => onDelete(take)}
              onUsePrompt={() => onUsePrompt(take)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function TakeCard({
  take,
  selected,
  modelName,
  promptChanged,
  onSelect,
  onDelete,
  onUsePrompt
}: {
  take: Generation
  selected: boolean
  modelName: string
  promptChanged: boolean
  onSelect: () => void
  onDelete: () => void
  onUsePrompt: () => void
}) {
  const pending = isPending(take)
  const progress = takeProgress(take)

  return (
    <div
      className={`group flex flex-col overflow-hidden rounded-lg border bg-panel transition ${
        selected ? 'border-accent/70' : 'border-line'
      }`}
    >
      <div className="relative aspect-video bg-black">
        {take.status === 'completed' && take.filePath && !take.fileMissing && (
          <video
            src={mediaUrl(take.filePath)}
            poster={take.thumbPath ? mediaUrl(take.thumbPath) : undefined}
            controls
            preload="metadata"
            className="h-full w-full object-contain"
          />
        )}
        {pending && (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 px-8 text-muted">
            <span className="animate-pulse">{take.status === 'queued' ? 'I kö…' : 'Genererar…'}</span>
            <div className="h-1 w-full max-w-40 overflow-hidden rounded bg-raised">
              <div
                className="h-full bg-accent transition-all duration-1000"
                style={{ width: `${(progress ?? 0.03) * 100}%` }}
              />
            </div>
            <span className="text-[11px]">
              {formatSeconds(take.executionDuration)}
              {take.averageExecutionTime ? ` av ~${formatSeconds(take.averageExecutionTime)}` : ''}
            </span>
          </div>
        )}
        {take.fileMissing && (
          <div className="flex h-full items-center justify-center p-4 text-center text-[12px] text-muted">
            Videofilen finns inte längre.
          </div>
        )}
        {take.status === 'failed' && (
          <div className="flex h-full items-center justify-center overflow-y-auto p-4 text-center text-[12px] text-accent select-text">
            {take.error ?? 'Misslyckades'}
          </div>
        )}
        {selected && (
          <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-accent px-1.5 py-px text-[11px] font-medium text-white">
            Vald
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-2.5">
        <p
          className={`line-clamp-2 text-[12px] select-text ${promptChanged ? 'text-muted' : ''}`}
          title={promptChanged ? `Annan prompt än nu:\n${take.prompt}` : take.prompt}
        >
          {take.prompt || <span className="italic">Ingen prompt</span>}
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted">
          <span>{formatTakeTime(take.createdAt)}</span>
          {take.status === 'completed' && (
            <>
              <span>·</span>
              <span>{formatLength(takeDuration(take))}</span>
            </>
          )}
          <span>·</span>
          <span>{formatUsd(take.quote)}</span>
          <span className="w-full truncate" title={take.model}>
            {modelName}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
          {take.status === 'completed' && !selected && (
            <button
              onClick={onSelect}
              className="rounded-md bg-raised px-2.5 py-1 font-medium text-text transition hover:bg-accent hover:text-white"
            >
              Välj
            </button>
          )}
          {selected && <span className="px-1 text-accent">Används i sekvensen</span>}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-0.5">
            {promptChanged && take.prompt && (
              <button onClick={onUsePrompt} className={action} title="Lägg tagningens prompt i redigeraren">
                Använd prompt
              </button>
            )}
            {take.filePath && !take.fileMissing && (
              <button onClick={() => window.studio.revealFile(take.filePath!)} className={action} title="Visa i Finder">
                Visa fil
              </button>
            )}
            {!pending && (
              <ConfirmButton
                question="Radera?"
                onConfirm={onDelete}
                title="Radera tagningen och videofilen"
                className={deleteAction}
              >
                Radera
              </ConfirmButton>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
