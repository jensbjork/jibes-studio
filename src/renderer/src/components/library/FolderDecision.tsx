import type { ReactNode } from 'react'
import type { FolderInspection, LibraryMode, LibraryStatus } from '@shared/types'
import { displayPath, folderName } from '../../lib/library'
import FolderIcon from './FolderIcon'
import { planFor, type PlanAction } from './plan'

interface Props {
  inspection: FolderInspection
  status: LibraryStatus
  /** A switch is in progress; actions are disabled. */
  busy: boolean
  /** Why the last attempt was refused, e.g. a generation still running. */
  error?: string
  onConfirm: (mode: LibraryMode) => void
}

/** The chosen folder, what to watch out for, and what Studio can do with it. */
export default function FolderDecision({ inspection, status, busy, error, onConfirm }: Props) {
  const plan = planFor(inspection, status)

  return (
    <div>
      <div className="flex min-w-0 items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2.5">
        <FolderIcon size={15} className="shrink-0 text-accent" />
        <span className="shrink-0 font-medium">{folderName(inspection.path)}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted select-text" title={inspection.path}>
          {displayPath(inspection.path)}
        </span>
      </div>

      {plan.blocked && <Callout tone="error">{plan.blocked}</Callout>}
      {plan.notes.map((note) => (
        <Callout key={note.text} tone={note.tone}>
          {note.text}
        </Callout>
      ))}

      {plan.actions.length > 0 && (
        <div className="mt-4 space-y-2">
          {plan.actions.map((action) => (
            <ActionCard key={action.mode} action={action} busy={busy} onClick={() => onConfirm(action.mode)} />
          ))}
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[12px] text-[#ffb3b5] select-text">
          {error}
        </p>
      )}
    </div>
  )
}

function ActionCard({ action, busy, onClick }: { action: PlanAction; busy: boolean; onClick: () => void }) {
  const unavailable = !!action.disabled
  const tone =
    action.primary && !unavailable
      ? 'border-accent/50 bg-accent/10 enabled:hover:border-accent enabled:hover:bg-accent/15'
      : 'border-line enabled:hover:border-muted enabled:hover:bg-raised'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || unavailable}
      className={`group flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition disabled:cursor-default ${tone} ${
        unavailable ? 'opacity-60' : busy ? 'opacity-40' : ''
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{action.label}</span>
        <span className={`mt-0.5 block text-[12px] leading-relaxed ${unavailable ? 'text-amber-200' : 'text-muted'}`}>
          {action.disabled ?? action.description}
        </span>
      </span>
      {!unavailable && (
        <span className="shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-text">
          →
        </span>
      )}
    </button>
  )
}

function Callout({ tone, children }: { tone: 'info' | 'warning' | 'error'; children: ReactNode }) {
  const tones = {
    info: 'border-line text-muted',
    warning: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    error: 'border-accent/30 bg-accent/10 text-[#ffb3b5]'
  }
  return <p className={`mt-3 rounded-md border px-3 py-2 text-[12px] leading-relaxed ${tones[tone]}`}>{children}</p>
}
