import type { DragEvent } from 'react'

export const IMAGE_EXT = /\.(jpe?g|png|webp)$/i

// Venice rejects reference images that are too small or too stretched.
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

const decimal = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 })

/** Reasons Venice is likely to reject the image as a reference; empty when it looks fine. */
export function imageIssues({ width, height }: Size): ImageIssue[] {
  if (!width || !height) return []
  const issues: ImageIssue[] = []
  const shortSide = Math.min(width, height)
  if (shortSide < MIN_SHORT_SIDE) {
    issues.push({
      label: 'Låg upplösning',
      detail: `Kortaste sidan är ${shortSide} px – Venice kräver minst ${MIN_SHORT_SIDE} px.`
    })
  }
  const ratio = width / height
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
    issues.push({
      label: 'Fel format',
      detail: `Sidförhållandet ${decimal.format(ratio)} ligger utanför ${decimal.format(MIN_RATIO)}–${decimal.format(MAX_RATIO)}, som Venice godtar.`
    })
  }
  return issues
}

/** True for drags carrying files from Finder, as opposed to in-app drags. */
export function isFileDrag(e: DragEvent): boolean {
  return e.dataTransfer.types.includes('Files')
}

/** Absolute paths of the files in a drop. */
export function droppedPaths(e: DragEvent): string[] {
  return Array.from(e.dataTransfer.files)
    .map((f) => window.studio.pathForFile(f))
    .filter(Boolean)
}

/** Splits paths into supported images and a count of everything else. */
export function splitImagePaths(paths: string[]): { images: string[]; skipped: number } {
  const images = paths.filter((p) => IMAGE_EXT.test(p))
  return { images, skipped: paths.length - images.length }
}

export function skippedMessage(skipped: number, added: number): string {
  if (!added) return 'Bara bilder i JPG, PNG eller WebP kan läggas till.'
  return `${skipped} ${skipped === 1 ? 'fil' : 'filer'} hoppades över – bara JPG, PNG och WebP stöds.`
}

export function imageCountLabel(n: number): string {
  if (n === 0) return 'Inga bilder'
  return `${n} ${n === 1 ? 'bild' : 'bilder'}`
}
