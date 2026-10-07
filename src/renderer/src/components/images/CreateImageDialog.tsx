import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { kindOfModelId } from '@shared/models'
import {
  NEEDS_CONSENT,
  type ConsentRequest,
  type ImageModel,
  type SegmentImageSlot,
  type Sequence,
  type Still,
  type StillParams
} from '@shared/types'
import { ASSET_VIEW } from '../../lib/assets'
import { ipcErrorMessage, useAssets } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import ConsentDialog from '../ConsentDialog'
import Modal from '../pickers/Modal'
import {
  aspectRatioLabel,
  formatImagePrice,
  maxInputImages,
  modeOf,
  modelsForMode,
  pickImageModel,
  plainImagePrompt,
  qualityLabel,
  ratioOf,
  rememberImageModel,
  rememberedImageModel,
  snapImageOptions,
  stillParamsForSubmit,
  useImageModels,
  useStillQuote,
  useStills,
  type ImageMode,
  type ImageOptions
} from './imageModels'
import ReferenceImages from './ReferenceImages'
import StillThumb from './StillThumb'
import StillViewer from './StillViewer'

export interface CreateImageDialogProps {
  open: boolean
  /**
   * The sequence the image is for: it is saved in the sequence's Storyboard folder, gets the sequence's aspect
   * ratio by default, and the sequence's stills are offered as references. Without one it goes to Referensbilder.
   */
  sequenceId?: string
  /** Prefills the prompt (e.g. the clip's notes or prompt); @ImageN tokens are taken out. */
  initialPrompt?: string
  /**
   * The clip slot the dialog was opened from. The result then offers "Använd som startbild / slutbild", which
   * puts it there (setSegmentImage) and closes the dialog; the slot given here is the main choice.
   */
  assign?: { segmentId: string; slot: SegmentImageSlot }
  onClose: () => void
  /** Every image created, as soon as it is saved as a still (also when the user creates several). */
  onCreated?: (still: Still) => void
  /** After the dialog put a result into the clip, with the updated sequence. */
  onAssigned?: (sequence: Sequence, slot: SegmentImageSlot, still: Still) => void
  /** Lets the dialog link to Settings and the library views (it closes first). */
  navigate?: Navigate
}

/**
 * "Skapa bild…": a still from a prompt, or from reference images combined by an edit model (characters,
 * environments, outfits, poses, the sequence's stills), with the model's options and its live price. Paid: the
 * button shows the price, and nothing is sent before it is pressed.
 */
export default function CreateImageDialog(props: CreateImageDialogProps) {
  // Mounted only while open, so every opening starts from the props (prompt, slot) with nothing left over.
  if (!props.open) return null
  return <CreateImageDialogBody {...props} />
}

const select = 'w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted'
const field = 'w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted'

/** Venice's consent request in an error message, if that is what it is. */
function consentOf(message: string): ConsentRequest | undefined {
  const i = message.indexOf(NEEDS_CONSENT)
  if (i === -1) return undefined
  try {
    return JSON.parse(message.slice(i + NEEDS_CONSENT.length)) as ConsentRequest
  } catch {
    return undefined
  }
}

function CreateImageDialogBody({
  sequenceId,
  initialPrompt,
  assign,
  onClose,
  onCreated,
  onAssigned,
  navigate
}: CreateImageDialogProps) {
  const { models, loaded: modelsLoaded, error: modelsError } = useImageModels()
  const assets = useAssets()
  const { stills } = useStills(sequenceId)

  // The sequence gives the default aspect ratio, the dialog's subtitle and, with a slot, the clip.
  const [sequence, setSequence] = useState<Sequence>()
  useEffect(() => {
    if (!sequenceId) return
    let active = true
    window.studio.getSequence(sequenceId).then(
      (s) => active && setSequence(s),
      () => {}
    )
    return () => {
      active = false
    }
  }, [sequenceId])
  const segmentIndex = assign && sequence ? sequence.segments.findIndex((s) => s.id === assign.segmentId) : -1
  const segment = segmentIndex === -1 ? undefined : sequence?.segments[segmentIndex]
  const sequenceAspect =
    sequence?.defaults.aspectRatio ?? sequence?.segments.find((s) => s.params.aspectRatio)?.params.aspectRatio ?? '16:9'

  // ── Form ────────────────────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState(() => plainImagePrompt(initialPrompt ?? ''))
  const [negativePrompt, setNegativePrompt] = useState('')
  const [references, setReferences] = useState<string[]>([])
  const [referenceNote, setReferenceNote] = useState<string>()
  const [chosen, setChosen] = useState<Record<ImageMode, string | undefined>>(() => ({
    text: rememberedImageModel('text'),
    edit: rememberedImageModel('edit')
  }))
  const [options, setOptions] = useState<ImageOptions>({})
  // Until the user picks an aspect ratio, it follows the sequence's (which may arrive after the models).
  const aspectTouched = useRef(false)

  const mode = modeOf(references.length)
  const model = pickImageModel(models, mode, chosen[mode])
  const editModel = mode === 'edit' ? model : pickImageModel(models, 'edit', chosen.edit)
  const maxReferences = maxInputImages(editModel)
  const modelList = useMemo(() => modelsForMode(models, mode), [models, mode])

  useEffect(() => {
    if (!model) return
    setOptions((o) =>
      snapImageOptions(model, aspectTouched.current ? o : { ...o, aspectRatio: undefined }, sequenceAspect)
    )
  }, [model?.id, sequenceAspect])

  useEffect(() => {
    if (!referenceNote) return
    const t = setTimeout(() => setReferenceNote(undefined), 6000)
    return () => clearTimeout(t)
  }, [referenceNote])

  const params: StillParams | undefined = model
    ? stillParamsForSubmit(
        {
          sequenceId,
          prompt,
          negativePrompt,
          model: model.id,
          referenceImages: references,
          aspectRatio: options.aspectRatio,
          resolution: options.resolution,
          quality: options.quality
        },
        model
      )
    : undefined
  const { price, pending: pricePending } = useStillQuote(params)

  const missing = !modelsLoaded
    ? 'Hämtar modeller…'
    : modelsError
      ? 'Modellerna kunde inte hämtas'
      : !model
        ? mode === 'edit'
          ? 'Ingen modell kan kombinera bilder just nu'
          : 'Ingen bildmodell är tillgänglig just nu'
        : !prompt.trim()
          ? 'Skriv vad bilden ska visa'
          : undefined

  // ── Creating ────────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string>()
  const [results, setResults] = useState<Still[]>([])
  const [currentId, setCurrentId] = useState<string>()
  const [consent, setConsent] = useState<{ request: ConsentRequest; params: StillParams }>()
  const [viewing, setViewing] = useState<Still>()
  const [assigning, setAssigning] = useState(false)
  const current = results.find((r) => r.id === currentId) ?? results[0]
  // Read when a generation answers, which may be after the parent passed new callbacks.
  const callbacks = useRef({ onCreated, onAssigned, onClose })
  useEffect(() => {
    callbacks.current = { onCreated, onAssigned, onClose }
  })

  useEffect(() => {
    if (!busy) return
    setElapsed(0)
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(t)
  }, [busy, startedAt])

  // A paid call: guarded by a ref too, since two quick presses (or ⌘+Enter) can both run before the
  // disabled button has rendered.
  const inFlight = useRef(false)
  const create = async (sent: StillParams | undefined = params) => {
    if (!sent || busy || missing || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setStartedAt(Date.now())
    setError(undefined)
    try {
      const still = await window.studio.generateStill(sent)
      setResults((r) => [still, ...r])
      setCurrentId(still.id)
      callbacks.current.onCreated?.(still)
    } catch (e) {
      const message = ipcErrorMessage(e)
      const request = consentOf(message)
      if (request) setConsent({ request, params: sent })
      else setError(message)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const acceptConsent = async () => {
    if (!consent) return
    const sent = consent.params
    setConsent(undefined)
    try {
      await window.studio.acceptConsent(consent.request.flow, consent.request.version)
    } catch (e) {
      setError(ipcErrorMessage(e))
      return
    }
    // The form can't change while the terms are shown (nothing but this dialog edits it), so this is what the
    // button priced.
    await create(sent)
  }

  const assignTo = async (slot: SegmentImageSlot, still: Still) => {
    if (!assign || assigning) return
    setAssigning(true)
    setError(undefined)
    try {
      const updated = await window.studio.setSegmentImage(assign.segmentId, slot, { kind: 'still', stillId: still.id })
      callbacks.current.onAssigned?.(updated, slot, still)
      callbacks.current.onClose()
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setAssigning(false)
    }
  }

  const chooseModel = (id: string) => {
    setChosen((c) => ({ ...c, [mode]: id }))
    rememberImageModel(mode, id)
  }

  const goTo = navigate
    ? (view: Parameters<Navigate>[0]) => {
        onClose()
        navigate(view)
      }
    : undefined

  // Escape and a click outside close the dialog, except while something is open on top of it: a picker or the
  // full-size viewer close on those themselves, and only they should go.
  const pickerOpen = useRef(false)
  const closeDialog = () => {
    if (pickerOpen.current) return
    if (viewing) setViewing(undefined)
    else onClose()
  }

  const clipNumber = segmentIndex === -1 ? undefined : segmentIndex + 1
  // What putting the image into the clip changes besides the slot (main does it; the user should know first).
  const assignNotes: string[] = []
  if (assign && segment && clipNumber) {
    if (kindOfModelId(segment.params.model) === 'reference-to-video' && segment.params.referenceImages?.length) {
      assignNotes.push(
        `Klipp ${clipNumber} görs i dag med referensbilder. Med en start- eller slutbild görs det som ` +
          'bild-till-video i stället, och referensbilderna tas bort från klippet.'
      )
    }
    if (assign.slot === 'start' && segment.continueFromPrevious) {
      assignNotes.push(
        `Klipp ${clipNumber} fortsätter i dag från klipp ${clipNumber - 1}. Som startbild ersätter bilden det.`
      )
    }
    if (assign.slot === 'end' && segment.endFromNext) {
      assignNotes.push(
        `Klipp ${clipNumber} slutar i dag där klipp ${clipNumber + 1} börjar. Som slutbild ersätter bilden det.`
      )
    }
  }
  const slotWord = (slot: SegmentImageSlot) => (slot === 'start' ? 'startbild' : 'slutbild')
  const subtitle = assign
    ? clipNumber
      ? `Till klipp ${clipNumber} – ${slotWord(assign.slot)}. Bilden sparas också bland sekvensens bilder.`
      : `Till klippets ${slotWord(assign.slot)}. Bilden sparas också bland sekvensens bilder.`
    : sequenceId
      ? `Sparas bland bilderna i ${sequence ? `”${sequence.name}”` : 'sekvensen'} – ` +
        'dra den sedan till en ruta i storyboarden.'
      : 'Sparas i Referensbilder.'

  const priceText = pricePending ? '…' : formatImagePrice(price)
  const createLabel = busy ? 'Skapar…' : (missing ?? (results.length ? 'Skapa igen' : 'Skapa'))

  return (
    <>
      <Modal
        title="Skapa bild"
        subtitle={subtitle}
        onClose={closeDialog}
        maxWidth={980}
        footer={
          <>
            <SafeModeNote onSettings={goTo ? () => goTo('settings') : undefined} />
            <button onClick={onClose} className="rounded-md border border-line px-4 py-2 hover:bg-raised">
              {results.length ? 'Klar' : 'Avbryt'}
            </button>
            <button
              onClick={() => void create()}
              disabled={!!missing || busy || !params}
              title={missing ?? (params?.referenceImages ? 'Kombinera referensbilderna enligt prompten' : undefined)}
              className={`flex items-center gap-2 rounded-md px-4 py-2 font-medium disabled:opacity-40 ${
                current && assign
                  ? 'border border-line text-text hover:bg-raised'
                  : 'bg-accent text-white hover:bg-accent-hover'
              }`}
            >
              <span>{createLabel}</span>
              {!missing && !busy && <span className="opacity-80">({priceText})</span>}
            </button>
          </>
        }
      >
        <div className="grid gap-6 md:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
          {/* Form */}
          <div className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-muted">Vad ska bilden visa?</span>
              <textarea
                autoFocus
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void create()
                  }
                }}
                rows={5}
                placeholder="Wide shot of a woman by a rainy window at dusk, warm lamp light, shallow depth of field"
                className={`${field} resize-y leading-relaxed`}
              />
              <span className="mt-1 block text-[11px] leading-relaxed text-muted">
                Skriv gärna på engelska och beskriv bilden som en filmruta: utsnitt, komposition, ljus och stämning.
                ⌘ + Enter skapar bilden.
              </span>
            </label>

            <ReferenceImages
              value={references}
              onChange={setReferences}
              max={maxReferences}
              assets={assets}
              stills={stills}
              stillsOfSequence={!!sequenceId}
              clipReferences={segment?.params.referenceImages}
              clipNumber={clipNumber}
              onNote={setReferenceNote}
              onManage={goTo ? (kind) => goTo(ASSET_VIEW[kind]) : undefined}
              onPickerOpen={(open) => {
                pickerOpen.current = open
              }}
            />
            {referenceNote && <p className="-mt-2 text-[12px] text-accent">{referenceNote}</p>}

            <label className="block">
              <span className="mb-1.5 flex items-baseline justify-between gap-2 text-muted">
                Modell
                <span className="text-[11px]">
                  {mode === 'edit' ? 'Kombinerar referensbilderna' : 'Skapar bilden från prompten'}
                </span>
              </span>
              {modelsError ? (
                <p className="text-[12px] text-accent select-text">{modelsError}</p>
              ) : (
                <select
                  value={model?.id ?? ''}
                  onChange={(e) => chooseModel(e.target.value)}
                  disabled={!modelList.length}
                  className={select}
                >
                  {!modelList.length && <option value="">{modelsLoaded ? 'Inga modeller' : 'Hämtar modeller…'}</option>}
                  {modelList.map((m) => (
                    <option key={m.id} value={m.id} disabled={m.offline}>
                      {modelOptionLabel(m, mode)}
                    </option>
                  ))}
                </select>
              )}
            </label>

            {model && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(112px,1fr))] gap-2">
                {model.aspectRatios.length > 0 && (
                  <label className="block">
                    <span className="mb-1.5 block text-muted">Bildformat</span>
                    <select
                      value={options.aspectRatio ?? ''}
                      onChange={(e) => {
                        aspectTouched.current = true
                        setOptions((o) => ({ ...o, aspectRatio: e.target.value }))
                      }}
                      className={select}
                    >
                      {model.aspectRatios.map((r) => (
                        <option key={r} value={r}>
                          {aspectRatioLabel(r)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {model.resolutions.length > 0 && (
                  <label className="block">
                    <span className="mb-1.5 block text-muted">Upplösning</span>
                    <select
                      value={options.resolution ?? ''}
                      onChange={(e) => setOptions((o) => ({ ...o, resolution: e.target.value }))}
                      className={select}
                    >
                      {model.resolutions.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {model.qualities.length > 0 && (
                  <label className="block">
                    <span className="mb-1.5 block text-muted">Kvalitet</span>
                    <select
                      value={options.quality ?? ''}
                      onChange={(e) => setOptions((o) => ({ ...o, quality: e.target.value }))}
                      className={select}
                    >
                      {model.qualities.map((q) => (
                        <option key={q} value={q}>
                          {qualityLabel(q)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
            {model && options.aspectRatio && options.aspectRatio !== sequenceAspect && sequenceId && (
              <p className="-mt-2 text-[11px] leading-relaxed text-muted">
                Sekvensen är i {sequenceAspect}. En start- eller slutbild i ett annat format ger klippet det formatet.
              </p>
            )}

            {mode === 'text' && (
              <label className="block">
                <span className="mb-1.5 block text-muted">Undvik (negativ prompt, valfri)</span>
                <input
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  placeholder="text, watermark, extra fingers"
                  className={field}
                />
              </label>
            )}
          </div>

          {/* Result */}
          <ResultPanel
            busy={busy}
            elapsed={elapsed}
            error={error}
            results={results}
            current={current}
            aspectRatio={options.aspectRatio ?? sequenceAspect}
            onSelect={(s) => setCurrentId(s.id)}
            onView={setViewing}
            assign={assign}
            clipNumber={clipNumber}
            assignNotes={assignNotes}
            assigning={assigning}
            onAssign={(slot, still) => void assignTo(slot, still)}
          />
        </div>
      </Modal>

      <StillViewer still={viewing} stills={results} onClose={() => setViewing(undefined)} />

      {/* In the body like the dialog's own portal, so it lands on top of it. */}
      {consent &&
        createPortal(
          <ConsentDialog
            request={consent.request}
            cost={`1 bild · ${formatImagePrice(price)}`}
            onAccept={() => void acceptConsent()}
            onCancel={() => setConsent(undefined)}
          />,
          document.body
        )}
    </>
  )
}

/** "Seedream V5 Pro · max 6 bilder", "Flux 2 Pro (offline)". */
function modelOptionLabel(m: ImageModel, mode: ImageMode): string {
  const extra = [mode === 'edit' ? `högst ${m.maxInputImages} bilder` : undefined, m.offline ? 'offline' : undefined]
    .filter(Boolean)
    .join(', ')
  return extra ? `${m.name} (${extra})` : m.name
}

interface ResultProps {
  busy: boolean
  elapsed: number
  error?: string
  /** This dialog's images, newest first. */
  results: Still[]
  current?: Still
  aspectRatio: string
  onSelect: (still: Still) => void
  onView: (still: Still) => void
  assign?: { segmentId: string; slot: SegmentImageSlot }
  clipNumber?: number
  /** What assigning changes in the clip besides the slot. */
  assignNotes: string[]
  assigning: boolean
  onAssign: (slot: SegmentImageSlot, still: Still) => void
}

/** The latest image (or the one picked among this dialog's results), with where it can go. */
function ResultPanel({
  busy,
  elapsed,
  error,
  results,
  current,
  aspectRatio,
  onSelect,
  onView,
  assign,
  clipNumber,
  assignNotes,
  assigning,
  onAssign
}: ResultProps) {
  // The placeholder's shape; 16:9 for "auto".
  const ratio = ratioOf(aspectRatio) ?? 16 / 9
  // The slot the dialog was opened from first; the other one is offered too, since a keyframe often fits both.
  const slots: SegmentImageSlot[] = assign ? (assign.slot === 'start' ? ['start', 'end'] : ['end', 'start']) : []

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div
        className="relative flex w-full items-center justify-center overflow-hidden rounded-lg border border-line bg-bg"
        style={{ aspectRatio: current && !busy ? undefined : String(ratio), minHeight: 180 }}
      >
        {busy ? (
          <div className="flex flex-col items-center gap-2 px-6 text-center text-muted">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
            <span>Skapar bilden… {elapsed > 0 && `${elapsed} s`}</span>
            <span className="text-[11px]">
              Brukar ta 5–30 sekunder. Stänger du rutan blir bilden klar ändå och hamnar bland sekvensens bilder.
            </span>
          </div>
        ) : current ? (
          <button
            onClick={() => onView(current)}
            title="Visa i full storlek"
            className="block max-h-[56vh] w-full cursor-zoom-in"
          >
            <img
              src={mediaUrl(current.path)}
              alt=""
              draggable={false}
              className="mx-auto max-h-[56vh] w-auto max-w-full object-contain"
            />
          </button>
        ) : (
          <p className="px-6 text-center text-muted">Bilden visas här.</p>
        )}
      </div>

      {error && (
        <p className="max-h-32 overflow-y-auto rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-[12px] leading-relaxed text-accent select-text">
          {error}
        </p>
      )}

      {current && !busy && assign && assignNotes.length > 0 && (
        <p className="text-[11px] leading-relaxed text-muted">{assignNotes.join(' ')}</p>
      )}

      {current && !busy && (
        <div className="flex flex-wrap items-center gap-2">
          {slots.map((slot, i) => (
            <button
              key={slot}
              onClick={() => onAssign(slot, current)}
              disabled={assigning}
              title={
                clipNumber
                  ? `Lägg bilden i klipp ${clipNumber}s ${slot === 'start' ? 'startruta' : 'slutruta'}`
                  : undefined
              }
              className={
                i === 0
                  ? 'rounded-md bg-accent px-3.5 py-1.5 font-medium text-white hover:bg-accent-hover disabled:opacity-40'
                  : 'rounded-md border border-line px-3.5 py-1.5 hover:bg-raised disabled:opacity-40'
              }
            >
              {slot === 'start' ? 'Använd som startbild' : 'Använd som slutbild'}
            </button>
          ))}
          <button
            onClick={() => void window.studio.revealFile(current.path)}
            className="rounded-md px-2.5 py-1.5 text-muted hover:bg-raised hover:text-text"
          >
            Visa i Finder
          </button>
          <span className="ml-auto text-[11px] text-muted">
            {current.costUsd !== undefined && `${formatImagePrice(current.costUsd)} · `}Sparad
          </span>
        </div>
      )}

      {results.length > 1 && (
        <div>
          <p className="mb-1.5 text-[11px] text-muted">Skapade nu – klicka för att välja</p>
          <div className="flex flex-wrap gap-1.5">
            {results.map((s) => (
              <StillThumb
                key={s.id}
                still={s}
                selected={s.id === current?.id}
                onOpen={onSelect}
                className="aspect-video w-20"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Whether Venice blurs adult content in the image ("Säkert läge för bilder" in Settings), switchable here too
 * so the setting doesn't come as a surprise after paying for a blurred picture.
 */
function SafeModeNote({ onSettings }: { onSettings?: () => void }) {
  const [on, setOn] = useState<boolean>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    const read = () =>
      window.studio.getSettings().then(
        (s) => active && setOn(s.imageSafeMode !== false),
        () => {}
      )
    void read()
    // Changed in Inställningar (or another dialog) while this one is open.
    const off = window.studio.onSettingsChange(() => void read())
    return () => {
      active = false
      off()
    }
  }, [])

  const toggle = async () => {
    if (on === undefined) return
    const next = !on
    setOn(next)
    setError(undefined)
    try {
      await window.studio.setImageSafeMode(next)
    } catch (e) {
      setOn(!next)
      setError(ipcErrorMessage(e))
    }
  }

  if (on === undefined) return <span className="mr-auto" />
  return (
    <p className="mr-auto max-w-md text-[11px] leading-relaxed text-muted">
      {error ? (
        <span className="text-accent">{error}</span>
      ) : on ? (
        <>Säkert läge är på – Venice suddar ut vuxet innehåll i bilden. </>
      ) : (
        <>Säkert läge är av – Venice suddar inte ut vuxet innehåll. </>
      )}
      <button onClick={() => void toggle()} className="text-text underline-offset-2 hover:underline">
        {on ? 'Stäng av' : 'Slå på'}
      </button>
      {onSettings && (
        <>
          {' · '}
          <button onClick={onSettings} className="text-text underline-offset-2 hover:underline">
            Inställningar
          </button>
        </>
      )}
    </p>
  )
}

export { CreateImageDialog }
