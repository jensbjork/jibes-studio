import { useEffect, useState } from 'react'
import type { Asset, EditJob, EditPlan, VoiceDesignRequest } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { formatPrice, needsConfirm, priceCheck } from '../editor/editorUtils'
import { PLAN_DEBOUNCE_MS } from '../editor/useEditOps'
import { PlanNotes, priceLabel, textArea } from '../editor/ui'
import Modal from '../pickers/Modal'

// "Skapa röst med AI…" (Karaktärer → Röst): a new voice for the character from a description, spoken with a sample
// text, saved as a new Röst clip. Paid (Venice's flat quote); the price is on the button, like everywhere else.

/** A neutral Swedish sentence that shows how a voice sounds. */
const DEFAULT_SAMPLE = 'Hej! Det här är min röst. Jag pratar lugnt och tydligt, så att du hör hur jag låter.'

interface Props {
  asset: Asset
  onClose: () => void
  /** The job is on its way; its progress comes through onEditProgress (assetId). */
  onStarted: (job: EditJob) => void
}

export default function VoiceDesignDialog({ asset, onClose, onStarted }: Props) {
  const [description, setDescription] = useState('')
  const [sample, setSample] = useState(DEFAULT_SAMPLE)
  const [plan, setPlan] = useState<EditPlan>()
  const [planning, setPlanning] = useState(false)
  const [error, setError] = useState<string>()
  const [sending, setSending] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const request: VoiceDesignRequest = { assetId: asset.id, description: description.trim(), sampleText: sample.trim() }
  const key = `${request.description}\n${request.sampleText}`
  const missing = !request.description
    ? 'Beskriv rösten.'
    : !request.sampleText
      ? 'Skriv en provtext.'
      : undefined

  // Planned (and priced) 600 ms after the last change, like the operations in Redigera.
  useEffect(() => {
    // A changed text asks again: the question was about the old price.
    setConfirming(false)
    if (missing) {
      setPlan(undefined)
      return
    }
    let active = true
    setPlanning(true)
    const t = setTimeout(() => {
      window.studio.planVoiceDesign(request).then(
        (p) => {
          if (!active) return
          setPlan(p)
          setError(undefined)
          setPlanning(false)
        },
        (e: unknown) => {
          if (!active) return
          setError(ipcErrorMessage(e))
          setPlanning(false)
        }
      )
    }, PLAN_DEBOUNCE_MS)
    return () => {
      active = false
      clearTimeout(t)
    }
  }, [key])

  const send = async () => {
    if (!plan || sending) return
    setSending(true)
    setError(undefined)
    try {
      // An unknown price was confirmed as unknown; main only compares a known one.
      const job = await window.studio.designVoice(request, plan.priceUsd ?? 0)
      onStarted(job)
      onClose()
    } catch (e) {
      setError(ipcErrorMessage(e))
      setSending(false)
    }
  }

  const click = () => {
    if (!plan || plan.problems.length) return
    if (needsConfirm(priceCheck(plan))) setConfirming(true)
    else void send()
  }

  const blocked = missing ?? plan?.problems[0]
  const price = planning && !plan ? '…' : priceLabel(plan)

  return (
    <>
      <Modal
        title="Skapa röst med AI"
        subtitle={`En ny röst för ${asset.name}, sparad som ett röstklipp.`}
        onClose={onClose}
        maxWidth={500}
        footer={
          confirming && plan ? (
            // The extra question above $5 (or without a price) is asked here, in the dialog itself.
            <>
              <span className="mr-auto text-[12px] leading-snug text-muted">
                {plan.priceUsd === undefined
                  ? 'Venice anger inget pris för det här i förväg. Fortsätt?'
                  : `Det här kostar ${formatPrice(plan.priceUsd)}. Fortsätt?`}
              </span>
              <button
                type="button"
                autoFocus
                onClick={() => setConfirming(false)}
                className="rounded-md border border-line px-4 py-2 hover:bg-raised"
              >
                Avbryt
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false)
                  void send()
                }}
                className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover"
              >
                {plan.priceUsd !== undefined ? `Fortsätt · ${formatPrice(plan.priceUsd)}` : 'Fortsätt'}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} className="rounded-md border border-line px-4 py-2 hover:bg-raised">
                Avbryt
              </button>
              <button
                type="button"
                onClick={click}
                disabled={!!blocked || planning || !plan || sending}
                title={blocked}
                className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
              >
                {sending ? 'Skickar…' : 'Skapa röst'}
                {!sending && price && <span className="text-white/80">· {price}</span>}
              </button>
            </>
          )
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-muted">Beskriv rösten</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              autoFocus
              spellCheck={false}
              placeholder="A calm, deep male voice around fifty, slightly hoarse"
              className={textArea}
            />
            <span className="mt-1 block text-[11px] text-muted">Kön, ålder, klang, tempo – gärna på engelska.</span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-muted">Provtext</span>
            <textarea value={sample} onChange={(e) => setSample(e.target.value)} rows={2} className={textArea} />
            <span className="mt-1 block text-[11px] text-muted">Det rösten säger i klippet.</span>
          </label>
          <PlanNotes
            plan={plan}
            error={error}
            extraNotes={['Hur bra rösten blir på svenska är inte prövat än.']}
          />
        </div>
      </Modal>
    </>
  )
}
