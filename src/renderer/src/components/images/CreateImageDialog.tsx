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
  type StillParams,
  type Storyboard
} from '@shared/types'
import { ASSET_VIEW } from '../../lib/assets'
import { ipcErrorMessage, useAssets } from '../../lib/hooks'
import { samePath } from '../../lib/library'
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
  mayPlaceOnBoard,
  snapImageOptions,
  stillParamsForSubmit,
  useImageModels,
  useStillQuote,
  useStills,
  withPreviousReference,
  type ImageMode,
  type ImageOptions
} from './imageModels'
import ReferenceImages from './ReferenceImages'
import StillThumb from './StillThumb'
import StillViewer from './StillViewer'

/** Where a created image is put, besides being saved as a still. */
export type CreateImageTarget =
  /**
   * A sequence clip's start or end image. The result offers "Använd som startbild / slutbild" (setSegmentImage),
   * which puts it there and closes the dialog; the slot given here is the main choice.
   */
  | { segmentId: string; slot: SegmentImageSlot }
  /**
   * A storyboard's board (sequenceId is then the storyboard's id). Every new image is put on the board as soon as
   * it is made (updateBoard), unless the board got another image meanwhile; an earlier result can be put back.
   */
  | { boardId: string }

export interface CreateImageDialogProps {
  open: boolean
  /**
   * The sequence or storyboard the image is for: it is saved with its stills (a sequence's Storyboard folder, a
   * storyboard's Bilder folder), gets its aspect ratio by default, and its stills are offered as references.
   * Without one it goes to Referensbilder.
   */
  sequenceId?: string
  /** Prefills the prompt (e.g. the board's note, the clip's notes or prompt); @ImageN tokens are taken out. */
  initialPrompt?: string
  /**
   * The previous board's image (absolute). Offered as "Använd föregående bild som referens", on from the start:
   * it goes first among the references (the base the edit model works from), so people, clothes and place carry
   * over from one milestone to the next.
   */
  previousImagePath?: string
  /** Where a result goes besides the stills (see CreateImageTarget). */
  assign?: CreateImageTarget
  onClose: () => void
  /** Every image created, as soon as it is saved as a still (also when the user creates several). */
  onCreated?: (still: Still) => void
  /** After the dialog put a result into the clip, with the updated sequence. */
  onAssigned?: (sequence: Sequence, slot: SegmentImageSlot, still: Still) => void
  /** After the dialog put a result on the board, with the updated storyboard. */
  onBoardAssigned?: (storyboard: Storyboard, still: Still) => void
  /** Lets the dialog link to Settings and the library views (it closes first). */
  navigate?: Navigate
}

/**
 * "Skapa bild…": a still from a prompt, or from reference images combined by an edit model (characters,
 * environments, outfits, poses, the sequence's or storyboard's own images), with the model's options and its live
 * price. Paid: the button shows the price, and nothing is sent before it is pressed.
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

/** What the image is made for: the sequence or storyboard behind sequenceId, once loaded. */
type Owner = { kind: 'sequence'; sequence: Sequence } | { kind: 'storyboard'; storyboard: Storyboard }

/**
 * Loads the sequence or storyboard behind the id. A board target says it is a storyboard; otherwise it is tried as
 * a sequence first (main refuses storyboard ids there) and then as a storyboard. A storyboard is kept current, since
 * its boards' numbers and images decide the wording and whether a new image may go on the board.
 */
function useOwner(id: string | undefined, isStoryboard: boolean): [Owner | undefined, (owner: Owner) => void] {
  const [owner, setOwner] = useState<Owner>()
  useEffect(() => {
    if (!id) return
    let active = true
    let storyboard = isStoryboard
    let latest = 0
    const loadStoryboard = () => {
      const n = ++latest
      window.studio.getStoryboard(id).then(
        (s) => active && n === latest && setOwner({ kind: 'storyboard', storyboard: s }),
        // Deleted meanwhile, or neither kind: the dialog still works, with plainer wording.
        () => {}
      )
    }
    if (storyboard) loadStoryboard()
    else {
      window.studio.getSequence(id).then(
        (s) => active && setOwner({ kind: 'sequence', sequence: s }),
        () => {
          if (!active) return
          storyboard = true
          loadStoryboard()
        }
      )
    }
    const off = window.studio.onStoryboardChange((changed) => storyboard && changed === id && loadStoryboard())
    return () => {
      active = false
      off()
    }
  }, [id, isStoryboard])
  return [owner, setOwner]
}

function CreateImageDialogBody({
  sequenceId,
  initialPrompt,
  previousImagePath,
  assign,
  onClose,
  onCreated,
  onAssigned,
  onBoardAssigned,
  navigate
}: CreateImageDialogProps) {
  const { models, loaded: modelsLoaded, error: modelsError } = useImageModels()
  const assets = useAssets()
  const { stills } = useStills(sequenceId)

  const slotTarget = assign && 'segmentId' in assign ? assign : undefined
  const boardId = assign && 'boardId' in assign ? assign.boardId : undefined
  const [owner, setOwner] = useOwner(sequenceId, !!boardId)
  const sequence = owner?.kind === 'sequence' ? owner.sequence : undefined
  const storyboard = owner?.kind === 'storyboard' ? owner.storyboard : undefined
  const isStoryboard = !!boardId || !!storyboard
  const ownerName = (storyboard?.name ?? sequence?.name)?.trim() || undefined

  const segmentIndex = slotTarget && sequence ? sequence.segments.findIndex((s) => s.id === slotTarget.segmentId) : -1
  const segment = segmentIndex === -1 ? undefined : sequence?.segments[segmentIndex]
  const boardIndex = boardId && storyboard ? storyboard.boards.findIndex((b) => b.id === boardId) : -1
  const board = boardIndex === -1 ? undefined : storyboard?.boards[boardIndex]
  const boardNumber = boardIndex === -1 ? undefined : boardIndex + 1
  const ownerAspect =
    storyboard?.aspectRatio ??
    sequence?.defaults.aspectRatio ??
    sequence?.segments.find((s) => s.params.aspectRatio)?.params.aspectRatio ??
    '16:9'

  // ── Form ────────────────────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState(() => plainImagePrompt(initialPrompt ?? ''))
  const [negativePrompt, setNegativePrompt] = useState('')
  // The previous board's image starts as the first reference ("Använd föregående bild som referens" is on).
  const [references, setReferences] = useState<string[]>(() => (previousImagePath ? [previousImagePath] : []))
  const [referenceNote, setReferenceNote] = useState<string>()
  const [chosen, setChosen] = useState<Record<ImageMode, string | undefined>>(() => ({
    text: rememberedImageModel('text'),
    edit: rememberedImageModel('edit')
  }))
  const [options, setOptions] = useState<ImageOptions>({})
  // Until the user picks an aspect ratio, it follows the sequence's or storyboard's (which may load after the models).
  const aspectTouched = useRef(false)

  const mode = modeOf(references.length)
  const model = pickImageModel(models, mode, chosen[mode])
  const editModel = mode === 'edit' ? model : pickImageModel(models, 'edit', chosen.edit)
  const maxReferences = maxInputImages(editModel)
  const modelList = useMemo(() => modelsForMode(models, mode), [models, mode])

  useEffect(() => {
    if (!model) return
    setOptions((o) =>
      snapImageOptions(model, aspectTouched.current ? o : { ...o, aspectRatio: undefined }, ownerAspect)
    )
  }, [model?.id, ownerAspect])

  useEffect(() => {
    if (!referenceNote) return
    const t = setTimeout(() => setReferenceNote(undefined), 6000)
    return () => clearTimeout(t)
  }, [referenceNote])

  // Derived from the list, so taking the picture out among the references unticks the box too.
  const usingPrevious = !!previousImagePath && references.includes(previousImagePath)
  const togglePrevious = (on: boolean) => {
    if (!previousImagePath) return
    const next = withPreviousReference(references, previousImagePath, on)
    setReferenceNote(
      on && next.length > maxReferences
        ? `Föregående bild lades först. Modellen tar högst ${maxReferences} bilder, så den sista skickas inte.`
        : undefined
    )
    setReferences(next)
  }

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
  // Why the newest image wasn't put on the board by itself (it got another image meanwhile).
  const [boardNote, setBoardNote] = useState<string>()
  const current = results.find((r) => r.id === currentId) ?? results[0]
  // Read when a generation answers, which may be after the parent passed new callbacks, or after the dialog closed.
  const callbacks = useRef({ onCreated, onAssigned, onBoardAssigned, onClose })
  useEffect(() => {
    callbacks.current = { onCreated, onAssigned, onBoardAssigned, onClose }
  })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const latestOwner = useRef(owner)
  useEffect(() => {
    latestOwner.current = owner
  })
  // The pictures made in this dialog: a board showing one of them may get the next one.
  const madeHere = useRef<string[]>([])

  useEffect(() => {
    if (!busy) return
    setElapsed(0)
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(t)
  }, [busy, startedAt])

  /** The board's image as this dialog last saw it: a path, undefined for an empty board, null when not known. */
  const boardImageSeen = (): string | undefined | null => {
    const o = latestOwner.current
    if (!boardId || o?.kind !== 'storyboard') return null
    const b = o.storyboard.boards.find((x) => x.id === boardId)
    return b ? b.imagePath : null
  }

  /** Puts the still on the board and shows the storyboard as main answered (when the dialog is still open). */
  const putOnBoard = async (still: Still) => {
    if (!boardId) return
    const updated = await window.studio.updateBoard(boardId, { image: { kind: 'still', stillId: still.id } })
    if (mounted.current) setOwner({ kind: 'storyboard', storyboard: updated })
    callbacks.current.onBoardAssigned?.(updated, still)
  }

  /**
   * After an image is made for a board: put it there, unless the board got another picture while it was being made
   * (in the storyboard, or by an agent) – that one is never replaced without asking. `seen` is what the board showed
   * when the image was asked for. Also runs when the dialog was closed meanwhile, so the board still gets its image.
   */
  const placeNewImage = async (still: Still, seen: string | undefined | null) => {
    if (!boardId || !sequenceId) return
    if (mounted.current) setAssigning(true)
    try {
      const fresh = await window.studio.getStoryboard(sequenceId)
      const now = fresh.boards.find((b) => b.id === boardId)
      if (!now) throw new Error('Rutan finns inte längre. Bilden finns kvar bland storyboardens bilder.')
      if (!mayPlaceOnBoard(now.imagePath, seen, madeHere.current)) {
        if (mounted.current) {
          setOwner({ kind: 'storyboard', storyboard: fresh })
          setBoardNote('Rutan fick en annan bild medan den här skapades, så den byttes inte ut.')
        }
        return
      }
      await putOnBoard(still)
    } catch (e) {
      if (mounted.current) {
        setError(`Bilden sparades bland storyboardens bilder men kunde inte läggas i rutan: ${ipcErrorMessage(e)}`)
      }
    } finally {
      if (mounted.current) setAssigning(false)
    }
  }

  // A paid call: guarded by a ref too, since two quick presses (or ⌘+Enter) can both run before the
  // disabled button has rendered.
  const inFlight = useRef(false)
  const create = async (sent: StillParams | undefined = params) => {
    if (!sent || busy || missing || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setStartedAt(Date.now())
    setError(undefined)
    setBoardNote(undefined)
    const seen = boardImageSeen()
    try {
      const still = await window.studio.generateStill(sent)
      madeHere.current.push(still.path)
      if (mounted.current) {
        setResults((r) => [still, ...r])
        setCurrentId(still.id)
      }
      callbacks.current.onCreated?.(still)
      void placeNewImage(still, seen)
    } catch (e) {
      if (!mounted.current) return
      const message = ipcErrorMessage(e)
      const request = consentOf(message)
      if (request) setConsent({ request, params: sent })
      else setError(message)
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
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

  const assignToSlot = async (slot: SegmentImageSlot, still: Still) => {
    if (!slotTarget || assigning) return
    setAssigning(true)
    setError(undefined)
    try {
      const updated = await window.studio.setSegmentImage(slotTarget.segmentId, slot, {
        kind: 'still',
        stillId: still.id
      })
      callbacks.current.onAssigned?.(updated, slot, still)
      callbacks.current.onClose()
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      if (mounted.current) setAssigning(false)
    }
  }

  /** "Använd i ruta N": an earlier result back on the board, by the user's own choice. */
  const assignToBoard = async (still: Still) => {
    if (!boardId || assigning) return
    setAssigning(true)
    setError(undefined)
    setBoardNote(undefined)
    try {
      await putOnBoard(still)
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      if (mounted.current) setAssigning(false)
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

  // ── Wording ─────────────────────────────────────────────────────────────────
  const clipNumber = segmentIndex === -1 ? undefined : segmentIndex + 1
  // What putting the image into the clip changes besides the slot (main does it; the user should know first).
  const assignNotes: string[] = []
  if (slotTarget && segment && clipNumber) {
    if (kindOfModelId(segment.params.model) === 'reference-to-video' && segment.params.referenceImages?.length) {
      assignNotes.push(
        `Klipp ${clipNumber} görs i dag med referensbilder. Med en start- eller slutbild görs det som ` +
          'bild-till-video i stället, och referensbilderna tas bort från klippet.'
      )
    }
    if (slotTarget.slot === 'start' && segment.continueFromPrevious) {
      assignNotes.push(
        `Klipp ${clipNumber} fortsätter i dag från klipp ${clipNumber - 1}. Som startbild ersätter bilden det.`
      )
    }
    if (slotTarget.slot === 'end' && segment.endFromNext) {
      assignNotes.push(
        `Klipp ${clipNumber} slutar i dag där klipp ${clipNumber + 1} börjar. Som slutbild ersätter bilden det.`
      )
    }
  }
  const slotWord = (slot: SegmentImageSlot) => (slot === 'start' ? 'startbild' : 'slutbild')
  const quoted = (name: string | undefined) => (name ? ` ”${name}”` : '')
  const subtitle = slotTarget
    ? clipNumber
      ? `Till klipp ${clipNumber} – ${slotWord(slotTarget.slot)}. Bilden sparas också bland sekvensens bilder.`
      : `Till klippets ${slotWord(slotTarget.slot)}. Bilden sparas också bland sekvensens bilder.`
    : boardId
      ? `${boardNumber ? `Till ruta ${boardNumber}${ownerName ? ` i ”${ownerName}”` : ''}` : 'Till rutan'}. ` +
        'Bilden läggs i rutan och sparas bland storyboardens bilder.'
      : isStoryboard
        ? `Sparas bland bilderna i storyboarden${quoted(ownerName)}.`
        : sequenceId
          ? `Sparas bland bilderna i ${ownerName ? `”${ownerName}”` : 'sekvensen'}.`
          : 'Sparas i Referensbilder.'
  const whereItGoes = boardId
    ? 'läggs i rutan'
    : isStoryboard
      ? 'hamnar bland storyboardens bilder'
      : sequenceId
        ? 'hamnar bland sekvensens bilder'
        : 'hamnar i Referensbilder'
  const aspectNote =
    model && options.aspectRatio && options.aspectRatio !== ownerAspect && sequenceId && owner
      ? isStoryboard
        ? `Storyboarden är i ${ownerAspect}. Med en bild i ett annat format får klippen bildens format.`
        : `Sekvensen är i ${ownerAspect}. En start- eller slutbild i ett annat format ger klippet det formatet.`
      : undefined

  const inBoard = !!current && !!board?.imagePath && samePath(board.imagePath, current.path)
  // Once the image is where it should go, finishing is the next step rather than making another.
  const placed = !!current && !busy && (slotTarget ? true : boardId ? inBoard : false)
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
            <button
              onClick={onClose}
              className={
                boardId && placed
                  ? 'rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover'
                  : 'rounded-md border border-line px-4 py-2 hover:bg-raised'
              }
            >
              {results.length ? 'Klar' : 'Avbryt'}
            </button>
            <button
              onClick={() => void create()}
              disabled={!!missing || busy || !params}
              title={missing ?? (params?.referenceImages ? 'Kombinera referensbilderna enligt prompten' : undefined)}
              className={`flex items-center gap-2 rounded-md px-4 py-2 font-medium disabled:opacity-40 ${
                placed ? 'border border-line text-text hover:bg-raised' : 'bg-accent text-white hover:bg-accent-hover'
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

            {previousImagePath && (
              <PreviousImageOption path={previousImagePath} checked={usingPrevious} onChange={togglePrevious} />
            )}

            <ReferenceImages
              value={references}
              onChange={setReferences}
              max={maxReferences}
              assets={assets}
              stills={stills}
              stillsOf={isStoryboard ? 'storyboard' : sequenceId ? 'sequence' : undefined}
              pathLabels={previousImagePath ? { [previousImagePath]: 'Föregående' } : undefined}
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
            {aspectNote && <p className="-mt-2 text-[11px] leading-relaxed text-muted">{aspectNote}</p>}

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
            busyNote={`Brukar ta 5–30 sekunder. Stänger du fönstret blir bilden klar ändå och ${whereItGoes}.`}
            error={error}
            results={results}
            current={current}
            aspectRatio={options.aspectRatio ?? ownerAspect}
            onSelect={(s) => setCurrentId(s.id)}
            onView={setViewing}
            slot={slotTarget ? { main: slotTarget.slot, clipNumber, notes: assignNotes } : undefined}
            board={
              boardId
                ? {
                    number: boardNumber,
                    imagePath: board?.imagePath,
                    note: boardNote
                  }
                : undefined
            }
            assigning={assigning}
            onAssignSlot={(slot, still) => void assignToSlot(slot, still)}
            onAssignBoard={(still) => void assignToBoard(still)}
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

/** "Använd föregående bild som referens": the previous board's image as the first reference, for continuity. */
function PreviousImageOption({
  path,
  checked,
  onChange
}: {
  path: string
  checked: boolean
  onChange: (on: boolean) => void
}) {
  const [missing, setMissing] = useState(false)
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-md border border-line px-3 py-2 transition hover:bg-raised/50">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      <span className="h-9 w-16 shrink-0 overflow-hidden rounded bg-raised">
        {!missing && (
          <img
            src={mediaUrl(path)}
            alt=""
            draggable={false}
            onError={() => setMissing(true)}
            className="h-full w-full object-cover"
          />
        )}
      </span>
      <span className="min-w-0">
        <span className="block">Använd föregående bild som referens</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted">
          {missing
            ? 'Bilden i rutan före finns inte kvar på sin plats.'
            : 'Bilden i rutan före läggs först bland referenserna, så att personer, kläder och miljö håller ihop.'}
        </span>
      </span>
    </label>
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
  /** Under the spinner: how long it takes and where the image goes if the dialog is closed. */
  busyNote: string
  error?: string
  /** This dialog's images, newest first. */
  results: Still[]
  current?: Still
  aspectRatio: string
  onSelect: (still: Still) => void
  onView: (still: Still) => void
  /** Made for a sequence clip: the slot it was opened from first, what assigning changes besides the slot. */
  slot?: { main: SegmentImageSlot; clipNumber?: number; notes: string[] }
  /** Made for a storyboard board: its number, the image it shows now, and why a new one wasn't put there. */
  board?: { number?: number; imagePath?: string; note?: string }
  assigning: boolean
  onAssignSlot: (slot: SegmentImageSlot, still: Still) => void
  onAssignBoard: (still: Still) => void
}

const primaryButton =
  'rounded-md bg-accent px-3.5 py-1.5 font-medium text-white hover:bg-accent-hover disabled:opacity-40'
const secondaryButton = 'rounded-md border border-line px-3.5 py-1.5 hover:bg-raised disabled:opacity-40'

/** The latest image (or the one picked among this dialog's results), with where it can go. */
function ResultPanel({
  busy,
  elapsed,
  busyNote,
  error,
  results,
  current,
  aspectRatio,
  onSelect,
  onView,
  slot,
  board,
  assigning,
  onAssignSlot,
  onAssignBoard
}: ResultProps) {
  // The placeholder's shape; 16:9 for "auto".
  const ratio = ratioOf(aspectRatio) ?? 16 / 9
  // The slot the dialog was opened from first; the other one is offered too, since a keyframe often fits both.
  const slots: SegmentImageSlot[] = slot ? (slot.main === 'start' ? ['start', 'end'] : ['end', 'start']) : []
  const onBoard = (s: Still) => !!board?.imagePath && samePath(board.imagePath, s.path)
  const boardName = board?.number ? `ruta ${board.number}` : 'rutan'

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
            <span className="text-[11px]">{busyNote}</span>
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

      {current && !busy && slot && slot.notes.length > 0 && (
        <p className="text-[11px] leading-relaxed text-muted">{slot.notes.join(' ')}</p>
      )}

      {current && !busy && (
        <div className="flex flex-wrap items-center gap-2">
          {slots.map((s, i) => (
            <button
              key={s}
              onClick={() => onAssignSlot(s, current)}
              disabled={assigning}
              title={
                slot?.clipNumber
                  ? `Lägg bilden i klipp ${slot.clipNumber}s ${s === 'start' ? 'startruta' : 'slutruta'}`
                  : undefined
              }
              className={i === 0 ? primaryButton : secondaryButton}
            >
              {s === 'start' ? 'Använd som startbild' : 'Använd som slutbild'}
            </button>
          ))}
          {board &&
            (onBoard(current) ? (
              <span className="flex items-center gap-1.5 text-emerald-300">
                <span aria-hidden>✓</span>
                Bilden ligger i {boardName}
              </span>
            ) : assigning ? (
              <span className="text-muted">Läggs i {boardName}…</span>
            ) : (
              <button onClick={() => onAssignBoard(current)} className={primaryButton}>
                Använd i {boardName}
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

      {current && !busy && board && (onBoard(current) || board.note) && (
        <p className={`text-[11px] leading-relaxed ${onBoard(current) ? 'text-muted' : 'text-amber-300'}`}>
          {onBoard(current)
            ? 'Skapar du en till byts bilden i rutan ut. De tidigare finns kvar bland storyboardens bilder.'
            : board.note}
        </p>
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
              >
                {board && onBoard(s) ? (
                  <span
                    title={`Ligger i ${boardName}`}
                    className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[9px] font-semibold text-black"
                  >
                    ✓
                  </span>
                ) : undefined}
              </StillThumb>
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
