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
import { directorDefaults, effectiveDirectorId, resolveDirector, withDirection } from '@shared/direction'
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
  referenceVideoLimits,
  referenceVideoModelFor,
  referenceVideosOf,
  supportsAudioInput,
  supportsEndImage,
  supportsReferenceVideos,
  videosAreReferences,
  type Kind
} from '@shared/models'
import { outfitWearersAmong, withOutfitWearer } from '@shared/outfits'
import { blockingContinuationError, blockingPromptError, validationContext } from '@shared/prompt-refs'
import { swapReferenceAsset, swapReferenceImage, type SwapResult } from '@shared/reference-swap'
import {
  ASSET_KINDS,
  type Asset,
  type AssetKind,
  type GenerationParams,
  type ReferenceAudio,
  type ReferenceKind,
  type ReferenceVideo,
  type SavedPrompt,
  type VideoModel
} from '@shared/types'
import { ASSET_COPY, ASSET_VIEW, englishList, isReferenceKind } from '../lib/assets'
import { useAssets, usePrompts } from '../lib/hooks'
import type { Navigate } from '../lib/navigation'
import ImageInput, { type ImageCaption, type SwapChoice } from './ImageInput'
import AssetChips, { posePeopleOf, productHolderOf } from './pickers/AssetChips'
import AssetPicker from './pickers/AssetPicker'
import AudioChips from './pickers/AudioChips'
import AudioPicker from './pickers/AudioPicker'
import { KIND_TONE } from './pickers/assetKinds'
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
import ReferenceVideos, { isVideoFile, videoFilesAsCandidates } from './pickers/ReferenceVideos'
import { moveItem } from './pickers/reorder'
import SavePromptDialog from './pickers/SavePromptDialog'
import { formatClipSeconds } from './pickers/text'
import { useVideoFacts, videoFactsNow } from './pickers/videoFacts'
import {
  addVideos,
  formVideos,
  sameVideos,
  videoFits,
  videosKey,
  withVideoWindow,
  type VideoCandidate
} from './pickers/videoRefs'
import type { ClipWindow } from './assets/audioUtils'
import DirectorField from './directors/DirectorField'
import { StyleFramesFromDirector, StyleVideosFromDirector } from './directors/FromDirector'
import DescriptionsBox from './prompt/DescriptionsBox'
import { assetIdsInForm, descriptionsView, withAssetDescription, withDescriptionsIncluded } from './prompt/descriptions'
import NegativePromptIssues, { negativePromptIssues } from './prompt/NegativePromptIssues'
import PromptField from './prompt/PromptField'
import PromptEditor, { type PromptEditorHandle } from './prompt/PromptEditor'
import { promptReferences, type AssetGroup, type ReferenceGroup } from './prompt/promptText'
import { usePromptLanguage } from './prompt/usePromptLanguage'
import Disclosure from './ui/Disclosure'
import Segmented from './ui/Segmented'

interface Props {
  models: VideoModel[]
  modelsError?: string
  params: GenerationParams
  setParams: Dispatch<SetStateAction<GenerationParams>>
  /** Which mode tabs to offer; default all three. */
  kinds?: Kind[]
  /** Replaces the start image input (not the end image) with a note, e.g. when the start frame comes from the previous clip. */
  startImageNote?: string
  /** Replaces the end image input with a note, e.g. when the end frame comes from the next clip ("End on the next clip's first frame"). */
  endImageNote?: string
  /**
   * A sequence clip that continues from the previous clip: its mode is fixed, so the prompt checks advise
   * what can be done there (remove the references, or switch off continuing) instead of a mode switch.
   */
  continuing?: boolean
  /**
   * A sequence clip that continues from the previous clip in reference mode: the previous clip's last frame is sent as
   * one more reference image after the ones shown, and the instruction in front of the prompt names it. Its text is
   * shown under the references. The frame takes the model's last place (one picture fewer fits), the clip needs no
   * picture of its own, and the prompt checks count the frame (see ValidateOptions.continuationFrame).
   */
  continuationFrame?: string
  /**
   * A sequence clip: an end image its model can't take stops the take (main refuses it rather than paying for one
   * without the keyframe), where the Generate form just leaves the picture out. The note under it says which.
   */
  endImageRequired?: boolean
  /** Called on ⌘↵ (Ctrl+Enter) in a prompt field; the view puts the same on its whole form (submitKeyHandler). */
  onSubmit?: () => void
  /** The mode switch is shown elsewhere: Generate puts ModeTabs in its title band. */
  hideTabs?: boolean
  /**
   * Duration, resolution, aspect ratio and sound: at the end of the form ('inline', the default), or left to the view
   * ('none'), which shows OutputSettings right above the price they set.
   */
  outputSettings?: 'inline' | 'none'
  /** Lets the pickers link to the library views (characters, environments, products, outfits, poses, prompts). */
  navigate?: Navigate
  /** A sequence clip's sequence: the swap picker offers its saved pictures (else every saved picture). */
  sequenceId?: string
  /**
   * The duration is set for the clip (a song clip's follows its place in the song): shown, not chosen, with this as
   * its explanation.
   */
  durationFixed?: string
  /**
   * A clip of a sequence cut to a song. `sendAs`: what it sends instead of what the form holds (song-send.ts withSong –
   * its window of the song as @Audio1, the words sung there), which the References legend and the prompt checks are
   * worked out from, as main does; `audioNote`: said under Voices & sound while the song takes their place; the quick
   * fixes for its place (No song) and its singer (Who sings).
   */
  song?: {
    sendAs: (params: GenerationParams) => GenerationParams
    audioNote?: string
    onNoSong: () => void
    onChooseSinger: () => void
  }
  /**
   * A sequence clip (or a storyboard transition): what it follows unless it chooses a director of its own
   * (params.director; null for none) – "the sequence" and that sequence's director. Left out in Generate, where a
   * form has no director unless one is chosen.
   */
  followDirector?: { what: string; directorId?: string }
}

/**
 * The open popover: the prompt library, a start/end image picker, the reference picker on a kind's tab, or the
 * audio picker.
 */
type Picker = 'library' | 'start' | 'end' | 'audio' | `references:${ReferenceKind}`

/**
 * The kinds a start or end image can be picked from, in the order the picker falls back through when the image
 * isn't a library photo: environments make good opening frames, and a product's packshot can open or close a clip.
 */
const SINGLE_IMAGE_KINDS: readonly ReferenceKind[] = ['environment', 'character', 'product', 'outfit', 'pose']

/** "characters, environments, products, outfits and poses": the kinds above in the app's order, for the button titles. */
const SINGLE_IMAGE_KINDS_TEXT = englishList(
  ASSET_KINDS.filter((k) => SINGLE_IMAGE_KINDS.includes(k)).map((k) => ASSET_COPY[k].plural.toLowerCase())
)

/** Every kind ＋ From library offers (a tab each in the picker), for its title. */
const REFERENCE_KINDS_TEXT = englishList(ASSET_KINDS.map((k) => ASSET_COPY[k].plural.toLowerCase()))

const select = 'w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted'
const smallButton =
  'whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-40'

/** Why the selected model can't be used right now, or undefined if it can (or the list isn't loaded yet). */
export function unavailableModel(model: VideoModel | undefined): string | undefined {
  return model?.offline ? 'The model is offline – pick another one' : undefined
}

/**
 * Why the params can't be submitted yet, or undefined if they can. Includes what is wrong with the @ImageN, @AudioN
 * and @VideoN references of the prompt and the negative prompt, and with the audio clips and videos themselves (their
 * lengths, alone and together): the main process refuses such params with the same words. `continuing`: a sequence clip that
 * continues from the previous clip, generated image-to-video from that clip's last frame (so it needs no start
 * image of its own) and without reference images or audio.
 */
export function missingInput(params: GenerationParams, continuing = false): string | undefined {
  const kind = kindOfModelId(params.model)
  if (!params.prompt.trim()) return 'Write a prompt'
  if (continuing) return blockingContinuationError(params)?.replace(/\.\s*$/, '')
  if (kind === 'image-to-video' && !params.startImage) return 'Add a start image'
  // With a model that takes reference videos, a video is as good a reference as a picture (the checks say so too).
  const videos = supportsReferenceVideos(params.model) && videosAreReferences(params) ? referenceVideosOf(params).length : 0
  if (kind === 'reference-to-video' && !params.referenceImages?.length && !videos) {
    const withVideos = supportsReferenceVideos(params.model)
    // Venice refuses reference audio on its own, which is worth saying when a voice is all there is.
    return paramsForSubmit(params).referenceAudios?.length
      ? withVideos
        ? 'Add at least one reference image or video – sound is only sent together with one'
        : 'Add at least one reference image – sound is only sent together with an image'
      : withVideos
        ? 'Add at least one reference image or video'
        : 'Add at least one reference image'
  }
  return blockingPromptError(params)?.replace(/\.\s*$/, '')
}

/** The form-only choices that shape how assets are named in the prompt ("applies to", "held by"). */
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

/**
 * Text | Start image | References: what the clip starts from. Choosing a mode picks the same family's model for it
 * (modelForKind). ParamsForm shows it at the top; Generate puts it in its title band instead (hideTabs).
 */
export function ModeTabs({
  models,
  params,
  setParams,
  kinds = KINDS.map((k) => k.id),
  className
}: {
  models: VideoModel[]
  params: GenerationParams
  setParams: Dispatch<SetStateAction<GenerationParams>>
  /** Which modes to offer; default all three. One or none: no switch. */
  kinds?: Kind[]
  className?: string
}) {
  const tabs = KINDS.filter((k) => kinds.includes(k.id))
  if (tabs.length < 2) return null
  const kind = kindOfModelId(params.model)
  const choose = (k: Kind) => {
    if (k === kind) return
    const id = modelForKind(models, params.model, k)
    if (id) setParams((p) => ({ ...p, model: id }))
  }
  return (
    <Segmented
      fill
      ariaLabel="Mode"
      value={kind}
      onChange={choose}
      options={tabs.map((k) => ({ value: k.id, label: k.label }))}
      className={className}
    />
  )
}

/**
 * Duration, resolution, aspect ratio and sound in one row: they set the price, so Generate and a sequence clip show
 * them right above the button (and ParamsForm at its end otherwise). The values say what they are ("8s", "720p",
 * "16:9"); each field is named in its tooltip and for screen readers. ParamsForm snaps the values when the model
 * changes.
 */
export function OutputSettings({
  model,
  params,
  set,
  durationFixed,
  className = ''
}: {
  model: VideoModel | undefined
  params: GenerationParams
  set: <K extends keyof GenerationParams>(key: K, value: GenerationParams[K]) => void
  /** The duration is set for the clip (a song clip's place): shown, not chosen, with this as its tooltip. */
  durationFixed?: string
  className?: string
}) {
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 ${className}`}
    >
      {durationFixed ? (
        <span
          title={durationFixed}
          aria-label={`Duration: ${durationFixed}`}
          className={`${select} block cursor-default truncate text-muted`}
        >
          {params.duration.replace(/s$/, ' s')} · auto
        </span>
      ) : (
        <select
          value={params.duration}
          onChange={(e) => set('duration', e.target.value)}
          aria-label="Duration"
          title="Duration"
          className={select}
        >
          {(model?.durations ?? [params.duration]).map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
      )}
      {!!model?.resolutions.length && (
        <select
          value={params.resolution}
          onChange={(e) => set('resolution', e.target.value)}
          aria-label="Resolution"
          title="Resolution"
          className={select}
        >
          {model.resolutions.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      )}
      {!!model?.aspectRatios.length && (
        <select
          value={params.aspectRatio}
          onChange={(e) => set('aspectRatio', e.target.value)}
          aria-label="Aspect ratio"
          title="Aspect ratio"
          className={select}
        >
          {model.aspectRatios.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      )}
      {model?.audio && (
        <label
          className="flex items-center gap-1.5 whitespace-nowrap"
          title={model.audioConfigurable ? 'Generate sound with the clip' : 'The model always makes the clip with sound'}
        >
          <input
            type="checkbox"
            checked={params.audio ?? true}
            disabled={!model.audioConfigurable}
            onChange={(e) => set('audio', e.target.checked)}
            className="accent-accent"
          />
          <span>Sound</span>
        </label>
      )}
    </div>
  )
}

/** The params with these "worn by" choices (left out when there are none, as the params store them). */
function withOutfitWearers(params: GenerationParams, wearers: GenerationParams['outfitWearers']): GenerationParams {
  if (params.outfitWearers === wearers) return params
  const { outfitWearers: _, ...rest } = params
  return wearers ? { ...rest, outfitWearers: wearers } : rest
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
  continuationFrame,
  endImageRequired = false,
  onSubmit,
  hideTabs = false,
  outputSettings = 'inline',
  navigate,
  sequenceId,
  durationFixed,
  song,
  followDirector
}: Props) {
  const model = models.find((m) => m.id === params.model)
  const kind = kindOfModelId(params.model)
  const assets = useAssets()
  const prompts = usePrompts()

  const [picker, setPicker] = useState<Picker | null>(null)
  const closePicker = useCallback(() => setPicker(null), [])
  const togglePicker = (p: Picker) => setPicker((cur) => (cur === p ? null : p))
  const startButton = useRef<HTMLButtonElement>(null)
  const endButton = useRef<HTMLButtonElement>(null)
  const libraryButton = useRef<HTMLButtonElement>(null)
  const referencesButton = useRef<HTMLButtonElement>(null)
  const audioButton = useRef<HTMLButtonElement>(null)
  const referenceKind = picker?.startsWith('references:')
    ? (picker.slice('references:'.length) as ReferenceKind)
    : undefined
  // The tab ＋ From library opens on: the kind last added from it, else the first kind (in the app's order) that has
  // photos – characters first, since who is in the clip usually comes first.
  const [lastReferenceKind, setLastReferenceKind] = useState<ReferenceKind>()
  const openReferenceKind: ReferenceKind =
    lastReferenceKind ?? ASSET_KINDS.find((k) => assets.some((a) => a.kind === k && a.images.length)) ?? 'character'

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
    return { text: a.name, className: KIND_TONE[a.kind].caption }
  }

  const refs = params.referenceImages ?? []
  // A continuation's frame takes the model's last place (see continuationFrame).
  const framed = !!continuationFrame && kind === 'reference-to-video'
  const maxRefs = Math.max(1, maxReferenceImages(params.model) - (framed ? 1 : 0))
  const [refNote, setRefNote] = useState<string>()

  useEffect(() => {
    if (!refNote) return
    const t = setTimeout(() => setRefNote(undefined), 6000)
    return () => clearTimeout(t)
  }, [refNote])

  // Which @ImageN tokens belong to which asset, and who wears which outfit ("worn by"). The choices are params
  // (outfitWearers), so they travel with a sequence clip, "Use again" and an agent's form, and the References
  // legend says who wears what by the same rule (shared/outfits.ts); they also shape the text a character chip inserts.
  const assetRefs = assetRefsOf(refs, byPath, maxRefs)
  const pairings = resolvePairings(assetRefs, params.outfitWearers)

  /** Who wears an outfit: a character id, or null for nobody. Built on the latest params, like every setter here. */
  const wear = (outfitId: string, characterId: string | null) =>
    setParams((p) => withOutfitWearers(p, withOutfitWearer(p.outfitWearers, outfitId, characterId)))

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

  // ── Reference videos (motion, camera, style; @VideoN) ────────────────────────
  // Seedance 2.x reference models only, within the family's limits (count, per video, in all). The Editor's video to
  // edit is no reference video: a form never holds one (canUseAgain), and if it did it wouldn't be shown here.

  const videoRefs = useMemo(
    () => (videosAreReferences(params) ? referenceVideosOf(params) : []),
    [params.referenceVideos, params.referenceTask]
  )
  const videoLimits = kind === 'reference-to-video' ? referenceVideoLimits(params.model) : undefined
  const videoFacts = useVideoFacts(videoRefs.map((v) => v.path))
  const videoKey = videosKey(videoRefs)
  const videos = useMemo(
    () => formVideos(videoRefs, videoFacts, videoLimits),
    [videoKey, videoFacts, videoLimits?.family]
  )
  // The model to offer when this one takes no reference videos: its family's reference model, else Seedance 2.5's.
  const videoModel = useMemo(() => {
    const id = referenceVideoModelFor(
      params.model,
      models.filter((m) => !m.offline).map((m) => m.id)
    )
    return id && id !== params.model ? models.find((m) => m.id === id) : undefined
  }, [models, params.model])
  const [videoNote, setVideoNote] = useState<string>()

  /**
   * Sets the reference images, audio and videos. A removed or swapped picture (or clip, or video) shifts the ones
   * after it, so the prompt's @ImageN, @AudioN and @VideoN tokens follow them in the same update (see
   * remapPromptReferences); `swap` names the outfits taken off and the one put on.
   */
  const setReferences = (
    next: { refs?: string[]; audios?: ReferenceAudio[]; videos?: ReferenceVideo[] },
    swap?: { from: Asset[]; to: Asset | null }
  ) => {
    const nextRefs = next.refs ?? refs
    const nextAudios = next.audios ?? audioRefs
    const nextVideos = next.videos ?? videoRefs
    if (sameList(nextRefs, refs) && sameAudios(nextAudios, audioRefs) && sameVideos(nextVideos, videoRefs)) return
    // "worn by" choices for outfits (or characters) no longer among the pictures are forgotten, so an outfit added
    // again starts from its default wearer.
    const present = new Set(nextRefs.flatMap((path) => byPath.get(path)?.id ?? []))
    // A picture in several places (a swapped-in asset with fewer photos reuses them) is followed place by place by
    // the remap itself (placeKeys).
    const images = { before: refs, after: nextRefs }
    const sounds = { before: audioRefs, after: nextAudios }
    const films = { before: videoRefs, after: nextVideos }
    const before = params.prompt
    const prompt = remapPromptReferences(before, images, sounds, swap, films)
    if (prompt !== before) ownPrompt.current = prompt
    // The negative prompt may name pictures, clips and videos too; its tokens follow them the same way (no outfit
    // swap there: that renames the outfit in the description, which belongs to the prompt).
    const negativeBefore = params.negativePrompt
    const negative = negativeBefore && remapPromptReferences(negativeBefore, images, sounds, undefined, films)
    setParams((p) => ({
      ...withOutfitWearers(p, outfitWearersAmong(p.outfitWearers, present)),
      referenceImages: nextRefs,
      referenceAudios: nextAudios.length ? nextAudios : undefined,
      ...(next.videos ? { referenceVideos: nextVideos.length ? nextVideos : undefined } : {}),
      ...(p.prompt === before ? { prompt } : {}),
      ...(negativeBefore && p.negativePrompt === negativeBefore ? { negativePrompt: negative || undefined } : {})
    }))
  }

  /** Adds videos at the end, each with its window, as many as the family takes; a note says what didn't fit. */
  const addVideoRefs = (candidates: VideoCandidate[]) => {
    const change = addVideos(videoRefs, candidates, videoFactsNow(), videoLimits)
    setReferences({ videos: change.videos })
    setVideoNote(change.note)
  }

  /** Takes videos (1-based @VideoN numbers) out of the form; their tokens go, the later ones' follow. */
  const removeVideos = (indices: readonly number[]) => {
    setReferences({ videos: videoRefs.filter((_, i) => !indices.includes(i + 1)) })
    setVideoNote(undefined)
  }

  /** A video dragged to another place (or moved with ⌥← / ⌥→; 0-based): the @VideoN tokens follow. */
  const moveVideo = (from: number, to: number) => {
    setReferences({ videos: moveItem(videoRefs, from, to) })
    setVideoNote(undefined)
  }

  /** Another part of the video is sent: the same file in the same place, so no token changes. */
  const setVideoWindow = (index: number, w: ClipWindow) => {
    setReferences({ videos: withVideoWindow(videoRefs, index, w) })
  }

  const videoFitsNow = (path: string, duration: number | undefined) =>
    videoFits(videoRefs, { path, duration }, videoFactsNow(), videoLimits)

  // Offered when the model takes no reference videos but the form has (or names) some, or to start using them.
  const switchToVideoModel =
    !supportsReferenceVideos(params.model) && videoModel && kinds.includes('reference-to-video')
      ? () => set('model', videoModel.id)
      : undefined

  /**
   * Files that aren't pictures dropped on the reference images (the first place one drops a clip): a video becomes a
   * reference video when the model takes them, as if dropped on that row; otherwise a note says why it can't be used.
   */
  const dropOtherOnReferences = async (paths: string[]) => {
    const videoPaths = paths.filter(isVideoFile)
    if (!videoPaths.length) return setRefNote('Only pictures (JPG, PNG or WebP) can be reference images.')
    if (!videoLimits) {
      return setRefNote(
        `${model?.name ?? 'This model'} doesn’t take reference videos${videoModel ? ` – choose ${videoModel.name} under Model` : ''}.`
      )
    }
    const { candidates, note } = await videoFilesAsCandidates(videoPaths)
    if (candidates.length) addVideoRefs(candidates)
    if (note) setVideoNote(note)
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

  /** "Include the voice" on a chip: the asset's first clip in, or all of its clips out. */
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

  // Which characters each pose applies to ("applies to"): form state only; it shapes the text a pose chip inserts.
  // undefined: every character in the form, also ones added later.
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

  // Which character holds each product ("held by"): form state only, like "applies to"; it shapes the text a product
  // chip inserts. Missing or null: nobody holds it (the default).
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

  /** "Change outfit": the new outfit takes the old one's place and is worn by the character (the choice goes with it). */
  const swapOutfitOf = (character: Asset, outfit: Asset | null) => {
    const wearing = outfitsWornBy(character.id, assetRefs, pairings).map((r) => r.asset)
    applyRefs(swapOutfit(refs, wearing, outfit, maxRefs), {
      from: wearing.filter((o) => o.id !== outfit?.id),
      to: outfit
    })
    if (!outfit) return
    const photos = new Set(outfit.images.map((img) => img.path))
    // After the swap's own update; only when some of the outfit's photos fitted.
    setParams((p) =>
      (p.referenceImages ?? []).some((path) => photos.has(path))
        ? withOutfitWearers(p, withOutfitWearer(p.outfitWearers, outfit.id, character.id))
        : p
    )
  }

  /**
   * A reference thumbnail clicked and another picture (or, for a library photo, another asset) picked: it takes the
   * same places, so no @ImageN or @AudioN number changes and the prompt keeps every token. Not a removal and an
   * addition through setReferences, which would renumber or drop them: the shared rules (shared/reference-swap)
   * change the pictures, clips, the name in front of the swapped tokens, the description switch, the wearers and – one
   * character for another – the outfit it wore, in one update, and the form's own "applies to" and "held by" choices
   * follow here. What the swap did, or why nothing changed, is the note under the references.
   */
  const swapReference = (index: number, choice: SwapChoice): void => {
    const old = refs[index]
    if (old === undefined) return
    const from = byPath.get(old)
    const target = choice.kind === 'asset' ? assets.find((a) => a.id === choice.assetId) : byPath.get(choice.path)
    const apply = (p: GenerationParams): SwapResult => {
      if (choice.kind === 'image') return swapReferenceImage(p, index, choice.path, assets)
      if (!from || !target) throw new Error('The library has changed – try again.')
      return swapReferenceAsset(p, from, target, assets)
    }
    let result: SwapResult
    try {
      result = apply(params)
    } catch (e) {
      setRefNote(e instanceof Error ? e.message : String(e))
      return
    }
    if (result.params === params) return
    if (result.params.prompt !== params.prompt) ownPrompt.current = result.params.prompt
    // On the latest params, like every setter here; nothing happens if the picture left that place meanwhile.
    setParams((p) => {
      if ((p.referenceImages ?? [])[index] !== old) return p
      try {
        const next = apply(p).params
        // As setReferences does: "worn by" choices for assets no longer among the pictures are forgotten.
        const present = new Set((next.referenceImages ?? []).flatMap((path) => byPath.get(path)?.id ?? []))
        return withOutfitWearers(next, outfitWearersAmong(next.outfitWearers, present))
      } catch {
        return p
      }
    })
    // The asset left every place it had and another of its kind took them: its "applies to" / "held by" go along.
    const after = result.params.referenceImages ?? []
    if (
      from &&
      target &&
      from.id !== target.id &&
      from.kind === target.kind &&
      !after.some((path) => byPath.get(path)?.id === from.id)
    ) {
      const follow = (id: string) => (id === from.id ? target.id : id)
      setPosePeople((chosen) =>
        Object.fromEntries(
          Object.entries(chosen).map(([pose, ids]) => [follow(pose), ids && [...new Set(ids.map(follow))]])
        )
      )
      setProductHolders((chosen) =>
        Object.fromEntries(
          Object.entries(chosen).map(([product, holder]) => [follow(product), holder && follow(holder)])
        )
      )
    }
    setRefNote(result.notes.join(' ') || undefined)
  }

  // ── References as the prompt sees them (@ImageN) ────────────────────────────

  const language = usePromptLanguage()
  const references = useMemo(
    () => (kind === 'reference-to-video' ? promptReferences(refs, byPath, maxRefs) : []),
    [kind, refs.join('\n'), byPath, maxRefs]
  )
  const groups = assetRefs.map((entry) => referenceGroupOf(entry, assetRefs, pairings, sentAudios, naming))

  /**
   * "@" menu → "Add from the library": adds the photos (and a character's voice) and tells the editor how
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
    return entry && referenceGroupOf(entry, after, resolvePairings(after, params.outfitWearers), audiosAfter, naming)
  }

  const manageKind = navigate
    ? (k: AssetKind) => {
        closePicker()
        navigate(ASSET_VIEW[k])
      }
    : undefined

  /** Opens one asset in its library view, e.g. to edit the description the prompt gets ("Edit description"). */
  const openAsset = navigate
    ? (a: Asset) => {
        closePicker()
        navigate(ASSET_VIEW[a.kind], { type: 'open-asset', assetId: a.id })
      }
    : undefined

  // ── Descriptions appended to the prompt ("Added to the prompt") ─────────────
  // Both flags are params, so they travel with the form, a sequence clip's saved params and "Use again", and
  // main composes the legend from them at submit. Built on the latest params, like every other setter here.

  // What the box shows, and which references the legend that is sent explains (for the prompt checks below).
  const promptLimit = model?.promptCharacterLimit
  // A song clip's legend and checks are those of what it sends (its window of the song as @Audio1).
  const sendAs = song?.sendAs
  // The director directing the form – its own, else the sequence's – as main resolves it: its `avoid`, style frames
  // and videos go into what is sent, and its Direction section after the legend (direction.ts withDirection).
  const directorId = effectiveDirectorId(params.director, followDirector?.directorId)
  const director = useMemo(() => resolveDirector(directorId, assets), [directorId, assets])
  const sent = useMemo(
    () => withDirection(sendAs ? sendAs(params) : params, director, { continuationFrame: framed }),
    [params, sendAs, director, framed]
  )
  const descriptions = useMemo(
    () => descriptionsView(sent, assets, language, promptLimit, director),
    [sent, assets, language, promptLimit, director]
  )
  const openDirector = navigate
    ? (id: string) => {
        closePicker()
        navigate('directors', { type: 'open-asset', assetId: id })
      }
    : undefined

  /**
   * "Director": its own (an id), none (null in a clip, left out in Generate) or the sequence's (left out in a clip).
   * Choosing a director applies its defaults – model, aspect ratio, resolution – where the models allowed here offer
   * them (directorDefaults, as a sequence's and a storyboard's do).
   */
  const chooseDirector = (value: string | null | undefined) => {
    const chosen = typeof value === 'string' ? resolveDirector(value, assets) : undefined
    const usable = models.filter((m) => !m.offline && kinds.includes(m.kind as Kind))
    setParams((p) => {
      const next: GenerationParams = { ...p }
      if (value === undefined) delete next.director
      else next.director = value
      return chosen ? { ...next, ...directorDefaults(next, chosen.direction, usable) } : next
    })
  }
  const includeDescriptions = (on: boolean) => setParams((p) => withDescriptionsIncluded(p, on))
  const toggleDescription = (assetId: string, on: boolean) =>
    setParams((p) => withAssetDescription(p, assetId, on, assetIdsInForm(p, assets)))

  /** The tab a single-image picker opens on: the current image's kind, else the first kind with photos. */
  const singleImageKind = (path: string | undefined): ReferenceKind =>
    SINGLE_IMAGE_KINDS.find((k) => !!path && byPath.get(path)?.kind === k) ??
    SINGLE_IMAGE_KINDS.find((k) => assets.some((a) => a.kind === k && a.images.length)) ??
    'environment'

  const libraryImageButton = (ref: RefObject<HTMLButtonElement | null>, target: 'start' | 'end', title: string) => (
    <button
      ref={ref}
      onClick={() => togglePicker(target)}
      className={`${smallButton} ${picker === target ? 'bg-raised text-text' : ''}`}
      title={title}
    >
      From library
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
      label={target === 'start' ? 'Choose a start image' : 'Choose an end image'}
    >
      <AssetPicker
        assets={assets}
        initialKind={singleImageKind(value)}
        title={target === 'start' ? 'Start image from the library' : 'End image from the library'}
        hint="Click an image – or the name for the cover image."
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
  // The prompt text this form last wrote itself; anything else came from outside (another segment, "Use again").
  const ownPrompt = useRef<string | null>(null)
  /** Sets the prompt; negativePrompt null leaves it as is, undefined clears it. */
  const setPrompt = (prompt: string, negativePrompt: string | null | undefined) => {
    ownPrompt.current = prompt
    setParams((p) => ({ ...p, prompt, ...(negativePrompt !== null ? { negativePrompt } : {}) }))
  }

  /** Inserts at the caret in the prompt, as one step ⌘Z can undo (chip clicks). */
  const insertIntoPrompt = (text: string) => editor.current?.insert(text)

  // The library prompt the current text came from, so "Save" can offer to update it. Set on an exact
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
  // What both prompts are checked against: exactly what the main process checks before sending – a reference the
  // References legend explains (its description, or who wears an outfit) isn't reported as unmentioned.
  const checks = validationContext(sent, { continuing, continuationFrame: framed, explained: descriptions.explained })
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
      {!hideTabs && <ModeTabs models={models} params={params} setParams={setParams} kinds={kinds} />}

      <label className="block">
        <span className="mb-1.5 block text-muted">Model</span>
        {modelsError ? (
          <p role="alert" className="text-danger">
            {modelsError}
          </p>
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
                {m.privacy === 'private' ? ' (private)' : ''}
              </option>
            ))}
          </select>
        )}
      </label>

      <DirectorField
        value={params.director}
        follow={followDirector}
        assets={assets}
        onChange={chooseDirector}
        onOpen={openDirector}
      />

      {kind === 'image-to-video' && (
        <>
          {startImageNote ? (
            <div>
              <span className="mb-1.5 block text-muted">Start image</span>
              <p className="rounded-md border border-dashed border-line px-3 py-2.5 text-muted">{startImageNote}</p>
            </div>
          ) : (
            <>
              <ImageInput
                label="Start image"
                value={params.startImage ? [params.startImage] : []}
                onChange={(v) => set('startImage', v[0])}
                caption={caption}
                library={assets}
                sequenceId={sequenceId}
                action={libraryImageButton(startButton, 'start', `Choose a start image from ${SINGLE_IMAGE_KINDS_TEXT}`)}
              />
              {singleImagePicker('start', params.startImage)}
            </>
          )}
          {/* Also shown when a note replaces the start image: the end image is still sent, so it must stay
              visible and removable. */}
          {endImageNote ? (
            <div>
              <span className="mb-1.5 block text-muted">End image</span>
              <p className="rounded-md border border-dashed border-line px-3 py-2.5 text-muted">{endImageNote}</p>
            </div>
          ) : (
            // An end image picked for another model stays visible (so it can be removed) but isn't sent.
            (endImagePossible || params.endImage) && (
              <>
                <ImageInput
                  label="End image (optional)"
                  // Optional, so it takes one line until there is a picture: the prompt stays near the top.
                  compact
                  value={params.endImage ? [params.endImage] : []}
                  onChange={(v) => set('endImage', v[0])}
                  caption={caption}
                  library={assets}
                  sequenceId={sequenceId}
                  action={libraryImageButton(endButton, 'end', `Choose an end image from ${SINGLE_IMAGE_KINDS_TEXT}`)}
                />
                {!endImagePossible && (
                  <p className="-mt-2 text-[11px] leading-relaxed text-danger">
                    {endImageRequired
                      ? 'This model takes no end image, so the clip can’t be generated with it. Remove the image or pick a model that takes both a start and an end image.'
                      : 'This model takes no end image, so the image isn’t sent. Remove it or pick a model that takes both a start and an end image.'}
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
            label="Reference images"
            multiple
            max={maxRefs}
            showCount={false}
            value={refs}
            onChange={(v) => setRefs(v)}
            onOtherFiles={(paths) => void dropOtherOnReferences(paths)}
            onSwap={swapReference}
            caption={caption}
            library={assets}
            sequenceId={sequenceId}
            action={
              // One button: the picker has a tab per kind (it opens on the kind added last).
              <button
                ref={referencesButton}
                type="button"
                onClick={() => togglePicker(`references:${openReferenceKind}`)}
                className={`${smallButton} ${referenceKind ? 'bg-raised text-text' : ''}`}
                title={`Add saved ${REFERENCE_KINDS_TEXT} as references`}
              >
                ＋ From library
              </button>
            }
          />
          {/* Keyed by kind: the picker starts on that tab again when the "@" menu opens it on another one. */}
          <Popover
            key={referenceKind}
            anchorRef={referencesButton}
            open={!!referenceKind}
            onClose={closePicker}
            align="end"
            width={380}
            maxHeight={480}
            label="Add from the library"
          >
            <AssetPicker
              assets={assets}
              initialKind={referenceKind ?? openReferenceKind}
              title="Add as a reference"
              hint={
                refs.length >= maxRefs
                  ? `All ${maxRefs} places are taken – remove an image first.`
                  : 'Click the name for all images or a single image. ' +
                    `${maxRefs - refs.length} of ${maxRefs} places free.`
              }
              selectedPaths={refs}
              freeSlots={Math.max(0, maxRefs - refs.length)}
              withVoice={audioSupported}
              onPickAsset={(a) => {
                if (isReferenceKind(a.kind)) setLastReferenceKind(a.kind)
                addAssetRefs(a)
                closePicker()
              }}
              onPickImage={(path, a) => {
                if (isReferenceKind(a.kind)) setLastReferenceKind(a.kind)
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
            onWear={wear}
            onSwapOutfit={swapOutfitOf}
            onManageOutfits={manageKind && (() => manageKind('outfit'))}
          />
          {refNote && <p className="mt-1 text-[11px] text-warning">{refNote}</p>}
          {framed && <p className="mt-1.5 text-[11px] leading-snug text-muted">{continuationFrame}</p>}
          {director && (
            <StyleFramesFromDirector
              sent={sent}
              director={director}
              onOpen={openDirector && (() => openDirector(director.id))}
            />
          )}
        </div>
      )}

      {kind === 'reference-to-video' &&
        (videoLimits || videos.length > 0 ? (
          <div>
            <ReferenceVideos
              // Optional: one header row until there is a video, so the prompt stays near the top.
              collapsedWhenEmpty
              videos={videos}
              limits={videoLimits}
              onAdd={addVideoRefs}
              onRemove={(index) => removeVideos([index])}
              onMove={moveVideo}
              onWindow={setVideoWindow}
              sequenceId={sequenceId}
              fits={videoFitsNow}
              note={videoNote}
              onNote={setVideoNote}
            />
            {director && videoLimits && (
              <StyleVideosFromDirector
                sent={sent}
                director={director}
                onOpen={openDirector && (() => openDirector(director.id))}
              />
            )}
            {!videoLimits && videos.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-danger">
                <span>{model?.name ?? 'The model'} doesn’t take reference videos – the videos aren’t sent.</span>
                {switchToVideoModel && videoModel && (
                  <button onClick={switchToVideoModel} className="text-text hover:underline">
                    Switch to {videoModel.name}
                  </button>
                )}
                <button onClick={() => removeVideos(videos.map((v) => v.index))} className="text-text hover:underline">
                  Remove the videos
                </button>
              </div>
            )}
          </div>
        ) : (
          switchToVideoModel &&
          videoModel && (
            <p className="-mt-2 text-[11px] leading-snug text-muted">
              Reference videos (motion, camera, style) need a Seedance 2.x reference model.{' '}
              <button onClick={switchToVideoModel} className="text-text hover:underline">
                Switch to {videoModel.name}
              </button>
            </p>
          )
        ))}

      {kind === 'reference-to-video' && (audioSupported || audios.length > 0) && (
        <div>
          {/* Empty, the section is this row alone: what it is for is the ＋ Sound tooltip. */}
          <div
            className={`flex items-center justify-between gap-2 ${audios.length > 0 || song?.audioNote ? 'mb-1.5' : ''}`}
          >
            <span className="text-muted">Voices & sound</span>
            {audioSupported && (
              <button
                ref={audioButton}
                type="button"
                onClick={() => togglePicker('audio')}
                className={`${smallButton} ${picker === 'audio' ? 'bg-raised text-text' : ''}`}
                title={
                  'Send a voice or a soundscape from the library – a character with a voice brings it along when you ' +
                  'add the character. Refer to it as @Audio1 … in the prompt.'
                }
              >
                ＋ Sound
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
            label="Add sound"
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
          {song?.audioNote && (
            <p className="mb-1.5 rounded-md border border-violet-300/25 bg-violet-300/10 px-2.5 py-1.5 text-[11px] leading-snug text-violet-100">
              {song.audioNote}
            </p>
          )}
          {audios.length > 0 && (
            <>
              <AudioChips
                audios={audios}
                language={language}
                onInsert={insertIntoPrompt}
                onRemove={(index) => removeAudios([index])}
                onMove={moveAudio}
              />
              <div className="mt-1.5 flex justify-end text-[11px] text-muted">
                <span
                  className={`tabular-nums ${
                    audioSeconds > MAX_REFERENCE_AUDIO_SECONDS || audios.length > maxAudios ? 'text-danger' : ''
                  }`}
                  title={
                    `${audios.length} of at most ${maxAudios} sound clips, ${formatClipSeconds(audioSeconds)} of at most ` +
                    `${MAX_REFERENCE_AUDIO_SECONDS} s together. Venice takes 2–15 s per clip.`
                  }
                >
                  {formatClipSeconds(audioSeconds).replace(/ s$/, '')}/{MAX_REFERENCE_AUDIO_SECONDS} s
                </span>
              </div>
            </>
          )}
          {!audioSupported && audios.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-danger">
              <span>{model?.name ?? 'The model'} doesn’t take sound – the sound clips aren’t sent.</span>
              {switchToAudioModel && audioModel && (
                <button onClick={switchToAudioModel} className="text-text hover:underline">
                  Switch to {audioModel.name}
                </button>
              )}
              <button onClick={() => removeAudios(audios.map((a) => a.index))} className="text-text hover:underline">
                Remove the sound
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
          <button
            ref={libraryButton}
            type="button"
            onClick={() => togglePicker('library')}
            className={`${smallButton} ${picker === 'library' ? 'bg-raised text-text' : ''}`}
            title="Load a saved prompt"
          >
            Library
          </button>
          <button
            type="button"
            onClick={() => setSaveOpen(true)}
            disabled={!params.prompt.trim()}
            className={`${smallButton} ${savedFlash ? 'text-success hover:text-success' : ''}`}
            title={linkedUnchanged ? 'Edit the saved prompt’s title and tags' : 'Save the prompt in the library'}
          >
            {savedFlash ? '✓ Saved' : 'Save'}
          </button>
        </div>
        <Popover
          anchorRef={libraryButton}
          open={picker === 'library'}
          onClose={closePicker}
          align="end"
          width={360}
          maxHeight={480}
          label="Prompt library"
        >
          <PromptLibraryPicker prompts={prompts} onPick={applyPrompt} onManage={managePrompts} />
        </Popover>
        <PromptEditor
          ref={editor}
          id={promptId}
          value={params.prompt}
          onChange={(prompt) => setPrompt(prompt, null)}
          onSubmit={onSubmit}
          // The text written here (the count shows near the limit); what descriptions add is counted under it.
          limit={promptLimit}
          rows={7}
          placeholder={
            kind === 'reference-to-video'
              ? videoLimits && videos.length
                ? 'Describe the scene, the motion and the camera… Type @ to refer to a reference image, a video or a sound.'
                : audioSupported
                  ? 'Describe the scene, the motion and the camera… Type @ to refer to a reference image or a sound.'
                  : 'Describe the scene, the motion and the camera… Type @ to refer to a reference image.'
              : 'Describe the scene, the motion and the camera…'
          }
          kind={kind}
          checks={checks}
          references={references}
          audios={kind === 'reference-to-video' ? audios : []}
          videos={kind === 'reference-to-video' ? videos : []}
          maxImages={maxRefs}
          groups={groups}
          library={assets}
          onAddFromLibrary={kind === 'reference-to-video' ? addFromLibrary : undefined}
          onSwitchToReference={switchToReference}
          onAddReferences={kind === 'reference-to-video' ? () => setPicker(`references:${openReferenceKind}`) : undefined}
          onRemoveAudio={audioRefs.length ? removeAudios : undefined}
          onUseAudioModel={switchToAudioModel}
          audioModelName={audioModel?.name}
          onRemoveVideo={videoRefs.length ? removeVideos : undefined}
          onUseVideoModel={switchToVideoModel}
          videoModelName={videoModel?.name}
          songFixes={song && { onNoSong: song.onNoSong, onChooseSinger: song.onChooseSinger }}
          language={language}
          belowInput={
            (linkedPrompt || canUndo) && (
              <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                {linkedPrompt && (
                  <span className="min-w-0 truncate" title={linkedPrompt.title}>
                    {linkedPrompt.favorite ? '★ ' : ''}From the library: “{linkedPrompt.title}”
                    {linkedUnchanged ? '' : ' · edited'}
                  </span>
                )}
                {canUndo && (
                  <button onClick={undoReplace} className="ml-auto shrink-0 text-text hover:underline">
                    Undo
                  </button>
                )}
              </div>
            )
          }
        />
        <DescriptionsBox
          view={descriptions}
          onInclude={includeDescriptions}
          onToggle={toggleDescription}
          onOpenAsset={openAsset}
          onOpenDirector={director && openDirector ? () => openDirector(director.id) : undefined}
        />
      </div>

      <Disclosure
        open={negativeOpen}
        onToggle={setNegativeOpen}
        plain
        summary={
          <span>
            Negative prompt
            {!negativeOpen && negativeHasError && <span className="ml-1.5 text-[11px] text-danger">(has errors)</span>}
            {!negativeOpen && !negativeHasError && params.negativePrompt && (
              <span className="ml-1.5 text-[11px]">(filled in)</span>
            )}
            {!negativeOpen && director?.direction.avoid && (
              <span className="ml-1.5 text-[11px]">+ {director.name}’s</span>
            )}
          </span>
        }
      >
        <PromptField
          textareaRef={negativeRef}
          value={params.negativePrompt ?? ''}
          onChange={(v) => set('negativePrompt', v || undefined)}
          // ⌘↵ sends from here as from the prompt.
          onSubmit={onSubmit}
          context="negative"
          minRows={2}
          maxRows={8}
          title="Avoid"
          focusHint="What the model should avoid, ideally in English and comma-separated. Type / for common things to avoid."
          placeholder="What you don’t want to see… (type / for suggestions)"
          ariaLabel="Negative prompt"
          ariaDescribedBy={negativeHasError ? negativeIssuesId : undefined}
          invalid={negativeHasError}
        />
        {director?.direction.avoid && (
          <p className="mt-1 text-[11px] leading-snug text-muted">
            <span className="text-text/80">{director.name} adds:</span> {director.direction.avoid} – after yours,
            without repeating a phrase.
          </p>
        )}
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
          onUseVideoModel={switchToVideoModel}
          videoModelName={videoModel?.name}
        />
      </Disclosure>

      {outputSettings === 'inline' && (
        <OutputSettings model={model} params={params} set={set} durationFixed={durationFixed} />
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
