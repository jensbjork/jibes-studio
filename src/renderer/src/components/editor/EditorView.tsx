import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { EditSummary } from '@shared/types'
import { useAgentPillVisible } from '../../lib/agent'
import { ipcErrorMessage, useHasApiKey, useModels } from '../../lib/hooks'
import { LAST_EDIT_KEY } from '../../lib/library'
import type { Intent, Navigate } from '../../lib/navigation'
import GenerationPickerDialog from '../feed/GenerationPickerDialog'
import { carriesFiles, droppedVideoPaths, useImportFlow } from '../feed/ownClips'
import { FloatingBanner, type NoticeTone } from '../ui/Banner'
import { ExportPickerDialog, OpenChoiceDialog } from './dialogs'
import EditList from './EditList'
import EditSideList from './EditSideList'
import { editsContaining, editsFrom } from './editorUtils'
import EditWorkspace, { type EditorNotice, type ShowVersionRequest } from './EditWorkspace'

// The Editor: change one finished film – a clip from Media, a take, an exported film or the user's own – with free
// local operations and priced AI ones. Every change is a new version; the original is never touched. The list of
// edits is always on the left (as in Sequences); on the right one edit is open – the remembered one, else the most
// recently changed – and "All edits" in its header shows the overview of them all instead. The overview also shows
// while there are no edits, and while a film is being found or brought in (until an edit is opened meanwhile: then
// that edit stays, and what comes in is offered in a notice). A film file dropped anywhere in the Editor is opened as
// an own film. Notices float at the bottom, one at a time.

type Source = { generationId: string } | { exportId: string }

interface Notice {
  /** Each notice its own, so a new one starts its own time (FloatingBanner). */
  id: number
  tone: NoticeTone
  text: ReactNode
  /** From the open edit: it goes when another edit opens. */
  editId?: string
}

let noticeCount = 0

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
  const hasApiKey = useHasApiKey()
  // A film to open (a clip, a take, an export) starts on the list, with what is being done, rather than in the edit
  // remembered from last time: that one would otherwise be on screen, and usable, while the film is found or copied in.
  const [openId, setOpenId] = useState<string | undefined>(() =>
    intent?.type === 'open-editor'
      ? intent.editId ?? (intent.generationId || intent.exportId ? undefined : loadLast())
      : loadLast()
  )
  // "All edits": the overview in place of the open edit (which stays the selected one).
  const [showAll, setShowAll] = useState(false)
  // Films being found, read or copied in (an intent, an import): no edit opens by itself meanwhile.
  const [resolving, setResolving] = useState(0)
  const [edits, setEdits] = useState<EditSummary[]>()
  const [listError, setListError] = useState<string>()
  const [notice, setNotice] = useState<Notice>()
  const [choice, setChoice] = useState<{ source: Source; edits: EditSummary[] }>()
  const [picker, setPicker] = useState<'feed' | 'export'>()
  const [busy, setBusy] = useState<string>()
  const [importing, setImporting] = useState<ReadonlySet<string>>(() => new Set())
  // An edit opened while films are being brought in: it shows in place of the overview, and the import offers what it
  // brought in rather than opening it over that edit. Each import (and "All edits") starts without one. The ref is
  // for the import, which reads it when it ends.
  const [picked, setPicked] = useState(false)
  const pickedRef = useRef(false)
  const setPick = useCallback((value: boolean) => {
    pickedRef.current = value
    setPicked(value)
  }, [])
  // A version to show in the player once its edit is open (open-editor with versionId).
  const [showVersion, setShowVersion] = useState<ShowVersionRequest & { editId: string }>()
  const imports = useImportFlow()
  // Edits deleted or found gone here: never opened by themselves, even while the list hasn't caught up.
  const gone = useRef(new Set<string>())
  // Above the agent's pill while it is on screen, like the seen toast and the update notice.
  const lifted = useAgentPillVisible()

  const notify = useCallback((tone: NoticeTone, text: ReactNode, editId?: string) => {
    setNotice({ id: ++noticeCount, tone, text, editId })
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

  const open = useCallback(
    (id: string | undefined) => {
      setOpenId(id)
      setShowAll(false)
      remember(id)
      if (id) setPick(true)
    },
    [setPick]
  )

  /** The edit is gone (deleted elsewhere, or a remembered one from before): another one opens in its place. */
  const closed = useCallback(
    (id: string) => {
      gone.current.add(id)
      setOpenId((cur) => (cur === id ? undefined : cur))
      if (loadLast() === id) remember(undefined)
      void reload()
    },
    [reload]
  )

  /**
   * Deletes an edit: the side list's ✕ (after its question in the row, with the row that takes its place) and Delete…
   * in the edit's ⋯. Throws, so the row can show the error. The open edit is let go of first (its workspace would
   * otherwise fetch it again and find it gone), and its neighbour in the list takes its place – behind the overview,
   * when that is on screen.
   */
  const removeEdit = async (id: string, nextId?: string) => {
    const wasOpen = id === openId
    const rest = (edits ?? []).filter((e) => e.id === id || !gone.current.has(e.id))
    const at = rest.findIndex((e) => e.id === id)
    const neighbour = nextId ?? (at === -1 ? undefined : (rest[at + 1] ?? rest[at - 1])?.id)
    gone.current.add(id)
    if (wasOpen) {
      setOpenId(neighbour)
      remember(neighbour)
    }
    try {
      await window.studio.deleteEdit(id)
      if (loadLast() === id) remember(undefined)
    } catch (e) {
      gone.current.delete(id)
      if (wasOpen) {
        setOpenId(id)
        remember(id)
      }
      throw e
    } finally {
      void reload()
    }
  }

  // Nothing open (the first visit, or the open one went): the remembered edit, else the most recently changed one
  // (the list is newest change first), as Sequences and Storyboards open theirs. Not while a film is being found or
  // brought in, or the overview was asked for. Before the paint, so the overview doesn't flash up first.
  const busyText = busy ?? (imports.inspecting ? 'Reading the file…' : undefined)
  useLayoutEffect(() => {
    if (openId || showAll || resolving || choice || busyText || importing.size || !edits) return
    const usable = edits.filter((e) => !gone.current.has(e.id))
    const last = loadLast()
    const first = usable.find((e) => e.id === last) ?? usable[0]
    if (first) open(first.id)
  }, [openId, showAll, resolving, choice, busyText, importing, edits, open])

  // A notice about the open edit doesn't stay for the next one.
  useEffect(() => {
    setNotice((n) => (n?.editId && n.editId !== openId ? undefined : n))
  }, [openId])

  const create = async (source: Source, name?: string): Promise<string | undefined> => {
    setBusy('exportId' in source ? 'Copying in the film…' : 'Creating the edit…')
    try {
      const edit = await window.studio.createEdit(source, name)
      void reload()
      return edit.id
    } catch (e) {
      notify('error', ipcErrorMessage(e))
      return undefined
    } finally {
      setBusy(undefined)
    }
  }

  /**
   * Opens a film in the Editor: the edit it is a version of, else (when edits were already made from it) a choice
   * between them and a new one, else a new edit. `present` does the opening (or the asking): an import passes its own,
   * which offers it instead when an edit was opened meanwhile.
   */
  const openSource = async (source: Source, present: (go: () => void) => void = (go) => go()) => {
    const list = await reload()
    if ('generationId' in source) {
      for (const candidate of editsContaining(list, source.generationId)) {
        const edit = await window.studio.getEdit(candidate.id).catch(() => undefined)
        if (edit?.versions.some((v) => v.id === source.generationId)) {
          present(() => open(edit.id))
          return
        }
      }
    }
    const existing = editsFrom(list, source)
    if (existing.length) {
      present(() => setChoice({ source, edits: existing }))
      return
    }
    const id = await create(source)
    if (id) present(() => open(id))
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
    setResolving((n) => n + 1)
    void run().finally(() => {
      setResolving((n) => n - 1)
      onIntentHandled()
    })
  }, [intent])

  // ── Own films ──

  /** What an import brought in while an edit was opened meanwhile: offered, rather than shown over that edit. */
  const offer = (text: string, label: string, go: () => void) =>
    notify(
      'success',
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{text}</span>
        <button
          type="button"
          onClick={() => {
            setNotice(undefined)
            go()
          }}
          className="rounded border border-emerald-400/40 px-2 py-0.5 font-medium hover:bg-emerald-400/10"
        >
          {label}
        </button>
      </span>
    )

  const importFilms = async (paths: string[]) => {
    if (!paths.length) return
    setResolving((n) => n + 1)
    setPick(false)
    setNotice(undefined)
    setImporting((s) => new Set([...s, ...paths]))
    try {
      const outcome = await imports.begin(paths, { kind: 'feed' })
      const ids = outcome.result?.generationIds ?? []
      if (outcome.errors.length) notify('error', outcome.errors.join(' '))
      else if (outcome.notes.length) notify('warning', outcome.notes.join(' '))
      // An error stays on screen; what came in is in the list all the same.
      const quiet = !!outcome.errors.length
      if (ids.length === 1) {
        await openSource({ generationId: ids[0] }, (go) => {
          if (!pickedRef.current) go()
          else if (!quiet) offer('Your film is ready to edit.', 'Open', go)
        })
      } else if (ids.length > 1) {
        // Several films: one edit each (unless one already has one), and the overview shows them.
        const list = await reload()
        let made = 0
        for (const id of ids) {
          if (editsFrom(list, { generationId: id }).length) continue
          if (await create({ generationId: id })) made++
        }
        const done = made ? `${made} ${made === 1 ? 'edit was created' : 'edits were created'}.` : ''
        if (pickedRef.current) {
          if (!quiet) offer(done || 'Your films are ready to edit.', 'All edits', () => setShowAll(true))
        } else {
          setShowAll(true)
          if (done && !quiet) notify('success', done)
        }
      }
    } finally {
      setImporting((s) => {
        const next = new Set(s)
        for (const p of paths) next.delete(p)
        return next
      })
      setResolving((n) => n - 1)
    }
  }

  // The import's progress shows in the overview (until an edit is opened); the open edit is back if nothing new opens.
  const pickOwnFilm = async () => {
    try {
      await importFilms(await window.studio.pickVideos(false))
    } catch (e) {
      notify('error', ipcErrorMessage(e))
    }
  }

  const dropFiles = (paths: string[], other: boolean) => {
    if (!paths.length) {
      notify('warning', 'Drop a film file (mp4, mov, m4v, webm or mkv).')
      return
    }
    void importFilms(paths)
    // After the import has cleared the last notice.
    if (other) notify('warning', 'Only the film files are opened; the other files were skipped.')
  }

  // A film dropped anywhere in the Editor, an edit open or not. A drop something inside took care of is its own.
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const onDragEnter = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    depth.current += 1
    setOver(true)
  }
  const onDragLeave = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (!depth.current) setOver(false)
  }
  const onDragOver = (e: DragEvent) => {
    if (!carriesFiles(e) || e.defaultPrevented) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    depth.current = 0
    setOver(false)
    if (e.defaultPrevented) return
    e.preventDefault()
    const { paths, other } = droppedVideoPaths(e)
    dropFiles(paths, other)
  }

  // ── Render ──

  const onWorkspaceNotice = useCallback((n: EditorNotice) => notify(n.tone, n.text, openId), [notify, openId])
  // The overview in place of the open edit; while only an import puts it there, the side list keeps its selection.
  const listShown = !openId || showAll || (importing.size > 0 && !picked)
  const selectedId = !openId || showAll ? undefined : openId

  return (
    <div
      className="relative flex h-full"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <EditSideList
        edits={edits}
        selectedId={selectedId}
        busy={!!busyText}
        onSelect={open}
        onOwnFilm={() => void pickOwnFilm()}
        onFromFeed={() => setPicker('feed')}
        onFromExport={() => setPicker('export')}
        onDelete={(edit, next) => removeEdit(edit.id, next?.id)}
      />
      <div className="relative min-w-0 flex-1">
        {listShown || !openId ? (
          <EditList
            edits={edits}
            error={listError}
            importing={importing}
            busy={busyText}
            onOpen={open}
            onOwnFilm={() => void pickOwnFilm()}
            onFromFeed={() => setPicker('feed')}
            onFromExport={() => setPicker('export')}
          />
        ) : (
          <EditWorkspace
            key={openId}
            editId={openId}
            models={models}
            modelsError={modelsError}
            hasApiKey={hasApiKey}
            navigate={navigate}
            onShowAll={() => {
              setShowAll(true)
              // Back to an import's progress: what it brings in opens when it is done.
              setPick(false)
            }}
            // The menu that asked is gone with the edit by the time an error comes back: it floats instead.
            onDelete={() => removeEdit(openId).catch((e: unknown) => notify('error', ipcErrorMessage(e)))}
            onClosed={closed}
            onNotice={onWorkspaceNotice}
            showVersion={showVersion?.editId === openId ? showVersion : undefined}
          />
        )}
        {notice ? (
          <FloatingBanner key={notice.id} tone={notice.tone} onDismiss={() => setNotice(undefined)} lifted={lifted}>
            {notice.text}
          </FloatingBanner>
        ) : (
          // Under the open edit, what is being done (the overview says it in its header).
          !listShown &&
          busyText && (
            <FloatingBanner tone="info" lifted={lifted}>
              {busyText}
            </FloatingBanner>
          )
        )}
      </div>
      {over && (
        <div className="pointer-events-none absolute inset-3 top-14 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-bg/80">
          <p className="text-base">Drop to open as your own film</p>
        </div>
      )}
      {imports.dialog}
      <GenerationPickerDialog
        open={picker === 'feed'}
        title="Edit a clip from Media"
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
