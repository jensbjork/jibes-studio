import { useMemo, useState } from 'react'
import { PICTURE_EDIT_MODELS } from '@shared/edit-plan'
import { DEFAULT_MODEL, supportsEndImage } from '@shared/models'
import type { EditOperation, EditPlan, VideoModel } from '@shared/types'
import { useAssets } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import { shortcut } from '../../lib/platform'
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

// Picture: the picture operations. Paid: Regenerate section (image-to-video between the frames around the range), Edit
// with prompt (a video-to-video edit of the range), Extend (image-to-video from the last frame) and Upscale (Topaz,
// the whole film). Free: trimming and fading.

const DEFAULT_REGENERATE_MODEL = DEFAULT_MODEL['image-to-video']
const DEFAULT_PROMPT_EDIT_MODEL = DEFAULT_MODEL['reference-to-video']

/** Example changes: short labels that insert full prompts. */
const EDIT_CHIPS: { label: string; text: string }[] = [
  {
    label: 'Remove the person in the background',
    text: 'Remove the person in the background, keeping the rest of the video unchanged.'
  },
  {
    label: 'Make it evening',
    text: 'Make it evening with warm, low light, keeping the rest of the video unchanged.'
  },
  {
    label: 'Change the jacket’s colour',
    text: 'Change the colour of the jacket to dark red, keeping the rest of the video unchanged.'
  },
  {
    label: 'Cartoon style',
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

/** Image-to-video models that can also end on a picture (Regenerate section needs both frames). */
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
    <Field label="Model" hint={hint}>
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
    <Field label="Resolution">
      <select value={value} onChange={(e) => onChange(e.target.value)} className={fieldInput}>
        <option value="">Same as the film (max 720p)</option>
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
  keepLabel = 'Keep the original sound'
}: {
  value: 'keep' | 'model'
  onChange: (v: 'keep' | 'model') => void
  keepLabel?: string
}) {
  return (
    <Field label="Sound">
      <Choice
        value={value}
        onChange={onChange}
        label="Sound"
        options={[
          { value: 'keep', label: keepLabel, hint: 'Best when someone speaks in the section.' },
          { value: 'model', label: 'New sound from the model' }
        ]}
      />
    </Field>
  )
}

/** The start image and end image from the plan (free, extracted by main). */
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
          <span className="px-2 text-center text-[11px] text-muted">{planning ? 'Loading…' : missing}</span>
        )}
      </div>
      <figcaption className="mt-1 text-[11px] text-muted">{label}</figcaption>
    </figure>
  )
  return (
    <div className="flex gap-2">
      {frame(start, 'Start image', 'No start image')}
      {frame(end, 'End image', 'None – the section runs to the end')}
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
  const missingPrompt = !prompt.trim() ? 'Write what happens in the section.' : undefined

  return (
    <OpCard
      title="Regenerate section"
      summary="A new AI take between the frame before and the frame after the selection."
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
            label="What happens?"
            hint={
              <button
                type="button"
                onClick={() => setPrompt(suggestRegeneratePrompt(transcript?.segments ?? [], range))}
                className={linkButton}
                title="Write a simple template from the frames and what is said in the section"
              >
                Suggest
              </button>
            }
          >
            <PromptField
              value={prompt}
              onChange={setPrompt}
              context="video"
              minRows={3}
              maxRows={10}
              title="What happens?"
              focusHint="What happens in the section – in English if you can. Type / for a building block."
              placeholder="She turns towards the window and smiles. Continuous shot."
            />
            <p className="mt-1 text-[11px] text-muted">Write in English if you can – the models understand it best.</p>
          </Field>
          {range && (
            <p className="text-[12px] text-muted">
              Length <span className="text-text">{formatSecondsShort(range.end - range.start)}</span> · the model makes
              whole seconds
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <ResolutionSelect value={resolution} onChange={setResolution} model={chosen} />
            <ModelSelect value={modelId} onChange={setModel} models={choices} />
          </div>
          <AudioChoice value={audio} onChange={setAudio} />
          <PlanNotes plan={plan} error={card.error ?? planError} quiet={missingPrompt} />
          <RunButton
            label="Regenerate section"
            plan={plan}
            planning={planning}
            running={card.running}
            disabled={!!missingPrompt}
            disabledReason={missingPrompt}
            onClick={() => plan && void card.run({ op: op!, plan, label: 'Regenerate section' })}
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
  const missingPrompt = !prompt.trim() ? 'Write what should change.' : undefined

  const addChip = (text: string) => setPrompt((p) => (p.trim() ? `${p.trim()} ${text}` : text))

  return (
    <OpCard
      title="Edit with prompt"
      summary="Change something in the selection – remove a thing, change the light, style or colour."
      open={open}
      onToggle={onToggle}
    >
      {!selection ? (
        <NeedsSelection />
      ) : (
        <>
          <Target range={range} />
          <Field label="What should change?">
            <PromptField
              value={prompt}
              onChange={setPrompt}
              context="video"
              minRows={3}
              maxRows={10}
              title="What should change?"
              focusHint="One change at a time, in English. Type / for light, style and camera."
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
              One change at a time and as short a selection as possible give the best result. Write in English.
            </p>
          </Field>
          {takesImages && (
            <ReferencePhotos selected={imageIds} onChange={setImageIds} onInsert={(token) => addChip(token)} />
          )}
          <Field label="Model">
            <Choice
              value={modelId}
              onChange={setModel}
              label="Model"
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
            label="Edit with prompt"
            plan={plan}
            planning={planning}
            running={card.running}
            disabled={!!missingPrompt}
            disabledReason={missingPrompt}
            onClick={() => plan && void card.run({ op: op!, plan, label: 'Edit with prompt' })}
          />
          {card.sent && <p className="text-[11px] text-emerald-300/90">{card.sent}</p>}
        </>
      )}
    </OpCard>
  )
}

/** "Images to start from": library photos sent with a Seedance edit, @Image1… in the prompt. */
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
      label="Images to start from"
      hint={
        <button type="button" onClick={() => setBrowsing((b) => !b)} className={linkButton}>
          {browsing ? 'Done' : selected.length ? 'Change' : 'Choose…'}
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
                title={`Type @Image${i + 1} in the prompt${img ? ` (${img.label})` : ''}`}
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
          <p className="text-[11px] text-muted">Optional: photos from the library, e.g. a person who should appear instead.</p>
        )
      )}
      {browsing && (
        <div className="mt-2 grid max-h-48 grid-cols-5 gap-1.5 overflow-y-auto rounded-md border border-line p-1.5">
          {images.length === 0 && <p className="col-span-5 p-2 text-[11px] text-muted">The library has no photos yet.</p>}
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
  const missingPrompt = !prompt.trim() ? 'Write what happens next.' : undefined

  return (
    <OpCard title="Extend" summary="Continue the film past its end with an AI take from the last frame." open={open} onToggle={onToggle}>
      <p className="text-[12px] text-muted">
        <span className="text-text">After the end</span> · starts on the film’s last frame
      </p>
      <Field label="What happens next?">
        <PromptField
          value={prompt}
          onChange={setPrompt}
          context="video"
          minRows={3}
          maxRows={10}
          title="What happens next?"
          focusHint="How the film goes on after the end – in English if you can. Type / for a building block."
          placeholder="The camera slowly pulls back as she walks away down the street."
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Length">
          <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className={fieldInput}>
            {EXTEND_SECONDS.map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
          </select>
        </Field>
        <ResolutionSelect value={resolution} onChange={setResolution} model={models.find((m) => m.id === modelId)} />
      </div>
      <ModelSelect value={modelId} onChange={setModel} models={choices} />
      <Field label="Sound">
        <Choice
          value={audio}
          onChange={setAudio}
          label="Sound"
          options={[
            { value: 'model', label: 'New sound from the model' },
            { value: 'silence', label: 'Silence' }
          ]}
        />
      </Field>
      <PlanNotes plan={plan} error={card.error ?? planError} quiet={missingPrompt} />
      <RunButton
        label="Extend"
        plan={plan}
        planning={planning}
        running={card.running}
        disabled={!!missingPrompt}
        disabledReason={missingPrompt}
        onClick={() => plan && void card.run({ op, plan, label: `Extend ${seconds} s` })}
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
    <OpCard title="Upscale" summary="A sharper picture at a higher resolution, the whole film at once." open={open} onToggle={onToggle}>
      <Target />
      <Choice
        value={chosen}
        onChange={setFactor}
        label="Scale"
        inline
        options={[
          { value: 2, label: '2×', hint: size(2), disabled: !fits(2) },
          {
            value: 4,
            label: '4×',
            hint: size(4),
            disabled: !fits(4),
            title: fits(4) ? undefined : `4× only works when the result is at most ${MAX_UPSCALED_SIDE} pixels wide.`
          }
        ]}
      />
      <PlanNotes plan={plan} error={card.error ?? planError} />
      <RunButton
        label={`Upscale ${chosen}×`}
        plan={plan}
        planning={planning}
        running={card.running}
        onClick={() => plan && void card.run({ op, plan, label: `Upscale ${chosen}×` })}
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
      title="Trim & fade"
      summary="Cut out or keep the selection, fade in or out."
      badge={<CostTag paid={false} />}
      open={open}
      onToggle={onToggle}
    >
      <div>
        <Target range={selection} whole="No selection" />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!selection || !!busy}
            onClick={() => selection && void go('cut', { op: 'cut', range: selection }, 'Cut out the selection')}
            title={selection ? 'Removes the selection from the film' : 'Mark a section first'}
            className="rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {busy === 'cut' ? 'Cutting…' : 'Cut out the selection'}
          </button>
          <button
            type="button"
            disabled={!selection || !!busy}
            onClick={() => selection && void go('trim', { op: 'trim', keep: selection }, 'Keep only the selection')}
            title={selection ? 'Everything outside the selection is removed' : 'Mark a section first'}
            className="rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {busy === 'trim' ? 'Trimming…' : 'Keep only the selection'}
          </button>
        </div>
      </div>
      <div className="border-t border-line pt-3">
        <div className="flex items-center gap-2">
          <span className="text-muted">Fade</span>
          <select value={fade} onChange={(e) => setFade(Number(e.target.value))} className={`${fieldInput} w-auto`}>
            {FADE_SECONDS.map((s) => (
              <option key={s} value={s}>
                {s} s
              </option>
            ))}
          </select>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!!busy || fadeTooLong}
            onClick={() => void go('fade-in', { op: 'fade', inSeconds: fade }, 'Fade in from black')}
            className="rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {busy === 'fade-in' ? 'Fading…' : 'Fade in from black'}
          </button>
          <button
            type="button"
            disabled={!!busy || fadeTooLong}
            onClick={() => void go('fade-out', { op: 'fade', outSeconds: fade }, 'Fade out to black')}
            className="rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {busy === 'fade-out' ? 'Fading…' : 'Fade out to black'}
          </button>
        </div>
        {fadeTooLong && <p className="mt-1.5 text-[11px] text-muted">A fade can be at most half the film.</p>}
      </div>
      <p className="text-[11px] leading-relaxed text-muted">Free. Every change becomes a new version – {shortcut('⌘Z')} goes back.</p>
      <PlanNotes error={card.error} />
    </OpCard>
  )
}
