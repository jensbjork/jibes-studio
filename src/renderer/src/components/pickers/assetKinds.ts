// Picker wording and kind colours for using library assets in the generate form (pickers, chips, captions).
// The general per-kind wording (plural, singular, possessive…) lives in lib/assets.

import type { AssetKind, ReferenceKind } from '@shared/types'

interface PickerCopy {
  search: string
  emptyTitle: string
  emptyText: string
  create: string
  manage: string
  noMatch: string
  /** Tooltip on a row without photos. */
  needsImages: string
}

/** Per reference kind: directors are never picked as references. */
export const PICKER_COPY: Record<ReferenceKind, PickerCopy> = {
  character: {
    search: 'Search characters…',
    emptyTitle: 'No characters yet.',
    emptyText: 'Save people with reference photos and you can reuse them here.',
    create: 'Create a character',
    manage: 'Manage characters →',
    noMatch: 'No character matches',
    needsImages: 'Add images to the character first'
  },
  environment: {
    search: 'Search environments…',
    emptyTitle: 'No environments yet.',
    emptyText: 'Save places with photos – a beach, a kitchen, a street – and let the scene play out there.',
    create: 'Create an environment',
    manage: 'Manage environments →',
    noMatch: 'No environment matches',
    needsImages: 'Add images to the environment first'
  },
  product: {
    search: 'Search products…',
    emptyTitle: 'No products yet.',
    emptyText: 'Save products with images and you can include them in your clips.',
    create: 'Create a product',
    manage: 'Manage products →',
    noMatch: 'No product matches',
    needsImages: 'Add images to the product first'
  },
  outfit: {
    search: 'Search outfits…',
    emptyTitle: 'No outfits yet.',
    emptyText: 'Save outfits with photos and you can choose what the characters wear.',
    create: 'Create an outfit',
    manage: 'Manage outfits →',
    noMatch: 'No outfit matches',
    needsImages: 'Add images to the outfit first'
  },
  pose: {
    search: 'Search poses…',
    emptyTitle: 'No poses yet.',
    emptyText:
      'Save a photo or a sketch of the positions you want – then refer to the people in it with your characters.',
    create: 'Create a pose',
    manage: 'Manage poses →',
    noMatch: 'No pose matches',
    needsImages: 'Add images to the pose first'
  }
}

interface KindTone {
  /** Kind icon colour. */
  text: string
  /** Chip border and background. */
  chip: string
  /** Ring around a chip's thumbnail. */
  ring: string
  /** Name strip on an image thumbnail. */
  caption: string
  /** An @ImageN token of this kind in the prompt editor: text and background only, so the layout never shifts. */
  token: string
}

// Full class strings (not built from parts) so Tailwind sees them when it scans the source.
export const KIND_TONE: Record<AssetKind, KindTone> = {
  character: {
    text: 'text-sky-400',
    chip: 'border-sky-400/30 bg-sky-400/10 hover:border-sky-400/60',
    ring: 'ring-sky-400/70',
    caption: 'bg-sky-700/85',
    token: 'bg-sky-400/15 text-sky-300'
  },
  environment: {
    text: 'text-emerald-400',
    chip: 'border-emerald-400/30 bg-emerald-400/10 hover:border-emerald-400/60',
    ring: 'ring-emerald-400/70',
    caption: 'bg-emerald-700/85',
    token: 'bg-emerald-400/15 text-emerald-300'
  },
  product: {
    text: 'text-orange-400',
    chip: 'border-orange-400/30 bg-orange-400/10 hover:border-orange-400/60',
    ring: 'ring-orange-400/70',
    caption: 'bg-orange-700/85',
    token: 'bg-orange-400/15 text-orange-300'
  },
  outfit: {
    text: 'text-violet-400',
    chip: 'border-violet-400/30 bg-violet-400/10 hover:border-violet-400/60',
    ring: 'ring-violet-400/70',
    caption: 'bg-violet-700/85',
    token: 'bg-violet-400/15 text-violet-300'
  },
  pose: {
    text: 'text-pink-400',
    chip: 'border-pink-400/30 bg-pink-400/10 hover:border-pink-400/60',
    ring: 'ring-pink-400/70',
    caption: 'bg-pink-700/85',
    token: 'bg-pink-400/15 text-pink-300'
  },
  // A director's style frames and videos, where they show beside a clip's references ("from the director").
  director: {
    text: 'text-indigo-300',
    chip: 'border-indigo-400/30 bg-indigo-400/10 hover:border-indigo-400/60',
    ring: 'ring-indigo-400/70',
    caption: 'bg-indigo-700/85',
    token: 'bg-indigo-400/15 text-indigo-200'
  }
}

/** A valid @ImageN token whose picture isn't a library photo (added from disk). */
export const OWN_IMAGE_TOKEN = 'bg-white/10 text-text'

/**
 * An @VideoN token, badge and tile: reference videos aren't library assets, so they have a colour of their own
 * (full class strings, so Tailwind sees them).
 */
export const VIDEO_TONE = { text: 'text-lime-300', token: 'bg-lime-400/15 text-lime-200' }
