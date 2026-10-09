import { useMemo, useState } from 'react'
import { PICTURE_EDIT_MODELS } from '@shared/edit-plan'
import { DEFAULT_MODEL, supportsEndImage } from '@shared/models'
import type { EditOperation, EditPlan, VideoModel } from '@shared/types'
import { useAssets } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import PromptField from '../prompt/PromptField'
import { useOpenCard, useReportRange } from './cards'
import { useCardRun, useEditor } from './EditorContext'
import { formatPrice, formatSecondsShort, operationRange, suggestRegeneratePrompt } from './editorUtils'
import { usePlan, usePlans } from './useEditOps'
import {
  Choice,
  CostTag,
  Field,
  NeedsSelection,
  OpCard,
  PlanNotes,
  RunButton,
  Target,
  fieldInput,
  linkButton,
  smallButton,
  textArea
} from './ui'

// Bild: the picture operations. Paid: Gör om avsnittet (image-to-video between the frames around the range), Ändra
// med prompt (a video-to-video edit of the range), Förläng (image-to-video from the last frame) and Uppskala (Topaz,
// the whole film). Free: cutting and fading.

const DEFAULT_REGENERATE_MODEL = DEFAULT_MODEL['image-to-video']
const DEFAULT_PROMPT_EDIT_MODEL = DEFAULT_MODEL['reference-to-video']

/** Example changes: Swedish labels that insert English prompts. */
const EDIT_CHIPS: { label: string; text: string }[] = [
  {
    label: 'Ta bort personen i bakgrunden',
    text: 'Remove the person in the background, keeping the rest of the video unchanged.'
  },
  {
    label: 'Gör det till kväll',
    text: 'Make it evening with warm, low light, keeping the rest of the video unchanged.'
  },
  {
    label: 'Byt färg på jackan',
    text: 'Change the colour of the jacket to dark red, keeping the rest of the video unchanged.'
  },
  {
    label: 'Tecknad stil',
    text: 'Turn the video into a hand-drawn cartoon style, keeping the motion and composition unchanged.'
  }
]

export default function PictureTab() {
  const [open, toggle] = useOpenCard('bild')
  return (
    <div className="space-y-1">
      <RegenerateCard open={open === 'regenerate'} onToggle={() => toggle('regenerate')} />
      <PromptEditCard open={open === 'prompt-edit'} onToggle={() => toggle('prompt-edit')} />
      <ExtendCard open={open === 'extend'} onToggle={() => toggle('extend')} />
      <UpscaleCard open={open === 'upscale'} onToggle={() => toggle('upscale')} />
      <CutCard open={open === 'cut'} onToggle={() => toggle('cut')} />
    </div>
  )
}

interface CardProps {
  open: boolean
  onToggle: () => void
}

/** Image-to-video models that can also end on a picture (Gör om avsnittet needs both frames). */
function endImageModels(models: VideoModel[]): VideoModel[] {
  return models.filter((m) => m.kind === 'image-to-video' && supportsEndImage(m.id) && !m.offline)
}

function imageToVideoModels(models: VideoModel[]): VideoModel[] {
  return models.filter((m) => m.kind === 'image-to-video' && !m.videoInput && !m.offline)
}

/** The model choice for a picture operation: the default when it is listed, else the first that is. */
function initialModel(preferred: string, list: VideoModel[]): string {
  return list.some((m) => m.id === preferred) || !list.length ? preferred : list[0].id
}

function ModelSelect({
  value,
  onChange,
  models,
  hint
}: {
  value: string
  onChange: (id: string) => void
  models: VideoModel[]
  hint?: string
}) {
  const { modelsError } = useEditor()
  return (
    <Field label="Modell" hint={hint}>
      {modelsError ? (
        <p className="text-[12px] text-accent select-text">{modelsError}</p>
      ) : (
        <select value={value} onChange={(e) => onChange(e.target.value)} className={fieldInput}>
          {!models.some((m) => m.id === value) && <option value={value}>{value}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}

function ResolutionSelect({
  value,
  onChange,
  model
}: {
  value: string
  onChange: (resolution: string) => void
  model?: VideoModel
}) {
  const options = model?.resolutions ?? []
  return (
    <Field label="Upplösning">
      <select value={value} onChange={(e) => onChange(e.target.value)} className={fieldInput}>
        <option value="">Som filmen (högst 720p)</option>
        {options.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </Field>
  )
}

function AudioChoice({
  value,
  onChange,
  keepLabel = 'Behåll originalljudet'
}: {
  value: 'keep' | 'model'
  onChange: (v: 'keep' | 'model') => void
  keepLabel?: string
}) {
  return (
    <Field label="Ljud">
      <Choice
        value={value}
        onChange={onChange}
        label="Ljud"
        options={[
          { value: 'keep', label: keepLabel, hint: 'Bäst när någon pratar i avsnittet.' },
          { value: 'model', label: 'Nytt ljud från modellen' }
        ]}
      />
    </Field>
  )
}

/** Startbild and Slutbild from the plan (free, extracted by main). */
function Frames({ plan, planning }: { plan?: EditPlan; planning: boolean }) {
  const start = plan?.frames?.start
  const end = plan?.frames?.end
  const box = 'flex aspect-video items-center justify-center overflow-hidden rounded-md border border-line bg-black'
  const frame = (path: string | undefined, label: string, missing: string) => (
    <figure className="min-w-0 flex-1">
      <div className={box}>
        {path ? (
          <img src={mediaUrl(path)} alt={label} draggable={false} className="h-full w-full object-contain" />
        ) : (
          <span className="px-2 text-center text-[11px] text-muted">{planning ? 'Hämtar…' : missing}</span>
        )}
      </div>
      <figcaption className="mt-1 text-[11px] text-muted">{label}</figcaption>
    </figure>
  )
  return (
    <div className="flex gap-2">
      {frame(start, 'Startbild', 'Ingen startbild')}
      {frame(end, 'Slutbild', 'Ingen – avsnittet går till slutet')}
    </div>
  )
}

function RegenerateCard({ open, onToggle }: CardProps) {
  const { edit, current, selection, models, transcript } = useEditor()
  const choices = useMemo(() => endImageModels(models), [models])
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<string>()
  const [resolution, setResolution] = useState('')
  const [audio, setAudio] = useState<'keep' | 'model'>('keep')
  const [nonce, setNonce] = useState(0)
  const modelId = model ?? initialModel(DEFAULT_REGENERATE_MODEL, choices)
  const chosen = models.find((m) => m.id === modelId)

  const op: EditOperation | undefined = selection
    ? { op: 'regenerate', range: selection, prompt: prompt.trim(), model: modelId, resolution: resolution || undefined, audio }
    : undefined
  // Planned even before a prompt is written: the plan shows the frames the take will start and end on.
  const { plan, planning, error: planError } = usePlan(edit.id, op, current.id, open && !!op, nonce)
  const range = operationRange(plan?.operation) ?? selection
  useReportRange(open, range)
  const card = useCardRun(() => setNonce((n) => n + 1))
  const missingPrompt = !prompt.trim() ? 'Skriv vad som händer i avsnittet.' : undefined

  return (
    <OpCard
      title="Gör om avsnittet"
      summary="En ny AI-tagning mellan bildrutan före och bildrutan efter markeringen."
      open={open}
      onToggle={onToggle}
    >
      {!selection ? (
        <NeedsSelection />
      ) : (
        <>
          <Target range={range} />
          <Frames plan={plan} planning={planning} />
          <Field
            label="Vad händer?"
            hint={
              <button
                type="button"
                onClick={() => setPrompt(suggestRegeneratePrompt(transcript?.segments ?? [], range))}
                className={linkButton}
                title="Skriv en enkel mall utifrån bilderna och det som sägs i avsnittet"
              >
                Föreslå
              </button>
            }
          >
            <PromptField
              value={prompt}
              onChange={setPrompt}
              context="video"
              minRows={3}
              maxRows={10}
              title="Vad händer?"
              focusHint="Vad som händer i avsnittet – gärna på engelska. Skriv / för en byggsten."
              placeholder="She turns towards the window and smiles. Continuous shot."
            />
            <p className="mt-1 text-[11px] text-muted">Skriv gärna på engelska – modellerna förstår det bäst.</p>
          </Field>
          {range && (
            <p className="text-[12px] text-muted">
              Längd <span className="text-text">{formatSecondsShort(range.end - range.start)}</span> · modellen gör hela
              sekunder
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <ResolutionSelect value={resolution} onChange={setResolution} model={chosen} />
            <ModelSelect value={modelId} onChange={setModel} models={choices} />
          </div>
          <AudioChoice value={audio} onChange={setAudio} />
          <PlanNotes plan={plan} error={card.error ?? planError} quiet={missingPrompt} />
          <RunButton
            label="Gör om avsnittet"
            plan={plan}
            planning={planning}
            running={card.running}
            disabled={!!missingPrompt}
            disabledReason={missingPrompt}
            onClick={() => plan && void card.run({ op: op!, plan, label: 'Gör om avsnittet' })}
          />
          {card.sent && <p className="text-[11px] text-emerald-300/90">{card.sent}</p>}
        </>
      )}
    </OpCard>
  )
}

function PromptEditCard({ open, onToggle }: CardProps) {
  const { edit, current, selection, models } = useEditor()
  // The edit models Venice lists (all of them while the list loads, so the card isn't empty).
  const choices = useMemo(() => {
    const ids = Object.keys(PICTURE_EDIT_MODELS)
    return models.length ? ids.filter((id) => models.some((m) => m.id === id && !m.offline)) : ids
  }, [models])
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<string>()
  const [resolution, setResolution] = useState('')
  const [audio, setAudio] = useState<'keep' | 'model'>('keep')
  const [imageIds, setImageIds] = useState<string[]>([])
  const [nonce, setNonce] = useState(0)
  const modelId = model ?? (choices.includes(DEFAULT_PROMPT_EDIT_MODEL) ? DEFAULT_PROMPT_EDIT_MODEL : (choices[0] ?? DEFAULT_PROMPT_EDIT_MODEL))
  const info = PICTURE_EDIT_MODELS[modelId]
  const takesImages = !!info?.referenceImages

  const opFor = (id: string): EditOperation | undefined =>
    selection
      ? {
          op: 'prompt-edit',
          range: selection,
          prompt: prompt.trim(),
          model: id,
          resolution: resolution || undefined,
          referenceImageIds: PICTURE_EDIT_MODELS[id]?.referenceImages && imageIds.length ? imageIds : undefined,
          audio
        }
      : undefined
  const op = opFor(modelId)
  const { plan, planning, error: planError } = usePlan(edit.id, op, current.id, open && !!op, nonce)
  // The price of every model for the same range, on its choice.
  const alternatives = usePlans(
    edit.id,
    choices.map((id) => opFor(id)),
    current.id,
    open && !!selection
  )
  const range = operationRange(plan?.operation) ?? selection
  useReportRange(open, range)
  const card = useCardRun(() => setNonce((n) => n + 1))
  const missingPrompt = !prompt.trim() ? 'Skriv vad som ska ändras.' : undefined

  const addChip = (text: string) => setPrompt((p) => (p.trim() ? `${p.trim()} ${text}` : text))

  return (
    <OpCard
      title="Ändra med prompt"
      summary="Ändra något i markeringen – ta bort en sak, byt ljus, stil eller färg."
      open={open}
      onToggle={onToggle}
    >
      {!selection ? (
        <NeedsSelection />
      ) : (
        <>
          <Target range={range} />
          <Field label="Vad ska ändras?">
            <PromptField
              value={prompt}
              onChange={setPrompt}
              context="video"
              minRows={3}
              maxRows={10}
              title="Vad ska ändras?"
              focusHint="En ändring i taget, på engelska. Skriv / för ljus, stil och kamera."
              placeholder="Remove the car in the background, keeping the rest of the video unchanged."
            />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {EDIT_CHIPS.map((c) => (
                <button key={c.label} type="button" onClick={() => addChip(c.text)} title={c.text} className={smallButton}>
                  {c.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              En ändring i taget och en så kort markering som möjligt ger bäst resultat. Skriv på engelska.
            </p>
          </Field>
          {takesImages && (
            <ReferencePhotos selected={imageIds} onChange={setImageIds} onInsert={(token) => addChip(token)} />
          )}
          <Field label="Modell">
            <Choice
              value={modelId}
              onChange={setModel}
              label="Modell"
              options={choices.map((id, i) => {
                const m = PICTURE_EDIT_MODELS[id]
                const alt = alternatives[i]
                // What stands in the way with this model (a range it can't take); an empty prompt is the same for all.
                const problem = alt?.problems.find((p) => p.trim() !== missingPrompt)
                return {
                  value: id,
                  label: (
                    <span className="flex items-baseline gap-2">
                      <span>{m?.label ?? id}</span>
                      <span className="text-[11px] tabular-nums text-muted">
                        {!problem && alt?.priceUsd !== undefined ? formatPrice(alt.priceUsd) : ''}
                      </span>
                    </span>
                  ),
                  hint: m ? `${m.minSeconds}–${m.maxSeconds} s${problem ? ` · ${problem}` : ''}` : undefined
                }
              })}
            />
          </Field>
          <ResolutionSelect value={resolution} onChange={setResolution} model={models.find((m) => m.id === modelId)} />
          <AudioChoice value={audio} onChange={setAudio} />
          <PlanNotes plan={plan} error={card.error ?? planError} quiet={missingPrompt} />
          <RunButton
            label="Ändra med prompt"
            plan={plan}
            planning={planning}
            running={card.running}
            disabled={!!missingPrompt}
            disabledReason={missingPrompt}
            onClick={() => plan && void card.run({ op: op!, plan, label: 'Ändra med prompt' })}
          />
          {card.sent && <p className="text-[11px] text-emerald-300/90">{card.sent}</p>}
        </>
      )}
    </OpCard>
  )
}

/** "Bilder att utgå från": library photos sent with a Seedance edit, @Image1… in the prompt. */
function ReferencePhotos({
  selected,
  onChange,
  onInsert
}: {
  selected: string[]
  onChange: (ids: string[]) => void
  onInsert: (token: string) => void
}) {
  const assets = useAssets()
  const [browsing, setBrowsing] = useState(false)
  const images = useMemo(
    () => assets.flatMap((a) => a.images.map((img, i) => ({ id: img.id, path: img.path, label: `${a.name} ${i + 1}` }))),
    [assets]
  )
  const byId = new Map(images.map((i) => [i.id, i]))
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id].slice(0, 9))

  return (
    <Field
      label="Bilder att utgå från"
      hint={
        <button type="button" onClick={() => setBrowsing((b) => !b)} className={linkButton}>
          {browsing ? 'Klar' : selected.length ? 'Ändra' : 'Välj…'}
        </button>
      }
    >
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {selected.map((id, i) => {
            const img = byId.get(id)
            return (
              <button
                key={id}
                type="button"
                onClick={() => onInsert(`@Image${i + 1}`)}
                title={`Skriv @Image${i + 1} i prompten${img ? ` (${img.label})` : ''}`}
                className="w-14 text-center"
              >
                <span className="block h-14 w-14 overflow-hidden rounded-md border border-line bg-black">
                  {img && <img src={mediaUrl(img.path)} alt="" className="h-full w-full object-cover" />}
                </span>
                <span className="mt-0.5 block text-[10px] text-muted">@Image{i + 1}</span>
              </button>
            )
          })}
        </div>
      ) : (
        !browsing && (
          <p className="text-[11px] text-muted">Valfritt: foton från biblioteket, t.ex. en person som ska synas i stället.</p>
        )
      )}
      {browsing && (
        <div className="mt-2 grid max-h-48 grid-cols-5 gap-1.5 overflow-y-auto rounded-md border border-line p-1.5">
          {images.length === 0 && <p className="col-span-5 p-2 text-[11px] text-muted">Biblioteket har inga foton än.</p>}
          {images.map((img) => {
            const at = selected.indexOf(img.id)
            return (
              <button
                key={img.id}
                type="button"
                onClick={() => toggle(img.id)}
                title={img.label}
                className={`relative aspect-square overflow-hidden rounded border ${
                  at >= 0 ? 'border-accent' : 'border-transparent hover:border-line'
                }`}
              >
                <img src={mediaUrl(img.path)} alt="" className="h-full w-full object-cover" />
                {at >= 0 && (
                  <span className="absolute right-0.5 top-0.5 rounded bg-accent px-1 text-[9px] font-medium text-white">
                    {at + 1}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </Field>
  )
}

const EXTEND_SECONDS = Array.from({ length: 12 }, (_, i) => i + 4)

function ExtendCard({ open, onToggle }: CardProps) {
  const { edit, current, models } = useEditor()
  const choices = useMemo(() => imageToVideoModels(models), [models])
  const [seconds, setSeconds] = useState(5)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<string>()
  const [resolution, setResolution] = useState('')
  const [audio, setAudio] = useState<'model' | 'silence'>('model')
  const [nonce, setNonce] = useState(0)
  const modelId = model ?? initialModel(DEFAULT_REGENERATE_MODEL, choices)
  const op: EditOperation = {
    op: 'extend',
    seconds,
    prompt: prompt.trim(),
    model: modelId,
    resolution: resolution || undefined,
    audio
  }
  const { plan, planning, error: planError } = usePlan(edit.id, op, current.id, open, nonce)
  const card = useCardRun(() => setNonce((n) => n + 1))
  const missingPrompt = !prompt.trim() ? 'Skriv vad som händer sedan.' : undefined

  return (
    <OpCard title="Förläng" summary="Fortsätt filmen efter slutet med en AI-tagning från sista bildrutan." open={open} onToggle={onToggle}>
      <p className="text-[12px] text-muted">
        <span className="text-text">Efter slutet</span> · börjar på filmens sista bildruta
      </p>
      <Field label="Vad händer sedan?">
        <PromptField
          value={prompt}
          onChange={setPrompt}
          context="video"
          minRows={3}
          maxRows={10}
          title="Vad händer sedan?"
          focusHint="Hur filmen fortsätter efter slutet – gärna på engelska. Skriv / för en byggsten."
          placeholder="The camera slowly pulls back as she walks away down the street."
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Längd">
          <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className={fieldInput}>
            {EXTEND_SECONDS.map((s) => (
              <option key={s} value={s}>
                {s} sekunder
              </option>
            ))}
          </select>
        </Field>
        <ResolutionSelect value={resolution} onChange={setResolution} model={models.find((m) => m.id === modelId)} />
      </div>
      <ModelSelect value={modelId} onChange={setModel} models={choices} />
      <Field label="Ljud">
        <Choice
          value={audio}
          onChange={setAudio}
          label="Ljud"
          options={[
            { value: 'model', label: 'Nytt ljud från modellen' },
            { value: 'silence', label: 'Tystnad' }
          ]}
        />
      </Field>
      <PlanNotes plan={plan} error={card.error ?? planError} quiet={missingPrompt} />
      <RunButton
        label="Förläng"
        plan={plan}
        planning={planning}
        running={card.running}
        disabled={!!missingPrompt}
        disabledReason={missingPrompt}
        onClick={() => plan && void card.run({ op, plan, label: `Förläng ${seconds} s` })}
      />
      {card.sent && <p className="text-[11px] text-emerald-300/90">{card.sent}</p>}
    </OpCard>
  )
}

/** Topaz's limit on the result's long side. */
const MAX_UPSCALED_SIDE = 3840

function UpscaleCard({ open, onToggle }: CardProps) {
  const { edit, current, timeline } = useEditor()
  const [factor, setFactor] = useState<2 | 4>(2)
  const [nonce, setNonce] = useState(0)
  const longSide = timeline ? Math.max(timeline.width, timeline.height) : 0
  const fits = (f: number) => !longSide || longSide * f <= MAX_UPSCALED_SIDE
  const chosen: 2 | 4 = factor === 4 && !fits(4) ? 2 : factor
  const op: EditOperation = { op: 'upscale', factor: chosen }
  const { plan, planning, error: planError } = usePlan(edit.id, op, current.id, open, nonce)
  const card = useCardRun(() => setNonce((n) => n + 1))
  const size = (f: number) =>
    timeline ? `${timeline.width * f}×${timeline.height * f}` : undefined

  return (
    <OpCard title="Uppskala" summary="Skärpare bild i högre upplösning, hela filmen på en gång." open={open} onToggle={onToggle}>
      <Target />
      <Choice
        value={chosen}
        onChange={setFactor}
        label="Förstoring"
        inline
        options={[
          { value: 2, label: '2×', hint: size(2), disabled: !fits(2) },
          {
            value: 4,
            label: '4×',
            hint: size(4),
            disabled: !fits(4),
            title: fits(4) ? undefined : `4× går bara när resultatet blir högst ${MAX_UPSCALED_SIDE} pixlar brett.`
          }
        ]}
      />
      <PlanNotes plan={plan} error={card.error ?? planError} />
      <RunButton
        label={`Uppskala ${chosen}×`}
        plan={plan}
        planning={planning}
        running={card.running}
        onClick={() => plan && void card.run({ op, plan, label: `Uppskala ${chosen}×` })}
      />
      {card.sent && <p className="text-[11px] text-emerald-300/90">{card.sent}</p>}
    </OpCard>
  )
}

const FADE_SECONDS = [0.5, 1, 2, 3]

/** Free: cut the range away, keep only the range, fade in from or out to black. */
function CutCard({ open, onToggle }: CardProps) {
  const { selection, duration } = useEditor()
  const [fade, setFade] = useState(1)
  const card = useCardRun()
  const [busy, setBusy] = useState<string>()
  useReportRange(open, selection)

  const go = async (key: string, op: EditOperation, label: string) => {
    setBusy(key)
    await card.run({ op, label })
    setBusy(undefined)
  }
  const fadeTooLong = fade > duration / 2

  return (
    <OpCard
      title="Klipp och tona"
      summary="Klipp bort eller behåll markeringen, tona in eller ut."
      badge={<CostTag paid={false} />}
      open={open}
      onToggle={onToggle}
    >
      <div>
        <Target range={selection} whole="Ingen markering" />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!selection || !!busy}
            onClick={() => selection && void go('cut', { op: 'cut', range: selection }, 'Klipp bort markeringen')}
            title={selection ? 'Tar bort markeringen ur filmen' : 'Markera ett avsnitt först'}
            className="rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {busy === 'cut' ? 'Klipper…' : 'Klipp bort markeringen'}
          </button>
          <button
            type="button"
            disabled={!selection || !!busy}
            onClick={() => selection && void go('trim', { op: 'trim', keep: selection }, 'Behåll bara markeringen')}
            title={selection ? 'Allt utanför markeringen tas bort' : 'Markera ett avsnitt först'}
            className="rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {busy === 'trim' ? 'Klipper…' : 'Behåll bara markeringen'}
          </button>
        </div>
      </div>
      <div className="border-t border-line pt-3">
        <div className="flex items-center gap-2">
          <span className="text-muted">Tona</span>
          <select value={fade} onChange={(e) => setFade(Number(e.target.value))} className={`${fieldInput} w-auto`}>
            {FADE_SECONDS.map((s) => (
              <option key={s} value={s}>
                {String(s).replace('.', ',')} s
              </option>
            ))}
          </select>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!!busy || fadeTooLong}
            onClick={() => void go('fade-in', { op: 'fade', inSeconds: fade }, 'Tona in från svart')}
            className="rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {busy === 'fade-in' ? 'Tonar…' : 'Tona in från svart'}
          </button>
          <button
            type="button"
            disabled={!!busy || fadeTooLong}
            onClick={() => void go('fade-out', { op: 'fade', outSeconds: fade }, 'Tona ut till svart')}
            className="rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {busy === 'fade-out' ? 'Tonar…' : 'Tona ut till svart'}
          </button>
        </div>
        {fadeTooLong && <p className="mt-1.5 text-[11px] text-muted">Toningen får vara högst halva filmen.</p>}
      </div>
      <p className="text-[11px] leading-relaxed text-muted">Gratis. Varje ändring blir en ny version – ⌘Z går tillbaka.</p>
      <PlanNotes error={card.error} />
    </OpCard>
  )
}
