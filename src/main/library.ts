import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { titleFromBody } from '@shared/prompts'
import type { AssetInput, PromptInput, SavedPrompt } from '@shared/types'
import {
  addAssetImages,
  deleteAsset,
  listAssets,
  removeAssetImage,
  reorderAssetImages,
  saveAsset,
  setAssetListeners
} from './assets'
import { getDb } from './db'

export { assetFolderPath, assetWorkBusy } from './assets'

// The library the user builds up themselves: assets (characters, environments, outfits — see assets.ts) and the
// prompt library.

let notifyChange: () => void = () => {}

interface PromptRow {
  id: string
  title: string
  body: string
  negative_prompt: string | null
  tags: string
  favorite: number
  use_count: number
  last_used_at: number | null
  created_at: number
  updated_at: number
}

/** IPC input is untyped at runtime; treat anything that isn't a string as empty. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// ── Prompt library ───────────────────────────────────────────────────────────

function parseTags(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

/** Trimmed, without empties, de-duplicated case-insensitively (the first spelling wins). */
function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    const tag = text(raw).replace(/\s+/g, ' ').trim()
    const key = tag.toLocaleLowerCase('sv')
    if (!tag || seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}

function promptFromRow(r: PromptRow): SavedPrompt {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    negativePrompt: r.negative_prompt ?? undefined,
    tags: parseTags(r.tags),
    favorite: r.favorite !== 0,
    useCount: r.use_count,
    lastUsedAt: r.last_used_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function findPromptRow(id: string): PromptRow | undefined {
  return getDb().prepare('SELECT * FROM prompts WHERE id = ?').get(id) as PromptRow | undefined
}

function getPrompt(id: string): SavedPrompt {
  const row = findPromptRow(id)
  if (!row) throw new Error('Prompten finns inte längre.')
  return promptFromRow(row)
}

function listPrompts(): SavedPrompt[] {
  return (
    getDb().prepare('SELECT * FROM prompts ORDER BY favorite DESC, updated_at DESC, created_at DESC').all() as PromptRow[]
  ).map(promptFromRow)
}

function savePrompt(input: PromptInput): SavedPrompt {
  const body = text(input?.body).trim()
  if (!body) throw new Error('Prompten kan inte vara tom.')
  const title = text(input.title).replace(/\s+/g, ' ').trim() || titleFromBody(body)
  const negativePrompt = text(input.negativePrompt).trim() || null
  const tags = JSON.stringify(normalizeTags(input.tags))
  const favorite = input.favorite ? 1 : 0
  const db = getDb()
  const now = Date.now()

  if (input.id) {
    const existing = findPromptRow(input.id)
    if (!existing) throw new Error('Prompten finns inte längre.')
    const unchanged =
      existing.title === title &&
      existing.body === body &&
      existing.negative_prompt === negativePrompt &&
      existing.tags === tags &&
      existing.favorite === favorite
    if (unchanged) return promptFromRow(existing)
    db.prepare(
      `UPDATE prompts SET title = ?, body = ?, negative_prompt = ?, tags = ?, favorite = ?, updated_at = ?
       WHERE id = ?`
    ).run(title, body, negativePrompt, tags, favorite, now, existing.id)
    notifyChange()
    return getPrompt(existing.id)
  }

  const id = randomUUID()
  db.prepare(
    `INSERT INTO prompts (id, title, body, negative_prompt, tags, favorite, use_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(id, title, body, negativePrompt, tags, favorite, now, now)
  notifyChange()
  return getPrompt(id)
}

function deletePrompt(id: string): void {
  const { changes } = getDb().prepare('DELETE FROM prompts WHERE id = ?').run(id)
  if (changes) notifyChange()
}

function markPromptUsed(id: string): void {
  // A prompt deleted in the meantime is not an error worth surfacing to whoever just used it.
  const now = Date.now()
  const { changes } = getDb()
    .prepare('UPDATE prompts SET use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, id)
  if (changes) notifyChange()
}

// ── IPC ──────────────────────────────────────────────────────────────────────

/**
 * Registers the asset and prompt handlers; notify fires after every change, filesMoved after asset images
 * moved (stored image paths in segment and generation params were rewritten with them).
 */
export function registerLibraryIpc(notify: () => void, filesMoved: () => void = () => {}): void {
  notifyChange = notify
  setAssetListeners({ changed: notify, filesMoved })

  ipcMain.handle('assets:list', (_e, kind?: unknown) => listAssets(kind))
  ipcMain.handle('assets:save', (_e, input: AssetInput) => saveAsset(input))
  ipcMain.handle('assets:delete', (_e, id: string) => deleteAsset(id))
  ipcMain.handle('assets:addImages', (_e, assetId: string, paths: string[]) => addAssetImages(assetId, paths))
  ipcMain.handle('assets:removeImage', (_e, imageId: string) => removeAssetImage(imageId))
  ipcMain.handle('assets:reorderImages', (_e, assetId: string, imageIds: string[]) =>
    reorderAssetImages(assetId, imageIds)
  )

  ipcMain.handle('prompts:list', () => listPrompts())
  ipcMain.handle('prompts:save', (_e, input: PromptInput) => savePrompt(input))
  ipcMain.handle('prompts:delete', (_e, id: string) => deletePrompt(id))
  ipcMain.handle('prompts:markUsed', (_e, id: string) => markPromptUsed(id))
}
