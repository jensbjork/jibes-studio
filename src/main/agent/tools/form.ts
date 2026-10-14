import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  DEFAULT_MODEL,
  MAX_REFERENCE_AUDIO_SECONDS,
  endImageVariant,
  kindOfModelId,
  maxReferenceAudios,
  maxReferenceImages,
  supportsEndImage,
  type Kind
} from '@shared/models'
import { includesDescriptions } from '@shared/prompt-compose'
import { inGenerateSession, isMediaTab, type MediaTab } from '@shared/session'
import {
  audioToken,
  canonicalizeTokens,
  findAudioTokens,
  findImageTokens,
  hasBlockingIssues,
  imageToken,
  type ReferenceKind
} from '@shared/prompt-refs'
import type {
  AgentFormState,
  AgentOpenArgs,
  AgentOpenResult,
  AgentReorderReferencesArgs,
  AgentSetFormArgs,
  AgentSetReferencesArgs,
  AssetKind,
  AssetViewId,
  Edit,
  ExportSummary,
  GenerationParams,
  ReferenceAudio,
  Sequence,
  Storyboard,
  VideoModel
} from '@shared/types'
import * as db from '../../db'
import * as store from '../../sequence-store'
import { currentSession } from '../../session'
import { callService } from '../local-ipc'
import { isStoryboardId } from '../storyboard-rows'
import {
  inOrder,
  movedSummary,
  movedTokens,
  namedPositions,
  newOrder,
  notSentInfo,
  referencesAnswer,
  reorderAnswer,
  unchanged
} from '../reorder'
import {
  applySwap,
  planSwap,
  swapArgs,
  swapNotes,
  swapSummary,
  swappedInfo,
  swappedTokens,
  swapsNothing,
  unchangedNote,
  type ReadySwap,
  type SwapInput
} from '../swap'
import {
  AssetIndex,
  MODES,
  StillIndex,
  applyOutfitWearers,
  assetPhotoPath,
  audioTarget,
  audioTokenMap,
  blockingProblem,
  canonical,
  checkOutputOptions,
  checkPromptLength,
  descriptionInfo,
  errorText,
  issueList,
  loadModels,
  modelForMode,
  modelsIfAvailable,
  normalizeAspectRatio,
  normalizeDuration,
  normalizeResolution,
  paramsInfo,
  promptIssues,
  q,
  requireLibrary,
  requireModel,
  resolveReferences,
  takesAudio,
  tokenMap,
  usableModels,
  type ReferenceItem
} from '../studio'
import {
  READ_ONLY,
  WRITE,
  defineTool,
  excludedDescriptionsInput,
  includeDescriptionsInput,
  outfitWearersInput,
  priceValue,
  quote,
  readForm,
  referenceItem,
  type ToolContext,
  type ToolOutput
} from './kit'
import { reorderClipReferences, swapClipReference } from './sequences'
import { importAsStill, resolvePictureReferences, uploadSource } from './sources'

// The Generate form in Studio's window and what the user is looking at. These tools go through the window (the
// form is its state), so the user sees every change as it happens.

/** What the model takes in reference mode: images, and audio when it has audio input. */
export function referenceLimits(modelId: string, models?: readonly VideoModel[]): Record<string, unknown> {
  if (kindOfModelId(modelId) !== 'reference-to-video') return {}
  const audioInput = takesAudio(modelId, models)
  return {
    max_reference_images: maxReferenceImages(modelId),
    audio_input: audioInput,
    ...(audioInput
      ? { max_reference_audios: maxReferenceAudios(modelId), max_reference_audio_seconds: MAX_REFERENCE_AUDIO_SECONDS }
      : {})
  }
}

/**
 * The form's reference images in order, including those past the model's limit: the window reports the sent
 * ones as params (what a generation would send) and the rest apart, so the user's "skickas inte" pictures are
 * there for an agent to see and move forward.
 */
function formImages(state: AgentFormState): string[] {
  const unsent = (Array.isArray(state.unsentReferences) ? state.unsentReferences : [])
    .filter((r) => typeof r?.path === 'string' && Number.isFinite(r.position))
    .sort((a, b) => a.position - b.position)
    .map((r) => r.path)
  return [...(state.params.referenceImages ?? []), ...unsent]
}

/**
 * The form as the tools report it: settings, the token maps, the prompt as it is sent (with the descriptions of
 * its references appended), problems and (optionally) the price.
 */
async function formInfo(state: AgentFormState, index: AssetIndex, withPrice: boolean): Promise<Record<string, unknown>> {
  const params = state.params
  const problem = blockingProblem(params)
  // Also what makes main remember the models' prompt limits, which the descriptions are fitted into.
  const models = await modelsIfAvailable()
  const reference = kindOfModelId(params.model) === 'reference-to-video'
  return {
    ...paramsInfo(params, index),
    ...(reference ? notSentInfo(formImages(state), params.model, index) : {}),
    ...descriptionInfo(params, index),
    issues: issueList(promptIssues(params)),
    ready: !problem,
    ...(problem ? { blocking_problem: problem } : {}),
    ...referenceLimits(params.model, models),
    ...(withPrice ? { price_usd: priceValue(await quote(params)) } : {})
  }
}

/** The asset ids an agent wants left out of the References legend, each checked to be an asset (no duplicates). */
export function excludedIds(ids: readonly string[], index: AssetIndex): string[] {
  return [...new Set(ids.map((id) => index.require(id.trim()).id))]
}

const sameIds = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort())

const sameWearers = (a: GenerationParams['outfitWearers'], b: GenerationParams['outfitWearers']): boolean =>
  JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort())

/** The model references are chosen for: the form's, or the reference-to-video model Studio would switch it to. */
function referenceModel(currentModel: string, models: readonly VideoModel[] | undefined): string {
  if (kindOfModelId(currentModel) === 'reference-to-video') return currentModel
  try {
    return models ? modelForMode(models, currentModel, 'reference-to-video') : DEFAULT_MODEL['reference-to-video']
  } catch {
    return DEFAULT_MODEL['reference-to-video']
  }
}

const sameAudio = (a: ReferenceAudio, b: ReferenceAudio): boolean =>
  a.path.normalize('NFC') === b.path.normalize('NFC')

const samePaths = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((p, i) => p.normalize('NFC') === b[i].normalize('NFC'))

/** What set_form changed, for the activity log. */
function formChanges(args: Record<string, unknown>): string {
  const labels: [string, string][] = [
    ['mode', 'läge'],
    ['model', 'modell'],
    ['duration', 'längd'],
    ['resolution', 'upplösning'],
    ['aspect_ratio', 'bildformat'],
    ['audio', 'ljud'],
    ['negative_prompt', 'negativ prompt'],
    ['start_image', 'startbild'],
    ['end_image', 'slutbild'],
    ['include_descriptions', 'beskrivningarna'],
    ['excluded_description_asset_ids', 'beskrivningarna'],
    ['outfit_wearers', 'vem som bär kläderna']
  ]
  const others = [...new Set(labels.filter(([key]) => args[key] !== undefined).map(([, label]) => label))]
  const prompt = args.prompt !== undefined
  if (prompt && others.length) return `satte prompten och ändrade ${others.join(', ')}`
  if (prompt) return 'satte prompten'
  if (others.length) return `ändrade ${others.join(', ')} i formuläret`
  return 'tittade på formuläret'
}

/** The library view of each asset kind (the renderer's View ids). */
const ASSET_VIEWS: Record<AssetKind, AssetViewId> = {
  character: 'characters',
  environment: 'environments',
  product: 'products',
  outfit: 'outfits',
  pose: 'poses'
}

/**
 * open for the Mediabank: a tab (none: the one it last showed), and the clip (Videor's drawer), picture (Bilder) or
 * film (Filmer) to open in it. The window answers with the tab on screen (agentBridge's applyOpen).
 */
type MediaOpenArgs = AgentOpenArgs & { view: 'media' }

/** open_in_studio's line in the activity log, by view. */
const OPENED = {
  generate: 'visade Generera',
  media: 'visade Mediabanken',
  sequence: 'visade en sekvens',
  storyboard: 'visade en storyboard',
  editor: 'visade Redigera',
  asset: 'visade en tillgång',
  prompts: 'visade promptbiblioteket'
} as const

/** The tab an item of the Mediabank is in. */
const MEDIA_TAB_OF = { generation_id: 'videos', still_id: 'pictures', export_id: 'films' } as const satisfies Record<
  string,
  MediaTab
>

/** A start or end picture for the Generate form, as an agent names it. */
const formPictureInput = z
  .union([
    z.object({ asset_id: z.string(), image_id: z.string().optional() }).strict(),
    z.object({ still_id: z.string() }).strict(),
    uploadSource,
    z.null()
  ])
  .optional()

type FormPictureInput = z.infer<typeof formPictureInput>

/**
 * The file a form picture names: a library photo (its cover unless image_id), a still, or an upload – made a still in
 * Referensbilder first, so the form (and every generation made from it) never points into the scratch folder. null
 * clears the slot.
 */
async function formPicture(
  ctx: ToolContext,
  value: FormPictureInput,
  index: AssetIndex
): Promise<string | null | undefined> {
  if (value === undefined || value === null) return value
  if ('asset_id' in value) return assetPhotoPath(value.asset_id, value.image_id, index)
  if ('still_id' in value) return (await StillIndex.load()).require(value.still_id).path
  return (await importAsStill(ctx, { upload_id: value.upload_id })).path
}

export function registerFormTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'get_workspace',
    {
      title: 'Get workspace',
      description:
        "What the user is looking at in Studio right now (the view – generate, media (the Mediabank: everything made, with media_tab – videos, pictures or films – the tab on screen), sequences, storyboards, editor, prompts, settings or a library view: characters, environments, products, outfits, poses – and the sequence and clip open in the sequence editor, the storyboard open in Storyboards, or the edit open in Redigera – view \"editor\", edit_id) and the Generate form: mode, model, duration, resolution, aspect ratio, audio, prompt, negative prompt, the reference images as a token map ({token: \"@Image1\", asset_name, kind, photo_number}), the reference audio as a token map ({token: \"@Audio1\", asset_name, role: \"voice\", start, length}), what the model takes (max_reference_images, audio_input), the start image, validation issues for the @ImageN / @AudioN tokens, whether it is ready to generate, and Venice's price. composed_prompt is the prompt exactly as it would be sent: Studio appends the descriptions of the referenced assets as a References legend (description_entries lists them with their tokens, whether each is switched on (included), whether it is in composed_prompt now (sent) and for an outfit who wears it (worn_by); include_descriptions, excluded_description_asset_ids and who wears what are the form's choices, changed with set_form). Issues warn about references the prompt never mentions only when the legend doesn't explain them either. Start here to see what the user is working on.",
      input: {},
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'tittade på arbetsytan'
    },
    async () => {
      requireLibrary()
      const state: AgentFormState = await readForm(ctx)
      const index = await AssetIndex.load()
      // The edit open in Redigera, named, so the agent knows which film the user is looking at.
      const edit = state.editId
        ? await callService<Edit>('edits:get', state.editId).catch(() => undefined)
        : undefined
      return {
        data: {
          view: state.view,
          ...(state.view === 'media' && isMediaTab(state.mediaTab) ? { media_tab: state.mediaTab } : {}),
          sequence_id: state.sequenceId,
          segment_id: state.segmentId,
          storyboard_id: state.storyboardId,
          ...(state.editId
            ? {
                edit_id: state.editId,
                ...(edit
                  ? { edit_name: edit.name, current_version_id: edit.currentId, version_count: edit.versionCount }
                  : {})
              }
            : {}),
          form: await formInfo(state, index, true)
        }
      }
    }
  )

  defineTool(
    server,
    ctx,
    'set_references',
    {
      title: 'Set references',
      description:
        "Sets the Generate form's references (reference-to-video mode) from assets: each item adds all photos of an asset, or just the image_ids you list, in order – and for models that take reference audio (audio_input in list_models) its audio: by default a character's first voice clip, or the audio_ids you list (include_voice: false leaves the voice out; true also adds an environment's soundscape). Photos become @Image1, @Image2 … and audio clips @Audio1, @Audio2 … in the order given. mode \"replace\" (default) makes these the references; \"append\" adds them after the current ones (duplicates skipped). The model's limits apply (9 images for Seedance; at most 3 audio clips and 15 s of audio in total); what doesn't fit is reported in not_added / not_added_audio. A pose asset is a picture of how people stand – add it like any asset and refer to it in the prompt (see the guide). A character's default outfit is NOT added automatically – add it (or another outfit) yourself. An item can also be {still_id} (a still) or {upload_id} (a ready image upload, made a still in Referensbilder first): one loose picture with no description, so nothing about it is appended to the prompt – say in words what it shows. A product goes after the characters (see the guide). Returns the resulting token maps (references, audio_references) – write the prompt with exactly these tokens. Choose the references first and write the prompt afterwards: setting the references (mode \"replace\") does not renumber tokens already in the prompt (check the returned issues and notes) – to change only their order, use reorder_references, which does. If the form is not in reference-to-video mode, Studio switches it (see notes). An empty items list with mode \"replace\" removes all references.",
      input: {
        items: z
          .array(referenceItem)
          .describe(
            'Assets (or loose pictures) in the order their photos (and audio) should get @Image / @Audio numbers.'
          ),
        mode: z.enum(['replace', 'append']).default('replace')
      },
      annotations: WRITE,
      summary: ({ items, mode }) =>
        !items.length && mode === 'replace' ? 'tömde referenserna' : `${mode === 'append' ? 'lade till' : 'satte'} referenserna`
    },
    async ({ items, mode }) => {
      const index = await AssetIndex.load()
      const current = await readForm(ctx)
      const models = items.length ? await modelsIfAvailable() : undefined
      const model = referenceModel(current.params.model, models)
      const existing = mode === 'append' ? (current.params.referenceAudios ?? []) : []
      const refs = await resolvePictureReferences(ctx, items, true)
      const resolved = resolveReferences(refs, index, audioTarget(model, models, existing))
      const args: AgentSetReferencesArgs = { paths: resolved.paths, audios: resolved.audios, mode }
      const state = await ctx.bridge.send<AgentFormState>('set_references', args)
      const result = new Set(state.params.referenceImages ?? [])
      const notAdded = resolved.paths.filter((p) => !result.has(p))
      const audioNow = state.params.referenceAudios ?? []
      // Clips the window didn't take (beyond what main already left out) are reported too, never silently lost.
      const droppedAudio = resolved.audios.filter((a) => !audioNow.some((b) => sameAudio(a, b)))
      const notAddedAudio = [
        ...resolved.skippedAudio,
        ...audioTokenMap(droppedAudio, index).map(({ token: _, ...rest }) => ({
          ...rest,
          reason: 'Studio-fönstret lade inte till ljudklippet (modellens gräns eller läge).'
        }))
      ]
      const names = [
        ...new Set(items.map((i) => ('asset_id' in i ? index.get(i.asset_id)?.name : undefined)).filter(Boolean))
      ] as string[]
      const kind = kindOfModelId(state.params.model)
      const notes = [...resolved.notes, ...(state.notes ?? [])]
      return {
        data: {
          references: tokenMap(state.params.referenceImages, index),
          ...(audioNow.length ? { audio_references: audioTokenMap(audioNow, index) } : {}),
          ...referenceLimits(state.params.model, models),
          ...(notAdded.length ? { not_added: tokenMap(notAdded, index).map(({ token: _, ...rest }) => rest) } : {}),
          ...(notAddedAudio.length ? { not_added_audio: notAddedAudio } : {}),
          mode: kind,
          ...(kind !== 'reference-to-video'
            ? { note: 'The form is not in reference-to-video mode, so these references are not sent. Call set_form({mode: "reference-to-video"}).' }
            : {}),
          issues: issueList(promptIssues(state.params)),
          ...(notes.length ? { notes } : {})
        },
        summary: names.length
          ? `${mode === 'append' ? 'lade till' : 'satte'} referenserna (${names.join(', ')}${audioNow.length ? `, ${audioNow.length} ljud` : ''})`
          : undefined
      }
    }
  )

  defineTool(
    server,
    ctx,
    'set_form',
    {
      title: 'Set Generate form',
      description:
        "Fills in Studio's Generate form and shows the Generate view. Only the fields you pass change. Values are checked against the model (see list_models): duration like \"8s\", resolution like \"480p\", aspect_ratio like \"16:9\". Passing mode alone switches to that mode's model in the same family (as Studio's mode switch does). start_image is the picture that becomes the first frame – {asset_id, image_id?} (a library photo, its cover unless you give image_id), {still_id} or {upload_id} (made a still in Referensbilder first); it switches the form to image-to-video. end_image is the picture the clip ends on (the same kinds), for an image-to-video model that takes an end image (supports_end_image in list_models; without a model given Studio picks the family's one that does). null clears either. @ImageN tokens are normalised (\"@image3\" → \"@Image3\"). include_descriptions and excluded_description_asset_ids decide which descriptions of the referenced assets Studio appends to the prompt as a References legend (all of them by default – don't repeat them in the prompt); outfit_wearers decides who wears each outfit among the references, which the legend says too. All or nothing: if any value is invalid, nothing changes and the error lists every problem. Returns the form with the token map, the composed prompt, validation issues, the price and notes about anything Studio adjusted on its own (e.g. a duration the new model doesn't offer). To use reference images, call set_references; to reorder them, reorder_references.",
      input: {
        mode: z.enum(MODES).optional().describe('"reference-to-video" (default mode), "image-to-video" or "text-to-video".'),
        model: z.string().optional().describe('A model id from list_models.'),
        duration: z.string().optional().describe('e.g. "8s".'),
        resolution: z.string().optional().describe('e.g. "480p" or "720p".'),
        aspect_ratio: z.string().optional().describe('e.g. "16:9", "9:16", "1:1".'),
        audio: z.boolean().optional(),
        prompt: z.string().optional(),
        negative_prompt: z.string().optional().describe('Empty string clears it.'),
        start_image: formPictureInput.describe(
          'The picture that becomes the first frame (image-to-video): {asset_id, image_id?}, {still_id} or {upload_id}; null clears it.'
        ),
        end_image: formPictureInput.describe(
          'The picture the clip ends on (a model with supports_end_image): {asset_id, image_id?}, {still_id} or {upload_id}; null clears it.'
        ),
        include_descriptions: includeDescriptionsInput,
        excluded_description_asset_ids: excludedDescriptionsInput,
        outfit_wearers: outfitWearersInput
      },
      annotations: WRITE,
      summary: (args) => formChanges(args)
    },
    async (input) => {
      const index = await AssetIndex.load()
      const excluded =
        input.excluded_description_asset_ids === undefined
          ? undefined
          : excludedIds(input.excluded_description_asset_ids, index)
      const duration = normalizeDuration(input.duration)
      const resolution = normalizeResolution(input.resolution)
      const aspectRatio = normalizeAspectRatio(input.aspect_ratio)
      const needsModel =
        input.mode !== undefined ||
        input.model !== undefined ||
        duration !== undefined ||
        resolution !== undefined ||
        aspectRatio !== undefined ||
        input.audio !== undefined ||
        !!input.start_image ||
        !!input.end_image

      const args: AgentSetFormArgs = {}
      if (needsModel) {
        const models = await loadModels()
        const current = await readForm(ctx)
        let modelId = current.params.model
        if (input.model) {
          modelId = requireModel(models, input.model).id
          const kind = kindOfModelId(modelId)
          if (input.mode && input.mode !== kind) {
            throw new Error(`Modellen ${modelId} är för läget ${kind}, inte ${input.mode}.`)
          }
        } else {
          // A start (or end) image alone means image-to-video, as choosing one in the form does.
          const wanted = input.mode ?? (input.start_image || input.end_image ? 'image-to-video' : undefined)
          if (wanted && wanted !== kindOfModelId(modelId)) modelId = modelForMode(models, modelId, wanted)
          // An end image needs a model that takes one: the family's, as a sequence clip gets it.
          if (input.end_image && kindOfModelId(modelId) === 'image-to-video' && !supportsEndImage(modelId)) {
            modelId = endImageVariant(modelId, usableModels(models).map((m) => m.id))
          }
        }
        const model = usableModels(models).find((m) => m.id === modelId)
        if (model) {
          checkOutputOptions(model, { duration, resolution, aspectRatio, audio: input.audio })
          checkPromptLength(model, input.prompt)
        }
        const mode: Kind = kindOfModelId(modelId)
        if (input.start_image && mode !== 'image-to-video') {
          throw new Error(`start_image används bara i läget image-to-video, men modellen ${modelId} är ${mode}.`)
        }
        if (input.end_image && (mode !== 'image-to-video' || !supportsEndImage(modelId))) {
          throw new Error(
            `${modelId} tar ingen slutbild. Välj en bild-till-video-modell med supports_end_image i list_models, eller lämna end_image.`
          )
        }
        if (modelId !== current.params.model || input.mode !== undefined || input.model !== undefined) {
          args.mode = mode
          args.model = modelId
        }
      }
      if (duration !== undefined) args.duration = duration
      if (resolution !== undefined) args.resolution = resolution
      if (aspectRatio !== undefined) args.aspect_ratio = aspectRatio
      if (input.audio !== undefined) args.audio = input.audio
      if (input.prompt !== undefined) args.prompt = canonical(input.prompt)
      if (input.negative_prompt !== undefined) args.negative_prompt = canonical(input.negative_prompt)
      // Who wears what, checked against the form's references and merged into its choices (the window takes the
      // whole set, as it takes the excluded descriptions).
      let wearers: GenerationParams['outfitWearers']
      if (input.outfit_wearers !== undefined) {
        const form = await readForm(ctx)
        wearers = applyOutfitWearers(form.params.outfitWearers, input.outfit_wearers, formImages(form), index)
        args.outfit_wearers = wearers ?? null
      }
      // Last: an upload becomes a still only once everything else is known to be right.
      if (input.start_image !== undefined) args.start_image = await formPicture(ctx, input.start_image, index)
      if (input.end_image !== undefined) args.end_image = await formPicture(ctx, input.end_image, index)
      if (input.include_descriptions !== undefined) args.include_descriptions = input.include_descriptions
      if (excluded !== undefined) args.excluded_description_asset_ids = excluded

      const state = await ctx.bridge.send<AgentFormState>('set_form', args)
      const notes = [...(state.notes ?? [])]
      // The switches only matter if the window took them; an agent must not believe a description is left out
      // (or sent) when it isn't.
      if (input.include_descriptions !== undefined && includesDescriptions(state.params) !== input.include_descriptions) {
        notes.push('Studio-fönstret ändrade inte ”Ta med beskrivningar” – kontrollera include_descriptions i svaret.')
      }
      if (excluded !== undefined && !sameIds(state.params.excludedDescriptionAssetIds, excluded)) {
        notes.push('Studio-fönstret ändrade inte vilka beskrivningar som är avslagna – kontrollera description_entries i svaret.')
      }
      if (input.outfit_wearers !== undefined && !sameWearers(state.params.outfitWearers, wearers)) {
        notes.push('Studio-fönstret ändrade inte vem som bär kläderna – kontrollera worn_by i description_entries i svaret.')
      }
      return {
        data: {
          view: state.view,
          form: await formInfo(state, index, true),
          ...(notes.length ? { notes } : {})
        }
      }
    }
  )

  defineTool(
    server,
    ctx,
    'validate_prompt',
    {
      title: 'Validate prompt',
      description:
        "Checks a prompt's @ImageN and @AudioN tokens against a set of references without changing anything – the same check Studio applies before every paid generation (tokens that point at nothing or past the model's limits, malformed ones like \"@Image 3\" or \"@Voice1\", audio with a model that takes none, audio without any reference image, more than 15 s of audio in total, references neither mentioned nor explained by the References legend). By default (use_form: true) it uses the Generate form's references, model, description switches and who wears what; pass reference_asset_ids (all photos of each asset, in order, plus characters' voices) or references (items like set_references) to check against another set, e.g. a planned sequence clip, and model or mode to check for another mode. Returns ok (no errors), the issues (Swedish messages, errors block generation, warnings are advice), the token maps with which references the prompt mentions, the prompt with tokens normalised, and composed_prompt: the prompt as it would be sent, with the descriptions of the referenced assets appended as a References legend (description_entries, with worn_by for an outfit somebody wears; include_descriptions / excluded_description_asset_ids change it like set_form's), measured against the model's prompt_character_limit.",
      input: {
        prompt: z.string(),
        negative_prompt: z.string().optional(),
        reference_asset_ids: z
          .array(z.string())
          .optional()
          .describe("Assets whose photos (all of them, in order) and – for characters, with a model that takes audio – first voice clip are the references."),
        references: z.array(referenceItem).optional().describe('Like set_references items; overrides reference_asset_ids.'),
        model: z.string().optional().describe('Check for this model (its mode and limits).'),
        mode: z.enum(MODES).optional().describe("Check for this mode (with the mode's default model) when no model is given."),
        use_form: z
          .boolean()
          .default(true)
          .describe(
            "Use the Generate form's references and model for whatever you don't pass (and, with the form's references, its description switches). Default true."
          ),
        include_descriptions: includeDescriptionsInput,
        excluded_description_asset_ids: excludedDescriptionsInput
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'kontrollerade en prompt'
    },
    async (input) => {
      const index = await AssetIndex.load()
      // A check changes nothing: an uploaded picture is checked as the upload itself, not made a still.
      const explicitRefs: ReferenceItem[] | undefined = input.references
        ? await resolvePictureReferences(ctx, input.references, false)
        : input.reference_asset_ids?.map((asset_id) => ({ asset_id }))
      const needsForm = input.use_form && (!explicitRefs || (!input.model && !input.mode))
      const form = needsForm ? await readForm(ctx) : undefined
      const model =
        input.model ?? (input.mode ? DEFAULT_MODEL[input.mode] : (form?.params.model ?? DEFAULT_MODEL['reference-to-video']))
      let paths: string[]
      let audios: ReferenceAudio[]
      const notes: string[] = []
      // Also what makes main remember the models' prompt limits, which the descriptions are fitted into.
      const models = await modelsIfAvailable()
      if (explicitRefs) {
        // The proposal as it is: limits are what the check is for, so nothing is trimmed here.
        const resolved = resolveReferences(explicitRefs, index, { ...audioTarget(model, models), enforceLimits: false })
        paths = resolved.paths
        audios = resolved.audios
        notes.push(...resolved.notes)
      } else {
        paths = form?.params.referenceImages ?? []
        audios = form?.params.referenceAudios ?? []
      }
      // The description switches follow the references: the form's go with the form's references.
      const switches = explicitRefs ? undefined : form?.params
      const excluded =
        input.excluded_description_asset_ids !== undefined
          ? excludedIds(input.excluded_description_asset_ids, index)
          : switches?.excludedDescriptionAssetIds
      const params: GenerationParams = {
        model,
        prompt: input.prompt,
        negativePrompt: input.negative_prompt,
        duration: form?.params.duration ?? '',
        referenceImages: paths,
        referenceAudios: audios.length ? audios : undefined,
        includeDescriptions: input.include_descriptions ?? switches?.includeDescriptions,
        ...(excluded?.length ? { excludedDescriptionAssetIds: excluded } : {}),
        // Who wears what goes with the form's references too; other references get Studio's default.
        ...(switches?.outfitWearers ? { outfitWearers: switches.outfitWearers } : {})
      }
      const issues = promptIssues(params)
      const mentioned = new Set(findImageTokens(input.prompt).map((t) => t.index))
      const mentionedAudio = new Set(findAudioTokens(input.prompt).map((t) => t.index))
      const kind = kindOfModelId(model)
      const normalized = canonicalizeTokens(input.prompt)
      const errors = issues.filter((i) => i.severity === 'error').length
      const reference = kind === 'reference-to-video'
      return {
        data: {
          ok: !hasBlockingIssues(issues),
          mode: kind,
          model,
          issues: issueList(issues),
          references: reference ? tokenMap(paths, index).map((t, i) => ({ ...t, mentioned: mentioned.has(i + 1) })) : [],
          ...(reference && audios.length
            ? { audio_references: audioTokenMap(audios, index).map((t, i) => ({ ...t, mentioned: mentionedAudio.has(i + 1) })) }
            : {}),
          ...(normalized !== input.prompt ? { normalized_prompt: normalized } : {}),
          ...descriptionInfo({ ...params, prompt: normalized }, index),
          ...(notes.length ? { notes } : {})
        },
        summary: errors ? `kontrollerade en prompt – ${errors} fel` : 'kontrollerade en prompt – inga fel'
      }
    }
  )

  defineTool(
    server,
    ctx,
    'reorder_references',
    {
      title: 'Reorder references',
      description:
        "Changes the order of the reference images and/or reference audio of the Generate form (target \"form\", the default) or of a sequence clip (target {segment_id}) – like dragging a thumbnail in Studio – and renumbers every @ImageN / @AudioN token in the prompt and the negative prompt so each keeps pointing at the same picture or clip. Example: references [A, B, C] and the prompt \"@Image1 hugs @Image3\"; images [\"@Image3\"] gives [C, A, B] and \"@Image2 hugs @Image1\". Name references by their token in the current numbering (\"@Image3\", \"@Audio2\"), by image_id / audio_id, or by asset_id (all of that asset's photos or clips, in their current order). The ones you name come first, in the order you name them; the others follow in their current order – so naming one moves it to the front, and naming all of them gives the full order. Nothing is added or removed. With a model that takes fewer images than the list has, only the first max_reference_images are sent: moving a picture to the front makes it sent (not_sent lists the ones left over). The descriptions appended to the prompt (composed_prompt, description_entries) follow the new order. Use this instead of set_references when only the order should change: set_references with mode \"replace\" does not renumber tokens already in the prompt. Returns the new token maps, which tokens moved (moved), the new prompt and its issues. A clip that continues from the previous one with continue_mode \"references\" reorders its own references (the previous clip's last frame stays last, after them); not for a clip that has no references of its own, continues with continue_mode \"exact\", or has a start or end image (it sends no references).",
      input: {
        target: z
          .union([z.literal('form'), z.object({ segment_id: z.string() }).strict()])
          .default('form')
          .describe('"form" (the Generate form, default) or {segment_id} for a sequence clip.'),
        images: z
          .array(z.string())
          .optional()
          .describe('Reference images in their new order: tokens ("@Image3"), image_ids or asset_ids. The rest follow in their current order.'),
        audios: z
          .array(z.string())
          .optional()
          .describe('Reference audio clips in their new order: tokens ("@Audio2"), audio_ids or asset_ids. The rest follow in their current order.')
      },
      annotations: { ...WRITE, idempotentHint: false },
      summary: ({ target }) =>
        target === 'form' ? 'ändrade ordningen på referenserna' : 'ändrade ordningen på ett klipps referenser'
    },
    async ({ target, images, audios }) => {
      if (!images?.length && !audios?.length) {
        throw new Error('Ange images och/eller audios: referenserna i den ordning de ska ha.')
      }
      if (target !== 'form') return reorderClipReferences(target.segment_id, images, audios)
      const index = await AssetIndex.load()
      const before = await readForm(ctx)
      const params = before.params
      const kind = kindOfModelId(params.model)
      if (kind !== 'reference-to-video') {
        throw new Error(
          `Formuläret är i läget ${kind} och skickar inga referenser, så det finns inget att ordna om. Byt till reference-to-video med set_form först.`
        )
      }
      const paths = formImages(before)
      const clips = params.referenceAudios ?? []
      const imageOrder = images?.length ? newOrder('image', images, paths, index, 'formuläret') : undefined
      const audioOrder = audios?.length
        ? newOrder('audio', audios, clips.map((a) => a.path), index, 'formuläret')
        : undefined
      const imagesMove = !!imageOrder && !unchanged(imageOrder)
      const audiosMove = !!audioOrder && !unchanged(audioOrder)
      if (!imagesMove && !audiosMove) {
        return {
          data: {
            target: 'form',
            ...reorderAnswer({ ...params, referenceImages: paths }, index, { images: [], audios: [] }),
            notes: ['Referenserna låg redan i den ordningen, så inget ändrades.']
          },
          summary: 'tittade på ordningen på referenserna (oförändrad)'
        }
      }
      // The references the agent named, by path, so the window moves the very pictures and clips named even if the
      // user changes the form before the command arrives: one of them gone refuses it (all or nothing), and the
      // others keep the order the form has then. Tokens only when a path is in the list twice. The window renumbers
      // the prompt with the same shared helper Studio's own drag and drop uses, in one change of the form.
      const leading = (kind: ReferenceKind, wanted: readonly string[], list: readonly string[]): string[] => {
        const first = namedPositions(kind, wanted, list, index, 'formuläret')
        if (new Set(list).size === list.length) return inOrder(list, first)
        return first.map((i) => (kind === 'image' ? imageToken(i + 1) : audioToken(i + 1)))
      }
      const args: AgentReorderReferencesArgs = {
        ...(imagesMove ? { images: leading('image', images!, paths) } : {}),
        ...(audiosMove ? { audios: leading('audio', audios!, clips.map((a) => a.path)) } : {})
      }
      const byPath = [...(args.images ?? []), ...(args.audios ?? [])].filter((entry) => entry.startsWith('/'))
      const state = await ctx.bridge.send<AgentFormState>('reorder_references', args).catch((err: unknown) => {
        // A picture or clip named by path that the window no longer has: the user removed it meanwhile.
        if (byPath.some((path) => errorText(err).includes(path))) {
          throw new Error(
            'Inget ändrades: formuläret ändrades samtidigt, så en av referenserna du nämnde finns inte längre där. Läs formuläret igen med get_workspace.'
          )
        }
        throw err
      })
      const after = state.params
      const notes = [...(state.notes ?? [])]
      const wantedImages = imagesMove ? inOrder(paths, imageOrder) : paths
      const wantedAudios = audiosMove ? inOrder(clips, audioOrder).map((a) => a.path) : clips.map((a) => a.path)
      const gotImages = formImages(state)
      const gotAudios = (after.referenceAudios ?? []).map((a) => a.path)
      // The user may have changed the form at the same moment; the agent hears what it is now, not what it asked.
      if (!samePaths(gotImages, wantedImages) || !samePaths(gotAudios, wantedAudios)) {
        notes.push(
          'Referenserna i formuläret blev inte exakt i den ordning du bad om (formuläret ändrades kanske samtidigt) – se references i svaret.'
        )
      }
      const moved = {
        images: movedTokens('image', paths, gotImages, index),
        audios: movedTokens('audio', clips.map((a) => a.path), gotAudios, index)
      }
      return {
        data: {
          target: 'form',
          ...reorderAnswer({ ...after, referenceImages: gotImages }, index, moved),
          ...(notes.length ? { notes } : {})
        },
        summary: `ändrade ordningen på referenserna${movedSummary(moved)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'swap_reference',
    {
      title: 'Swap reference',
      description:
        "Swaps the picture in one place of the Generate form's (target \"form\", the default) or a sequence clip's (target {segment_id}) reference images for another – as the user does by clicking a reference thumbnail in Studio – without changing any number: every @ImageN / @AudioN token in the prompt and negative prompt keeps its number and now shows the new picture. image names the place: its token in the current numbering (\"@Image2\") or the image_id of the library photo there. with is the new picture: {asset_id, image_id?} (a library photo, the asset's cover unless image_id), {still_id} or {upload_id} (made a still in Referensbilder first). whole_asset: true swaps the whole asset instead – what clicking a library photo in Studio does: every place of the asset whose photo is in image is taken by the asset in with.asset_id (its photos in order, the first ones reused when it has fewer), and its voice or sound clips take the old asset's @Audio places (when it has none, the old clips stay and a note says so). One character for another also hands over the outfit the old one wore among the references: the new character's default outfit takes that outfit's places, or – when it has none – the old outfit stays and is worn by the new character (outfit_wearers follows either way); a note says which. The name written right before a group of tokens that all changed follows (\"Anna (@Image1, voice @Audio1)\" → \"Bo (@Image1, voice @Audio1)\"), and so do the description switches and who wears which outfit; a name before a group that still holds some of the old asset's pictures stays, so read the notes. Use this to change who or what a reference shows without touching the prompt's numbers; to change the order use reorder_references, to choose the list anew set_references. Returns the token maps, swapped (each token that shows another picture or clip now: was / now), the prompt, composed_prompt, issues and notes. A clip that continues in reference mode swaps its own references (the clips that carry them keep their tokens too); a clip that carries another clip's references is refused (swap them in that clip, which the answer names), and so is a clip that sends no references.",
      input: {
        target: z
          .union([z.literal('form'), z.object({ segment_id: z.string() }).strict()])
          .default('form')
          .describe('"form" (the Generate form, default) or {segment_id} for a sequence clip.'),
        image: z
          .string()
          .describe('The place to swap: its token in the current numbering ("@Image2") or the image_id of the library photo there.'),
        with: z
          .union([
            z.object({ asset_id: z.string(), image_id: z.string().optional() }).strict(),
            z.object({ still_id: z.string() }).strict(),
            uploadSource
          ])
          .describe(
            'The new picture: {asset_id, image_id?} (a library photo, the cover unless image_id), {still_id} or {upload_id}. With whole_asset: {asset_id} alone.'
          ),
        whole_asset: z
          .boolean()
          .default(false)
          .describe(
            "true: every place of the asset whose photo is in image (and its voice; for a character also its outfit) is taken by with.asset_id. Default false: only this place."
          )
      },
      annotations: { ...WRITE, idempotentHint: false },
      summary: ({ target, whole_asset }) =>
        `bytte ${whole_asset ? 'en tillgång bland referenserna' : 'en referensbild'}${target === 'form' ? '' : ' i ett klipp'}`
    },
    async ({ target, image, with: replacement, whole_asset }) => {
      const input: SwapInput = { image, with: replacement, whole_asset }
      if (target !== 'form') return swapClipReference(ctx, target.segment_id, input)
      const index = await AssetIndex.load()
      const before = await readForm(ctx)
      const params = before.params
      const kind = kindOfModelId(params.model)
      if (kind !== 'reference-to-video') {
        throw new Error(
          `Formuläret är i läget ${kind} och skickar inga referenser, så det finns inget att byta. Byt till reference-to-video med set_form först.`
        )
      }
      const paths = formImages(before)
      const clips = params.referenceAudios ?? []
      const all: GenerationParams = { ...params, referenceImages: paths }
      const asked = await planSwap(input, paths, index, 'formuläret')
      if (!('uploadId' in asked) && swapsNothing(asked, paths)) {
        return {
          data: {
            target: 'form',
            ...referencesAnswer(all, index, swappedInfo({ images: [], audios: [] })),
            notes: [unchangedNote(asked)]
          },
          summary: 'tittade på referenserna (oförändrade)'
        }
      }
      // Last: an upload becomes a still only once everything else is known to be right.
      const plan: ReadySwap =
        'uploadId' in asked
          ? { whole: false, place: asked.place, path: (await importAsStill(ctx, { upload_id: asked.uploadId })).path }
          : asked
      // What the swap should give, by the same shared rules the window applies to the form as it is when it arrives.
      const expected = applySwap(all, plan, index.assets).params
      const state = await ctx.bridge.send<AgentFormState>('swap_reference', swapArgs(plan, paths))
      const after = state.params
      const gotImages = formImages(state)
      const gotAudios = after.referenceAudios ?? []
      const notes = [...(state.notes ?? [])]
      // The user may have changed the form at the same moment; the agent hears what it is now, not what it asked.
      if (
        !samePaths(gotImages, expected.referenceImages ?? []) ||
        !samePaths(gotAudios.map((a) => a.path), (expected.referenceAudios ?? []).map((a) => a.path)) ||
        after.prompt !== expected.prompt
      ) {
        notes.push(
          'Referenserna i formuläret blev inte exakt som du bad om (formuläret ändrades kanske samtidigt) – se references och prompt i svaret.'
        )
      }
      const swapped = swappedTokens({ images: paths, audios: clips }, { images: gotImages, audios: gotAudios }, index)
      notes.push(...swapNotes(all, { ...after, referenceImages: gotImages }, plan, swapped, index))
      return {
        data: {
          target: 'form',
          ...referencesAnswer({ ...after, referenceImages: gotImages }, index, swappedInfo(swapped)),
          ...(notes.length ? { notes } : {})
        },
        summary: swapSummary(plan, swapped)
      }
    }
  )

  defineTool(
    server,
    ctx,
    'open_in_studio',
    {
      title: 'Open in Studio',
      description:
        "Brings a place in Studio to the front so the user sees it: the Generate view (with generation_id: that clip opened in its drawer – Generera's list only holds this session's clips, so an older one opens in the Mediabank instead and the answer says so), the Mediabank (view \"media\": everything made – tab \"videos\" with generation_id: that clip in its drawer, \"pictures\" with still_id: that picture, \"films\" with export_id: that exported film; an id picks its tab), a sequence (optionally with one clip selected), a storyboard (with transition_id: that transition opened in the transition editor), an edit in Redigera (view \"editor\" with edit_id; with version_id: that version in the player; without either the list of edits), an asset (view \"asset\" with asset_id: its library view – Karaktärer, Miljöer, Produkter, Kläder or Poser – with the asset open) or the prompt library (view \"prompts\"). Use it when you want the user to look at something you prepared. Opening something doesn't count as the user having seen it.",
      input: {
        view: z.enum(['generate', 'media', 'sequence', 'storyboard', 'editor', 'asset', 'prompts']),
        sequence_id: z.string().optional().describe('For view "sequence".'),
        segment_id: z.string().optional().describe('For view "sequence": the clip to select (its sequence is found automatically).'),
        storyboard_id: z.string().optional().describe('For view "storyboard": the storyboard to open.'),
        transition_id: z
          .string()
          .optional()
          .describe('For view "storyboard": the transition to open (its storyboard is found automatically).'),
        edit_id: z.string().optional().describe('For view "editor": the edit to open (list_edits).'),
        version_id: z
          .string()
          .optional()
          .describe('For view "editor": the version to show (get_edit; its edit is found automatically).'),
        generation_id: z
          .string()
          .optional()
          .describe('For view "generate" or "media": the clip to open in its drawer (in the Mediabank: its Videor tab).'),
        asset_id: z.string().optional().describe('For view "asset": the asset to open.'),
        tab: z
          .enum(['videos', 'pictures', 'films'] as const satisfies readonly MediaTab[])
          .optional()
          .describe('For view "media": the tab to show (default: the one an id belongs to, else the one last shown).'),
        still_id: z.string().optional().describe('For view "media": a picture to open in Bilder (list_stills).'),
        export_id: z.string().optional().describe('For view "media": an exported film to open in Filmer (list_exports).')
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: ({ view }) => OPENED[view]
    },
    async (input) => {
      const {
        view,
        sequence_id,
        segment_id,
        storyboard_id,
        transition_id,
        edit_id,
        version_id,
        generation_id,
        asset_id,
        tab,
        still_id,
        export_id
      } = input
      requireLibrary()
      const open = async (args: AgentOpenArgs): Promise<Partial<AgentOpenResult>> => {
        const shown = (await ctx.bridge.send<AgentOpenResult | undefined>('open', args)) ?? {}
        ctx.bridge.showWindow()
        return shown
      }
      /** The Mediabank on a tab, with a clip, picture or film open in it. */
      const openMedia = async (args: MediaOpenArgs, note?: string): Promise<ToolOutput> => {
        const shown: Partial<AgentOpenResult> = (await ctx.bridge.send<AgentOpenResult | undefined>('open', args)) ?? {}
        ctx.bridge.showWindow()
        const notes = [note, shown.note].filter(Boolean)
        return {
          data: {
            shown: 'media',
            tab: isMediaTab(shown.tab) ? shown.tab : args.tab,
            ...(args.generationId ? { generation_id: args.generationId } : {}),
            ...(args.stillId ? { still_id: args.stillId } : {}),
            ...(args.exportId ? { export_id: args.exportId } : {}),
            ...(notes.length ? { note: notes.join(' ') } : {})
          },
          summary: args.generationId
            ? 'visade ett klipp i Mediabanken'
            : args.stillId
              ? 'visade en bild i Mediabanken'
              : args.exportId
                ? 'visade en film i Mediabanken'
                : 'visade Mediabanken'
        }
      }
      if (view === 'media') {
        const named = (['generation_id', 'still_id', 'export_id'] as const).filter((key) => input[key])
        if (named.length > 1) throw new Error('Ange bara ett av generation_id, still_id och export_id.')
        const key = named[0]
        if (key && tab && tab !== MEDIA_TAB_OF[key]) {
          throw new Error(`${key} öppnas i fliken "${MEDIA_TAB_OF[key]}", inte "${tab}". Utelämna tab eller ändra den.`)
        }
        // Checked here first, as the neighbouring views do, so a wrong id gets a message that says where to look.
        if (generation_id && !db.getGeneration(generation_id)) {
          throw new Error(`Genereringen ${generation_id} finns inte (längre). list_generations visar vilka som finns.`)
        }
        if (still_id) (await StillIndex.load()).require(still_id)
        if (export_id && !(await callService<ExportSummary[]>('exports:list')).some((e) => e.id === export_id)) {
          throw new Error(`Det finns ingen exporterad film med id ${export_id}. Använd list_exports för att se vilka som finns.`)
        }
        return openMedia({
          view: 'media',
          // No id and no tab: the tab the window last showed.
          ...(key ? { tab: MEDIA_TAB_OF[key] } : tab ? { tab } : {}),
          ...(generation_id ? { generationId: generation_id } : {}),
          ...(still_id ? { stillId: still_id } : {}),
          ...(export_id ? { exportId: export_id } : {})
        })
      }
      if (view === 'asset') {
        if (!asset_id) throw new Error('Ange asset_id för att visa en tillgång.')
        const asset = (await AssetIndex.load()).require(asset_id)
        const shown = await open({ view: ASSET_VIEWS[asset.kind], assetId: asset.id })
        return {
          data: {
            shown: 'asset',
            asset_id: asset.id,
            asset_name: asset.name,
            kind: asset.kind,
            ...(shown.note ? { note: shown.note } : {})
          },
          summary: `visade ${q(asset.name)}`
        }
      }
      if (view === 'prompts') {
        await open({ view: 'prompts' })
        return { data: { shown: 'prompts' }, summary: 'visade promptbiblioteket' }
      }
      if (view === 'editor') {
        let editId = edit_id
        if (version_id) {
          const version = db.getGeneration(version_id)
          if (!version?.editId) {
            throw new Error('Det finns ingen version i Redigera med det id:t. get_edit visar en redigerings versioner.')
          }
          if (editId && editId !== version.editId) throw new Error('Versionen hör inte till den redigeringen.')
          editId = version.editId
        }
        // Checked here first, so a wrong id gets the service's own message rather than the window's.
        const edit = editId ? await callService<Edit>('edits:get', editId) : undefined
        const shown = await open({
          view: 'editor',
          ...(edit ? { editId: edit.id } : {}),
          ...(version_id ? { versionId: version_id } : {})
        })
        return {
          data: {
            shown: 'editor',
            ...(shown.editId ? { edit_id: shown.editId } : {}),
            ...(shown.versionId ? { version_id: shown.versionId } : {}),
            ...(shown.note ? { note: shown.note } : {})
          },
          summary: edit ? `visade redigeringen ${q(edit.name)}` : 'visade Redigera'
        }
      }
      if (view === 'generate') {
        const g = generation_id ? db.getGeneration(generation_id) : undefined
        if (generation_id && !g) {
          throw new Error(`Genereringen ${generation_id} finns inte (längre). list_generations visar vilka som finns.`)
        }
        // Generera's list holds only this session's clips (shared/session.ts): any other is in the Mediabank's Videor.
        if (g && !inGenerateSession(g, currentSession())) {
          return openMedia(
            { view: 'media', tab: 'videos', generationId: g.id },
            'Klippet finns inte i Genereras lista (den visar bara klipp från den här sessionen), så det öppnades i Mediabanken.'
          )
        }
        const shown = await open({ view: 'generate', ...(generation_id ? { generationId: generation_id } : {}) })
        return {
          data: {
            shown: 'generate',
            ...(shown.generationId ? { generation_id: shown.generationId } : {}),
            ...(shown.note ? { note: shown.note } : {})
          },
          summary: generation_id ? 'visade ett klipp i Generera' : 'visade Generera'
        }
      }
      let sequenceId = sequence_id
      let transitionId = transition_id
      if (transitionId) {
        const row = store.getSegmentRow(transitionId)
        if (!row || !isStoryboardId(row.sequence_id)) throw new Error('Det finns ingen övergång med det id:t (längre).')
        if (storyboard_id && storyboard_id !== row.sequence_id) {
          throw new Error('Övergången hör inte till den storyboarden.')
        }
        sequenceId = row.sequence_id
      }
      if (segment_id) {
        const row = store.getSegmentRow(segment_id)
        if (!row) throw new Error('Klippet finns inte längre.')
        if (sequenceId && sequenceId !== row.sequence_id) throw new Error('Klippet hör inte till den sekvensen.')
        sequenceId = row.sequence_id
        // A storyboard's transition given as a clip opens as the transition it is.
        if (isStoryboardId(row.sequence_id)) transitionId ??= segment_id
      }
      // A storyboard named as a sequence (or a transition as a clip) is opened where it lives: in Storyboards.
      const storyboardId = view === 'storyboard' ? (storyboard_id ?? sequenceId) : isStoryboardId(sequenceId) ? sequenceId : undefined
      if (view === 'storyboard' || storyboardId) {
        if (!storyboardId) throw new Error('Ange storyboard_id för att visa en storyboard.')
        if (!isStoryboardId(storyboardId)) {
          throw new Error(
            store.getSequenceRow(storyboardId)
              ? 'Det här är en sekvens, inte en storyboard. Visa den med view "sequence".'
              : 'Storyboarden finns inte längre.'
          )
        }
        const storyboard = await callService<Storyboard>('storyboards:get', storyboardId)
        const shown = await open({ view: 'storyboards', storyboardId, ...(transitionId ? { transitionId } : {}) })
        const number = transitionId ? storyboard.transitions.findIndex((t) => t.id === transitionId) + 1 : 0
        return {
          data: {
            shown: 'storyboard',
            storyboard_id: storyboardId,
            ...(shown.transitionId ? { transition_id: shown.transitionId } : {}),
            ...(shown.note ? { note: shown.note } : {})
          },
          summary: number
            ? `visade övergång ${number} i storyboarden ${q(storyboard.name)}`
            : `visade storyboarden ${q(storyboard.name)}`
        }
      }
      if (!sequenceId) throw new Error('Ange sequence_id eller segment_id för att visa en sekvens.')
      const sequence = await callService<Sequence>('sequences:get', sequenceId)
      const clip = segment_id ? sequence.segments.findIndex((s) => s.id === segment_id) + 1 : 0
      // The window answers with the clip it actually shows (and a note when that isn't the one asked for).
      const shown = await open({ view: 'sequences', sequenceId, segmentId: segment_id })
      const shownId = shown.segmentId ?? segment_id
      const shownClip = shownId ? sequence.segments.findIndex((s) => s.id === shownId) + 1 : clip
      return {
        data: {
          shown: 'sequence',
          sequence_id: sequenceId,
          segment_id: shownId,
          clip_number: shownClip || undefined,
          ...(shown.note ? { note: shown.note } : {})
        },
        summary: shownClip ? `visade klipp ${shownClip} i ${q(sequence.name)}` : `visade sekvensen ${q(sequence.name)}`
      }
    }
  )
}
