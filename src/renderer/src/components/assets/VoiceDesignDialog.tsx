import { useEffect, useState } from 'react'
import type { Asset, EditJob, EditPlan, PromptLanguage, VoiceDesignRequest } from '@shared/types'
import { withBudgetConfirm } from '../../lib/budget'
import { ipcErrorMessage } from '../../lib/hooks'
import { formatPrice, needsConfirm, priceCheck } from '../editor/editorUtils'
import { PLAN_DEBOUNCE_MS } from '../editor/useEditOps'
import { PlanNotes, priceLabel, textArea } from '../editor/ui'
import Modal from '../pickers/Modal'
import { usePromptLanguage } from '../prompt/usePromptLanguage'

// "Design a voice with AI…" (Characters → Voice): a new voice for the character from a description, spoken with a
// sample text, saved as a new Voice clip. Paid (Venice's flat quote); the price is on the button, like everywhere else.

/**
 * A neutral sentence that shows how a voice sounds, in the prompt language (Settings → Prompt language), since it is
 * what the new voice speaks – and so what later generations hear it speak.
 */
const DEFAULT_SAMPLE: Record<PromptLanguage, string> = {
  en: "Hi! This is my voice. I'm speaking calmly and clearly, so you can hear how I sound.",
  sv: 'Hej! Det här är min röst. Jag pratar lugnt och tydligt, så att du hör hur jag låter.'
}
const DEFAULT_SAMPLES: readonly string[] = Object.values(DEFAULT_SAMPLE)

interface Props {
  asset: Asset
  onClose: () => void
  /** The job is on its way; its progress comes through onEditProgress (assetId). */
  onStarted: (job: EditJob) => void
}

export default function VoiceDesignDialog({ asset, onClose, onStarted }: Props) {
  const [description, setDescription] = useState('')
  const language = usePromptLanguage()
  const [sample, setSample] = useState(() => DEFAULT_SAMPLE[language])
  const [plan, setPlan] = useState<EditPlan>()
  const [planning, setPlanning] = useState(false)
  const [error, setError] = useState<string>()
  const [sending, setSending] = useState(false)
  const [confirming, setConfirming] = useState(false)

  // The setting arrives from main a moment after the dialog opens; a sample nobody has changed follows it.
  useEffect(() => {
    setSample((s) => (DEFAULT_SAMPLES.includes(s) ? DEFAULT_SAMPLE[language] : s))
  }, [language])

  const request: VoiceDesignRequest = { assetId: asset.id, description: description.trim(), sampleText: sample.trim() }
  const key = `${request.description}\n${request.sampleText}`
  const missing = !request.description
    ? 'Describe the voice.'
    : !request.sampleText
      ? 'Write a sample text.'
      : undefined

  // Planned (and priced) 600 ms after the last change, like the operations in the Editor.
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
      // Past the budget the user is asked first; no leaves the dialog open with nothing sent.
      const job = await withBudgetConfirm((confirmed) =>
        window.studio.designVoice(request, plan.priceUsd ?? 0, confirmed ? { confirmOverBudget: true } : undefined)
      )
      if (!job) {
        setSending(false)
        return
      }
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
        title="Design a voice with AI"
        subtitle={`A new voice for ${asset.name}, saved as a voice clip.`}
        onClose={onClose}
        maxWidth={500}
        footer={
          confirming && plan ? (
            // The extra question above $5 (or without a price) is asked here, in the dialog itself.
            <>
              <span className="mr-auto text-[12px] leading-snug text-muted">
                {plan.priceUsd === undefined
                  ? "Venice doesn't give a price for this in advance. Continue?"
                  : `This costs ${formatPrice(plan.priceUsd)}. Continue?`}
              </span>
              <button
                type="button"
                autoFocus
                onClick={() => setConfirming(false)}
                className="rounded-md border border-line px-4 py-2 hover:bg-raised"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false)
                  void send()
                }}
                className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover"
              >
                {plan.priceUsd !== undefined ? `Continue · ${formatPrice(plan.priceUsd)}` : 'Continue'}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} className="rounded-md border border-line px-4 py-2 hover:bg-raised">
                Cancel
              </button>
              <button
                type="button"
                onClick={click}
                disabled={!!blocked || planning || !plan || sending}
                title={blocked}
                className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
              >
                {sending ? 'Sending…' : 'Design voice'}
                {!sending && price && <span className="text-white/80">· {price}</span>}
              </button>
            </>
          )
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-muted">Describe the voice</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              autoFocus
              spellCheck={false}
              placeholder="A calm, deep male voice around fifty, slightly hoarse"
              className={textArea}
            />
            <span className="mt-1 block text-[11px] text-muted">Gender, age, timbre, pace – preferably in English.</span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-muted">Sample text</span>
            <textarea value={sample} onChange={(e) => setSample(e.target.value)} rows={2} className={textArea} />
            <span className="mt-1 block text-[11px] text-muted">What the voice says in the clip.</span>
          </label>
          <PlanNotes
            plan={plan}
            error={error}
            extraNotes={language === 'sv' ? ["How well the voice works in Swedish hasn't been tested yet."] : undefined}
          />
        </div>
      </Modal>
    </>
  )
}
