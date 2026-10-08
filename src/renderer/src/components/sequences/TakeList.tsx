import { useState, type DragEvent } from 'react'
import { canUseAgain, generationTitle, sourceBadge } from '@shared/generation-label'
import type { Generation, Segment, VideoModel } from '@shared/types'
import { formatSeconds, formatUsd, mediaUrl } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { ScissorsIcon } from '../feed/icons'
import { carriesFiles, DropHint, droppedVideoPaths, ImportCardView, type ImportCard } from '../feed/ownClips'
import ConfirmButton from './ConfirmButton'
import { CameraIcon } from './icons'
import { formatLength, formatTakeTime, isPending, takeDuration, takeProgress, takePromptsFor } from './sequenceUtils'

interface Props {
  segment: Segment
  number: number
  models: VideoModel[]
  /** The prompt currently in the editor, to mark takes made from another one. */
  currentPrompt: string
  /** Own films on their way in as takes of this clip. */
  importing?: ImportCard[]
  /** "Redigera tagningen…" opens the take in Redigera. */
  navigate?: Navigate
  onSelect: (take: Generation) => void
  onDelete: (take: Generation) => void
  onUsePrompt: (take: Generation) => void
  /** Video files dropped on the list: own films as takes (the last one selected). */
  onImport?: (paths: string[]) => void
  /** "Lägg till tagning från fil…". */
  onPickFile?: () => void
}

const action = 'rounded px-1.5 py-0.5 transition hover:bg-raised hover:text-text'
const deleteAction = 'rounded px-1.5 py-0.5 transition hover:bg-raised hover:text-accent'

/**
 * Every generation of the segment, newest first; one of them is the take used in the cut. Own films can be added as
 * takes too ("Lägg till tagning från fil…", or dropped on the list), next to AI takes of the same clip.
 */
export default function TakeList({
  segment,
  number,
  models,
  currentPrompt,
  importing = [],
  navigate,
  onSelect,
  onDelete,
  onUsePrompt,
  onImport,
  onPickFile
}: Props) {
  const takes = segment.takes
  const [dropping, setDropping] = useState(false)

  const onDragOver = (e: DragEvent) => {
    if (!onImport || !carriesFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }
  const onDrop = (e: DragEvent) => {
    if (!onImport || !carriesFiles(e)) return
    e.preventDefault()
    setDropping(false)
    const { paths } = droppedVideoPaths(e)
    if (paths.length) onImport(paths)
  }

  return (
    <section
      className="relative"
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
    >
      {dropping && <DropHint text="Släpp för att lägga till som tagningar" />}
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="font-medium">Tagningar</h3>
        <span className="text-[12px] text-muted">
          klipp {number}
          {takes.length > 0 && ` · ${takes.length} st`}
        </span>
        {onPickFile && (
          <button
            type="button"
            onClick={onPickFile}
            title="Lägg till en egen film som tagning av klippet"
            className="ml-auto rounded px-1.5 py-0.5 text-[12px] text-muted transition hover:bg-raised hover:text-text"
          >
            Lägg till tagning från fil…
          </button>
        )}
      </div>

      {takes.length === 0 && importing.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center leading-relaxed text-muted">
          Inga tagningar ännu. Skriv en prompt och klicka på <span className="text-text">Generera tagning</span>
          {onImport ? ', eller släpp en egen film här.' : '.'}
          <br />
          Varje försök sparas här, så att du kan välja det bästa till sekvensen.
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
          {importing.map((card) => (
            <div
              key={card.path}
              className="flex aspect-video flex-col overflow-hidden rounded-lg border border-line bg-panel"
            >
              <ImportCardView card={card} />
            </div>
          ))}
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
              onEdit={navigate ? () => navigate('editor', { type: 'open-editor', generationId: take.id }) : undefined}
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
  onUsePrompt,
  onEdit
}: {
  take: Generation
  selected: boolean
  modelName: string
  promptChanged: boolean
  onSelect: () => void
  onDelete: () => void
  onUsePrompt: () => void
  /** "Redigera tagningen…". */
  onEdit?: () => void
}) {
  const pending = isPending(take)
  const progress = takeProgress(take)
  const badge = sourceBadge(take)
  // An own film or a version: named by its title, no model or price of its own.
  const own = badge?.kind === 'own' || badge?.kind === 'edited'
  const title = generationTitle(take)

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
        {(selected || badge) && (
          <span className="pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1">
            {selected && (
              <span className="rounded bg-accent px-1.5 py-px text-[11px] font-medium text-white">Vald</span>
            )}
            {badge && (
              <span className="flex items-center gap-1 rounded bg-black/75 px-1.5 py-px text-[10px] font-medium text-text">
                {own && <CameraIcon size={10} />}
                {badge.label}
              </span>
            )}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-2.5">
        {own ? (
          <p className="line-clamp-2 text-[12px] select-text" title={title}>
            {title}
          </p>
        ) : (
          <p
            className={`line-clamp-2 text-[12px] select-text ${promptChanged ? 'text-muted' : ''}`}
            title={promptChanged ? `Annan prompt än nu:\n${take.prompt}` : take.prompt}
          >
            {take.prompt ? title : <span className="italic">Ingen prompt</span>}
          </p>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted">
          <span>{formatTakeTime(take.createdAt)}</span>
          {take.status === 'completed' && (
            <>
              <span>·</span>
              <span>{formatLength(takeDuration(take))}</span>
            </>
          )}
          {(!own || take.quote !== undefined) && (
            <>
              <span>·</span>
              <span>{formatUsd(take.quote)}</span>
            </>
          )}
          <span className="w-full truncate" title={own ? undefined : take.model}>
            {own ? (badge?.kind === 'edited' ? 'Redigerad film' : 'Eget klipp') : modelName}
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
            {promptChanged && take.prompt && canUseAgain(take) && (
              <button onClick={onUsePrompt} className={action} title="Lägg tagningens prompt i redigeraren">
                Använd prompt
              </button>
            )}
            {onEdit && take.status === 'completed' && take.filePath && !take.fileMissing && (
              <button
                onClick={onEdit}
                className={`${action} flex items-center gap-1`}
                title="Öppna tagningen i Redigera och ändra den med AI. Klippet rörs inte förrän du skickar tillbaka en version."
              >
                <ScissorsIcon size={11} />
                Redigera tagningen…
              </button>
            )}
            {take.filePath && !take.fileMissing && (
              <button onClick={() => window.studio.revealFile(take.filePath!)} className={action} title="Visa i Finder">
                Visa fil
              </button>
            )}
            {/* A film Redigera keeps (a version, an edit's original) only leaves the clip; main does the same. */}
            {!pending && (
              <ConfirmButton
                question={take.keptByEdit ? 'Ta bort?' : 'Radera?'}
                onConfirm={onDelete}
                title={
                  take.keptByEdit
                    ? 'Ta bort tagningen från klippet (filmen finns kvar i Redigera)'
                    : 'Radera tagningen och videofilen'
                }
                className={deleteAction}
              >
                {take.keptByEdit ? 'Ta bort' : 'Radera'}
              </ConfirmButton>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
