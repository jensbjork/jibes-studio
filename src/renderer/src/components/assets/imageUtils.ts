import type { DragEvent } from 'react'
import { AUDIO_EXT, AUDIO_FORMATS } from './audioUtils'

export const IMAGE_EXT = /\.(jpe?g|png|webp)$/i

// The video models reject reference images that are too small or too stretched.
const MIN_SHORT_SIDE = 300
const MIN_RATIO = 0.4
const MAX_RATIO = 2.5

export interface Size {
  width: number
  height: number
}

export interface ImageIssue {
  /** Short badge text. */
  label: string
  /** Full explanation for tooltips and the preview. */
  detail: string
}

const decimal = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 })

/** Reasons a model is likely to reject the image as a reference; empty when it looks fine. */
export function imageIssues({ width, height }: Size): ImageIssue[] {
  if (!width || !height) return []
  const issues: ImageIssue[] = []
  const shortSide = Math.min(width, height)
  if (shortSide < MIN_SHORT_SIDE) {
    issues.push({
      label: 'Low resolution',
      detail: `The shortest side is ${shortSide} px – the models need at least ${MIN_SHORT_SIDE} px.`
    })
  }
  const ratio = width / height
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
    issues.push({
      label: 'Odd aspect ratio',
      detail: `The aspect ratio ${decimal.format(ratio)} is outside the ${decimal.format(MIN_RATIO)}–${decimal.format(MAX_RATIO)} that the models accept.`
    })
  }
  return issues
}

/** True for drags carrying files from Finder, as opposed to in-app drags. */
export function isFileDrag(e: DragEvent): boolean {
  return e.dataTransfer.types.includes('Files')
}

/** What a file drag carries, as far as the browser tells before the drop. */
export interface FileDragKinds {
  image: boolean
  audio: boolean
}

/**
 * Whether a drag from Finder carries images and/or audio, from the files' MIME types (known while dragging,
 * unlike their names). A file of unknown type counts as both, so a target never stays dark for a file it
 * would take.
 */
export function fileDragKinds(e: DragEvent): FileDragKinds {
  const kinds = { image: false, audio: false }
  for (const item of Array.from(e.dataTransfer.items)) {
    if (item.kind !== 'file') continue
    if (item.type.startsWith('image/')) kinds.image = true
    else if (item.type.startsWith('audio/')) kinds.audio = true
    else if (!item.type || item.type === 'application/octet-stream') {
      kinds.image = true
      kinds.audio = true
    }
  }
  return kinds
}

/** Absolute paths of the files in a drop. */
export function droppedPaths(e: DragEvent): string[] {
  return Array.from(e.dataTransfer.files)
    .map((f) => window.studio.pathForFile(f))
    .filter(Boolean)
}

/** Files dropped on or picked for an asset, sorted by where they go. */
export interface SortedFiles {
  images: string[]
  /** Empty for kinds without sound clips; such files are counted in `audioRefused`. */
  audio: string[]
  /** Audio files for a kind that has no sound clips. */
  audioRefused: number
  /** Neither images nor audio. */
  other: number
}

export function sortFiles(paths: string[], acceptsAudio: boolean): SortedFiles {
  const images = paths.filter((p) => IMAGE_EXT.test(p))
  const sounds = paths.filter((p) => AUDIO_EXT.test(p))
  return {
    images,
    audio: acceptsAudio ? sounds : [],
    audioRefused: acceptsAudio ? 0 : sounds.length,
    other: paths.length - images.length - sounds.length
  }
}

const IMAGE_FORMATS = 'JPG, PNG or WebP'

/** What to say about files that were left out; undefined when every file was taken. */
export function sortedFilesNotice(files: SortedFiles, acceptsAudio: boolean): string | undefined {
  const skipped = files.other + files.audioRefused
  if (!skipped) return undefined
  const taken = files.images.length + files.audio.length
  if (!acceptsAudio && files.audioRefused && !files.other) {
    return taken
      ? `${skipped === 1 ? 'The audio file was skipped' : 'The audio files were skipped'} – sound can only be added to characters (voice) and environments (soundscape).`
      : 'Sound can only be added to characters (voice) and environments (soundscape). Here you can add images.'
  }
  const accepted = acceptsAudio
    ? `images in ${IMAGE_FORMATS} and sound in ${AUDIO_FORMATS}`
    : `images in ${IMAGE_FORMATS}`
  if (!taken) return `Only ${accepted} can be added.`
  return `${skipped} ${skipped === 1 ? 'file was' : 'files were'} skipped – only ${accepted} are supported.`
}

/** Where a dragged list entry is dropped: before or after the entry with this id. */
export interface DropTarget {
  id: string
  after: boolean
}

/** Where the dragged entry lands, as an index in the list without it; undefined when nothing would move. */
export function insertIndex(
  ids: string[],
  dragged: string | undefined,
  target: DropTarget | undefined
): number | undefined {
  if (!dragged || !target) return undefined
  const from = ids.indexOf(dragged)
  const over = ids.indexOf(target.id)
  if (from === -1 || over === -1) return undefined
  const to = over + (target.after ? 1 : 0)
  const adjusted = to > from ? to - 1 : to
  return adjusted === from ? undefined : adjusted
}

export function imageCountLabel(n: number): string {
  if (n === 0) return 'No images'
  return `${n} ${n === 1 ? 'image' : 'images'}`
}
