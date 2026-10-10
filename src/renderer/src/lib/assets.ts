import { isGenericAgentName } from '@shared/agent-name'
import { MAX_AUDIO_CLIP_SECONDS, MIN_AUDIO_CLIP_SECONDS } from '@shared/models'
import {
  ASSET_KINDS,
  type Asset,
  type AssetAudio,
  type AssetFileOrigin,
  type AssetKind,
  type LibraryFolderTarget
} from '@shared/types'
import type { View } from './navigation'

/** Every kind, in the order the app lists them (Karaktärer, Miljöer, Produkter, Kläder, Poser). */
export { ASSET_KINDS }

/** "2–15 sekunder": how long the part of a sound clip sent to Venice may be. */
const CLIP_SECONDS = `${MIN_AUDIO_CLIP_SECONDS}–${MAX_AUDIO_CLIP_SECONDS} sekunder`

/** Swedish wording for the sound clips of a kind that has them (a character's voice, a place's sound). */
export interface AudioCopy {
  /** Section title: "Röst". */
  title: string
  /** What one clip is called, singular and plural alike: "röstklipp". */
  clip: string
  /** Definite form: "röstklippet". */
  clipDefinite: string
  /** In the list column, when the asset has clips: "3 bilder · röst". */
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

/** Swedish wording for one kind of library asset (karaktär, miljö, produkt, klädsel, pose). */
export interface AssetCopy {
  /** Sidebar and list title: "Karaktärer". */
  plural: string
  /** "karaktär" */
  singular: string
  /** "karaktären" */
  definite: string
  /** Genitive of the definite form: "karaktärens". */
  possessive: string
  /** "Ny karaktär", also the name given to a new one. */
  newName: string
  /** How generating with it reads: "med karaktären" → "Generera med karaktären". */
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
  /** How the asset is used when generating, shown in the editor when the kind needs explaining. */
  usage?: string
  /** Kinds that can have sound clips (characters' voices, environments' sounds); absent for the others. */
  audio?: AudioCopy
}

export const ASSET_COPY: Record<AssetKind, AssetCopy> = {
  character: {
    plural: 'Karaktärer',
    singular: 'karaktär',
    definite: 'karaktären',
    possessive: 'karaktärens',
    newName: 'Ny karaktär',
    generatePhrase: 'med karaktären',
    descriptionPlaceholder: 'Utseende, ålder, frisyr, personlighet…',
    descriptionHint: 'Klistra in i prompter för att hålla utseendet konsekvent',
    emptyTitle: 'Inga karaktärer än',
    emptyText:
      'Spara personer eller figurer med några referensfoton, en beskrivning av utseendet och gärna ett ' +
      'röstklipp. Sedan genererar du med dem i referensläget, där bilderna får @Image-nummer och rösten ' +
      '@Audio-nummer som du hänvisar till i prompten.',
    listHint: 'Karaktärer du skapar visas här. Släpp bilder eller ljud på en karaktär för att lägga till dem.',
    imageTips: 'Några vinklar med tydligt ansikte ger bäst resultat. Kläderna kan du spara separat under Kläder.',
    audio: {
      title: 'Röst',
      clip: 'röstklipp',
      clipDefinite: 'röstklippet',
      listLabel: 'röst',
      intro:
        `Hur karaktären låter. Venice använder ett utdrag på ${CLIP_SECONDS} som förebild för röstens klang, ` +
        'ton och tempo – det blir en liknande röst, inte en exakt kopia.',
      tips: 'En inspelning där bara personen pratar, utan musik eller bakgrundsljud, ger bäst resultat.',
      firstBadge: {
        label: 'Följer med',
        title:
          'Det första röstklippet följer med när du lägger till karaktären i Generera och modellen tar emot ljud. ' +
          'Flytta ett annat klipp överst för att använda det i stället.'
      }
    }
  },
  environment: {
    plural: 'Miljöer',
    singular: 'miljö',
    definite: 'miljön',
    possessive: 'miljöns',
    newName: 'Ny miljö',
    generatePhrase: 'i miljön',
    descriptionPlaceholder: 'Plats, tid på dygnet, ljus, väder, stämning…',
    descriptionHint: 'Klistra in i prompter för att hålla platsen konsekvent',
    emptyTitle: 'Inga miljöer än',
    emptyText:
      'Spara platser – ett kök, en strand, en gata i regn – med några foton, en beskrivning och gärna hur det ' +
      'låter där. Använd dem som referens eller som startbild, så utspelar sig klippen på samma ställe varje gång.',
    listHint: 'Miljöer du skapar visas här. Släpp bilder eller ljud på en miljö för att lägga till dem.',
    imageTips: 'Några vyer av platsen i samma ljus ger bäst resultat – gärna utan människor i bild.',
    audio: {
      title: 'Ljudmiljö',
      clip: 'ljudklipp',
      clipDefinite: 'ljudklippet',
      listLabel: 'ljud',
      intro:
        `Hur platsen låter – vågor, sorl, trafik, regn. Venice använder ett utdrag på ${CLIP_SECONDS} som ` +
        'förebild för ljudet i klippet, när du lägger till det i Generera med en modell som tar emot ljud.',
      tips: 'En inspelning av själva platsen, utan tal eller musik, ger bäst resultat.'
    }
  },
  product: {
    plural: 'Produkter',
    singular: 'produkt',
    definite: 'produkten',
    possessive: 'produktens',
    newName: 'Ny produkt',
    generatePhrase: 'med produkten',
    descriptionPlaceholder: 'Märke, modell, färg, material, storlek, vad som står på förpackningen…',
    descriptionHint: 'Läggs till i prompten så att produkten ser likadan ut i varje klipp',
    emptyTitle: 'Inga produkter än',
    emptyText:
      'Spara produkter du vill ha med i filmerna – en förpackning, en flaska, en pryl – med några tydliga bilder ' +
      'och en beskrivning. Sedan hänvisar du till dem i prompten, t.ex. att en karaktär håller produkten.',
    listHint: 'Produkter du skapar visas här. Släpp bilder på en produkt för att lägga till dem.',
    imageTips:
      'Tydliga bilder mot enkel bakgrund – framsidan med etiketten först, gärna även sidan och i en hand för ' +
      'storleken. Små texter och logotyper blir sällan exakta i video.',
    usage:
      'Lägg till produkten i Generera tillsammans med karaktären som håller den, så skriver prompten t.ex. ' +
      '”Anna (@Image1) håller Kaffeburken (@Image4)”.'
  },
  outfit: {
    plural: 'Kläder',
    singular: 'klädsel',
    definite: 'klädseln',
    possessive: 'klädselns',
    newName: 'Ny klädsel',
    generatePhrase: 'med klädseln',
    descriptionPlaceholder: 'Plagg, färger, material, stil…',
    descriptionHint: 'Klistra in i prompter för att hålla kläderna konsekventa',
    emptyTitle: 'Inga kläder än',
    emptyText:
      'Spara kläder med några bilder och en beskrivning, och klä dina karaktärer i dem när du genererar. Ge en ' +
      'karaktär en standardklädsel så följer den med automatiskt.',
    listHint: 'Kläder du skapar visas här. Släpp bilder på en klädsel för att lägga till dem.',
    imageTips:
      'Bilder där plaggen syns tydligt och i sin helhet – gärna mot en enkel bakgrund eller burna av någon – ger ' +
      'bäst resultat.'
  },
  pose: {
    plural: 'Poser',
    singular: 'pose',
    definite: 'posen',
    possessive: 'posens',
    newName: 'Ny pose',
    generatePhrase: 'med posen',
    descriptionPlaceholder: 'Vem står var, kroppshållning, avstånd, kameravinkel…',
    descriptionHint: 'Klistra in i prompter för att få samma placering och hållning',
    emptyTitle: 'Inga poser än',
    emptyText:
      'Spara ett foto eller en skiss av positionerna du vill ha – hur någon står, sitter eller rör sig, eller ' +
      'hur flera personer står i förhållande till varandra. När du genererar hänvisar du till personerna på ' +
      'bilden med dina karaktärer, så intar de samma ställning.',
    listHint: 'Poser du skapar visas här. Släpp bilder på en pose för att lägga till dem.',
    imageTips:
      'Hela kroppar och tydliga positioner ger bäst resultat. En enkel skiss fungerar bra – och ju mindre ' +
      'ansiktena syns, desto mindre lånar klippet av personerna på bilden.',
    usage:
      'Lägg till posen i Generera tillsammans med karaktärerna, så skriver prompten vilka som ska stå så, ' +
      't.ex. ”Anna (@Image1) och Erik (@Image3) i posen Kram (@Image5)”. Det är positionerna som lånas, inte ' +
      'personerna på bilden.'
  }
}

/** The library view that lists each kind. */
export const ASSET_VIEW: Record<AssetKind, View> = {
  character: 'characters',
  environment: 'environments',
  product: 'products',
  outfit: 'outfits',
  pose: 'poses'
}

/** The library folder that holds each kind (Karaktärer, Miljöer, Produkter, Kläder, Poser). */
export const ASSET_FOLDER: Record<AssetKind, LibraryFolderTarget> = {
  character: 'characters',
  environment: 'environments',
  product: 'products',
  outfit: 'outfits',
  pose: 'poses'
}

export function assetKindOfView(view: View): AssetKind | undefined {
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

/** "1 röstklipp", "3 ljudklipp"; undefined for kinds without sound clips. */
export function audioCountLabel(kind: AssetKind, n: number): string | undefined {
  const copy = ASSET_COPY[kind].audio
  if (!copy) return undefined
  return n === 0 ? `Inga ${copy.clip}` : `${n} ${copy.clip}`
}

const originDay = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short' })
const originDayAndYear = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' })
const originClock = new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit' })

/**
 * Who added a photo or a sound clip, when an agent did: "Tillagd av Min agent 9 okt 14:02 · från example.com"
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
      // Swedish short months end in a period ("okt."), which reads oddly before the time.
      .replace(/\.(?=\s|$)/g, '')
    when = ` ${day} ${originClock.format(d)}`
  }
  // "Tillagd av agenten" for a generic MCP client name ("mcp"), "Tillagd av OpenClaw" for a real one.
  const who = isGenericAgentName(origin.agent) ? 'agenten' : origin.agent.trim()
  return `Tillagd av ${who}${when}${origin.host ? ` · från ${origin.host}` : ''}`
}

/** "Anna", "Anna och Kalle", "Anna, Kalle och Lisa". */
export function swedishList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} och ${items[items.length - 1]}`
}
