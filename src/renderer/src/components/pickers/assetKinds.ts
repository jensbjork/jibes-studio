// Picker wording and kind colours for using library assets in the generate form (pickers, chips, captions).
// The general per-kind wording (plural, singular, possessive…) lives in lib/assets.

import type { AssetKind } from '@shared/types'

interface PickerCopy {
  /** Header button, after "＋ ". */
  add: string
  /** Tooltip of the header button. */
  addTitle: string
  search: string
  emptyTitle: string
  emptyText: string
  create: string
  manage: string
  noMatch: string
  /** Tooltip on a row without photos. */
  needsImages: string
}

export const PICKER_COPY: Record<AssetKind, PickerCopy> = {
  character: {
    add: 'Karaktär',
    addTitle: 'Lägg till en sparad karaktärs bilder (och standardklädseln)',
    search: 'Sök karaktär…',
    emptyTitle: 'Inga karaktärer än.',
    emptyText: 'Spara personer med referensfoton så kan du återanvända dem här.',
    create: 'Skapa en karaktär',
    manage: 'Hantera karaktärer →',
    noMatch: 'Ingen karaktär matchar',
    needsImages: 'Lägg till bilder på karaktären först'
  },
  environment: {
    add: 'Miljö',
    addTitle: 'Lägg till en sparad miljös bilder',
    search: 'Sök miljö…',
    emptyTitle: 'Inga miljöer än.',
    emptyText: 'Spara platser med foton – en strand, ett kök, en gata – och låt scenen utspela sig där.',
    create: 'Skapa en miljö',
    manage: 'Hantera miljöer →',
    noMatch: 'Ingen miljö matchar',
    needsImages: 'Lägg till bilder på miljön först'
  },
  product: {
    add: 'Produkt',
    addTitle: 'Lägg till en sparad produkts bilder',
    search: 'Sök produkt…',
    emptyTitle: 'Inga produkter än.',
    emptyText: 'Spara produkter med bilder så kan du ta med dem i klippen.',
    create: 'Skapa en produkt',
    manage: 'Hantera produkter →',
    noMatch: 'Ingen produkt matchar',
    needsImages: 'Lägg till bilder på produkten först'
  },
  outfit: {
    add: 'Kläder',
    addTitle: 'Lägg till en sparad klädsels bilder',
    search: 'Sök kläder…',
    emptyTitle: 'Inga kläder än.',
    emptyText: 'Spara klädslar med foton så kan du välja vad karaktärerna har på sig.',
    create: 'Skapa en klädsel',
    manage: 'Hantera kläder →',
    noMatch: 'Ingen klädsel matchar',
    needsImages: 'Lägg till bilder på klädseln först'
  },
  pose: {
    add: 'Pose',
    addTitle: 'Lägg till en sparad pose: bilder som visar hur personerna står och var, i förhållande till varandra',
    search: 'Sök pose…',
    emptyTitle: 'Inga poser än.',
    emptyText:
      'Spara ett foto eller en skiss av positionerna du vill ha – sedan hänvisar du till personerna i den med dina karaktärer.',
    create: 'Skapa en pose',
    manage: 'Hantera poser →',
    noMatch: 'Ingen pose matchar',
    needsImages: 'Lägg till bilder på posen först'
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
  }
}

/** A valid @ImageN token whose picture isn't a library photo (added from disk). */
export const OWN_IMAGE_TOKEN = 'bg-white/10 text-text'
