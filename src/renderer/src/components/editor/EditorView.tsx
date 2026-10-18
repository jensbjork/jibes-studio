import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditSummary } from '@shared/types'
import { ipcErrorMessage, useModels } from '../../lib/hooks'
import { LAST_EDIT_KEY } from '../../lib/library'
import type { Intent, Navigate } from '../../lib/navigation'
import GenerationPickerDialog from '../feed/GenerationPickerDialog'
import { useImportFlow } from '../feed/ownClips'
import Modal from '../pickers/Modal'
import { Banner } from '../storyboards/ui'
import { ExportPickerDialog, OpenChoiceDialog } from './dialogs'
import EditList from './EditList'
import EditSideList from './EditSideList'
import { DELETE_EDIT_TEXT, editsContaining, editsFrom } from './editorUtils'
import EditWorkspace, { type ShowVersionRequest } from './EditWorkspace'

// The Editor: change one finished film — a clip from the feed, a take, an exported film or the user's own — with free
// local operations and priced AI ones. Every change is a new version; the original is never touched. The list of
// edits is always on the left (as in Sequences); on the right one edit open (remembered, like the open sequence), or
// with none open the overview of them all.

type Source = { generationId: string } | { exportId: string }

interface Notice {
  tone: 'error' | 'warning' | 'success'
  text: string
}

function loadLast(): string | undefined {
  try {
    return localStorage.getItem(LAST_EDIT_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function remember(id: string | undefined): void {
  try {
    if (id) localStorage.setItem(LAST_EDIT_KEY, id)
    else localStorage.removeItem(LAST_EDIT_KEY)
  } catch {
    // Remembering the open edit is only a convenience.
  }
}

interface Props {
  intent?: Intent
  onIntentHandled: () => void
  navigate: Navigate
}

export default function EditorView({ intent, onIntentHandled, navigate }: Props) {
  const { models, error: modelsError } = useModels()
  const [hasApiKey, setHasApiKey] = useState(true)
  // A film to open (a clip, a take, an export) starts on the list, with what is being done, rather than in the edit
  // remembered from last time: that one would otherwise be on screen, and usable, while the film is found or copied in.
  const [openId, setOpenId] = useState<string | undefined>(() =>
    intent?.type === 'open-editor'
      ? intent.editId ?? (intent.generationId || intent.exportId ? undefined : loadLast())
      : loadLast()
  )
  const [edits, setEdits] = useState<EditSummary[]>()
  const [listError, setListError] = useState<string>()
  const [notice, setNotice] = useState<Notice>()
  const [choice, setChoice] = useState<{ source: Source; edits: EditSummary[] }>()
  const [picker, setPicker] = useState<'feed' | 'export'>()
  const [busy, setBusy] = useState<string>()
  const [importing, setImporting] = useState<ReadonlySet<string>>(() => new Set())
  // A version to show in the player once its edit is open (open-editor with versionId).
  const [showVersion, setShowVersion] = useState<ShowVersionRequest & { editId: string }>()
  const imports = useImportFlow()
  /** The edit whose ✕ in the list was clicked: asked about before it goes. */
  const [confirmDelete, setConfirmDelete] = useState<EditSummary>()
  const [deleting, setDeleting] = useState(false)
  const deleteEdit = async (edit: EditSummary) => {
    setDeleting(true)
    try {
      await window.studio.deleteEdit(edit.id)
      try {
        if (localStorage.getItem(LAST_EDIT_KEY) === edit.id) localStorage.removeItem(LAST_EDIT_KEY)
      } catch {
        // Ignore unavailable storage.
      }
      setConfirmDelete(undefined)
      setNotice({ tone: 'success', text: `“${edit.name}” was deleted.` })
    } catch (e) {
      setConfirmDelete(undefined)
      setNotice({ tone: 'error', text: ipcErrorMessage(e) })
    } finally {
      setDeleting(false)
      void reload()
    }
  }

  /**
   * The side list's ✕, after its question in the row; throws, so the row can show the error. The open edit is let go
   * of first (its workspace would otherwise fetch it again and find it gone) and the overview takes its place.
   */
  const removeEdit = async (edit: EditSummary) => {
    const wasOpen = edit.id === openId
    if (wasOpen) setOpenId(undefined)
    try {
      await window.studio.deleteEdit(edit.id)
      if (loadLast() === edit.id) remember(undefined)
    } catch (e) {
      if (wasOpen) setOpenId(edit.id)
      throw e
    } finally {
      void reload()
    }
  }

  useEffect(() => {
    const read = () => void window.studio.getSettings().then((s) => setHasApiKey(s.hasApiKey))
    read()
    return window.studio.onSettingsChange(read)
  }, [])

  // ── The list ──

  const latestList = useRef(0)
  const reload = useCallback(async (): Promise<EditSummary[]> => {
    const n = ++latestList.current
    try {
      const list = await window.studio.listEdits()
      if (n === latestList.current) {
        setEdits(list)
        setListError(undefined)
      }
      return list
    } catch (e) {
      if (n === latestList.current) {
        setEdits((l) => l ?? [])
        setListError(ipcErrorMessage(e))
      }
      return []
    }
  }, [])

  useEffect(() => {
    void reload()
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void reload(), 150)
    }
    const offChange = window.studio.onEditChange(soon)
    const offDelete = window.studio.onGenerationDelete(soon)
    return () => {
      clearTimeout(timer)
      offChange()
      offDelete()
    }
  }, [reload])

  // ── Opening ──

  const open = useCallback((id: string | undefined) => {
    setOpenId(id)
    remember(id)
  }, [])

  /** The edit is gone (deleted, or a remembered one from before): back to the list. */
  const closed = useCallback(
    (id: string) => {
      setOpenId((cur) => (cur === id ? undefined : cur))
      if (loadLast() === id) remember(undefined)
      void reload()
    },
    [reload]
  )

  const create = async (source: Source, name?: string): Promise<string | undefined> => {
    setBusy('exportId' in source ? 'Copying in the film…' : 'Creating the edit…')
    try {
      const edit = await window.studio.createEdit(source, name)
      void reload()
      return edit.id
    } catch (e) {
      setNotice({ tone: 'error', text: ipcErrorMessage(e) })
      return undefined
    } finally {
      setBusy(undefined)
    }
  }

  /**
   * Opens a film in the Editor: the edit it is a version of, else (when edits were already made from it) a choice
   * between them and a new one, else a new edit.
   */
  const openSource = async (source: Source) => {
    const list = await reload()
    if ('generationId' in source) {
      for (const candidate of editsContaining(list, source.generationId)) {
        const edit = await window.studio.getEdit(candidate.id).catch(() => undefined)
        if (edit?.versions.some((v) => v.id === source.generationId)) {
          open(edit.id)
          return
        }
      }
    }
    const existing = editsFrom(list, source)
    if (existing.length) {
      setChoice({ source, edits: existing })
      return
    }
    const id = await create(source)
    if (id) open(id)
  }

  const handled = useRef<Intent>(undefined)
  useEffect(() => {
    if (intent?.type !== 'open-editor' || handled.current === intent) return
    handled.current = intent
    const run = async () => {
      // Whatever edit is open is closed first (it stays remembered until another one opens).
      if (!intent.editId && (intent.generationId || intent.exportId)) setOpenId(undefined)
      if (intent.editId && intent.versionId) {
        setShowVersion({ editId: intent.editId, versionId: intent.versionId, byAgent: intent.source === 'agent' })
      }
      if (intent.editId) open(intent.editId)
      else if (intent.generationId) await openSource({ generationId: intent.generationId })
      else if (intent.exportId) await openSource({ exportId: intent.exportId })
      else open(undefined)
    }
    void run().finally(onIntentHandled)
  }, [intent])

  // ── Own films ──

  const importFilms = async (paths: string[]) => {
    if (!paths.length) return
    setNotice(undefined)
    setImporting((s) => new Set([...s, ...paths]))
    try {
      const outcome = await imports.begin(paths, { kind: 'feed' })
      const ids = outcome.result?.generationIds ?? []
      if (outcome.errors.length) setNotice({ tone: 'error', text: outcome.errors.join(' ') })
      else if (outcome.notes.length) setNotice({ tone: 'warning', text: outcome.notes.join(' ') })
      if (ids.length === 1) {
        await openSource({ generationId: ids[0] })
      } else if (ids.length > 1) {
        // Several films: one edit each (unless one already has one), and the list shows them.
        const list = await reload()
        let made = 0
        for (const id of ids) {
          if (editsFrom(list, { generationId: id }).length) continue
          if (await create({ generationId: id })) made++
        }
        if (made && !outcome.errors.length) {
          setNotice({ tone: 'success', text: `${made} ${made === 1 ? 'edit was created' : 'edits were created'}.` })
        }
      }
    } finally {
      setImporting((s) => {
        const next = new Set(s)
        for (const p of paths) next.delete(p)
        return next
      })
    }
  }

  const pickOwnFilm = async () => {
    try {
      const paths = await window.studio.pickVideos(false)
      // The import's progress shows in the overview: an open edit closes (it stays remembered until another opens).
      if (paths.length) setOpenId(undefined)
      await importFilms(paths)
    } catch (e) {
      setNotice({ tone: 'error', text: ipcErrorMessage(e) })
    }
  }

  // A note that is good to know (not an error) goes away by itself.
  useEffect(() => {
    if (!notice || notice.tone === 'error') return
    const t = setTimeout(() => setNotice(undefined), 8000)
    return () => clearTimeout(t)
  }, [notice])

  // ── Render ──

  const busyText = busy ?? (imports.inspecting ? 'Reading the file…' : undefined)

  return (
    <div className="flex h-full">
      <EditSideList
        edits={edits}
        selectedId={openId}
        busy={!!busyText}
        onSelect={open}
        onOwnFilm={() => void pickOwnFilm()}
        onFromFeed={() => setPicker('feed')}
        onFromExport={() => setPicker('export')}
        onDelete={removeEdit}
      />
      <div className="relative min-w-0 flex-1">
        {openId ? (
          <EditWorkspace
            key={openId}
            editId={openId}
            models={models}
            modelsError={modelsError}
            hasApiKey={hasApiKey}
            navigate={navigate}
            onBack={() => {
              open(undefined)
              void reload()
            }}
            onClosed={closed}
            showVersion={showVersion?.editId === openId ? showVersion : undefined}
          />
        ) : (
          <EditList
            edits={edits}
            error={listError}
            importing={importing}
            busy={busyText}
            onOpen={open}
            onOwnFilm={() => void pickOwnFilm()}
            onDropFiles={(paths, other) => {
              if (!paths.length) {
                setNotice({ tone: 'warning', text: 'Drop a film file (mp4, mov, m4v, webm or mkv).' })
                return
              }
              if (other) setNotice({ tone: 'warning', text: 'Only the film files are opened; the other files were skipped.' })
              void importFilms(paths)
            }}
            onFromFeed={() => setPicker('feed')}
            onFromExport={() => setPicker('export')}
            onDelete={setConfirmDelete}
          />
        )}
        {(notice || (openId && busy)) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
            <div className="pointer-events-auto w-full max-w-xl [&>div]:mx-0">
              {notice ? (
                <Banner tone={notice.tone} onDismiss={() => setNotice(undefined)}>
                  {notice.text}
                </Banner>
              ) : (
                <Banner tone="success">{busy}</Banner>
              )}
            </div>
          </div>
        )}
      </div>
      {confirmDelete && (
        <Modal
          title={`Delete “${confirmDelete.name}”?`}
          onClose={() => !deleting && setConfirmDelete(undefined)}
          footer={
            <>
              <button
                type="button"
                disabled={deleting}
                onClick={() => setConfirmDelete(undefined)}
                className="rounded-md px-3 py-1.5 text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                disabled={deleting}
                onClick={() => void deleteEdit(confirmDelete)}
                className="rounded-md bg-accent px-3 py-1.5 font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
              >
                {deleting ? 'Deleting…' : 'Delete the edit'}
              </button>
            </>
          }
        >
          <p className="leading-relaxed text-muted">{DELETE_EDIT_TEXT}</p>
        </Modal>
      )}
      {imports.dialog}
      <GenerationPickerDialog
        open={picker === 'feed'}
        title="Edit a clip"
        onClose={() => setPicker(undefined)}
        onPicked={(g) => {
          setPicker(undefined)
          void openSource({ generationId: g.id })
        }}
      />
      {picker === 'export' && (
        <ExportPickerDialog
          onClose={() => setPicker(undefined)}
          onPicked={(e) => {
            setPicker(undefined)
            void openSource({ exportId: e.id })
          }}
        />
      )}
      {choice && (
        <OpenChoiceDialog
          edits={choice.edits}
          onClose={() => setChoice(undefined)}
          onOpen={(id) => {
            setChoice(undefined)
            open(id)
          }}
          onNew={() => {
            const source = choice.source
            setChoice(undefined)
            void create(source).then((id) => id && open(id))
          }}
        />
      )}
    </div>
  )
}
