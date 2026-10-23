import { useEffect, useId } from 'react'
import { createPortal } from 'react-dom'
import type { ConsentRequest } from '@shared/types'
import { buttonClass } from './ui/button'

interface Props {
  request: ConsentRequest
  /** What accepting generates and what it costs, e.g. "3 clips · $1.13". */
  cost?: string
  onAccept: () => void
  onCancel: () => void
}

/**
 * Shown when Venice answers 409 needs_consent; acceptance is remembered per policy version. A question over
 * everything (it may come from a dialog): Esc or a click beside it says no, and Cancel has the focus, so a stray
 * Enter accepts nothing. The policy scrolls; what you confirm and what it costs stay by the buttons.
 */
export default function ConsentDialog({ request, cost, onAccept, onCancel }: Props) {
  const titleId = useId()
  const textId = useId()

  useEffect(() => {
    // Before every other key handler (a dialog underneath listens on the document, a view on the window).
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onCancel])

  return createPortal(
    // no-drag: the overlay covers the view's title-bar drag region.
    <div
      className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      // mousedown (not click) so a text selection that ends on the backdrop doesn't say no.
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        className="flex max-h-full w-full max-w-lg flex-col rounded-xl border border-line bg-panel text-text shadow-2xl"
      >
        <div className="shrink-0 border-b border-line p-5">
          <h2 id={titleId} className="text-base font-semibold">
            The model needs your consent
          </h2>
          <p id={textId} className="mt-1 text-muted">
            The provider ({request.flow}) wants you to accept its policy before the generation is sent.
          </p>
        </div>
        <div className="max-h-[40vh] min-h-0 overflow-y-auto whitespace-pre-wrap p-5 leading-relaxed text-muted select-text">
          {request.policyText || 'No policy text was included.'}
        </div>
        <div className="shrink-0 space-y-1 border-t border-line p-5 text-muted">
          <p>By accepting you confirm that:</p>
          <ul className="list-disc pl-5">
            <li>you accept the terms and privacy policy above,</li>
            <li>you have the legal right to use the images you send,</li>
            <li>you understand that the images may be reviewed before they are processed.</li>
          </ul>
          <p className="pt-1 text-[11px]">
            Your consent is saved for policy version {request.version || '–'} and sent with future generations.
          </p>
          {cost && <p className="pt-2 text-text">Then generates: {cost}</p>}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-line p-4">
          <button type="button" autoFocus onClick={onCancel} className={buttonClass('secondary')}>
            Cancel
          </button>
          <button type="button" onClick={onAccept} className={buttonClass('primary')}>
            Approve and generate
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
