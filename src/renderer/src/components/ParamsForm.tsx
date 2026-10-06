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
  PREFERRED,
  audioForModel,
  kindOfModelId,
  maxReferenceImages,
  pickOption,
  type Kind
} from '@shared/models'
import { blockingContinuationError, blockingPromptError } from '@shared/prompt-refs'
import {
  ASSET_KINDS,
  type Asset,
  type AssetKind,
  type GenerationParams,
  type SavedPrompt,
  type VideoModel
} from '@shared/types'
import { ASSET_COPY, ASSET_VIEW } from '../lib/assets'
import { useAssets, usePrompts } from '../lib/hooks'
import type { Navigate } from '../lib/navigation'
import ImageInput, { type ImageCaption } from './ImageInput'
import AssetChips from './pickers/AssetChips'
import AssetPicker from './pickers/AssetPicker'
import { KIND_TONE, PICKER_COPY } from './pickers/assetKinds'
import {
  addAsset,
  addPaths,
  assetRefsOf,
  assetsByPath,
  outfitsWornBy,
  remapPromptImages,
  removeAsset,
  resolvePairings,
  sameList,
  swapOutfit,
  type AssetRef,
  type RefsChange
} from './pickers/assetRefs'
import Popover from './pickers/Popover'
import PromptLibraryPicker from './pickers/PromptLibraryPicker'
import SavePromptDialog from './pickers/SavePromptDialog'
import NegativePromptIssues, { negativePromptIssues } from './prompt/NegativePromptIssues'
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
  /**
   * A sequence clip that continues from the previous clip: its mode is fixed, so the prompt checks advise
   * what can be done there (remove the references, or switch off continuing) instead of a mode switch.
   */
  continuing?: boolean
  /** Called on ⌘/Ctrl+Enter in the prompt field. */
  onSubmit?: () => void
  /** Lets the pickers link to the library views (characters, environments, outfits, prompts). */
  navigate?: Navigate
}

/** The open popover: the prompt library, a start/end image picker, or the reference picker on a kind's tab. */
type Picker = 'library' | 'start' | 'end' | `references:${AssetKind}`

/** Tab order for a start/end image picker when the image isn't a library photo: environments make good opening frames. */
const SINGLE_IMAGE_KINDS: readonly AssetKind[] = ['environment', 'character', 'outfit']

const select = 'w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted'
const smallButton =
  'whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-40'

/** Why the selected model can't be used right now, or undefined if it can (or the list isn't loaded yet). */
export function unavailableModel(model: VideoModel | undefined): string | undefined {
  return model?.offline ? 'Modellen är offline – välj en annan' : undefined
}

/**
 * Why the params can't be submitted yet, or undefined if they can. Includes what is wrong with the @ImageN
 * references of the prompt and the negative prompt: the main process refuses such params with the same words.
 * `continuing`: a sequence clip that continues from the previous clip, generated image-to-video from that
 * clip's last frame (so it needs no start image of its own) and without reference images.
 */
export function missingInput(params: GenerationParams, continuing = false): string | undefined {
  const kind = kindOfModelId(params.model)
  if (!params.prompt.trim()) return 'Skriv en prompt'
  if (continuing) return blockingContinuationError(params)?.replace(/\.\s*$/, '')
  if (kind === 'image-to-video' && !params.startImage) return 'Lägg till en startbild'
  if (kind === 'reference-to-video' && !params.referenceImages?.length) return 'Lägg till minst en referensbild'
  return blockingPromptError(params)?.replace(/\.\s*$/, '')
}

/** What a library asset among the references is called in the prompt, with the clothes a character wears. */
function referenceGroupOf(entry: AssetRef, assetRefs: AssetRef[], pairings: ReadonlyMap<string, string>): AssetGroup {
  const { asset, indices } = entry
  const outfits =
    asset.kind === 'character'
      ? outfitsWornBy(asset.id, assetRefs, pairings).map((w) => ({ name: w.asset.name, indices: w.indices }))
      : undefined
  return { asset, name: asset.name, indices, outfits }
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
  continuing = false,
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
  const outfitButton = useRef<HTMLButtonElement>(null)
  const kindButtons: Record<AssetKind, RefObject<HTMLButtonElement | null>> = {
    character: characterButton,
    environment: environmentButton,
    outfit: outfitButton
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

  const supportsEndImage = /first-last-frame|transition/.test(params.model)

  // ── Library assets (characters, environments, outfits) ───────────────────────

  const byPath = useMemo(() => assetsByPath(assets), [assets])
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])
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

  /**
   * Sets the reference images. A removed or swapped picture shifts the ones after it, so the prompt's
   * @ImageN tokens follow their pictures in the same update (see remapPromptImages); `swap` names the
   * outfits taken off and the one put on.
   */
  const setRefs = (next: string[], swap?: { from: Asset[]; to: Asset | null }) => {
    if (sameList(next, refs)) return
    const before = params.prompt
    const prompt = remapPromptImages(before, refs, next, swap)
    if (prompt !== before) ownPrompt.current = prompt
    // The negative prompt may name pictures too; its tokens follow them the same way (no outfit swap there:
    // that renames the outfit in the description, which belongs to the prompt).
    const negativeBefore = params.negativePrompt
    const negative = negativeBefore && remapPromptImages(negativeBefore, refs, next)
    setParams((p) => ({
      ...p,
      referenceImages: next,
      ...(p.prompt === before ? { prompt } : {}),
      ...(negativeBefore && p.negativePrompt === negativeBefore ? { negativePrompt: negative || undefined } : {})
    }))
  }

  const applyRefs = ({ refs: next, note }: RefsChange, swap?: { from: Asset[]; to: Asset | null }) => {
    setRefs(next, swap)
    setRefNote(note)
  }

  const removeAssetRefs = (a: Asset) => {
    setRefs(removeAsset(refs, a))
    setRefNote(undefined)
  }

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
  const groups = assetRefs.map((entry) => referenceGroupOf(entry, assetRefs, pairings))

  /** "@" menu → "Lägg till från biblioteket": adds the photos and tells the editor how to name the asset. */
  const addFromLibrary = (asset: Asset): ReferenceGroup | undefined => {
    const change = addAsset(refs, asset, assetById, maxRefs)
    applyRefs(change)
    const after = assetRefsOf(change.refs, byPath, maxRefs)
    const entry = after.find((r) => r.asset.id === asset.id)
    return entry && referenceGroupOf(entry, after, resolvePairings(after, wornBy))
  }

  const manageKind = navigate
    ? (k: AssetKind) => {
        closePicker()
        navigate(ASSET_VIEW[k])
      }
    : undefined

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
  // @ImageN mistakes in the negative prompt block generating as well.
  const negativeHasError = negativePromptIssues(
    params.negativePrompt ?? '',
    references.length,
    kind,
    maxRefs,
    continuing
  ).some((i) => i.severity === 'error')
  const switchToReference = kinds.includes('reference-to-video') ? () => switchKind('reference-to-video') : undefined

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
                action={libraryImageButton(startButton, 'start', 'Välj startbild bland karaktärer, miljöer och kläder')}
              />
              {singleImagePicker('start', params.startImage)}
            </>
          )}
          {/* Shown with the note too: the end image is still sent, so it must stay visible and removable. */}
          {supportsEndImage && (
            <>
              <ImageInput
                label="Slutbild (valfri)"
                value={params.endImage ? [params.endImage] : []}
                onChange={(v) => set('endImage', v[0])}
                caption={caption}
                action={libraryImageButton(endButton, 'end', 'Välj slutbild bland karaktärer, miljöer och kläder')}
              />
              {singleImagePicker('end', params.endImage)}
            </>
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
              <span className="flex items-center">
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
            width={340}
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
              onPickAsset={(a) => {
                applyRefs(addAsset(refs, a, assetById, maxRefs))
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
            onInsert={insertIntoPrompt}
            onRemove={removeAssetRefs}
            onWear={(outfitId, characterId) => setWornBy((chosen) => ({ ...chosen, [outfitId]: characterId }))}
            onSwapOutfit={swapOutfitOf}
            onManageOutfits={manageKind && (() => manageKind('outfit'))}
          />
          {refNote && <p className="mt-1 text-[11px] text-accent">{refNote}</p>}
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
              ? 'Beskriv scenen, rörelsen och kameran… Skriv @ för att hänvisa till en referensbild.'
              : 'Beskriv scenen, rörelsen och kameran…'
          }
          kind={kind}
          continuing={continuing}
          references={references}
          maxImages={maxRefs}
          groups={groups}
          library={assets}
          onAddFromLibrary={kind === 'reference-to-video' ? addFromLibrary : undefined}
          onSwitchToReference={switchToReference}
          onAddReferences={kind === 'reference-to-video' ? () => setPicker('references:character') : undefined}
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
      </div>

      <details open={negativeOpen} onToggle={(e) => setNegativeOpen(e.currentTarget.open)} className="group">
        <summary className="cursor-pointer text-muted hover:text-text">
          Negativ prompt
          {!negativeOpen && negativeHasError && <span className="ml-1.5 text-[11px] text-accent">(har fel)</span>}
          {!negativeOpen && !negativeHasError && params.negativePrompt && (
            <span className="ml-1.5 text-[11px]">(ifylld)</span>
          )}
        </summary>
        <textarea
          ref={negativeRef}
          value={params.negativePrompt ?? ''}
          onChange={(e) => set('negativePrompt', e.target.value || undefined)}
          rows={2}
          placeholder="Det du inte vill se…"
          aria-describedby={negativeHasError ? negativeIssuesId : undefined}
          aria-invalid={negativeHasError || undefined}
          className={`mt-2 w-full resize-y rounded-md border bg-raised px-3 py-2 outline-none ${
            negativeHasError ? 'border-accent/50 focus:border-accent/80' : 'border-line focus:border-muted'
          }`}
        />
        <NegativePromptIssues
          id={negativeIssuesId}
          value={params.negativePrompt ?? ''}
          onChange={(v) => set('negativePrompt', v || undefined)}
          textareaRef={negativeRef}
          kind={kind}
          referenceCount={references.length}
          maxImages={maxRefs}
          continuing={continuing}
          onSwitchToReference={switchToReference}
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
