import { useCallback, useEffect, useRef, useState } from 'react'
import type { Asset, AssetInput } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'

const SAVE_DELAY_MS = 500

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }

interface Fields {
  name: string
  description: string
  /** Characters only; null is "no default outfit". */
  defaultOutfitId: string | null
}

function fieldsOf(asset: Asset): Fields {
  return { name: asset.name, description: asset.description, defaultOutfitId: asset.defaultOutfitId ?? null }
}

function sameFields(a: Fields, b: Fields): boolean {
  return a.name === b.name && a.description === b.description && a.defaultOutfitId === b.defaultOutfitId
}

/**
 * Local drafts of one asset's name and description (and a character's default outfit), autosaved after a
 * pause in typing, on blur and when the editor unmounts; a new default outfit is saved right away. Mount
 * one per asset (key the editor by id).
 */
export function useAssetDraft(asset: Asset, onSaved: (a: Asset) => void) {
  const [name, setNameState] = useState(asset.name)
  const [description, setDescriptionState] = useState(asset.description)
  const [defaultOutfitId, setOutfitState] = useState<string | null>(asset.defaultOutfitId ?? null)
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  /** Counts saves that came back, so outside changes held off meanwhile are looked at again. */
  const [settled, setSettled] = useState(0)

  const draft = useRef<Fields>(fieldsOf(asset))
  const saved = useRef<Fields>(fieldsOf(asset))
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seq = useRef(0)
  const inFlight = useRef(0)
  const suspended = useRef(false)
  const onSavedRef = useRef(onSaved)
  const assetRef = useRef(asset)
  useEffect(() => {
    onSavedRef.current = onSaved
    assetRef.current = asset
  })

  /**
   * Adopts outside changes (the trimmed name coming back, the default outfit cleared because that outfit was
   * deleted, an agent renaming the asset) field by field: a field with an edit of ours waiting keeps the edit,
   * every other field follows the asset, also while a field has focus. Otherwise the next save would send
   * the old name back and rename the asset (and its folder) back. Not while a save of ours is under way: an
   * older reply arriving then would undo the newer value; it runs again when the saves are done.
   */
  const reconcile = useCallback(() => {
    if (inFlight.current) return
    const a = assetRef.current
    const outside: Fields = fieldsOf(a)
    const local = draft.current
    const base = saved.current
    const pick = <K extends keyof Fields>(key: K): Fields[K] => (local[key] !== base[key] ? local[key] : outside[key])
    draft.current = { name: pick('name'), description: pick('description'), defaultOutfitId: pick('defaultOutfitId') }
    saved.current = outside
    setNameState(draft.current.name)
    setDescriptionState(draft.current.description)
    setOutfitState(draft.current.defaultOutfitId)
  }, [])

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    if (suspended.current) return
    // An empty name can't be saved; the field is restored on blur, and the other fields save meanwhile.
    const next: Fields = { ...draft.current, name: draft.current.name.trim() || saved.current.name }
    if (sameFields(next, saved.current)) return

    const previous = saved.current
    saved.current = next
    const id = ++seq.current
    setState({ kind: 'saving' })
    inFlight.current += 1
    const input: AssetInput = { id: asset.id, kind: asset.kind, name: next.name, description: next.description }
    // Only when it changed: main keeps the current one otherwise, so a name edit can't bring back an outfit
    // that was deleted meanwhile.
    if (next.defaultOutfitId !== previous.defaultOutfitId) input.defaultOutfitId = next.defaultOutfitId
    window.studio.saveAsset(input).then(
      (a) => {
        inFlight.current -= 1
        onSavedRef.current(a)
        if (id === seq.current) setState({ kind: 'saved' })
        // A change from outside that arrived while this save was under way is taken in once the asset the
        // parent now holds has rendered (see the effect below).
        setSettled((n) => n + 1)
      },
      (e: unknown) => {
        inFlight.current -= 1
        // Let the next edit or blur retry.
        if (saved.current === next) saved.current = previous
        if (id === seq.current) setState({ kind: 'error', message: ipcErrorMessage(e) })
      }
    )
  }, [asset.id, asset.kind])

  // Switching asset or leaving the view must not lose the last keystrokes.
  useEffect(() => () => flush(), [flush])

  const outsideOutfit = asset.defaultOutfitId ?? null
  useEffect(() => reconcile(), [asset.name, asset.description, outsideOutfit, settled, reconcile])

  // "Saved" is only a brief confirmation.
  useEffect(() => {
    if (state.kind !== 'saved') return
    const t = setTimeout(() => setState({ kind: 'idle' }), 2000)
    return () => clearTimeout(t)
  }, [state])

  const schedule = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY_MS)
  }

  const setName = (value: string) => {
    draft.current = { ...draft.current, name: value }
    setNameState(value)
    schedule()
  }

  const setDescription = (value: string) => {
    draft.current = { ...draft.current, description: value }
    setDescriptionState(value)
    schedule()
  }

  /** Characters only. Saved at once, together with any pending name or description edit. */
  const setDefaultOutfit = (id: string | null) => {
    draft.current = { ...draft.current, defaultOutfitId: id }
    setOutfitState(id)
    flush()
  }

  const onBlur = () => {
    const trimmed = draft.current.name.trim()
    const restored = trimmed || saved.current.name
    if (restored !== draft.current.name) {
      draft.current = { ...draft.current, name: restored }
      setNameState(restored)
    }
    flush()
  }

  /** Stops autosaving, e.g. while the asset is being deleted. */
  const suspend = () => {
    suspended.current = true
    clearTimeout(timer.current)
    timer.current = undefined
  }

  const resume = () => {
    suspended.current = false
  }

  return {
    name,
    description,
    defaultOutfitId,
    state,
    setName,
    setDescription,
    setDefaultOutfit,
    onBlur,
    suspend,
    resume
  }
}
