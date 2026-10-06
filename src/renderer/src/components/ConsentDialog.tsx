import type { ConsentRequest } from '@shared/types'

interface Props {
  request: ConsentRequest
  /** What accepting generates and what it costs, e.g. "3 klipp · $1.13". */
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
          <h2 className="text-base font-semibold">Modellen kräver godkännande</h2>
          <p className="mt-1 text-muted">
            Leverantören ({request.flow}) vill att du godkänner sin policy innan genereringen skickas.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto whitespace-pre-wrap p-5 leading-relaxed text-muted select-text">
          {request.policyText || 'Ingen policytext skickades med.'}
        </div>
        <div className="space-y-1 border-t border-line p-5 text-muted">
          <p>Genom att godkänna intygar du att:</p>
          <ul className="list-disc pl-5">
            <li>du accepterar villkoren och integritetspolicyn ovan,</li>
            <li>du har laglig rätt att använda bilderna du skickar in,</li>
            <li>du förstår att bilderna kan granskas innan de behandlas.</li>
          </ul>
          <p className="pt-1 text-[11px]">
            Godkännandet sparas för policyversion {request.version || '–'} och skickas med framtida genereringar.
          </p>
          {cost && <p className="pt-2 text-text">Genereras sedan: {cost}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-line p-4">
          <button onClick={onCancel} className="rounded-md border border-line px-4 py-2 hover:bg-raised">
            Avbryt
          </button>
          <button
            onClick={onAccept}
            className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover"
          >
            Godkänn och generera
          </button>
        </div>
      </div>
    </div>
  )
}
