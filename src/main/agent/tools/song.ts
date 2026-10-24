import { basename } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { longPlaceNote, placesOf } from '@shared/song'
import { lyricsInWindow, MAX_SONG_WINDOW_SECONDS, MIN_SONG_WINDOW_SECONDS } from '@shared/song-window'
import type { ApprovalRequest, AudioCatalog, Sequence, SequenceSong, SongOverview } from '@shared/types'
import { lyricsModelOf } from '../../song'
import { THIS_COMPUTER } from '../../platform'
import type { ApprovalPlan } from '../approvals'
import { callService } from '../local-ipc'
import { localTime, q, requireLibrary } from '../studio'
import { READ_ONLY, WRITE, defineTool, priceValue, usd, type ToolContext } from './kit'
import { loadSequence } from './sequences'
import { stageFiles, uploadSource, urlSource } from './sources'
import { overBudgetAnswer } from './spending'

// A sequence cut to a song ("New sequence from a song…"), for agents: making one from an uploaded audio file, the cut
// points the song suggests and setting them (the clips' places in the song), correcting the lyrics, and asking the
// user to approve transcribing them (paid). get_sequence shows the song and each clip's place; update_segment changes
// what a clip hears and who sings; update_sequence({song: null}) takes the song off.

const round = (t: number, step = 1000): number => Math.round(t * step) / step

/** The song as the tools answer about it: its name, length, beat and vocals, and its lyric lines numbered from 1. */
function songInfo(song: SequenceSong, overview?: SongOverview): Record<string, unknown> {
  return {
    name: song.name,
    duration: round(song.duration, 100),
    ...(overview?.bpm ? { bpm: overview.bpm } : {}),
    ...(overview ? { beats_found: overview.beats.length > 0, bars_found: !!overview.bars?.length } : {}),
    has_vocals: !!song.vocalsPath,
    lyrics: song.lyrics
      ? {
          ...(song.lyrics.model ? { model: song.lyrics.model } : {}),
          ...(song.lyrics.language ? { language: song.lyrics.language } : {}),
          lines: song.lyrics.lines.map((l, i) => ({
            line: i + 1,
            start: round(l.start, 100),
            end: round(l.end, 100),
            text: l.text,
            ...(l.edited ? { edited: true } : {})
          }))
        }
      : null
  }
}

/** What runs for the song right now, and why its last step failed. */
function workInfo(sequence: Sequence): Record<string, unknown> {
  return {
    ...(sequence.songWork
      ? { working: { stage: sequence.songWork.stage, ...(sequence.songWork.fraction !== undefined ? { fraction: sequence.songWork.fraction } : {}) } }
      : {}),
    ...(sequence.songError ? { song_error: sequence.songError } : {})
  }
}

/** The clips' places in the song, in order: where each is, how long, what it hears and the words sung there. */
function placesInfo(sequence: Sequence): Record<string, unknown>[] {
  const lyrics = sequence.song?.lyrics
  return sequence.segments.map((s, i) => {
    const w = s.params.song
    if (!w) return { clip: i + 1, segment_id: s.id, place: null }
    const words = lyricsInWindow(lyrics, w.start, w.end)
    const note = longPlaceNote(w.start, w.end)
    return {
      clip: i + 1,
      segment_id: s.id,
      start: round(w.start),
      end: round(w.end),
      length: round(w.end - w.start, 100),
      part: w.part,
      ...(words ? { words } : {}),
      ...(note ? { note } : {})
    }
  })
}

/** The sequence, which must be cut to a song. */
async function songSequence(sequenceId: string): Promise<Sequence & { song: SequenceSong }> {
  const sequence = await loadSequence(sequenceId)
  if (!sequence.song) {
    throw new Error(`${q(sequence.name)} isn't cut to a song. Make a sequence from a song with create_sequence_from_song.`)
  }
  return sequence as Sequence & { song: SequenceSong }
}

const NEXT_LYRICS =
  'The lyrics give every clip the words sung in it (a singing clip mimes exactly those) and let the cut points fall between lines: ask for them with request_song_lyrics (paid, a few cents; the user approves).'

/** get_approval's fields for a 'song-lyrics' request: the song, and once approved how the transcription went. */
export async function songApprovalInfo(request: ApprovalRequest): Promise<Record<string, unknown>> {
  const s = request.song
  if (!s) return {}
  const data: Record<string, unknown> = {
    song_name: s.songName,
    duration: round(s.duration, 100),
    model: s.model,
    ...(s.language ? { language: s.language } : {}),
    from_vocals: s.fromVocals,
    replaces_lyrics: s.replaces
  }
  if (request.status !== 'approved' || !request.sequenceId) return data
  const sequence = await callService<Sequence>('sequences:get', request.sequenceId).catch(() => undefined)
  if (!sequence?.song) return { ...data, lyrics: 'The sequence or its song is gone.' }
  if (sequence.songWork?.stage === 'transcribing' || sequence.songWork?.stage === 'separating') {
    return { ...data, lyrics: 'being transcribed', next: 'Poll get_approval again in 10–20 seconds.' }
  }
  if (sequence.songError) return { ...data, lyrics: 'failed', error: sequence.songError }
  const lines = sequence.song.lyrics?.lines ?? []
  return {
    ...data,
    lyrics: { lines: lines.length },
    next: 'Read the lines with suggest_song_sections (song.lyrics), correct misheard words with edit_song_lyrics (free), and set cut points between the lines with set_song_sections.'
  }
}

export function registerSongTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'create_sequence_from_song',
    {
      title: 'New sequence from a song',
      description:
        `Makes a new sequence cut to a song (\"New sequence from a song…\"), for a music video: the audio file – {upload_id} (a ready audio upload, begin_upload) or {url} – is copied into the sequence's folder as its song. Then, in the background (free, on ${THIS_COMPUTER}): the vocals are separated (separate_vocals, default on when ${THIS_COMPUTER} can), the beat and bars are found, and the song is split into empty clips of about clip_seconds (default 8, 2–15) between its phrases, on the beat; every clip has its place in the song and starts with the sequence's cast (set it with update_sequence({cast}) – the artist, the outfit, the stage). A clip sends its place of the song as its reference audio (@Audio1): the vocals for lip sync, or the music for mood and rhythm; get_sequence shows the places. The lyrics are paid, so they are not transcribed here: ask for them with request_song_lyrics, then adjust the cut points with suggest_song_sections / set_song_sections. Returns at once with the new sequence_id while the work goes on (working); poll get_sequence or suggest_song_sections.`,
      input: {
        audio: z.union([uploadSource, urlSource]).describe('The song: {upload_id} or {url}.'),
        name: z.string().min(1).max(120).optional().describe("The sequence's name; default the file's name."),
        separate_vocals: z.boolean().optional().describe(`Separate the vocals (free, on ${THIS_COMPUTER}). Default: when ${THIS_COMPUTER} can.`),
        clip_seconds: z
          .number()
          .min(MIN_SONG_WINDOW_SECONDS)
          .max(MAX_SONG_WINDOW_SECONDS)
          .optional()
          .describe('About how long each clip is (2–15 s, default 8).')
      },
      annotations: WRITE,
      summary: ({ name }) => (name ? `made a sequence from a song (${q(name)})` : 'made a sequence from a song')
    },
    async ({ audio, name, separate_vocals, clip_seconds }) => {
      requireLibrary()
      const [file] = await stageFiles(ctx, 'audio', [audio])
      const sequence = await callService<Sequence>('songs:createSequence', file.path, {
        ...(name ? { name } : {}),
        ...(separate_vocals !== undefined ? { separateVocals: separate_vocals } : {}),
        ...(clip_seconds !== undefined ? { targetSeconds: clip_seconds } : {})
      })
      return {
        data: {
          sequence_id: sequence.id,
          name: sequence.name,
          song: sequence.song ? songInfo(sequence.song) : null,
          ...workInfo(sequence),
          next: `The song is being prepared and split into clips: poll get_sequence (or suggest_song_sections) until working is gone. Then choose the cast with update_sequence({cast}) and write each clip's prompt. ${NEXT_LYRICS}`
        },
        summary: `made the sequence ${q(sequence.name)} from a song`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'suggest_song_sections',
    {
      title: 'Suggest cut points in a song',
      description:
        "A song sequence's song – its length, tempo, whether its vocals are separated, and its lyric lines (numbered from 1, with their times: what edit_song_lyrics corrects) – the clips' places in it now, and the cut points the song suggests for clips of about clip_seconds (2–15, default 8): in the pauses between sung lines (or where the vocals pause), on a bar or a beat, every place 2–15 s. Changes nothing: apply them (or your own) with set_song_sections. Free; the first call may analyse the song for a few seconds.",
      input: {
        sequence_id: z.string(),
        clip_seconds: z.number().min(MIN_SONG_WINDOW_SECONDS).max(MAX_SONG_WINDOW_SECONDS).optional()
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'read the cut points a song suggests'
    },
    async ({ sequence_id, clip_seconds }) => {
      const sequence = await songSequence(sequence_id)
      const target = clip_seconds ?? 8
      const [overview, cuts] = await Promise.all([
        callService<SongOverview>('songs:overview', sequence.id),
        callService<number[]>('songs:suggestSections', sequence.id, target)
      ])
      const lyrics = sequence.song.lyrics
      return {
        data: {
          sequence_id: sequence.id,
          song: songInfo(sequence.song, overview),
          ...workInfo(sequence),
          clips: placesInfo(sequence),
          suggested: {
            clip_seconds: target,
            cut_points: cuts,
            places: placesOf(cuts, sequence.song.duration).map((p) => ({
              start: round(p.start),
              end: round(p.end),
              length: round(p.end - p.start, 100),
              ...(lyricsInWindow(lyrics, p.start, p.end) ? { words: lyricsInWindow(lyrics, p.start, p.end) } : {})
            }))
          },
          next: `set_song_sections({cut_points}) gives the clips these places${lyrics ? '' : `. ${NEXT_LYRICS}`}`
        }
      }
    }
  )

  defineTool(
    server,
    ctx,
    'set_song_sections',
    {
      title: "Set the clips' places in a song",
      description:
        "Sets where a song sequence's clips are in its song: cut_points are the seconds where one clip's place ends and the next begins, strictly inside the song and ascending (the first place starts at 0, the last ends with the song), every place at least 2 s (a place over 15 s is allowed, but only its first 15 s are sent). The clips keep their order, prompts and takes and get the places in order, each take's duration following its place; clips are added at the end (empty, with the cast) or removed there when there are fewer places – only clips nothing has been put in (no takes, prompt or notes): otherwise it is refused and nothing changes. A new place hears the vocals where words are sung, else the music. suggest_song_sections suggests cut points. Free.",
      input: {
        sequence_id: z.string(),
        cut_points: z.array(z.number()).max(400).describe('Seconds into the song, ascending.')
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: ({ cut_points }) => `set ${cut_points.length + 1} places in a song`
    },
    async ({ sequence_id, cut_points }) => {
      const before = await songSequence(sequence_id)
      const sequence = await callService<Sequence>('songs:setSections', before.id, cut_points)
      const added = sequence.segments.length - before.segments.length
      return {
        data: {
          sequence_id: sequence.id,
          clips: placesInfo(sequence),
          ...(added > 0 ? { added_clips: added } : {}),
          ...(added < 0 ? { removed_clips: -added } : {})
        },
        summary: `set the places of ${sequence.segments.length} clips in the song of ${q(sequence.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'edit_song_lyrics',
    {
      title: "Correct a song's lyrics",
      description:
        "Corrects lines of a song sequence's lyrics (transcribed with request_song_lyrics): line is the number suggest_song_sections lists (from 1), text the right words. A line with as many words keeps every word's time (a misheard word replaced); otherwise its new words share the line's time in proportion to their length. An empty text removes the line (words the transcription heard in the music). The clips' words follow (they are what a singing clip mimes). Free.",
      input: {
        sequence_id: z.string(),
        lines: z
          .array(z.object({ line: z.number().int().min(1), text: z.string().max(2000) }).strict())
          .min(1)
          .max(100)
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: ({ lines }) => `corrected ${lines.length === 1 ? 'a line' : `${lines.length} lines`} of a song's lyrics`
    },
    async ({ sequence_id, lines }) => {
      const sequence = await songSequence(sequence_id)
      const count = sequence.song.lyrics?.lines.length ?? 0
      if (!sequence.song.lyrics) throw new Error(`The song has no lyrics yet. ${NEXT_LYRICS}`)
      const numbers = lines.map((l) => l.line)
      const wrong = numbers.find((line) => line > count)
      if (wrong !== undefined) throw new Error(`There is no line ${wrong}: the lyrics have ${count} ${count === 1 ? 'line' : 'lines'}.`)
      if (new Set(numbers).size !== numbers.length) throw new Error('Each line can be corrected once per call.')
      // From the last line up, so a removed line doesn't move the ones still to come.
      let updated: Sequence = sequence
      for (const l of [...lines].sort((a, b) => b.line - a.line)) {
        updated = await callService<Sequence>('songs:editLyricLine', sequence.id, l.line - 1, l.text)
      }
      return {
        data: { sequence_id: updated.id, song: updated.song ? songInfo(updated.song) : null, clips: placesInfo(updated) },
        summary: `corrected the lyrics of ${q(updated.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'request_song_lyrics',
    {
      title: "Request a song's lyrics (paid, needs approval)",
      description:
        "💰 Asks the user to approve transcribing a song sequence's lyrics (speech-to-text at the active service with the time of every word, about $0.01 a minute; from the separated vocals when there are any). Nothing is sent or paid for until they approve in Studio; approving starts the transcription, which replaces any lyrics the song has (corrections too). model: a transcription model that times every word (list_audio_models; default ElevenLabs Scribe); language: a hint (e.g. \"en\"), else it is detected. Returns {approval_id, status: \"pending\", price_usd}; follow it with get_approval, then read the lines with suggest_song_sections and correct them with edit_song_lyrics.",
      input: {
        sequence_id: z.string(),
        model: z.string().optional(),
        language: z.string().max(20).optional(),
        note: z.string().max(500).optional().describe('Shown to the user in the approval dialog.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      summary: () => 'wants to transcribe a song'
    },
    async ({ sequence_id, model, language, note }) => {
      const epoch = ctx.approvals.epoch()
      const sequence = await songSequence(sequence_id)
      const song = sequence.song
      if (sequence.songWork?.stage === 'transcribing') {
        throw new Error('The lyrics are being transcribed right now. Wait for them (get_sequence) before you ask again.')
      }
      const catalog = await callService<AudioCatalog>('audio:models')
      const chosen = lyricsModelOf(catalog.transcription, model)
      const price = await callService<number>('songs:quoteLyrics', sequence.id, chosen.id)
      const lang = language?.trim() || undefined
      const fromVocals = !!song.vocalsPath || sequence.songWork?.stage === 'separating'
      const plan: Omit<ApprovalPlan, 'epoch'> = {
        kind: 'song-lyrics',
        client: ctx.clientName(),
        note,
        song: {
          songName: song.name,
          duration: song.duration,
          model: chosen.id,
          modelName: chosen.name,
          ...(lang ? { language: lang } : {}),
          fromVocals,
          replaces: !!song.lyrics
        },
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        priceUsd: price,
        fingerprint: `song-lyrics:${sequence.id}:${basename(song.path)}:${song.duration}:${chosen.id}:${lang ?? ''}:${price}`,
        // One request per song waits at a time: a newer one replaces it.
        target: `song-lyrics:${sequence.id}`,
        verify: async () => {
          // The same song (its folder may have been renamed meanwhile, which moves its file).
          const now = await callService<Sequence>('sequences:get', sequence.id).catch(() => undefined)
          if (!now?.song || basename(now.song.path) !== basename(song.path) || now.song.duration !== song.duration) {
            throw new Error('The song has changed since the agent asked, so the request no longer applies. Ask the agent to ask again.')
          }
          const again = await callService<number>('songs:quoteLyrics', sequence.id, chosen.id)
          if (again > price + 0.01) {
            throw new Error(`The price has changed since the agent asked (${usd(price)} → ${usd(again)}), so the request no longer applies. Ask the agent to ask again.`)
          }
        },
        // The user's OK is their yes to the price, also past the budget (the dialog warns).
        execute: async () => {
          await callService<Sequence>('songs:transcribe', sequence.id, {
            model: chosen.id,
            ...(lang ? { language: lang } : {}),
            confirmOverBudget: true
          })
          return {}
        }
      }
      if (!ctx.connected()) throw new Error("The agent connection is closed, so the request wasn't sent to the user.")
      const { request, reused } = ctx.approvals.create({ ...plan, epoch })
      return {
        data: {
          approval_id: request.id,
          status: request.status,
          price_usd: priceValue(request.priceUsd) ?? null,
          expires: localTime(request.expiresAt),
          model: chosen.id,
          from_vocals: fromVocals,
          ...(song.lyrics ? { replaces_lyrics: true } : {}),
          ...(reused ? { reused: true } : {}),
          message: reused
            ? 'An identical request is already waiting for the user; this is that one.'
            : 'Waiting for the user to approve it in Studio. Tell them briefly what is waiting, then poll get_approval every 15–30 seconds.',
          ...(request.status === 'pending' ? overBudgetAnswer(request.priceUsd) : {})
        },
        approvalId: request.id,
        summary: `wants to transcribe the lyrics of ${q(song.name)} (${usd(price)}) – waiting for your OK`
      }
    }
  )
}
