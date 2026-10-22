import { isGenericAgentName } from '@shared/agent-name'
import { MAX_AUDIO_CLIP_SECONDS, MIN_AUDIO_CLIP_SECONDS } from '@shared/models'
import {
  ASSET_KINDS,
  LIBRARY_KINDS,
  type Asset,
  type AssetAudio,
  type AssetFileOrigin,
  type AssetKind,
  type LibraryFolderTarget,
  type ReferenceKind
} from '@shared/types'
import type { View } from './navigation'

/**
 * The kinds a prompt refers to, in the order the app lists them (Characters, Environments, Products, Outfits, Poses):
 * the pickers, chips and filters. LIBRARY_KINDS adds Directors after them (the sidebar, ⌘K).
 */
export { ASSET_KINDS, LIBRARY_KINDS }

/** Whether the kind is one a prompt refers to (not a director, which directs a clip instead). */
export function isReferenceKind(kind: AssetKind): kind is ReferenceKind {
  return (ASSET_KINDS as readonly AssetKind[]).includes(kind)
}

/** "2–15 seconds": how long the part of a sound clip sent to Venice may be. */
const CLIP_SECONDS = `${MIN_AUDIO_CLIP_SECONDS}–${MAX_AUDIO_CLIP_SECONDS} seconds`

/** The wording for the sound clips of a kind that has them (a character's voice, a place's sound). */
export interface AudioCopy {
  /** Section title: "Voice". */
  title: string
  /** What one clip is called: "voice clip". */
  clip: string
  /** What several clips are called: "voice clips". */
  clips: string
  /** Definite form: "the voice clip". */
  clipDefinite: string
  /** In the list column, when the asset has clips: "3 images · voice". */
  listLabel: string
  /** What the section is for, under its title. */
  intro: string
  /** Advice under the drop area. */
  tips: string
  /**
   * Badge on the first clip when it comes along automatically as the asset is added to a generation, with
   * its tooltip. Absent when nothing comes along by itself.
   */
  firstBadge?: { label: string; title: string }
}

/** The wording for one kind of library asset (character, environment, product, outfit, pose, director). */
export interface AssetCopy {
  /** Sidebar and list title: "Characters". */
  plural: string
  /** "character" */
  singular: string
  /** "the character" */
  definite: string
  /** Genitive of the definite form: "the character's". */
  possessive: string
  /** "New character", also the name given to a new one. */
  newName: string
  /** How generating with it reads: "with the character" → "Generate with the character". */
  generatePhrase: string
  /** Placeholder of the description field. */
  descriptionPlaceholder: string
  /** Next to the description label. */
  descriptionHint: string
  emptyTitle: string
  /** What the kind is for, in the empty state. */
  emptyText: string
  /** Shown in the list column while it is empty. */
  listHint: string
  /** Advice under the image drop area. */
  imageTips: string
  /**
   * The images' section, when it isn't "Reference images" (a director's style frames): its title, the line under it
   * and the note when there are more than a generation takes.
   */
  images?: { title: string; intro: string; many: string }
  /** How the asset is used when generating, shown in the editor when the kind needs explaining. */
  usage?: string
  /** Kinds that can have sound clips (characters' voices, environments' sounds); absent for the others. */
  audio?: AudioCopy
}

export const ASSET_COPY: Record<AssetKind, AssetCopy> = {
  character: {
    plural: 'Characters',
    singular: 'character',
    definite: 'the character',
    possessive: "the character's",
    newName: 'New character',
    generatePhrase: 'with the character',
    descriptionPlaceholder: 'Looks, age, hairstyle, personality…',
    descriptionHint: 'Paste into prompts to keep the look consistent',
    emptyTitle: 'No characters yet',
    emptyText:
      'Save people or figures with a few reference photos, a description of their looks and ideally a ' +
      'voice clip. Then generate with them in reference mode, where the images get @Image numbers and the voice ' +
      'an @Audio number that you refer to in the prompt.',
    listHint: 'Characters you create show up here. Drop images or sound on a character to add them.',
    imageTips: 'A few angles with a clear face give the best results. You can save the clothes separately under Outfits.',
    audio: {
      title: 'Voice',
      clip: 'voice clip',
      clips: 'voice clips',
      clipDefinite: 'the voice clip',
      listLabel: 'voice',
      intro:
        `How the character sounds. Venice uses an excerpt of ${CLIP_SECONDS} as a model for the voice's timbre, ` +
        'tone and pace – the result is a similar voice, not an exact copy.',
      tips: 'A recording where only the person speaks, without music or background noise, gives the best results.',
      firstBadge: {
        label: 'Comes along',
        title:
          'The first voice clip comes along when you add the character in Generate and the model takes audio. ' +
          'Move another clip to the top to use it instead.'
      }
    }
  },
  environment: {
    plural: 'Environments',
    singular: 'environment',
    definite: 'the environment',
    possessive: "the environment's",
    newName: 'New environment',
    generatePhrase: 'in the environment',
    descriptionPlaceholder: 'Place, time of day, light, weather, mood…',
    descriptionHint: 'Paste into prompts to keep the place consistent',
    emptyTitle: 'No environments yet',
    emptyText:
      'Save places – a kitchen, a beach, a street in the rain – with a few photos, a description and ideally how it ' +
      'sounds there. Use them as a reference or as a start image, and the clips play out in the same place every time.',
    listHint: 'Environments you create show up here. Drop images or sound on an environment to add them.',
    imageTips: 'A few views of the place in the same light give the best results – ideally with no people in the picture.',
    audio: {
      title: 'Soundscape',
      clip: 'sound clip',
      clips: 'sound clips',
      clipDefinite: 'the sound clip',
      listLabel: 'sound',
      intro:
        `How the place sounds – waves, chatter, traffic, rain. Venice uses an excerpt of ${CLIP_SECONDS} as a ` +
        'model for the sound in the clip when you add it in Generate with a model that takes audio.',
      tips: 'A recording of the place itself, without speech or music, gives the best results.'
    }
  },
  product: {
    plural: 'Products',
    singular: 'product',
    definite: 'the product',
    possessive: "the product's",
    newName: 'New product',
    generatePhrase: 'with the product',
    descriptionPlaceholder: 'Brand, model, colour, material, size, what the packaging says…',
    descriptionHint: 'Added to the prompt so the product looks the same in every clip',
    emptyTitle: 'No products yet',
    emptyText:
      'Save products you want in your films – a package, a bottle, a gadget – with a few clear images ' +
      'and a description. Then refer to them in the prompt, e.g. a character holding the product.',
    listHint: 'Products you create show up here. Drop images on a product to add them.',
    imageTips:
      'Clear images against a plain background – the front with the label first, ideally also the side and in a hand for ' +
      'scale. Small text and logos are rarely exact in video.',
    usage:
      'Add the product in Generate together with the character holding it, and the prompt says e.g. ' +
      '“Anna (@Image1) holding Coffee tin (@Image4)”.'
  },
  outfit: {
    plural: 'Outfits',
    singular: 'outfit',
    definite: 'the outfit',
    possessive: "the outfit's",
    newName: 'New outfit',
    generatePhrase: 'with the outfit',
    descriptionPlaceholder: 'Garments, colours, materials, style…',
    descriptionHint: 'Paste into prompts to keep the clothes consistent',
    emptyTitle: 'No outfits yet',
    emptyText:
      'Save outfits with a few images and a description, and dress your characters in them when you generate. Give a ' +
      'character a default outfit and it comes along automatically.',
    listHint: 'Outfits you create show up here. Drop images on an outfit to add them.',
    imageTips:
      'Images where the garments show clearly and in full – ideally against a plain background or worn by someone – give ' +
      'the best results.'
  },
  pose: {
    plural: 'Poses',
    singular: 'pose',
    definite: 'the pose',
    possessive: "the pose's",
    newName: 'New pose',
    generatePhrase: 'with the pose',
    descriptionPlaceholder: 'Who stands where, posture, distance, camera angle…',
    descriptionHint: 'Paste into prompts to get the same placement and posture',
    emptyTitle: 'No poses yet',
    emptyText:
      'Save a photo or a sketch of the positions you want – how someone stands, sits or moves, or ' +
      'how several people stand in relation to each other. When you generate, you refer to the people in the ' +
      'image with your characters, and they take the same stance.',
    listHint: 'Poses you create show up here. Drop images on a pose to add them.',
    imageTips:
      'Whole bodies and clear positions give the best results. A simple sketch works well – and the less ' +
      'the faces show, the less the clip borrows from the people in the image.',
    usage:
      'Add the pose in Generate together with the characters, and the prompt says who should stand like that, ' +
      'e.g. “Anna (@Image1) and Erik (@Image3) posed as in Hug (@Image5)”. It is the positions that are borrowed, not ' +
      'the people in the image.'
  },
  director: {
    plural: 'Directors',
    singular: 'director',
    definite: 'the director',
    possessive: "the director's",
    newName: 'New director',
    generatePhrase: 'with the director',
    descriptionPlaceholder: 'What the director is good for, in one line…',
    descriptionHint: 'Shown in the pickers',
    emptyTitle: 'No directors of your own yet',
    emptyText:
      'A director is a way of making a film – how it is cut, its look, the camera, the light, the framing, the rhythm, ' +
      'the acting and the sound, what it never does, and pictures and videos of the style. Choose one in Generate, for ' +
      'a sequence or a storyboard, and every prompt it directs gets the same direction.',
    listHint: 'Directors you create show up here. Start from a ready-made one with “Use a copy”.',
    imageTips:
      'Stills whose grade, light and texture the clips should match – never their people, places or objects. Three or ' +
      'four that agree with each other work best.',
    images: {
      title: 'Style frames',
      intro:
        'Sent after a clip’s own reference images, in this order, so the clip matches their look – grade, light, ' +
        'texture – never their people, places or objects. Only in reference mode. The first is the cover.',
      many:
        'A clip takes only as many style frames as the model has places left after its own reference images; the ' +
        'first ones come along.'
    }
  }
}

/** The library view that lists each kind. */
export const ASSET_VIEW: Record<AssetKind, View> = {
  character: 'characters',
  environment: 'environments',
  product: 'products',
  outfit: 'outfits',
  pose: 'poses',
  director: 'directors'
}

/** The library folder that holds each kind (on disk: Characters, Environments, Products, Outfits, Poses, Directors). */
export const ASSET_FOLDER: Record<AssetKind, LibraryFolderTarget> = {
  character: 'characters',
  environment: 'environments',
  product: 'products',
  outfit: 'outfits',
  pose: 'poses',
  director: 'directors'
}

/** The reference kind a library view lists (Characters … Poses); Directors has a view of its own. */
export function assetKindOfView(view: View): ReferenceKind | undefined {
  return ASSET_KINDS.find((kind) => ASSET_VIEW[kind] === view)
}

/** Whether assets of the kind have sound clips (a character's voice, an environment's sound). */
export function hasAudio(kind: AssetKind): boolean {
  return !!ASSET_COPY[kind].audio
}

/**
 * The asset's sound clips in order. Tolerates an asset without the field (one sent by a main process from
 * before sound clips, while a development build reloads only the window), so the views don't crash on it.
 */
export function assetAudio(asset: Pick<Asset, 'audio'>): AssetAudio[] {
  return asset.audio ?? []
}

/** "1 voice clip", "3 sound clips"; undefined for kinds without sound clips. */
export function audioCountLabel(kind: AssetKind, n: number): string | undefined {
  const copy = ASSET_COPY[kind].audio
  if (!copy) return undefined
  return n === 0 ? `No ${copy.clips}` : `${n} ${n === 1 ? copy.clip : copy.clips}`
}

const originDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const originDayAndYear = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const originClock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/**
 * Who added a photo or a sound clip, when an agent did: "Added by My agent 9 Oct 14:02 · from example.com"
 * (the year only when it isn't this year's; the host only for a file fetched from a URL). Undefined for the user's
 * own files.
 */
export function originText(origin: AssetFileOrigin | undefined, now = Date.now()): string | undefined {
  if (!origin?.agent) return undefined
  let when = ''
  if (origin.at > 0) {
    const d = new Date(origin.at)
    const day = (d.getFullYear() === new Date(now).getFullYear() ? originDay : originDayAndYear)
      .format(d)
      // Some locales end short months in a period ("Sept."), which reads oddly before the time.
      .replace(/\.(?=\s|$)/g, '')
    when = ` ${day} ${originClock.format(d)}`
  }
  // "Added by the agent" for a generic MCP client name ("mcp"), "Added by Hermes" for a real one.
  const who = isGenericAgentName(origin.agent) ? 'the agent' : origin.agent.trim()
  return `Added by ${who}${when}${origin.host ? ` · from ${origin.host}` : ''}`
}

/** "Anna", "Anna and Kalle", "Anna, Kalle and Bo": a list in UI text. */
export function englishList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** "Anna", "Anna och Kalle", "Anna, Kalle och Bo": only for prompt text written in Swedish (Prompt language). */
export function swedishList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} och ${items[items.length - 1]}`
}
