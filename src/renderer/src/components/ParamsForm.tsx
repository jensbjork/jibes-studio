import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import {
  DEFAULT_MODEL,
  KINDS,
  MAX_REFERENCE_AUDIO_SECONDS,
  PREFERRED,
  audioForModel,
  kindOfModelId,
  maxReferenceAudios,
  maxReferenceImages,
  paramsForSubmit,
  pickOption,
  supportsAudioInput,
  supportsEndImage,
  type Kind
} from '@shared/models'
import { blockingContinuationError, blockingPromptError, validationContext } from '@shared/prompt-refs'
import {
  ASSET_KINDS,
  type Asset,
  type AssetKind,
  type GenerationParams,
  type ReferenceAudio,
  type SavedPrompt,
  type VideoModel
} from '@shared/types'
import { ASSET_COPY, ASSET_VIEW, swedishList } from '../lib/assets'
import { useAssets, usePrompts } from '../lib/hooks'
import type { Navigate } from '../lib/navigation'
import ImageInput, { type ImageCaption } from './ImageInput'
import AssetChips, { posePeopleOf, productHolderOf } from './pickers/AssetChips'
import AssetPicker from './pickers/AssetPicker'
import AudioChips from './pickers/AudioChips'
import AudioPicker from './pickers/AudioPicker'
import { KIND_TONE, PICKER_COPY } from './pickers/assetKinds'
import {
  addAssetToForm,
  addPaths,
  assetRefsOf,
  assetsByPath,
  outfitsWornBy,
  remapPromptReferences,
  removeAsset,
  resolvePairings,
  sameList,
  swapOutfit,
  type AssetRef,
  type RefsChange
} from './pickers/assetRefs'
import {
  addAudios,
  audioIndicesOf,
  audioSourcesByPath,
  clipsOf,
  fitsAudio,
  formAudios,
  referenceAudioOf,
  removeAudiosOf,
  sameAudios,
  totalSeconds,
  type AudiosChange,
  type FormAudio
} from './pickers/audioRefs'
import Popover from './pickers/Popover'
import PromptLibraryPicker from './pickers/PromptLibraryPicker'
import { moveItem } from './pickers/reorder'
import SavePromptDialog from './pickers/SavePromptDialog'
import { formatClipSeconds } from './pickers/text'
import DescriptionsBox from './prompt/DescriptionsBox'
import { assetIdsInForm, withAssetDescription, withDescriptionsIncluded } from './prompt/descriptions'
import NegativePromptIssues, { negativePromptIssues } from './prompt/NegativePromptIssues'
import PromptField from './prompt/PromptField'
import PromptEditor, { type PromptEditorHandle } from './prompt/PromptEditor'
import { promptReferences, type AssetGroup, type ReferenceGroup } from './prompt/promptText'
import { usePromptLanguage } from './prompt/usePromptLanguage'

interface Props {
  models: VideoModel[]
  modelsError?: string
  params: GenerationParams
  setParams: Dispatch<SetStateAction<GenerationParams>>
  /** Which mode tabs to offer; default all three. */
  kinds?: Kind[]
  /** Replaces the start image input (not the end image) with a note, e.g. when the start frame comes from the previous clip. */
  startImageNote?: string
  /** Replaces the end image input with a note, e.g. when the end frame comes from the next clip ("Slutbild från nästa klipp"). */
  endImageNote?: string
  /**
   * A sequence clip that continues from the previous clip: its mode is fixed, so the prompt checks advise
   * what can be done there (remove the references, or switch off continuing) instead of a mode switch.
   */
  continuing?: boolean
  /**
   * A sequence clip: an end image its model can't take stops the take (main refuses it rather than paying for one
   * without the keyframe), where the Generate form just leaves the picture out. The note under it says which.
   */
  endImageRequired?: boolean
  /** Called on ⌘/Ctrl+Enter in the prompt field. */
  onSubmit?: () => void
  /** Lets the pickers link to the library views (characters, environments, products, outfits, poses, prompts). */
  navigate?: Navigate
}

/**
 * The open popover: the prompt library, a start/end image picker, the reference picker on a kind's tab, or the
 * audio picker.
 */
type Picker = 'library' | 'start' | 'end' | 'audio' | `references:${AssetKind}`

/**
 * The kinds a start or end image can be picked from, in the order the picker falls back through when the image
 * isn't a library photo: environments make good opening frames, and a product's packshot can open or close a clip.
 */
const SINGLE_IMAGE_KINDS: readonly AssetKind[] = ['environment', 'character', 'product', 'outfit', 'pose']

/** "karaktärer, miljöer, produkter, kläder och poser": the kinds above in the app's order, for the button titles. */
const SINGLE_IMAGE_KINDS_TEXT = swedishList(
  ASSET_KINDS.filter((k) => SINGLE_IMAGE_KINDS.includes(k)).map((k) => ASSET_COPY[k].plural.toLocaleLowerCase('sv'))
)

const select = 'w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted'
const smallButton =
  'whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-40'

/** Why the selected model can't be used right now, or undefined if it can (or the list isn't loaded yet). */
export function unavailableModel(model: VideoModel | undefined): string | undefined {
  return model?.offline ? 'Modellen är offline – välj en annan' : undefined
}

/**
 * Why the params can't be submitted yet, or undefined if they can. Includes what is wrong with the @ImageN and
 * @AudioN references of the prompt and the negative prompt, and with the audio clips themselves (2–15 s each,
 * 15 s together): the main process refuses such params with the same words. `continuing`: a sequence clip that
 * continues from the previous clip, generated image-to-video from that clip's last frame (so it needs no start
 * image of its own) and without reference images or audio.
 */
export function missingInput(params: GenerationParams, continuing = false): string | undefined {
  const kind = kindOfModelId(params.model)
  if (!params.prompt.trim()) return 'Skriv en prompt'
  if (continuing) return blockingContinuationError(params)?.replace(/\.\s*$/, '')
  if (kind === 'image-to-video' && !params.startImage) return 'Lägg till en startbild'
  if (kind === 'reference-to-video' && !params.referenceImages?.length) {
    // Venice refuses reference audio on its own, which is worth saying when a voice is all there is.
    return paramsForSubmit(params).referenceAudios?.length
      ? 'Lägg till minst en referensbild – ljud skickas bara tillsammans med en bild'
      : 'Lägg till minst en referensbild'
  }
  return blockingPromptError(params)?.replace(/\.\s*$/, '')
}

/** The form-only choices that shape how assets are named in the prompt ("gäller", "hålls av"). */
interface NamingChoices {
  posePeople: Readonly<Record<string, string[] | undefined>>
  productHolders: Readonly<Record<string, string | null | undefined>>
}

/**
 * What a library asset among the references is called in the prompt: with a character's voice and the clothes
 * it wears, an environment's sound, for a pose the characters that take it, for a product the character holding
 * it.
 */
function referenceGroupOf(
  entry: AssetRef,
  assetRefs: AssetRef[],
  pairings: ReadonlyMap<string, string>,
  sentAudios: readonly FormAudio[],
  { posePeople, productHolders }: NamingChoices
): AssetGroup {
  const { asset, indices } = entry
  const outfits =
    asset.kind === 'character'
      ? outfitsWornBy(asset.id, assetRefs, pairings).map((w) => ({ name: w.asset.name, indices: w.indices }))
      : undefined
  const audios = audioIndicesOf(sentAudios, asset.id)
  const characters = assetRefs.filter((r) => r.asset.kind === 'character')
  const people =
    asset.kind === 'pose'
      ? posePeopleOf(asset.id, characters, posePeople).map((p) => ({ name: p.asset.name, indices: p.indices }))
      : undefined
  const holder = asset.kind === 'product' ? productHolderOf(asset.id, characters, productHolders) : undefined
  return {
    asset,
    name: asset.name,
    indices,
    kind: asset.kind,
    ...(audios.length ? { audios } : {}),
    ...(outfits ? { outfits } : {}),
    ...(people ? { people } : {}),
    ...(holder ? { holder: { name: holder.asset.name, indices: holder.indices } } : {})
  }
}

/**
 * A reference model that takes audio, to offer when the current one doesn't: the app's default reference model,
 * else the first one (by name) that does.
 */
function audioModelOf(models: readonly VideoModel[]): VideoModel | undefined {
  const usable = models.filter((m) => !m.offline && supportsAudioInput(m))
  return (
    usable.find((m) => m.id === DEFAULT_MODEL['reference-to-video']) ??
    [...usable].sort((a, b) => a.name.localeCompare(b.name))[0]
  )
}

/** The model to use for a mode: the same family if it exists there, then the app default, then any online one. */
export function modelForKind(models: VideoModel[], currentModel: string, kind: Kind): string | undefined {
  const list = models.filter((m) => m.kind === kind && !m.offline)
  const sibling = currentModel.replace(/(text|image|reference)-to-video/, kind)
  const preferred = [sibling, DEFAULT_MODEL[kind]].find((c) => list.some((m) => m.id === c))
  return preferred ?? [...list].sort((a, b) => a.name.localeCompare(b.name))[0]?.id
}

/** Model, image inputs, prompt and output settings. Shared by the generate view and the segment editor. */
export default function ParamsForm({
  models,
  modelsError,
  params,
  setParams,
  kinds = KINDS.map((k) => k.id),
  startImageNote,
  endImageNote,
  continuing = false,
  endImageRequired = false,
  onSubmit,
  navigate
}: Props) {
  const model = models.find((m) => m.id === params.model)
  const kind = kindOfModelId(params.model)
  const tabs = KINDS.filter((k) => kinds.includes(k.id))
  const assets = useAssets()
  const prompts = usePrompts()

  const [picker, setPicker] = useState<Picker | null>(null)
  const closePicker = useCallback(() => setPicker(null), [])
  const togglePicker = (p: Picker) => setPicker((cur) => (cur === p ? null : p))
  const startButton = useRef<HTMLButtonElement>(null)
  const endButton = useRef<HTMLButtonElement>(null)
  const libraryButton = useRef<HTMLButtonElement>(null)
  const characterButton = useRef<HTMLButtonElement>(null)
  const environmentButton = useRef<HTMLButtonElement>(null)
  const productButton = useRef<HTMLButtonElement>(null)
  const outfitButton = useRef<HTMLButtonElement>(null)
  const poseButton = useRef<HTMLButtonElement>(null)
  const audioButton = useRef<HTMLButtonElement>(null)
  const kindButtons: Record<AssetKind, RefObject<HTMLButtonElement | null>> = {
    character: characterButton,
    environment: environmentButton,
    product: productButton,
    outfit: outfitButton,
    pose: poseButton
  }
  const referenceKind = picker?.startsWith('references:')
    ? (picker.slice('references:'.length) as AssetKind)
    : undefined

  const modelsByKind = useMemo(
    () =>
      Object.fromEntries(
        KINDS.map((k) => [
          k.id,
          models.filter((m) => m.kind === k.id && !m.offline).sort((a, b) => a.name.localeCompare(b.name))
        ])
      ) as Record<Kind, VideoModel[]>,
    [models]
  )

  const listed = (modelsByKind[kind] ?? []).some((m) => m.id === params.model)

  // When the model changes, snap duration/resolution/aspect ratio to values it supports.
  useEffect(() => {
    if (!model) return
    setParams((p) => ({
      ...p,
      duration: pickOption(model.durations, p.duration, PREFERRED.durations) ?? p.duration,
      resolution: pickOption(model.resolutions, p.resolution, PREFERRED.resolutions),
      aspectRatio: pickOption(model.aspectRatios, p.aspectRatio, PREFERRED.aspectRatios),
      audio: audioForModel(model, p.audio)
    }))
  }, [model?.id])

  // If the current mode isn't allowed here (e.g. a continuation segment), switch to the first allowed one.
  useEffect(() => {
    if (models.length && !kinds.includes(kind)) switchKind(kinds[0])
  }, [models.length, kind, kinds.join()])

  const set = <K extends keyof GenerationParams>(key: K, value: GenerationParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }))

  function switchKind(k: Kind) {
    if (k === kind) return
    const id = modelForKind(models, params.model, k)
    if (id) set('model', id)
  }

  // Which image-to-video models take an end image is a curated list shared with main and the agents.
  const endImagePossible = supportsEndImage(params.model)

  // ── Library assets (characters, environments, products, outfits, poses) ──────

  const byPath = useMemo(() => assetsByPath(assets), [assets])
  const outfits = useMemo(() => assets.filter((a) => a.kind === 'outfit'), [assets])

  const caption = (path: string): ImageCaption | undefined => {
    const a = byPath.get(path)
    if (!a) return undefined
    const title = `${a.name} (${ASSET_COPY[a.kind].singular})`
    return { text: a.name, title, className: KIND_TONE[a.kind].caption }
  }

  const refs = params.referenceImages ?? []
  const maxRefs = maxReferenceImages(params.model)
  const [refNote, setRefNote] = useState<string>()

  useEffect(() => {
    if (!refNote) return
    const t = setTimeout(() => setRefNote(undefined), 6000)
    return () => clearTimeout(t)
  }, [refNote])

  // Which @ImageN tokens belong to which asset, and who wears which outfit. "bärs av" choices are form
  // state only: they shape the text a character chip inserts, nothing is stored.
  const assetRefs = assetRefsOf(refs, byPath, maxRefs)
  const [wornBy, setWornBy] = useState<Record<string, string | null>>({})
  const pairings = resolvePairings(assetRefs, wornBy)

  // Forget the choice for an outfit that left the form, so adding it again starts from its default wearer.
  const outfitsInForm = [
    ...new Set(
      refs.flatMap((p) => {
        const a = byPath.get(p)
        return a?.kind === 'outfit' ? [a.id] : []
      })
    )
  ]
    .sort()
    .join()
  useEffect(() => {
    const present = new Set(outfitsInForm.split(','))
    setWornBy((chosen) => {
      const ids = Object.keys(chosen)
      const keep = ids.filter((id) => present.has(id))
      return keep.length === ids.length ? chosen : Object.fromEntries(keep.map((id) => [id, chosen[id]]))
    })
  }, [outfitsInForm])

  // ── Reference audio (voices, sounds; @AudioN) ────────────────────────────────

  const audioRefs = params.referenceAudios ?? []
  const audioSupported = kind === 'reference-to-video' && supportsAudioInput(model ?? params.model)
  const maxAudios = maxReferenceAudios(params.model)
  const audioSources = useMemo(() => audioSourcesByPath(assets), [assets])
  const audioKey = audioRefs.map((a) => `${a.path}\u0000${a.start}\u0000${a.length}`).join('\n')
  const audios = useMemo(
    () => formAudios(audioRefs, audioSources, maxAudios, audioSupported),
    [audioKey, audioSources, maxAudios, audioSupported]
  )
  const sentAudios = useMemo(() => audios.filter((a) => a.sent), [audios])
  const audioSeconds = totalSeconds(audioRefs, audioSources)
  const audioModel = useMemo(() => audioModelOf(models), [models])

  /**
   * Sets the reference images and audio. A removed or swapped picture (or clip) shifts the ones after it, so the
   * prompt's @ImageN and @AudioN tokens follow them in the same update (see remapPromptReferences); `swap` names
   * the outfits taken off and the one put on.
   */
  const setReferences = (
    next: { refs?: string[]; audios?: ReferenceAudio[] },
    swap?: { from: Asset[]; to: Asset | null }
  ) => {
    const nextRefs = next.refs ?? refs
    const nextAudios = next.audios ?? audioRefs
    if (sameList(nextRefs, refs) && sameAudios(nextAudios, audioRefs)) return
    const images = { before: refs, after: nextRefs }
    const sounds = { before: audioRefs, after: nextAudios }
    const before = params.prompt
    const prompt = remapPromptReferences(before, images, sounds, swap)
    if (prompt !== before) ownPrompt.current = prompt
    // The negative prompt may name pictures and clips too; its tokens follow them the same way (no outfit swap
    // there: that renames the outfit in the description, which belongs to the prompt).
    const negativeBefore = params.negativePrompt
    const negative = negativeBefore && remapPromptReferences(negativeBefore, images, sounds)
    setParams((p) => ({
      ...p,
      referenceImages: nextRefs,
      referenceAudios: nextAudios.length ? nextAudios : undefined,
      ...(p.prompt === before ? { prompt } : {}),
      ...(negativeBefore && p.negativePrompt === negativeBefore ? { negativePrompt: negative || undefined } : {})
    }))
  }

  const setRefs = (next: string[], swap?: { from: Asset[]; to: Asset | null }) => setReferences({ refs: next }, swap)

  const applyRefs = ({ refs: next, note }: RefsChange, swap?: { from: Asset[]; to: Asset | null }) => {
    setRefs(next, swap)
    setRefNote(note)
  }

  const applyAudios = ({ audios: next, note }: AudiosChange) => {
    setReferences({ audios: next })
    setRefNote(note)
  }

  /** Adds an asset's photos (a character's default outfit and, when the model takes audio, its voice too). */
  const addAssetRefs = (a: Asset) => {
    const change = addAssetToForm({ referenceImages: refs, referenceAudios: audioRefs }, a, assets, params.model)
    setReferences({ refs: change.referenceImages, audios: change.referenceAudios ?? [] })
    setRefNote(change.note)
  }

  /** ✕ on a chip: the asset's photos go, and its voice or sound with them. */
  const removeAssetRefs = (a: Asset) => {
    setReferences({ refs: removeAsset(refs, a), audios: removeAudiosOf(audioRefs, a) })
    setRefNote(undefined)
  }

  /** "Ta med rösten" on a chip: the asset's first clip in, or all of its clips out. */
  const toggleAssetAudio = (a: Asset, include: boolean) => {
    const first = clipsOf(a)[0]
    if (!include) {
      setReferences({ audios: removeAudiosOf(audioRefs, a) })
      setRefNote(undefined)
    } else if (first) applyAudios(addAudios(audioRefs, [referenceAudioOf(first)], audioSources, maxAudios))
  }

  const assetAudioFits = (a: Asset) => {
    const first = clipsOf(a)[0]
    return first ? fitsAudio(audioRefs, referenceAudioOf(first), audioSources, maxAudios) : { fits: false }
  }

  /** Takes clips (1-based @AudioN numbers) out of the form; their tokens follow. */
  const removeAudios = (indices: readonly number[]) => {
    setReferences({ audios: audioRefs.filter((_, i) => !indices.includes(i + 1)) })
    setRefNote(undefined)
  }

  /**
   * A clip dragged to another place (or moved with ⌥← / ⌥→; 0-based positions): the @AudioN tokens of both
   * prompts follow their clips in the same update, as the pictures' do when the image strip is reordered.
   */
  const moveAudio = (from: number, to: number) => {
    setReferences({ audios: moveItem(audioRefs, from, to) })
    setRefNote(undefined)
  }

  // Which characters each pose applies to ("gäller"): form state only, like "bärs av"; it shapes the text a
  // pose chip inserts. undefined: every character in the form, also ones added later.
  const [posePeople, setPosePeople] = useState<Record<string, string[] | undefined>>({})
  const posesInForm = [
    ...new Set(
      refs.flatMap((p) => {
        const a = byPath.get(p)
        return a?.kind === 'pose' ? [a.id] : []
      })
    )
  ]
    .sort()
    .join()
  useEffect(() => {
    const present = new Set(posesInForm.split(','))
    setPosePeople((chosen) => {
      const ids = Object.keys(chosen)
      const keep = ids.filter((id) => present.has(id))
      return keep.length === ids.length ? chosen : Object.fromEntries(keep.map((id) => [id, chosen[id]]))
    })
  }, [posesInForm])

  // Which character holds each product ("hålls av"): form state only, like "bärs av" and "gäller"; it shapes the
  // text a product chip inserts. Missing or null: nobody holds it (the default).
  const [productHolders, setProductHolders] = useState<Record<string, string | null>>({})
  const productsInForm = [
    ...new Set(
      refs.flatMap((p) => {
        const a = byPath.get(p)
        return a?.kind === 'product' ? [a.id] : []
      })
    )
  ]
    .sort()
    .join()
  // Forget the choice for a product that left the form, so adding it again starts with nobody holding it.
  useEffect(() => {
    const present = new Set(productsInForm.split(','))
    setProductHolders((chosen) => {
      const ids = Object.keys(chosen)
      const keep = ids.filter((id) => present.has(id))
      return keep.length === ids.length ? chosen : Object.fromEntries(keep.map((id) => [id, chosen[id]]))
    })
  }, [productsInForm])
  const naming: NamingChoices = { posePeople, productHolders }

  const swapOutfitOf = (character: Asset, outfit: Asset | null) => {
    const wearing = outfitsWornBy(character.id, assetRefs, pairings).map((r) => r.asset)
    applyRefs(swapOutfit(refs, wearing, outfit, maxRefs), {
      from: wearing.filter((o) => o.id !== outfit?.id),
      to: outfit
    })
    if (outfit) setWornBy((chosen) => ({ ...chosen, [outfit.id]: character.id }))
  }

  // ── References as the prompt sees them (@ImageN) ────────────────────────────

  const language = usePromptLanguage()
  const references = useMemo(
    () => (kind === 'reference-to-video' ? promptReferences(refs, byPath, maxRefs) : []),
    [kind, refs.join('\n'), byPath, maxRefs]
  )
  const groups = assetRefs.map((entry) => referenceGroupOf(entry, assetRefs, pairings, sentAudios, naming))

  /**
   * "@" menu → "Lägg till från biblioteket": adds the photos (and a character's voice) and tells the editor how
   * to name the asset with its new @ImageN (and @AudioN) numbers.
   */
  const addFromLibrary = (asset: Asset): ReferenceGroup | undefined => {
    const change = addAssetToForm({ referenceImages: refs, referenceAudios: audioRefs }, asset, assets, params.model)
    setReferences({ refs: change.referenceImages, audios: change.referenceAudios ?? [] })
    setRefNote(change.note)
    const after = assetRefsOf(change.referenceImages, byPath, maxRefs)
    const entry = after.find((r) => r.asset.id === asset.id)
    const audiosAfter = formAudios(change.referenceAudios ?? [], audioSources, maxAudios, audioSupported).filter(
      (a) => a.sent
    )
    return entry && referenceGroupOf(entry, after, resolvePairings(after, wornBy), audiosAfter, naming)
  }

  const manageKind = navigate
    ? (k: AssetKind) => {
        closePicker()
        navigate(ASSET_VIEW[k])
      }
    : undefined

  /** Opens one asset in its library view, e.g. to edit the description the prompt gets ("Ändra beskrivning"). */
  const openAsset = navigate
    ? (a: Asset) => {
        closePicker()
        navigate(ASSET_VIEW[a.kind], { type: 'open-asset', assetId: a.id })
      }
    : undefined

  // ── Descriptions appended to the prompt ("Läggs till i prompten") ─────────────
  // Both flags are params, so they travel with the form, a sequence clip's saved params and "Använd igen", and
  // main composes the legend from them at submit. Built on the latest params, like every other setter here.

  const includeDescriptions = (on: boolean) => setParams((p) => withDescriptionsIncluded(p, on))
  const toggleDescription = (assetId: string, on: boolean) =>
    setParams((p) => withAssetDescription(p, assetId, on, assetIdsInForm(p, assets)))

  /** The tab a single-image picker opens on: the current image's kind, else the first kind with photos. */
  const singleImageKind = (path: string | undefined): AssetKind =>
    (path ? byPath.get(path)?.kind : undefined) ??
    SINGLE_IMAGE_KINDS.find((k) => assets.some((a) => a.kind === k && a.images.length)) ??
    'environment'

  const libraryImageButton = (ref: RefObject<HTMLButtonElement | null>, target: 'start' | 'end', title: string) => (
    <button
      ref={ref}
      onClick={() => togglePicker(target)}
      className={`${smallButton} ${picker === target ? 'bg-raised text-text' : ''}`}
      title={title}
    >
      Från biblioteket
    </button>
  )

  const singleImagePicker = (target: 'start' | 'end', value: string | undefined) => (
    <Popover
      anchorRef={target === 'start' ? startButton : endButton}
      open={picker === target}
      onClose={closePicker}
      align="end"
      width={340}
      maxHeight={480}
      label={target === 'start' ? 'Välj startbild' : 'Välj slutbild'}
    >
      <AssetPicker
        assets={assets}
        initialKind={singleImageKind(value)}
        title={target === 'start' ? 'Startbild från biblioteket' : 'Slutbild från biblioteket'}
        hint="Klicka på en bild – eller på namnet för omslagsbilden."
        selectedPaths={value ? [value] : []}
        onPickImage={(path) => {
          set(target === 'start' ? 'startImage' : 'endImage', path)
          closePicker()
        }}
        onManage={manageKind}
      />
    </Popover>
  )

  // ── Prompt ─────────────────────────────────────────────────────────────────

  const promptId = useId()
  const editor = useRef<PromptEditorHandle>(null)
  // The prompt text this form last wrote itself; anything else came from outside (another segment, "Använd igen").
  const ownPrompt = useRef<string | null>(null)
  /** Sets the prompt; negativePrompt null leaves it as is, undefined clears it. */
  const setPrompt = (prompt: string, negativePrompt: string | null | undefined) => {
    ownPrompt.current = prompt
    setParams((p) => ({ ...p, prompt, ...(negativePrompt !== null ? { negativePrompt } : {}) }))
  }

  /** Inserts at the caret in the prompt, as one step ⌘Z can undo (chip clicks). */
  const insertIntoPrompt = (text: string) => editor.current?.insert(text)

  // The library prompt the current text came from, so "Spara" can offer to update it. Set on an exact
  // match and kept while the text is edited here; text replaced from outside keeps it only if it matches.
  const [linkedPromptId, setLinkedPromptId] = useState<string>()
  useEffect(() => {
    const body = params.prompt.trim()
    const matches = (p: SavedPrompt) => !!body && p.body.trim() === body
    setLinkedPromptId((current) => {
      if (prompts.some((p) => p.id === current && matches(p))) return current
      const exact = prompts.find(matches)
      if (exact || !body || params.prompt !== ownPrompt.current) return exact?.id
      return current
    })
  }, [params.prompt, prompts])
  const linkedPrompt = prompts.find((p) => p.id === linkedPromptId)
  const linkedUnchanged = !!linkedPrompt && linkedPrompt.body.trim() === params.prompt.trim()

  // Picking from the library overwrites the text, so keep what was there for one undo.
  const [replaced, setReplaced] = useState<{ prompt: string; negativePrompt?: string; by: string }>()
  const canUndo = !!replaced && replaced.by === params.prompt

  const applyPrompt = (p: SavedPrompt) => {
    closePicker()
    const previous = params.prompt
    setReplaced(
      previous.trim() && previous.trim() !== p.body.trim()
        ? { prompt: previous, negativePrompt: params.negativePrompt, by: p.body }
        : undefined
    )
    setPrompt(p.body, p.negativePrompt || undefined)
    setLinkedPromptId(p.id)
    void window.studio.markPromptUsed(p.id).catch(() => {})
    requestAnimationFrame(() => editor.current?.focus())
  }

  const undoReplace = () => {
    if (!replaced) return
    setPrompt(replaced.prompt, replaced.negativePrompt)
    setReplaced(undefined)
  }

  const [saveOpen, setSaveOpen] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  useEffect(() => {
    if (!savedFlash) return
    const t = setTimeout(() => setSavedFlash(false), 2000)
    return () => clearTimeout(t)
  }, [savedFlash])

  const managePrompts = navigate
    ? () => {
        closePicker()
        navigate('prompts')
      }
    : undefined

  // Open the negative prompt section whenever it gets content (e.g. from the library).
  const [negativeOpen, setNegativeOpen] = useState(!!params.negativePrompt)
  useEffect(() => {
    if (params.negativePrompt) setNegativeOpen(true)
  }, [!!params.negativePrompt])
  const negativeRef = useRef<HTMLTextAreaElement>(null)
  const negativeIssuesId = useId()
  // What both prompts are checked against: exactly what the main process checks before sending.
  const checks = validationContext(params, { continuing })
  // @ImageN and @AudioN mistakes in the negative prompt block generating as well.
  const negativeHasError = negativePromptIssues(params.negativePrompt ?? '', checks).some((i) => i.severity === 'error')
  const switchToReference = kinds.includes('reference-to-video') ? () => switchKind('reference-to-video') : undefined
  // Offered when the reference model takes no audio but the form has (or names) some.
  const switchToAudioModel =
    kind === 'reference-to-video' && !audioSupported && audioModel && audioModel.id !== params.model
      ? () => set('model', audioModel.id)
      : undefined

  return (
    <div className="space-y-5">
      {tabs.length > 1 && (
        <div className={`grid gap-1 rounded-lg bg-raised p-1`} style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
          {tabs.map((k) => (
            <button
              key={k.id}
              onClick={() => switchKind(k.id)}
              className={`rounded-md py-1.5 transition ${kind === k.id ? 'bg-line text-text' : 'text-muted hover:text-text'}`}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}

      <label className="block">
        <span className="mb-1.5 block text-muted">Modell</span>
        {modelsError ? (
          <p className="text-accent">{modelsError}</p>
        ) : (
          <select value={params.model} onChange={(e) => set('model', e.target.value)} className={select}>
            {/* Without an option for it, the select would show the first model while quote and submit use this one. */}
            {!listed && (
              <option value={params.model}>
                {model ? `${model.name}${model.offline ? ' (offline)' : ''}` : params.model}
              </option>
            )}
            {(modelsByKind[kind] ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.privacy === 'private' ? ' (privat)' : ''}
              </option>
            ))}
          </select>
        )}
      </label>

      {kind === 'image-to-video' && (
        <>
          {startImageNote ? (
            <div>
              <span className="mb-1.5 block text-muted">Startbild</span>
              <p className="rounded-md border border-dashed border-line px-3 py-2.5 text-muted">{startImageNote}</p>
            </div>
          ) : (
            <>
              <ImageInput
                label="Startbild"
                value={params.startImage ? [params.startImage] : []}
                onChange={(v) => set('startImage', v[0])}
                caption={caption}
                action={libraryImageButton(startButton, 'start', `Välj startbild bland ${SINGLE_IMAGE_KINDS_TEXT}`)}
              />
              {singleImagePicker('start', params.startImage)}
            </>
          )}
          {/* Also shown when a note replaces the start image: the end image is still sent, so it must stay
              visible and removable. */}
          {endImageNote ? (
            <div>
              <span className="mb-1.5 block text-muted">Slutbild</span>
              <p className="rounded-md border border-dashed border-line px-3 py-2.5 text-muted">{endImageNote}</p>
            </div>
          ) : (
            // An end image picked for another model stays visible (so it can be removed) but isn't sent.
            (endImagePossible || params.endImage) && (
              <>
                <ImageInput
                  label="Slutbild (valfri)"
                  value={params.endImage ? [params.endImage] : []}
                  onChange={(v) => set('endImage', v[0])}
                  caption={caption}
                  action={libraryImageButton(endButton, 'end', `Välj slutbild bland ${SINGLE_IMAGE_KINDS_TEXT}`)}
                />
                {!endImagePossible && (
                  <p className="-mt-2 text-[11px] leading-relaxed text-accent">
                    {endImageRequired
                      ? 'Den här modellen tar ingen slutbild, så klippet kan inte genereras med den. Ta bort bilden eller välj en modell som klarar både start- och slutbild.'
                      : 'Den här modellen tar ingen slutbild, så bilden skickas inte. Ta bort den eller välj en modell som klarar både start- och slutbild.'}
                  </p>
                )}
                {singleImagePicker('end', params.endImage)}
              </>
            )
          )}
        </>
      )}

      {kind === 'reference-to-video' && (
        <div>
          <ImageInput
            label="Referensbilder"
            multiple
            max={maxRefs}
            showCount={false}
            value={refs}
            onChange={(v) => setRefs(v)}
            caption={caption}
            action={
              // Five kinds don't fit beside the label in the form's width: the buttons wrap onto a second row,
              // right-aligned, rather than squeezing the label.
              <span className="flex flex-wrap items-center justify-end gap-y-0.5">
                {ASSET_KINDS.map((k) => (
                  <button
                    key={k}
                    ref={kindButtons[k]}
                    onClick={() => togglePicker(`references:${k}`)}
                    className={`${smallButton} ${referenceKind === k ? 'bg-raised text-text' : ''}`}
                    title={PICKER_COPY[k].addTitle}
                  >
                    ＋ {PICKER_COPY[k].add}
                  </button>
                ))}
              </span>
            }
          />
          {/* Keyed by kind: the panel re-anchors (and the picker starts on that tab) when another button opens it. */}
          <Popover
            key={referenceKind}
            anchorRef={kindButtons[referenceKind ?? 'character']}
            open={!!referenceKind}
            onClose={closePicker}
            align="end"
            width={380}
            maxHeight={480}
            label="Lägg till från biblioteket"
          >
            <AssetPicker
              assets={assets}
              initialKind={referenceKind ?? 'character'}
              title="Lägg till som referens"
              hint={
                refs.length >= maxRefs
                  ? `Alla ${maxRefs} platser är upptagna – ta bort en bild först.`
                  : 'Klicka på namnet för alla bilder eller på en enskild bild. ' +
                    `${maxRefs - refs.length} av ${maxRefs} platser lediga.`
              }
              selectedPaths={refs}
              freeSlots={Math.max(0, maxRefs - refs.length)}
              withVoice={audioSupported}
              onPickAsset={(a) => {
                addAssetRefs(a)
                closePicker()
              }}
              onPickImage={(path) => {
                applyRefs(addPaths(refs, [path], maxRefs))
                closePicker()
              }}
              onManage={manageKind}
            />
          </Popover>

          <AssetChips
            assetRefs={assetRefs}
            pairings={pairings}
            outfits={outfits}
            refs={refs}
            max={maxRefs}
            language={language}
            audios={audios}
            audioSupported={audioSupported}
            audioFits={assetAudioFits}
            onToggleAudio={toggleAssetAudio}
            posePeople={posePeople}
            onPosePeople={(poseId, ids) => setPosePeople((chosen) => ({ ...chosen, [poseId]: ids }))}
            productHolders={productHolders}
            onHolder={(productId, characterId) =>
              setProductHolders((chosen) => ({ ...chosen, [productId]: characterId }))
            }
            onInsert={insertIntoPrompt}
            onRemove={removeAssetRefs}
            onWear={(outfitId, characterId) => setWornBy((chosen) => ({ ...chosen, [outfitId]: characterId }))}
            onSwapOutfit={swapOutfitOf}
            onManageOutfits={manageKind && (() => manageKind('outfit'))}
          />
          {refNote && <p className="mt-1 text-[11px] text-accent">{refNote}</p>}
        </div>
      )}

      {kind === 'reference-to-video' && (audioSupported || audios.length > 0) && (
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-muted">Röster och ljud</span>
            {audioSupported && (
              <button
                ref={audioButton}
                onClick={() => togglePicker('audio')}
                className={`${smallButton} ${picker === 'audio' ? 'bg-raised text-text' : ''}`}
                title="Skicka med en röst eller en ljudmiljö från biblioteket"
              >
                ＋ Ljud
              </button>
            )}
          </div>
          <Popover
            anchorRef={audioButton}
            open={picker === 'audio'}
            onClose={closePicker}
            align="end"
            width={360}
            maxHeight={480}
            label="Lägg till ljud"
          >
            <AudioPicker
              assets={assets}
              audios={audioRefs}
              byPath={audioSources}
              max={maxAudios}
              onPick={(clip) => {
                applyAudios(addAudios(audioRefs, [referenceAudioOf(clip)], audioSources, maxAudios))
                closePicker()
              }}
              onManage={manageKind}
            />
          </Popover>
          {audios.length > 0 ? (
            <>
              <AudioChips
                audios={audios}
                language={language}
                onInsert={insertIntoPrompt}
                onRemove={(index) => removeAudios([index])}
                onMove={moveAudio}
              />
              <div className="mt-1.5 flex items-start gap-3 text-[11px] text-muted">
                <span className="min-w-0 flex-1">
                  Klicka på ett ljud för att infoga det i prompten – ▶ spelar utdraget som skickas.
                </span>
                <span
                  className={`shrink-0 tabular-nums ${
                    audioSeconds > MAX_REFERENCE_AUDIO_SECONDS || audios.length > maxAudios ? 'text-accent' : ''
                  }`}
                  title={
                    `${audios.length} av max ${maxAudios} ljudklipp, ${formatClipSeconds(audioSeconds)} av max ` +
                    `${MAX_REFERENCE_AUDIO_SECONDS} s tillsammans. Venice tar 2–15 s per klipp.`
                  }
                >
                  Ljud {formatClipSeconds(audioSeconds).replace(/ s$/, '')}/{MAX_REFERENCE_AUDIO_SECONDS} s
                </span>
              </div>
            </>
          ) : (
            <p className="rounded-md border border-dashed border-line px-3 py-2 text-[11px] text-muted">
              Skicka med hur någon låter: en karaktär med röst tar med den när du lägger till karaktären, eller välj
              under ＋ Ljud. Hänvisa till ljudet med @Audio1 … i prompten.
            </p>
          )}
          {!audioSupported && audios.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-accent">
              <span>{model?.name ?? 'Modellen'} tar inte emot ljud – ljudklippen skickas inte.</span>
              {switchToAudioModel && audioModel && (
                <button onClick={switchToAudioModel} className="text-text hover:underline">
                  Byt till {audioModel.name}
                </button>
              )}
              <button onClick={() => removeAudios(audios.map((a) => a.index))} className="text-text hover:underline">
                Ta bort ljudet
              </button>
            </div>
          )}
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-center gap-1">
          <label htmlFor={promptId} className="mr-auto text-muted">
            Prompt
          </label>
          {model?.promptCharacterLimit && (
            <span
              className={`mr-1 text-[11px] ${
                params.prompt.length > model.promptCharacterLimit ? 'text-accent' : 'text-muted'
              }`}
              // The text written here; descriptions appended when it is sent are counted under it.
              title={`Din prompt: ${params.prompt.length} av högst ${model.promptCharacterLimit} tecken`}
            >
              {params.prompt.length}/{model.promptCharacterLimit}
            </span>
          )}
          <button
            ref={libraryButton}
            onClick={() => togglePicker('library')}
            className={`${smallButton} ${picker === 'library' ? 'bg-raised text-text' : ''}`}
            title="Hämta en sparad prompt"
          >
            Bibliotek
          </button>
          <button
            onClick={() => setSaveOpen(true)}
            disabled={!params.prompt.trim()}
            className={`${smallButton} ${savedFlash ? 'text-emerald-400 hover:text-emerald-400' : ''}`}
            title={linkedUnchanged ? 'Ändra titel och taggar för den sparade prompten' : 'Spara prompten i biblioteket'}
          >
            {savedFlash ? '✓ Sparad' : 'Spara'}
          </button>
        </div>
        <Popover
          anchorRef={libraryButton}
          open={picker === 'library'}
          onClose={closePicker}
          align="end"
          width={360}
          maxHeight={480}
          label="Promptbibliotek"
        >
          <PromptLibraryPicker prompts={prompts} onPick={applyPrompt} onManage={managePrompts} />
        </Popover>
        <PromptEditor
          ref={editor}
          id={promptId}
          value={params.prompt}
          onChange={(prompt) => setPrompt(prompt, null)}
          onSubmit={onSubmit}
          rows={7}
          placeholder={
            kind === 'reference-to-video'
              ? audioSupported
                ? 'Beskriv scenen, rörelsen och kameran… Skriv @ för att hänvisa till en referensbild eller ett ljud.'
                : 'Beskriv scenen, rörelsen och kameran… Skriv @ för att hänvisa till en referensbild.'
              : 'Beskriv scenen, rörelsen och kameran…'
          }
          kind={kind}
          checks={checks}
          references={references}
          audios={kind === 'reference-to-video' ? audios : []}
          maxImages={maxRefs}
          groups={groups}
          library={assets}
          onAddFromLibrary={kind === 'reference-to-video' ? addFromLibrary : undefined}
          onSwitchToReference={switchToReference}
          onAddReferences={kind === 'reference-to-video' ? () => setPicker('references:character') : undefined}
          onRemoveAudio={audioRefs.length ? removeAudios : undefined}
          onUseAudioModel={switchToAudioModel}
          audioModelName={audioModel?.name}
          language={language}
          belowInput={
            (linkedPrompt || canUndo) && (
              <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                {linkedPrompt && (
                  <span className="min-w-0 truncate" title={linkedPrompt.title}>
                    {linkedPrompt.favorite ? '★ ' : ''}Från biblioteket: ”{linkedPrompt.title}”
                    {linkedUnchanged ? '' : ' · ändrad'}
                  </span>
                )}
                {canUndo && (
                  <button onClick={undoReplace} className="ml-auto shrink-0 text-text hover:underline">
                    Ångra
                  </button>
                )}
              </div>
            )
          }
        />
        <DescriptionsBox
          params={params}
          assets={assets}
          language={language}
          limit={model?.promptCharacterLimit}
          onInclude={includeDescriptions}
          onToggle={toggleDescription}
          onOpenAsset={openAsset}
        />
      </div>

      <details open={negativeOpen} onToggle={(e) => setNegativeOpen(e.currentTarget.open)} className="group">
        <summary className="cursor-pointer text-muted hover:text-text">
          Negativ prompt
          {!negativeOpen && negativeHasError && <span className="ml-1.5 text-[11px] text-accent">(har fel)</span>}
          {!negativeOpen && !negativeHasError && params.negativePrompt && (
            <span className="ml-1.5 text-[11px]">(ifylld)</span>
          )}
        </summary>
        <div className="mt-2">
          <PromptField
            textareaRef={negativeRef}
            value={params.negativePrompt ?? ''}
            onChange={(v) => set('negativePrompt', v || undefined)}
            context="negative"
            minRows={2}
            maxRows={8}
            title="Undvik"
            focusHint="Det modellen ska undvika, gärna på engelska och kommaseparerat. Skriv / för vanliga saker att undvika."
            placeholder="Det du inte vill se… (skriv / för förslag)"
            ariaLabel="Negativ prompt"
            ariaDescribedBy={negativeHasError ? negativeIssuesId : undefined}
            invalid={negativeHasError}
          />
        </div>
        <NegativePromptIssues
          id={negativeIssuesId}
          value={params.negativePrompt ?? ''}
          onChange={(v) => set('negativePrompt', v || undefined)}
          textareaRef={negativeRef}
          kind={kind}
          checks={checks}
          onSwitchToReference={switchToReference}
          onUseAudioModel={switchToAudioModel}
          audioModelName={audioModel?.name}
        />
      </details>

      <div className="grid grid-cols-3 gap-2">
        <label>
          <span className="mb-1.5 block text-muted">Längd</span>
          <select value={params.duration} onChange={(e) => set('duration', e.target.value)} className={select}>
            {(model?.durations ?? [params.duration]).map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        {!!model?.resolutions.length && (
          <label>
            <span className="mb-1.5 block text-muted">Upplösning</span>
            <select value={params.resolution} onChange={(e) => set('resolution', e.target.value)} className={select}>
              {model.resolutions.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        )}
        {!!model?.aspectRatios.length && (
          <label>
            <span className="mb-1.5 block text-muted">Format</span>
            <select value={params.aspectRatio} onChange={(e) => set('aspectRatio', e.target.value)} className={select}>
              {model.aspectRatios.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {model?.audio && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={params.audio ?? true}
            disabled={!model.audioConfigurable}
            onChange={(e) => set('audio', e.target.checked)}
            className="accent-accent"
          />
          <span>Generera ljud</span>
        </label>
      )}

      {saveOpen && (
        <SavePromptDialog
          body={params.prompt}
          negativePrompt={params.negativePrompt}
          existing={linkedPrompt}
          library={prompts}
          onClose={() => setSaveOpen(false)}
          onSaved={(p) => {
            setSaveOpen(false)
            setLinkedPromptId(p.id)
            setSavedFlash(true)
          }}
        />
      )}
    </div>
  )
}
