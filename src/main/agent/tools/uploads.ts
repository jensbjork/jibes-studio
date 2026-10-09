import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { extractFrames } from '../../ffmpeg'
import { MAX_URL_LENGTH } from '../fetch-url'
import { imageBlock, jpegBlock } from '../images'
import { localTime, q, requireLibrary } from '../studio'
import { KIND_WORDS, UPLOAD_CAPS, UPLOAD_KINDS, type UploadKind } from '../upload-check'
import { MAX_INLINE_BYTES, type UploadEntry } from '../uploads'
import { READ_ONLY, WRITE, defineTool, type LabeledImage, type ToolContext } from './kit'
import { beginUrlUpload } from './sources'

// Uploads: how a file an agent has reaches Studio. Three ways – a URL Studio fetches, a raw PUT of the file to the
// agent port (curl -T), or base64 in the call for tiny files – each ending in a checked file staged in the library's
// scratch, which the content tools (add_asset_images, add_asset_audio, import_still, import_own_clips, add_edit_audio,
// keyframes and board pictures, references) copy in by its upload_id.

/** begin_upload waits this long for a URL before it answers "downloading". */
const URL_ANSWER_WAIT_MS = 20_000

/** The preview get_upload sends. */
const PREVIEW_SIDE = 512

const kindInput = z.enum(UPLOAD_KINDS)

const BASE64 = /^[A-Za-z0-9+/\s]*={0,2}\s*$/

/** The bytes of data_base64 (a data: URL prefix is allowed); throws when it isn't base64. */
function decodeBase64(text: string): Buffer {
  const body = text.replace(/^data:[^,]*;base64,/i, '')
  if (!BASE64.test(body)) throw new Error('data_base64 är inte giltig base64.')
  return Buffer.from(body.replace(/\s+/g, ''), 'base64')
}

/** An upload as the tools answer about it. */
export function uploadInfo(e: UploadEntry): Record<string, unknown> {
  const info = e.info
  return {
    upload_id: e.id,
    status: e.status,
    kind: e.kind,
    ...(e.mime ? { mime: e.mime } : {}),
    file_name: e.fileName,
    ...(e.bytes !== undefined ? { bytes: e.bytes } : {}),
    received: e.received,
    ...(e.sha256 ? { sha256: e.sha256 } : {}),
    ...(e.host ? { from_host: e.host } : {}),
    ...(info?.kind === 'image' ? { image: { width: info.width, height: info.height } } : {}),
    ...(info?.kind === 'audio' ? { audio: { duration: Math.round(info.duration * 100) / 100 } } : {}),
    ...(info?.kind === 'video'
      ? {
          video: {
            duration: Math.round(info.duration * 100) / 100,
            width: info.width,
            height: info.height,
            fps: Math.round(info.fps * 100) / 100,
            working_copy_reasons: info.workingCopy
          }
        }
      : {}),
    ...(e.error ? { error: e.error } : {}),
    expires_at: localTime(e.expiresAt)
  }
}

/** A small picture of the upload: the picture itself, or a frame of a video. */
async function preview(e: UploadEntry): Promise<LabeledImage | undefined> {
  if (e.status !== 'ready' || !e.path) return undefined
  if (e.kind === 'image') {
    const image = await imageBlock(e.path, PREVIEW_SIDE)
    return image ? { label: `Upload ${e.id} – ${e.fileName}`, image } : undefined
  }
  if (e.kind === 'video' && e.info?.kind === 'video') {
    const at = Math.min(1, e.info.duration / 2)
    const [frame] = await extractFrames(e.path, [at], PREVIEW_SIDE).catch(() => [])
    return frame
      ? { label: `Upload ${e.id} – ${e.fileName}, frame at ${at.toFixed(1)} s`, image: jpegBlock(frame.jpeg) }
      : undefined
  }
  return undefined
}

const PUT_HINT =
  'PUT the raw file to put_url with your Authorization header and Content-Length = bytes, e.g. curl -T <file> -H "Authorization: Bearer <token>" <put_url>. Studio answers 201 when the file is in and checked (then get_upload shows it ready), or 4xx with {"error"} (507: too little free disk). A PUT that sends nothing for 60 s, or takes longer than 30 minutes in all, is stopped with 408 – send it again (on a slow link, discard_upload this upload and let Studio fetch the file by url instead).'

export function registerUploadTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'begin_upload',
    {
      title: 'Begin an upload',
      description: `Sends Studio a file – a picture (JPG, PNG, WebP or HEIC, which becomes JPEG; at most ${UPLOAD_CAPS.image.label}, 16 384 px a side, 80 megapixels), a sound (MP3, WAV, AIFF, FLAC, OGG, M4A or AAC; at most ${UPLOAD_CAPS.audio.label}) or a video (MP4, MOV, M4V, WebM or MKV; at most ${UPLOAD_CAPS.video.label}) – to use with add_asset_images, add_asset_audio, import_still, import_own_clips, add_edit_audio, set_form/set_references, keyframes and board pictures by its upload_id. Give exactly one of: url (Studio fetches it – public addresses only, or a server on your own machine; it waits up to 20 s, else answers status "downloading" – poll get_upload), bytes (the file's exact size: Studio answers a put_url, and you PUT the raw file there, e.g. curl -T <file> -H "Authorization: Bearer <token>" <put_url>; put_path when only the path is known – use the address you reach Studio at) or data_base64 (only for files under ${Math.round(MAX_INLINE_BYTES / 1000)} KB; checked at once). Never a local path. What the file is comes from its bytes, not its name or extension, and it is checked like Studio checks its own files (a picture must decode, a sound must have sound, a video must import). A ready upload lives two hours and can be used by several tools; discard_upload throws it away sooner.`,
      input: {
        kind: kindInput.describe('"image", "audio" or "video".'),
        file_name: z
          .string()
          .min(1)
          .max(200)
          .describe('The file name; its stem names the photo, clip or own film in Studio.'),
        url: z.string().min(1).max(MAX_URL_LENGTH).optional().describe('An http(s) URL Studio fetches.'),
        data_base64: z
          .string()
          .max(1_000_000)
          .optional()
          .describe(`The whole file as base64 (at most ${MAX_INLINE_BYTES.toLocaleString('en')} bytes decoded).`),
        bytes: z.number().int().min(1).optional().describe('The exact size in bytes of the file you will PUT.'),
        sha256: z
          .string()
          .regex(/^[0-9a-fA-F]{64}$/)
          .optional()
          .describe("The file's SHA-256 (hex); a file that arrives with another one is refused.")
      },
      annotations: WRITE,
      summary: ({ file_name, url }) => {
        if (!url) return `laddade upp ${q(file_name)}`
        try {
          return `hämtar ${q(file_name)} från ${new URL(url).hostname}`
        } catch {
          return `hämtar ${q(file_name)}`
        }
      }
    },
    async ({ kind, file_name, url, data_base64, bytes, sha256 }) => {
      requireLibrary()
      const given = [url !== undefined, data_base64 !== undefined, bytes !== undefined].filter(Boolean).length
      if (given !== 1) throw new Error('Ange exakt en av url, bytes eller data_base64.')
      const fileName = file_name.trim()
      if (url !== undefined) {
        const begun = await beginUrlUpload(ctx, kind as UploadKind, url, fileName)
        const settled = (await ctx.uploads.waitSettled(begun.id, URL_ANSWER_WAIT_MS)) ?? begun
        // Ended while this call waited: this call's own log entry says how.
        if (settled.status === 'ready' || settled.status === 'failed') ctx.uploads.markReported(settled.id)
        if (settled.status === 'failed') {
          // Nothing usable was made; the failed upload goes, and the agent gets the reason as the tool's error.
          ctx.uploads.discard(settled.id)
          throw new Error(settled.error ?? 'Hämtningen misslyckades.')
        }
        return {
          data: {
            ...uploadInfo(settled),
            ...(settled.status !== 'ready'
              ? {
                  next: 'Studio is still fetching it: poll get_upload until status is "ready", then use the upload_id.'
                }
              : {})
          },
          summary:
            settled.status === 'ready'
              ? `hämtade ${KIND_WORDS[settled.kind].one} från ${settled.host ?? 'webben'} (${q(fileName)})`
              : `hämtar ${q(fileName)} från ${settled.host ?? 'webben'}`
        }
      }
      if (data_base64 !== undefined) {
        const data = decodeBase64(data_base64)
        const entry = await ctx.uploads.begin({
          client: ctx.clientName(),
          peer: ctx.peer(),
          kind: kind as UploadKind,
          fileName,
          source: { data },
          sha256
        })
        return { data: uploadInfo(entry), summary: `laddade upp ${q(fileName)}` }
      }
      const entry = await ctx.uploads.begin({
        client: ctx.clientName(),
        peer: ctx.peer(),
        kind: kind as UploadKind,
        fileName,
        source: { bytes: bytes! },
        sha256
      })
      const base = ctx.baseUrl()
      const path = `/uploads/${entry.id}`
      return {
        data: {
          ...uploadInfo(entry),
          ...(base ? { put_url: `${base}${path}` } : {}),
          put_path: path,
          put_hint: PUT_HINT
        },
        summary: `började ta emot ${q(fileName)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'get_upload',
    {
      title: 'Get upload',
      description:
        "One upload: status (receiving – waiting for your PUT, with error when the last one broke off or was stopped; downloading – Studio fetches the URL; checking; ready; failed with error), kind, mime (what the bytes are), file name, size, bytes received, SHA-256, and what it is: a picture's width and height, a sound's duration, a video's duration, size, fps and working_copy_reasons (why import_own_clips will make a working copy: HDR, 4K → 1080p, rotation…). With include_preview (default true) a ready picture comes as a small image (a video as a frame). expires_at is when it goes away. Free; changes nothing.",
      input: {
        upload_id: z.string(),
        include_preview: z.boolean().default(true)
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'tittade på en uppladdning'
    },
    async ({ upload_id, include_preview }) => {
      const entry = ctx.uploads.require(upload_id)
      const image = include_preview ? await preview(entry) : undefined
      return {
        data: uploadInfo(entry),
        images: image ? [image] : [],
        summary: `tittade på uppladdningen ${q(entry.fileName)} (${entry.status})`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'discard_upload',
    {
      title: 'Discard upload',
      description:
        'Throws an upload away now (a transfer in progress stops). Only the uploaded scratch file goes: photos, sound clips, stills or own clips already made from it stay in the library. Do it for large video uploads once import_own_clips is done.',
      input: { upload_id: z.string() },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'slängde en uppladdning'
    },
    async ({ upload_id }) => {
      const entry = ctx.uploads.get(upload_id)
      ctx.uploads.discard(upload_id)
      return {
        data: { upload_id, discarded: true },
        summary: entry ? `slängde uppladdningen ${q(entry.fileName)}` : 'slängde en uppladdning'
      }
    }
  )
}
