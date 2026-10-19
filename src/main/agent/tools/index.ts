import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { kindOfModelId, referenceVideosOf, supportsReferenceVideos } from '@shared/models'
import { composePrompt, describedAssets, includesDescriptions } from '@shared/prompt-compose'
import type { GenerationParams, Learning } from '@shared/types'
import { isLibraryReady } from '../../paths'
import { promptWritingGuide, studioGuide } from '../guide'
import {
  AssetIndex,
  asGenerated,
  audioTokenMap,
  seconds,
  takesAudio,
  tokenMap,
  videoTokenMap,
  type AudioTokenEntry,
  type TokenEntry
} from '../studio'
import { registerDeleteTools } from './delete'
import { registerEditorTools } from './editor'
import { registerEditorPaidTools } from './editor-paid'
import { registerFormTools } from './form'
import { registerImportTools } from './imports'
import { readForm, type ToolContext } from './kit'
import { learningsForGuide, registerLibraryTools } from './library'
import { registerPaidTools } from './paid'
import { registerReviewTools } from './review'
import { asSent, continuationOf, continues, endsOnNext, loadClip, registerSequenceTools } from './sequences'
import { registerSongTools } from './song'
import { registerStillTools } from './stills'
import { registerSpendingTools } from './spending'
import { boardNumbers, loadTransition, registerStoryboardTools } from './storyboards'
import { registerUploadTools } from './uploads'
import { registerWorkTools } from './work'

export type { ToolContext } from './kit'

/** "@Image1 = Anna (character), photo 1" / "@Audio1 = Anna's voice, 0–8 s" lines for the write_video_prompt context. */
function tokenLines(images: TokenEntry[], audios: AudioTokenEntry[]): string {
  const lines = images.map((e) =>
    e.asset_name
      ? `- ${e.token} = ${e.asset_name} (${e.kind}), photo ${e.photo_number}`
      : `- ${e.token} = a picture (${e.file ?? 'unknown file'})`
  )
  for (const a of audios) {
    lines.push(
      a.asset_name
        ? `- ${a.token} = ${a.asset_name}'s ${a.role} (${a.length} s)`
        : `- ${a.token} = a sound (${a.file ?? 'unknown file'}, ${a.length} s)`
    )
  }
  return lines.join('\n')
}

/**
 * What Studio appends to the prompt from the referenced assets' descriptions (the References legend), for the
 * write_video_prompt context: so the agent writes the action, camera and mood instead of repeating them.
 */
function descriptionContext(params: GenerationParams, assets: AssetIndex): string {
  const all = composePrompt(params, describedAssets(assets.assets), { language: 'en', include: true }).entries
  if (!all.length) {
    return params.referenceImages?.length
      ? "\nNone of these assets has a description, so nothing is appended to the prompt: say in words what matters about their looks that the photos don't show (or improve the descriptions with update_asset)."
      : ''
  }
  if (!includesDescriptions(params)) {
    return '\nThe descriptions of the references are switched off here ("Include descriptions" is off), so nothing is appended: say in the prompt what matters about their looks.'
  }
  const off = new Set(params.excludedDescriptionAssetIds ?? [])
  const lines = all.map((e) => {
    // An outfit's line says who wears it, so the prompt needn't.
    const worn = e.wornBy ? `, worn by ${e.wornBy.name} (${e.wornBy.tokens.join(', ')})` : ''
    const text = off.has(e.assetId) ? '(switched off – not appended)' : e.description || '(no description)'
    return `- ${e.name} (${e.tokens.join(', ')})${worn}: ${text}`
  })
  return `\nStudio appends these descriptions after your prompt as a References legend (with who wears each outfit) – don't repeat them; write the action, camera and mood:\n${lines.join('\n')}`
}

/** The references of reference-mode params, for the write_video_prompt context. */
function referenceContext(params: GenerationParams, assets: AssetIndex, empty: string): string {
  const images = tokenMap(params.referenceImages, assets)
  const audios = audioTokenMap(params.referenceAudios, assets)
  const voices = takesAudio(params.model)
    ? audios.length
      ? ''
      : '\nThe model takes reference audio, but none is chosen (characters with a voice clip get it with set_references).'
    : '\nThe model takes no reference audio: write no @Audio tokens.'
  const videos = supportsReferenceVideos(params.model) ? videoTokenMap(referenceVideosOf(params)) : []
  const videoLines = videos.map(
    (v) =>
      `- ${v.token} = a reference video (${v.title ?? v.file}, ${v.start}–${seconds(v.start + v.length)} s): take its action, camera movement or style – say which, e.g. "the camera moves as in ${v.token}"`
  )
  const listed = images.length || audios.length ? tokenLines(images, audios) : videoLines.length ? '' : empty
  const references = [listed, ...videoLines].filter(Boolean).join('\n')
  return `Its references:\n${references}${voices}${descriptionContext(params, assets)}`
}

/**
 * The learnings that apply to a model, for the write_video_prompt context: its own and the general ones, pinned
 * first, then the most recent of those (chosen after filtering, so learnings about other models don't crowd
 * them out).
 */
async function learningLines(model: string): Promise<string> {
  const relevant: Learning[] = await learningsForGuide(model)
  if (!relevant.length) return ''
  return `\nLearnings to apply (list_learnings has them all):\n${relevant.map((l) => `- ${l.title}: ${l.insight.replace(/\s*\n\s*/g, ' ')}`).join('\n')}`
}

/** What write_video_prompt tells the agent about a storyboard transition: the two boards it goes between. */
async function transitionContext(transitionId: string): Promise<string> {
  const { storyboard, index, transition } = await loadTransition(transitionId)
  const { from, to } = boardNumbers(storyboard, transition)
  const p = transition.params
  const board = (number: number, role: string): string => {
    const b = storyboard.boards[number - 1]
    if (!b) return `${role}: a board that can't be found.`
    const note = b.note.trim() ? `, whose note ("What does the image show?") says:\n"""${b.note.trim()}"""` : ' (no note).'
    const picture = b.imagePath ? '' : '\nIt has no picture yet: it needs one before the transition can be generated.'
    return `${role}: board ${number}${note}${picture}`
  }
  return [
    `You are writing the prompt for transition ${index + 1} of the storyboard "${storyboard.name}" (transition_id ${transition.id}), ${p.duration}, model ${p.model}.`,
    `It is image-to-video from two pictures: it starts on board ${from}'s picture and must end exactly on board ${to}'s picture – look at both with preview_transition first. No references and no @ tokens: describe how the first picture becomes the second, as one continuous shot.`,
    board(from, 'Start'),
    board(to, 'End'),
    p.prompt.trim() ? `Its prompt so far:\n"""${p.prompt.trim()}"""` : 'It has no prompt yet.'
  ].join('\n') + (await learningLines(p.model))
}

/** What write_video_prompt tells the agent about the references (or pictures) it writes for. */
async function promptContext(ctx: ToolContext, segmentId: string | undefined, transitionId?: string): Promise<string> {
  if (!isLibraryReady()) return 'Studio has no library open yet, so there are no references to describe.'
  try {
    if (transitionId) return await transitionContext(transitionId)
    const assets = await AssetIndex.load()
    if (segmentId) {
      const { sequence, index, segment } = await loadClip(segmentId)
      const continuing = continues(sequence, index)
      const ending = endsOnNext(sequence, index)
      const generated = asGenerated(segment.params, continuing, ending)
      const head = `You are writing the prompt for clip ${index + 1} of the sequence "${sequence.name}" (segment_id ${segment.id}), ${generated.duration}, model ${generated.model}.`
      const notes = segment.notes?.trim()
        ? `\nThe clip's notes ("What happens"):\n"""${segment.notes.trim()}"""`
        : ''
      // A continuation in reference mode is written with the references it carries; the frame goes after them.
      const plan = continuing ? continuationOf(sequence, index) : undefined
      if (plan?.mode === 'references') {
        const sent = asSent(sequence, index)
        const from = plan.carried?.inherited ? `carried from clip ${plan.carried.fromClip}` : 'its own'
        const previous = sequence.segments[index - 1].params.prompt
        const frame =
          `It continues from clip ${index} in reference mode: the references below are ${from}, and clip ${index}'s ` +
          `last frame is sent after them as @Image${plan.frameToken}. Studio puts "Start exactly on @Image${plan.frameToken} …" ` +
          `in front of the prompt itself – don't write it. Use the tokens for the people and their voices and write only ` +
          `what happens next. Clip ${index}'s prompt was:\n"""${previous}"""`
        return `${head}\n${frame}\n${referenceContext(sent, assets, '- none')}${notes}${await learningLines(sent.model)}`
      }
      if (continuing || ending || kindOfModelId(generated.model) === 'image-to-video') {
        const start = continuing
          ? `It starts on the last frame of clip ${index}, whose prompt was:\n"""${sequence.segments[index - 1].params.prompt}"""`
          : generated.startImage
            ? 'It starts on its own start image (preview_segment_frames shows it).'
            : 'It has no start image yet.'
        const end = ending
          ? `\nIt must end on the first frame of clip ${index + 2}, whose prompt is:\n"""${sequence.segments[index + 1].params.prompt}"""`
          : generated.endImage
            ? '\nIt must end on its own end image (preview_segment_frames shows it).'
            : ''
        return `${head}\nIt is image-to-video: no references and no @ tokens – the look comes from its start and end pictures; describe the motion and the camera between them. ${start}${end}${notes}${await learningLines(generated.model)}`
      }
      return `${head}\n${referenceContext(generated, assets, '- none yet (add them with update_segment)')}${notes}${await learningLines(generated.model)}`
    }
    const state = await readForm(ctx)
    const mode = kindOfModelId(state.params.model)
    const head = `You are writing the prompt for Studio's Generate form: ${mode}, model ${state.params.model}, ${state.params.duration}.`
    if (mode !== 'reference-to-video') {
      return `${head}\nThis mode has no references: write no @ tokens.${await learningLines(state.params.model)}`
    }
    return `${head}\n${referenceContext(state.params, assets, '- none yet (choose them with set_references first)')}${await learningLines(state.params.model)}`
  } catch (err) {
    return `(Could not read the references: ${err instanceof Error ? err.message : String(err)}. Use get_workspace or get_sequence.)`
  }
}

/**
 * Everything a session offers: the tools, the write_video_prompt prompt and the studio://guide resource. 96 tools:
 * 37 that only read, 49 that change the library or the form (free), and 10 that only ask the user – the 9 paid
 * requests and request_delete. No tool removes anything or spends money on its own.
 */
export function registerAgentTools(server: McpServer, ctx: ToolContext): void {
  registerLibraryTools(server, ctx)
  registerUploadTools(server, ctx)
  registerFormTools(server, ctx)
  registerSequenceTools(server, ctx)
  registerSongTools(server, ctx)
  registerImportTools(server, ctx)
  registerStillTools(server, ctx)
  registerStoryboardTools(server, ctx)
  registerPaidTools(server, ctx)
  registerEditorTools(server, ctx)
  registerEditorPaidTools(server, ctx)
  registerReviewTools(server, ctx)
  registerDeleteTools(server, ctx)
  registerWorkTools(server, ctx)
  registerSpendingTools(server, ctx)

  server.registerPrompt(
    'write_video_prompt',
    {
      title: 'Write a video prompt',
      description:
        "Write a video prompt for Studio – for the Generate form, one sequence clip or one storyboard transition – from an idea, using the clip's actual references (photos and voices) or the transition's two board pictures, the learnings recorded so far and Studio's prompt-writing guide.",
      argsSchema: {
        idea: z.string().optional().describe('What should happen in the clip, in any language.'),
        segment_id: z.string().optional().describe('Write for this sequence clip instead of the Generate form.'),
        transition_id: z.string().optional().describe('Write for this storyboard transition instead.')
      }
    },
    async ({ idea, segment_id, transition_id }) => {
      const context = await promptContext(ctx, segment_id, transition_id)
      const task = idea?.trim()
        ? `Write the video prompt for this idea: ${idea.trim()}`
        : 'Ask the user what should happen in the clip, then write the video prompt.'
      const text = [
        promptWritingGuide(ctx.promptLanguage()),
        '## Context',
        context,
        '## Task',
        task,
        transition_id
          ? 'Then save it with update_transition and check that the transition is ready (get_storyboard).'
          : segment_id
            ? 'Then save it with update_segment and check that the clip is ready (get_sequence).'
            : 'Then put it into the form with set_form({prompt, negative_prompt}) and check it with validate_prompt({use_form: true}).'
      ].join('\n\n')
      return { messages: [{ role: 'user', content: { type: 'text', text } }] }
    }
  )

  server.registerResource(
    'studio-guide',
    'studio://guide',
    {
      title: 'Studio guide',
      description: 'How Studio works and how to write video prompts for it, with the learnings so far (the same text as get_studio_guide).',
      mimeType: 'text/markdown'
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'text/markdown', text: studioGuide(ctx.promptLanguage(), await learningsForGuide()) }
      ]
    })
  )
}
