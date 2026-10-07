import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { kindOfModelId } from '@shared/models'
import type { GenerationParams, Learning } from '@shared/types'
import { isLibraryReady } from '../../paths'
import { promptWritingGuide, studioGuide } from '../guide'
import { AssetIndex, asGenerated, audioTokenMap, takesAudio, tokenMap, type AudioTokenEntry, type TokenEntry } from '../studio'
import { registerFormTools } from './form'
import { readForm, type ToolContext } from './kit'
import { learningsForGuide, registerLibraryTools } from './library'
import { registerPaidTools } from './paid'
import { registerReviewTools } from './review'
import { continues, loadClip, registerSequenceTools } from './sequences'

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

/** The references of reference-mode params, for the write_video_prompt context. */
function referenceContext(params: GenerationParams, assets: AssetIndex, empty: string): string {
  const images = tokenMap(params.referenceImages, assets)
  const audios = audioTokenMap(params.referenceAudios, assets)
  const voices = takesAudio(params.model)
    ? audios.length
      ? ''
      : '\nThe model takes reference audio, but none is chosen (characters with a voice clip get it with set_references).'
    : '\nThe model takes no reference audio: write no @Audio tokens.'
  return `Its references:\n${images.length || audios.length ? tokenLines(images, audios) : empty}${voices}`
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

/** What write_video_prompt tells the agent about the references it writes for. */
async function promptContext(ctx: ToolContext, segmentId: string | undefined): Promise<string> {
  if (!isLibraryReady()) return 'Studio has no library open yet, so there are no references to describe.'
  try {
    const assets = await AssetIndex.load()
    if (segmentId) {
      const { sequence, index, segment } = await loadClip(segmentId)
      const continuing = continues(sequence, index)
      const generated = asGenerated(segment.params, continuing)
      const head = `You are writing the prompt for clip ${index + 1} of the sequence "${sequence.name}" (segment_id ${segment.id}), ${generated.duration}, model ${generated.model}.`
      if (continuing) {
        const previous = sequence.segments[index - 1].params.prompt
        return `${head}\nIt continues from the last frame of clip ${index}, so it is image-to-video: no references and no @ tokens. Clip ${index}'s prompt was:\n"""${previous}"""${await learningLines(generated.model)}`
      }
      return `${head}\n${referenceContext(generated, assets, '- none yet (add them with update_segment)')}${await learningLines(generated.model)}`
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

/** Everything a session offers: the tools, the write_video_prompt prompt and the studio://guide resource. */
export function registerAgentTools(server: McpServer, ctx: ToolContext): void {
  registerLibraryTools(server, ctx)
  registerFormTools(server, ctx)
  registerSequenceTools(server, ctx)
  registerPaidTools(server, ctx)
  registerReviewTools(server, ctx)

  server.registerPrompt(
    'write_video_prompt',
    {
      title: 'Write a video prompt',
      description:
        "Write a video prompt for Studio – for the Generate form, or for one sequence clip – from an idea, using the clip's actual references (photos and voices), the learnings recorded so far and Studio's prompt-writing guide.",
      argsSchema: {
        idea: z.string().optional().describe('What should happen in the clip, in any language.'),
        segment_id: z.string().optional().describe('Write for this sequence clip instead of the Generate form.')
      }
    },
    async ({ idea, segment_id }) => {
      const context = await promptContext(ctx, segment_id)
      const task = idea?.trim()
        ? `Write the video prompt for this idea: ${idea.trim()}`
        : 'Ask the user (in Swedish) what should happen in the clip, then write the video prompt.'
      const text = [
        promptWritingGuide(ctx.promptLanguage()),
        '## Context',
        context,
        '## Task',
        task,
        segment_id
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
