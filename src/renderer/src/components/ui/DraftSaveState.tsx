import type { DraftStatus } from '../sequences/useDraft'

/**
 * How an autosaving field's last change is doing: nothing once it is saved (like every other field that saves as you
 * type), "Saving…" on its way, "Couldn't save" with the reason as its tooltip.
 */
export default function DraftSaveState({
  status,
  error,
  className = ''
}: {
  status: DraftStatus
  error?: string
  className?: string
}) {
  return (
    <span aria-live="polite" className={`text-[11px] text-muted ${className}`}>
      {error ? (
        <span className="text-danger" title={error}>
          Couldn't save
        </span>
      ) : status !== 'idle' ? (
        'Saving…'
      ) : null}
    </span>
  )
}

export { DraftSaveState }
