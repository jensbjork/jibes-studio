import type { ConsentRequest } from '@shared/types'

interface Props {
  request: ConsentRequest
  /** What accepting generates and what it costs, e.g. "3 clips · $1.13". */
  cost?: string
  onAccept: () => void
  onCancel: () => void
}

/** Shown when Venice answers 409 needs_consent; acceptance is remembered per policy version. */
export default function ConsentDialog({ request, cost, onAccept, onCancel }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8">
      <div className="flex max-h-full w-full max-w-lg flex-col rounded-xl border border-line bg-panel shadow-2xl">
        <div className="border-b border-line p-5">
          <h2 className="text-base font-semibold">The model needs your consent</h2>
          <p className="mt-1 text-muted">
            The provider ({request.flow}) wants you to accept its policy before the generation is sent.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto whitespace-pre-wrap p-5 leading-relaxed text-muted select-text">
          {request.policyText || 'No policy text was included.'}
        </div>
        <div className="space-y-1 border-t border-line p-5 text-muted">
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
        <div className="flex justify-end gap-2 border-t border-line p-4">
          <button onClick={onCancel} className="rounded-md border border-line px-4 py-2 hover:bg-raised">
            Cancel
          </button>
          <button
            onClick={onAccept}
            className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover"
          >
            Approve and generate
          </button>
        </div>
      </div>
    </div>
  )
}
