import { useEffect, useRef } from 'react'
import {
  DEFAULT_MODEL,
  KINDS,
  PREFERRED,
  audioForModel,
  kindOfModelId,
  maxReferenceImages,
  paramsForSubmit,
  pickOption,
  type Kind
} from '@shared/models'
import { canonicalizeTokens, findImageTokens } from '@shared/prompt-refs'
import type {
  AgentCommand,
  AgentCommandReply,
  AgentFormReference,
  AgentFormState,
  AgentOpenResult,
  Asset,
  GenerationParams,
  VideoModel
} from '@shared/types'
import { modelForKind } from '../components/ParamsForm'
import { addPaths, sameList } from '../components/pickers/assetRefs'
import { generateParamsFrozen, getGenerateParams, setGenerateParams } from './generateStore'
import { ipcErrorMessage, loadModels } from './hooks'
import { followAssetImages, readRememberedImageIds } from './library'
import type { Intent, Navigate, View } from './navigation'
import { promptIssuesOf } from './promptIssues'
import { openInSequenceEditor } from './workspace'

// The renderer half of the agent connection. Tools that read or fill the Generate form (get_workspace,
// set_form, set_references, open_in_studio) reach main's MCP server as an 'agent:command'; this applies them
// to the form store with the same rules the form itself uses (mode switching, model options, the reference
// cap) and answers with 'agent:reply'. Everything else the agent does goes straight to main's services.
// Error messages are Swedish: they are shown to the agent, which talks to the user in Swedish.

/** An image of the form tied to the library photo it is (asset, photo number), like a reference minus its token. */
export type FormImage = Omit<AgentFormReference, 'token'>

/**
 * The answer to get_form, set_form and set_references. `params` is what a generation would send now (inputs
 * the mode doesn't use are left out); `references` are in order, @Image1 first, only in reference mode and
 * only the images the model takes.
 */
export interface FormSnapshot extends AgentFormState {
  view: View
  /** The start (and end) image in image-to-video mode, tied to its library photo. */
  startImage?: FormImage
  endImage?: FormImage
  /** What the command adjusted on its own, e.g. a mode switch or images that didn't fit. */
  notes?: string[]
}

/** A refusal with a message meant for the agent (nothing was changed). */
export class BridgeError extends Error {}

type Args = Record<string, unknown>

function asArgs(value: unknown): Args {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Args) : {}
}

/** A tool argument by its snake_case name, or the camelCase spelling main may pass instead. */
function field(args: Args, snake: string): unknown {
  if (args[snake] !== undefined) return args[snake]
  return args[snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())]
}

function given(value: unknown): boolean {
  return value !== undefined && value !== null
}

// ── Modes and models ────────────────────────────────────────────────────────

const MODE_ALIASES: Record<string, Kind> = {
  'text-to-video': 'text-to-video',
  text: 'text-to-video',
  t2v: 'text-to-video',
  'image-to-video': 'image-to-video',
  image: 'image-to-video',
  i2v: 'image-to-video',
  'start-image': 'image-to-video',
  start_image: 'image-to-video',
  startbild: 'image-to-video',
  'reference-to-video': 'reference-to-video',
  reference: 'reference-to-video',
  references: 'reference-to-video',
  r2v: 'reference-to-video',
  referens: 'reference-to-video'
}

/** "”Referens” (reference-to-video)": the tab name the user sees and the id the agent uses. */
function modeName(kind: Kind): string {
  return `”${KINDS.find((k) => k.id === kind)?.label ?? kind}” (${kind})`
}

function parseMode(value: unknown): Kind {
  const kind = typeof value === 'string' ? MODE_ALIASES[value.trim().toLowerCase()] : undefined
  if (!kind) {
    throw new BridgeError(
      `Okänt läge ”${String(value)}”. Använd text-to-video, image-to-video (startbild) eller reference-to-video (referensbilder).`
    )
  }
  return kind
}

/** Duration, resolution, aspect ratio and audio snapped to what the model supports, as the form does. */
function snapToModel(params: GenerationParams, model: VideoModel | undefined): GenerationParams {
  if (!model) return params
  return {
    ...params,
    duration: pickOption(model.durations, params.duration, PREFERRED.durations) ?? params.duration,
    resolution: pickOption(model.resolutions, params.resolution, PREFERRED.resolutions),
    aspectRatio: pickOption(model.aspectRatios, params.aspectRatio, PREFERRED.aspectRatios),
    audio: audioForModel(model, params.audio)
  }
}

/** Notes for the settings a model change adjusted without being asked. */
function adjustedNotes(before: GenerationParams, after: GenerationParams, explicit: Set<string>): string[] {
  const labels: [keyof GenerationParams, string, string][] = [
    ['duration', 'duration', 'Längden'],
    ['resolution', 'resolution', 'Upplösningen'],
    ['aspectRatio', 'aspect_ratio', 'Formatet']
  ]
  return labels.flatMap(([key, arg, label]) =>
    !explicit.has(arg) && before[key] !== after[key] && after[key] !== undefined
      ? [`${label} ändrades till ${String(after[key])}, som modellen stöder.`]
      : []
  )
}

/** "8" or 8 → "8s"; anything else as written. */
function normalizeDuration(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}s`
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase().replace(/\s+/g, '')
  return /^\d+(\.\d+)?$/.test(v) ? `${v}s` : v
}

/** "720" or 720 → "720p". */
function normalizeResolution(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}p`
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  return /^\d+$/.test(v) ? `${v}p` : v
}

/** "16x9" → "16:9". */
function normalizeAspect(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().replace(/^(\d+)\s*[x/]\s*(\d+)$/i, '$1:$2') : undefined
}

function choices(options: readonly string[]): string {
  return options.join(', ')
}

// ── Commands (pure, so they can be tested without a window) ─────────────────

export interface FormChange {
  params: GenerationParams
  notes: string[]
}

/**
 * Applies set_form's arguments to the form. Everything is checked before anything changes: one invalid value
 * refuses the whole command with every problem listed. Choosing a mode picks a model of that mode in the
 * same family (like the mode tabs); a start image without a mode switches to image-to-video.
 */
export function applySetForm(
  current: GenerationParams,
  rawArgs: unknown,
  models: readonly VideoModel[],
  modelsError?: string
): FormChange {
  const args = asArgs(rawArgs)
  const modeValue = field(args, 'mode')
  const modelValue = field(args, 'model')
  const durationValue = field(args, 'duration')
  const resolutionValue = field(args, 'resolution')
  const aspectValue = field(args, 'aspect_ratio')
  const audioValue = field(args, 'audio')
  const promptValue = field(args, 'prompt')
  const negativeValue = field(args, 'negative_prompt')
  const startValue = field(args, 'start_image')
  const explicit = new Set(
    ['duration', 'resolution', 'aspect_ratio', 'audio'].filter((key) => given(field(args, key)))
  )

  const needsModels =
    [modeValue, modelValue, durationValue, resolutionValue, aspectValue, audioValue, startValue].some(given)
  if (needsModels && !models.length) {
    throw new BridgeError(
      `Studio kunde inte hämta modellistan från Venice${modelsError ? ` (${modelsError})` : ''}. Försök igen om en stund.`
    )
  }

  const errors: string[] = []
  const notes: string[] = []
  const mode = given(modeValue) ? parseMode(modeValue) : undefined

  // Mode and model first: the other values are checked against the model they end up with.
  let modelId = current.model
  if (given(modelValue)) {
    const id = typeof modelValue === 'string' ? modelValue.trim() : ''
    const chosen = models.find((m) => m.id === id)
    if (!chosen) errors.push(`Modellen ”${String(modelValue)}” finns inte. Se list_models för vilka som finns.`)
    else if (chosen.offline) errors.push(`${chosen.name} är offline just nu – välj en annan modell.`)
    else if (mode && kindOfModelId(chosen.id) !== mode) {
      errors.push(`${chosen.name} hör till läget ${modeName(kindOfModelId(chosen.id))}, inte ${modeName(mode)}.`)
    } else modelId = chosen.id
  } else {
    const currentKind = kindOfModelId(current.model)
    const wanted = mode ?? (given(startValue) && currentKind !== 'image-to-video' ? 'image-to-video' : undefined)
    if (wanted && wanted !== currentKind) {
      const id = modelForKind([...models], current.model, wanted)
      if (!id) errors.push(`Det finns ingen tillgänglig modell för läget ${modeName(wanted)} just nu.`)
      else {
        modelId = id
        if (!mode) notes.push(`Bytte till läget ${modeName(wanted)} för startbilden.`)
      }
    }
  }

  const model = models.find((m) => m.id === modelId)
  const modelLabel = model?.name ?? modelId
  const modelChanged = modelId !== current.model
  const before: GenerationParams = { ...current, model: modelId }
  const next = snapToModel(before, model)
  if (modelChanged) notes.push(...adjustedNotes(current, next, explicit))

  const unknownModel = () =>
    errors.push(`Modellen ${modelLabel} finns inte i Venice modellista längre – välj en annan med model.`)

  if (given(durationValue)) {
    const duration = normalizeDuration(durationValue)
    if (!model) unknownModel()
    else if (!duration || !model.durations.includes(duration)) {
      errors.push(`Längden ${String(durationValue)} går inte med ${modelLabel}. Välj bland: ${choices(model.durations)}.`)
    } else next.duration = duration
  }

  if (given(resolutionValue)) {
    const resolution = normalizeResolution(resolutionValue)
    if (!model) unknownModel()
    else if (!model.resolutions.length) errors.push(`${modelLabel} har ingen valbar upplösning.`)
    else if (!resolution || !model.resolutions.includes(resolution)) {
      errors.push(
        `Upplösningen ${String(resolutionValue)} går inte med ${modelLabel}. Välj bland: ${choices(model.resolutions)}.`
      )
    } else next.resolution = resolution
  }

  if (given(aspectValue)) {
    const aspect = normalizeAspect(aspectValue)
    if (!model) unknownModel()
    else if (!model.aspectRatios.length) errors.push(`${modelLabel} har inget valbart format.`)
    else if (!aspect || !model.aspectRatios.includes(aspect)) {
      errors.push(
        `Formatet ${String(aspectValue)} går inte med ${modelLabel}. Välj bland: ${choices(model.aspectRatios)}.`
      )
    } else next.aspectRatio = aspect
  }

  if (given(audioValue)) {
    if (typeof audioValue !== 'boolean') errors.push('audio ska vara true eller false.')
    else if (!model) unknownModel()
    else if (!model.audio) {
      if (audioValue) errors.push(`${modelLabel} kan inte generera ljud.`)
    } else if (!model.audioConfigurable && !audioValue) errors.push(`Ljudet går inte att stänga av för ${modelLabel}.`)
    else next.audio = audioValue
  }

  if (promptValue !== undefined) {
    if (promptValue === null) next.prompt = ''
    else if (typeof promptValue !== 'string') errors.push('prompt ska vara text.')
    else next.prompt = canonicalizeTokens(promptValue)
  }

  if (negativeValue !== undefined) {
    if (negativeValue === null) next.negativePrompt = undefined
    else if (typeof negativeValue !== 'string') errors.push('negative_prompt ska vara text.')
    else next.negativePrompt = negativeValue.trim() ? negativeValue : undefined
  }

  if (startValue !== undefined) {
    if (startValue === null) next.startImage = undefined
    else {
      const path = typeof startValue === 'string' ? startValue : asArgs(startValue).path
      const kind = kindOfModelId(next.model)
      if (typeof path !== 'string' || !path.startsWith('/')) errors.push('Startbilden kunde inte hittas i biblioteket.')
      else if (kind !== 'image-to-video') {
        errors.push(`En startbild används bara i läget ${modeName('image-to-video')}, inte ${modeName(kind)}.`)
      } else next.startImage = path
    }
  }

  const limit = model?.promptCharacterLimit
  if (limit && next.prompt.length > limit && (promptValue !== undefined || modelChanged)) {
    errors.push(`Prompten är ${next.prompt.length} tecken – ${modelLabel} tar högst ${limit}. Korta den.`)
  }

  if (errors.length) throw new BridgeError(`Inget ändrades. ${errors.join(' ')}`)
  return { params: next, notes }
}

/**
 * Applies set_references: the given photos (main has resolved asset ids to paths) replace the reference
 * images or are added after them, as many as the model takes. Switches to reference mode if needed. The
 * prompt is left alone: an agent typically writes it for the new list right after.
 */
export function applySetReferences(
  current: GenerationParams,
  rawArgs: unknown,
  models: readonly VideoModel[]
): FormChange {
  const args = asArgs(rawArgs)
  const paths = args.paths
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p.startsWith('/'))) {
    throw new BridgeError('Referensbilderna kunde inte läsas (paths ska vara en lista med bildsökvägar).')
  }
  const mode = args.mode ?? 'replace'
  if (mode !== 'replace' && mode !== 'append') throw new BridgeError('mode ska vara ”replace” eller ”append”.')

  const notes: string[] = []
  let next: GenerationParams = { ...current }
  if (kindOfModelId(current.model) !== 'reference-to-video') {
    const id = modelForKind([...models], current.model, 'reference-to-video') ?? DEFAULT_MODEL['reference-to-video']
    const model = models.find((m) => m.id === id)
    next = snapToModel({ ...next, model: id }, model)
    notes.push(`Bytte till läget ${modeName('reference-to-video')} med ${model?.name ?? id}.`)
  }

  const max = maxReferenceImages(next.model)
  const before = current.referenceImages ?? []
  const { refs, note } = addPaths(mode === 'append' ? before : [], paths as string[], max)
  if (note) notes.push(note)
  next.referenceImages = refs

  if (mode === 'replace' && findImageTokens(next.prompt).length && !sameList(before, refs)) {
    notes.push('Prompten ändrades inte – se till att varje @ImageN i den pekar på rätt bild i den nya listan.')
  }
  return { params: next, notes }
}

// ── Answers ─────────────────────────────────────────────────────────────────

function photoIndex(assets: readonly Asset[]): Map<string, FormImage> {
  const map = new Map<string, FormImage>()
  for (const a of assets) {
    a.images.forEach((img, i) =>
      map.set(img.path, { path: img.path, assetId: a.id, assetName: a.name, kind: a.kind, photoNumber: i + 1 })
    )
  }
  return map
}

/** The form as the agent should see it, with every image tied to its library asset. */
export function describeForm(
  params: GenerationParams,
  assets: readonly Asset[],
  where: { view: View; sequenceId?: string; segmentId?: string },
  notes: string[] = []
): FormSnapshot {
  const sent = paramsForSubmit(params)
  const photos = photoIndex(assets)
  const describe = (path: string): FormImage => photos.get(path) ?? { path }
  return {
    ...where,
    params: sent,
    references: (sent.referenceImages ?? []).map((path, i) => ({ token: `@Image${i + 1}`, ...describe(path) })),
    ...(sent.startImage ? { startImage: describe(sent.startImage) } : {}),
    ...(sent.endImage ? { endImage: describe(sent.endImage) } : {}),
    issues: promptIssuesOf(params),
    ...(notes.length ? { notes } : {})
  }
}

// ── The bridge ──────────────────────────────────────────────────────────────

export interface BridgeContext {
  view: () => View
  /** Brings a view to the front (with an intent, e.g. which sequence to open). */
  show: (view: View, intent?: Intent) => void
}

/**
 * Venice's model list, waiting at most `ms` for it: a slow Venice must not hold up a command until main gives
 * up on the window (COMMAND_TIMEOUT_MS) and tells the agent Studio isn't answering.
 */
async function modelList(ms: number): Promise<{ models: VideoModel[]; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Venice svarar inte med modellistan just nu.')), ms)
  })
  try {
    return { models: await Promise.race([loadModels(), timeout]) }
  } catch (e) {
    return { models: [], error: ipcErrorMessage(e) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The library's assets, after pointing the form's photos at where they are now: a renamed character's photos
 * move with its folder (GenerateView does the same while it is open).
 */
async function assetsFollowingForm(): Promise<Asset[]> {
  const assets = await window.studio.listAssets()
  const followed = followAssetImages(getGenerateParams(), assets, readRememberedImageIds())
  if (followed) setGenerateParams(followed)
  return assets
}

function snapshot(view: View, assets: readonly Asset[], notes?: string[]): FormSnapshot {
  const where = view === 'sequences' ? { view, ...openInSequenceEditor() } : { view }
  return describeForm(getGenerateParams(), assets, where, notes)
}

async function findSequenceOfSegment(segmentId: string): Promise<string | undefined> {
  for (const summary of await window.studio.listSequences()) {
    const sequence = await window.studio.getSequence(summary.id)
    if (sequence.segments.some((s) => s.id === segmentId)) return sequence.id
  }
  return undefined
}

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function open(rawArgs: unknown, ctx: BridgeContext): Promise<AgentOpenResult> {
  const args = asArgs(rawArgs)
  if (args.view === 'generate') {
    ctx.show('generate')
    return { view: 'generate' }
  }
  if (args.view !== 'sequences' && args.view !== 'sequence') {
    throw new BridgeError('view ska vara ”generate” eller ”sequences”.')
  }
  const segmentId = optionalId(field(args, 'segment_id'))
  const sequenceId = optionalId(field(args, 'sequence_id')) ?? (segmentId && (await findSequenceOfSegment(segmentId)))
  if (segmentId && !sequenceId) throw new BridgeError('Klippet finns inte (längre).')
  if (!sequenceId) {
    ctx.show('sequences')
    return { view: 'sequences', ...openInSequenceEditor() }
  }
  const sequence = await window.studio.getSequence(sequenceId).catch(() => undefined)
  if (!sequence) throw new BridgeError('Sekvensen finns inte (längre).')
  if (segmentId && !sequence.segments.some((s) => s.id === segmentId)) {
    throw new BridgeError(`Klippet finns inte i sekvensen ”${sequence.name}”.`)
  }
  ctx.show('sequences', { type: 'open-sequence', sequenceId, segmentId })
  // Answer with the clip that is actually on screen once the sequence editor has loaded it.
  const shown = await settled(() => {
    const onScreen = openInSequenceEditor()
    return onScreen.sequenceId === sequenceId && !!onScreen.segmentId && (!segmentId || onScreen.segmentId === segmentId)
  })
  const onScreen = openInSequenceEditor()
  return {
    view: 'sequences',
    sequenceId,
    sequenceName: sequence.name,
    segmentId: onScreen.sequenceId === sequenceId ? onScreen.segmentId : undefined,
    ...(shown || !segmentId ? {} : { note: 'Sekvensen öppnades, men ett annat klipp än det begärda visas.' })
  }
}

/** Waits (up to `ms`) for the UI to get somewhere; true if it did. */
async function settled(done: () => boolean, ms = 2000): Promise<boolean> {
  const until = Date.now() + ms
  while (!done()) {
    if (Date.now() > until) return false
    await new Promise((r) => setTimeout(r, 50))
  }
  return true
}

/** Main has answered the command as failed already (it waited COMMAND_TIMEOUT_MS); it must not be applied. */
function expired(cmd: AgentCommand): boolean {
  return cmd.deadline !== undefined && Date.now() > cmd.deadline
}

const TOO_LATE = 'Studio hann inte svara i tid, så inget ändrades. Försök igen.'
const SWITCHING_LIBRARY = 'Studios bibliotek är inte öppet just nu – försök igen om en stund.'

async function run(cmd: AgentCommand, ctx: BridgeContext): Promise<unknown> {
  // Queued behind slow commands until main stopped waiting for it.
  if (expired(cmd)) throw new BridgeError(TOO_LATE)
  // During a library switch the paths and ids in the form belong to the library being left.
  const library = await window.studio.libraryStatus()
  if (library.state !== 'ready' || generateParamsFrozen()) throw new BridgeError(SWITCHING_LIBRARY)

  if (cmd.command === 'open') return open(cmd.args, ctx)
  if (cmd.command !== 'get_form' && cmd.command !== 'set_form' && cmd.command !== 'set_references') {
    throw new BridgeError(`Studio känner inte igen kommandot ”${String(cmd.command)}”.`)
  }

  // Loading the models also registers their modes, which decide the mode of ids that don't name it. Reading
  // the form only needs that for unusual ids, so it waits less.
  const { models, error } = await modelList(cmd.command === 'get_form' ? 1500 : 4000)
  const assets = await assetsFollowingForm()
  if (cmd.command === 'get_form') return snapshot(ctx.view(), assets)

  // Read after the awaits, so the change builds on the form as it is now (the user may have typed meanwhile).
  const change =
    cmd.command === 'set_form'
      ? applySetForm(getGenerateParams(), cmd.args, models, error)
      : applySetReferences(getGenerateParams(), cmd.args, models)
  // The awaits may have outlasted main's patience, or a library switch may have gone through meanwhile.
  if (expired(cmd)) throw new BridgeError(TOO_LATE)
  if (generateParamsFrozen()) throw new BridgeError(SWITCHING_LIBRARY)
  setGenerateParams(change.params)
  ctx.show('generate')
  return snapshot('generate', assets, change.notes)
}

/** Runs one command and says how it went; never throws. */
export async function handleAgentCommand(cmd: AgentCommand, ctx: BridgeContext): Promise<AgentCommandReply> {
  try {
    return { ok: true, result: await run(cmd, ctx) }
  } catch (e) {
    return { ok: false, error: e instanceof BridgeError ? e.message : ipcErrorMessage(e) }
  }
}

/**
 * Answers the agent's form commands while the workspace is open. Commands run one at a time, in the order
 * they arrive, so two quick edits can't overwrite each other.
 */
export function useAgentBridge(view: View, navigate: Navigate): void {
  const viewRef = useRef(view)
  const navigateRef = useRef(navigate)
  useEffect(() => {
    viewRef.current = view
    navigateRef.current = navigate
  })

  useEffect(() => {
    const ctx: BridgeContext = {
      view: () => viewRef.current,
      show: (target, intent) => {
        if (target === viewRef.current && !intent) return
        viewRef.current = target
        navigateRef.current(target, intent)
      }
    }
    let queue: Promise<void> = Promise.resolve()
    const off = window.studio.onAgentCommand((cmd) => {
      queue = queue
        .then(async () => window.studio.replyAgentCommand(cmd.id, await handleAgentCommand(cmd, ctx)))
        // Keep the queue going; main times the command out if no reply got through.
        .catch(() => {})
    })
    return off
  }, [])
}
