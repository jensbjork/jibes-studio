import { ASSET_KINDS, type AssetKind, type LibraryFolderTarget } from '@shared/types'
import type { View } from './navigation'

/** Every kind, in the order the app lists them (Karaktärer, Miljöer, Kläder). */
export { ASSET_KINDS }

/** Swedish wording for one kind of library asset (karaktär, miljö, klädsel). */
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
      'Spara personer eller figurer med några referensfoton och en beskrivning av utseendet. Sedan genererar du med ' +
      'dem i referensläget, där bilderna får @Image-nummer som du hänvisar till i prompten.',
    listHint: 'Karaktärer du skapar visas här. Släpp bilder på en karaktär för att lägga till dem.',
    imageTips: 'Några vinklar med tydligt ansikte ger bäst resultat. Kläderna kan du spara separat under Kläder.'
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
      'Spara platser – ett kök, en strand, en gata i regn – med några foton och en beskrivning. Använd dem som ' +
      'referens eller som startbild, så utspelar sig klippen på samma ställe varje gång.',
    listHint: 'Miljöer du skapar visas här. Släpp bilder på en miljö för att lägga till dem.',
    imageTips: 'Några vyer av platsen i samma ljus ger bäst resultat – gärna utan människor i bild.'
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
  }
}

/** The library view that lists each kind. */
export const ASSET_VIEW: Record<AssetKind, View> = {
  character: 'characters',
  environment: 'environments',
  outfit: 'outfits'
}

/** The library folder that holds each kind (Karaktärer, Miljöer, Kläder). */
export const ASSET_FOLDER: Record<AssetKind, LibraryFolderTarget> = {
  character: 'characters',
  environment: 'environments',
  outfit: 'outfits'
}

export function assetKindOfView(view: View): AssetKind | undefined {
  return ASSET_KINDS.find((kind) => ASSET_VIEW[kind] === view)
}

/** "Anna", "Anna och Kalle", "Anna, Kalle och Bo". */
export function swedishList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} och ${items[items.length - 1]}`
}
