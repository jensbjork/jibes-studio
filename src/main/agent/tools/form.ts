import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DEFAULT_MODEL, kindOfModelId, maxReferenceImages, type Kind } from '@shared/models'
import { canonicalizeTokens, findImageTokens, hasBlockingIssues } from '@shared/prompt-refs'
import type {
  AgentFormState,
  AgentOpenArgs,
  AgentOpenResult,
  AgentSetFormArgs,
  AgentSetReferencesArgs,
  Sequence
} from '@shared/types'
import * as store from '../../sequence-store'
import { callService } from '../local-ipc'
import {
  AssetIndex,
  MODES,
  assetPhotoPath,
  blockingProblem,
  canonical,
  checkOutputOptions,
  checkPromptLength,
  issueList,
  loadModels,
  modelForMode,
  normalizeAspectRatio,
  normalizeDuration,
  normalizeResolution,
  paramsInfo,
  promptIssues,
  q,
  referencePaths,
  requireLibrary,
  requireModel,
  tokenMap,
  usableModels
} from '../studio'
import { READ_ONLY, WRITE, defineTool, priceValue, quote, readForm, type ToolContext } from './kit'

// The Generate form in Studio's window and what the user is looking at. These tools go through the window (the
// form is its state), so the user sees every change as it happens.

/** The form as the tools report it: settings, the token map, problems and (optionally) the price. */
async function formInfo(state: AgentFormState, index: AssetIndex, withPrice: boolean): Promise<Record<string, unknown>> {
  const params = state.params
  const problem = blockingProblem(params)
  return {
    ...paramsInfo(params, index),
    issues: issueList(promptIssues(params)),
    ready: !problem,
    ...(problem ? { blocking_problem: problem } : {}),
    ...(kindOfModelId(params.model) === 'reference-to-video'
      ? { max_reference_images: maxReferenceImages(params.model) }
      : {}),
    ...(withPrice ? { price_usd: priceValue(await quote(params)) } : {})
  }
}

const referenceItem = z.object({
  asset_id: z.string().describe('An asset id from list_assets.'),
  image_ids: z
    .array(z.string())
    .optional()
    .describe("Only these photos, in this order (image_ids from list_assets/get_asset). All the asset's photos when left out.")
})

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
    ['start_image', 'startbild']
  ]
  const others = labels.filter(([key]) => args[key] !== undefined).map(([, label]) => label)
  const prompt = args.prompt !== undefined
  if (prompt && others.length) return `satte prompten och ändrade ${others.join(', ')}`
  if (prompt) return 'satte prompten'
  if (others.length) return `ändrade ${others.join(', ')} i formuläret`
  return 'tittade på formuläret'
}

export function registerFormTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'get_workspace',
    {
      title: 'Get workspace',
      description:
        "What the user is looking at in Studio right now (the view, and the sequence and clip open in the sequence editor) and the Generate form: mode, model, duration, resolution, aspect ratio, audio, prompt, negative prompt, the reference images as a token map ({token: \"@Image1\", asset_name, kind, photo_number}), the start image, validation issues for the @ImageN tokens, whether it is ready to generate, and Venice's price. Start here to see what the user is working on.",
      input: {},
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'tittade på arbetsytan'
    },
    async () => {
      requireLibrary()
      const state = await readForm(ctx)
      const index = await AssetIndex.load()
      return {
        data: {
          view: state.view,
          sequence_id: state.sequenceId,
          segment_id: state.segmentId,
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
      title: 'Set reference images',
      description:
        "Sets the Generate form's reference images (reference-to-video mode) from assets: each item adds all photos of an asset, or just the image_ids you list, in order. mode \"replace\" (default) makes these the references; \"append\" adds them after the current ones (duplicates skipped). The model's limit applies (9 for Seedance); photos that don't fit are reported in not_added. A character's default outfit is NOT added automatically – add it (or another outfit) yourself. Returns the resulting token map – write the prompt with exactly these tokens. Choose the references first and write the prompt afterwards: changing the references does not renumber @ImageN tokens already in the prompt (check the returned issues and notes). If the form is not in reference-to-video mode, Studio switches it (see notes). An empty items list with mode \"replace\" removes all references.",
      input: {
        items: z.array(referenceItem).describe('Assets in the order their photos should get @Image numbers.'),
        mode: z.enum(['replace', 'append']).default('replace')
      },
      annotations: WRITE,
      summary: ({ items, mode }) =>
        !items.length && mode === 'replace' ? 'tömde referensbilderna' : `${mode === 'append' ? 'lade till' : 'satte'} referensbilderna`
    },
    async ({ items, mode }) => {
      const index = await AssetIndex.load()
      const paths = referencePaths(items, index)
      const args: AgentSetReferencesArgs = { paths, mode }
      const state = await ctx.bridge.send<AgentFormState>('set_references', args)
      const result = new Set(state.params.referenceImages ?? [])
      const notAdded = paths.filter((p) => !result.has(p))
      const names = [...new Set(items.map((i) => index.get(i.asset_id)?.name).filter(Boolean))] as string[]
      const kind = kindOfModelId(state.params.model)
      return {
        data: {
          references: tokenMap(state.params.referenceImages, index),
          max_reference_images: maxReferenceImages(state.params.model),
          ...(notAdded.length ? { not_added: tokenMap(notAdded, index).map(({ token: _, ...rest }) => rest) } : {}),
          mode: kind,
          ...(kind !== 'reference-to-video'
            ? { note: 'The form is not in reference-to-video mode, so these images are not sent. Call set_form({mode: "reference-to-video"}).' }
            : {}),
          issues: issueList(promptIssues(state.params)),
          ...(state.notes?.length ? { notes: state.notes } : {})
        },
        summary: names.length
          ? `${mode === 'append' ? 'lade till' : 'satte'} referensbilderna (${names.join(', ')})`
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
        "Fills in Studio's Generate form and shows the Generate view. Only the fields you pass change. Values are checked against the model (see list_models): duration like \"8s\", resolution like \"480p\", aspect_ratio like \"16:9\". Passing mode alone switches to that mode's model in the same family (as Studio's mode switch does). start_image is one photo of an asset (its cover unless you give image_id) that becomes the first frame; it switches the form to image-to-video. @ImageN tokens are normalised (\"@image3\" → \"@Image3\"). All or nothing: if any value is invalid, nothing changes and the error lists every problem. Returns the form with the token map, validation issues, the price and notes about anything Studio adjusted on its own (e.g. a duration the new model doesn't offer). To use reference images, call set_references.",
      input: {
        mode: z.enum(MODES).optional().describe('"reference-to-video" (default mode), "image-to-video" or "text-to-video".'),
        model: z.string().optional().describe('A model id from list_models.'),
        duration: z.string().optional().describe('e.g. "8s".'),
        resolution: z.string().optional().describe('e.g. "480p" or "720p".'),
        aspect_ratio: z.string().optional().describe('e.g. "16:9", "9:16", "1:1".'),
        audio: z.boolean().optional(),
        prompt: z.string().optional(),
        negative_prompt: z.string().optional().describe('Empty string clears it.'),
        start_image: z
          .object({ asset_id: z.string(), image_id: z.string().optional() })
          .optional()
          .describe('The photo that becomes the first frame (image-to-video).')
      },
      annotations: WRITE,
      summary: (args) => formChanges(args)
    },
    async (input) => {
      const index = await AssetIndex.load()
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
        input.start_image !== undefined

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
          // A start image alone means image-to-video, as choosing one in the form does.
          const wanted = input.mode ?? (input.start_image ? 'image-to-video' : undefined)
          if (wanted && wanted !== kindOfModelId(modelId)) modelId = modelForMode(models, modelId, wanted)
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
      if (input.start_image) args.start_image = assetPhotoPath(input.start_image.asset_id, input.start_image.image_id, index)

      const state = await ctx.bridge.send<AgentFormState>('set_form', args)
      return {
        data: {
          view: state.view,
          form: await formInfo(state, index, true),
          ...(state.notes?.length ? { notes: state.notes } : {})
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
        "Checks a prompt's @ImageN tokens against a set of reference images without changing anything – the same check Studio applies before every paid generation. By default (use_form: true) it uses the Generate form's references and model; pass reference_asset_ids (all photos of each asset, in order) or references (with image_ids) to check against another set, e.g. a planned sequence clip, and model or mode to check for another mode. Returns ok (no errors), the issues (Swedish messages, errors block generation, warnings are advice), the token map with which references the prompt mentions, and the prompt with tokens normalised.",
      input: {
        prompt: z.string(),
        negative_prompt: z.string().optional(),
        reference_asset_ids: z.array(z.string()).optional().describe('Assets whose photos (all of them, in order) are the references.'),
        references: z.array(referenceItem).optional().describe('Like set_references items; overrides reference_asset_ids.'),
        model: z.string().optional().describe('Check for this model (its mode and image limit).'),
        mode: z.enum(MODES).optional().describe("Check for this mode (with the mode's default model) when no model is given."),
        use_form: z
          .boolean()
          .default(true)
          .describe("Use the Generate form's references and model for whatever you don't pass. Default true.")
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'kontrollerade en prompt'
    },
    async (input) => {
      const index = await AssetIndex.load()
      const explicitRefs = input.references ?? input.reference_asset_ids?.map((asset_id) => ({ asset_id }))
      const needsForm = input.use_form && (!explicitRefs || (!input.model && !input.mode))
      const form = needsForm ? await readForm(ctx) : undefined
      const model =
        input.model ?? (input.mode ? DEFAULT_MODEL[input.mode] : (form?.params.model ?? DEFAULT_MODEL['reference-to-video']))
      const paths = explicitRefs ? referencePaths(explicitRefs, index) : (form?.params.referenceImages ?? [])
      const params = { model, prompt: input.prompt, negativePrompt: input.negative_prompt, referenceImages: paths }
      const issues = promptIssues(params)
      const mentioned = new Set(findImageTokens(input.prompt).map((t) => t.index))
      const kind = kindOfModelId(model)
      const normalized = canonicalizeTokens(input.prompt)
      const errors = issues.filter((i) => i.severity === 'error').length
      return {
        data: {
          ok: !hasBlockingIssues(issues),
          mode: kind,
          model,
          issues: issueList(issues),
          references:
            kind === 'reference-to-video'
              ? tokenMap(paths, index).map((t, i) => ({ ...t, mentioned: mentioned.has(i + 1) }))
              : [],
          ...(normalized !== input.prompt ? { normalized_prompt: normalized } : {})
        },
        summary: errors ? `kontrollerade en prompt – ${errors} fel` : 'kontrollerade en prompt – inga fel'
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
        "Brings a place in Studio to the front so the user sees it: the Generate view, or a sequence (optionally with one clip selected). Use it when you want the user to look at something you prepared.",
      input: {
        view: z.enum(['generate', 'sequence']),
        sequence_id: z.string().optional().describe('For view "sequence".'),
        segment_id: z.string().optional().describe('For view "sequence": the clip to select (its sequence is found automatically).')
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: ({ view }) => (view === 'generate' ? 'visade Generera' : 'visade en sekvens')
    },
    async ({ view, sequence_id, segment_id }) => {
      requireLibrary()
      if (view === 'generate') {
        const args: AgentOpenArgs = { view: 'generate' }
        await ctx.bridge.send('open', args)
        ctx.bridge.showWindow()
        return { data: { shown: 'generate' }, summary: 'visade Generera' }
      }
      let sequenceId = sequence_id
      if (segment_id) {
        const row = store.getSegmentRow(segment_id)
        if (!row) throw new Error('Klippet finns inte längre.')
        if (sequenceId && sequenceId !== row.sequence_id) throw new Error('Klippet hör inte till den sekvensen.')
        sequenceId = row.sequence_id
      }
      if (!sequenceId) throw new Error('Ange sequence_id eller segment_id för att visa en sekvens.')
      const sequence = await callService<Sequence>('sequences:get', sequenceId)
      const clip = segment_id ? sequence.segments.findIndex((s) => s.id === segment_id) + 1 : 0
      const args: AgentOpenArgs = { view: 'sequences', sequenceId, segmentId: segment_id }
      // The window answers with the clip it actually shows (and a note when that isn't the one asked for).
      const shown: Partial<AgentOpenResult> = (await ctx.bridge.send<AgentOpenResult | undefined>('open', args)) ?? {}
      ctx.bridge.showWindow()
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
