import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref
} from 'react'
import { maxReferenceAudios, type Kind } from '@shared/models'
import { validatePromptReferences, type ReferenceKind, type ValidateOptions } from '@shared/prompt-refs'
import type { Asset, PromptLanguage } from '@shared/types'
import { KIND_TONE, OWN_IMAGE_TOKEN } from '../pickers/assetKinds'
import type { FormAudio } from '../pickers/audioRefs'
import PromptIssueList from './PromptIssueList'
import {
  applyEdits,
  atQueryAt,
  diffEdit,
  groupInsertText,
  isDisabled,
  markKey,
  mentionedAudioIndices,
  mentionedIndices,
  promptMarks,
  removeRanges,
  segmentsOf,
  spacedInsert,
  tokenMenuSections,
  type AssetGroup,
  type MenuItem,
  type PromptMark,
  type PromptReference,
  type ReferenceGroup,
  type TextRange
} from './promptText'
import { issueViews, type FixAction } from './quickFixes'
import ReferenceStrip from './ReferenceStrip'
import { markAtPoint, replaceRange, textRect } from './textareaDom'
import TokenHoverCard from './TokenHoverCard'
import TokenMenu, { optionId } from './TokenMenu'
import { refreshPromptLanguage } from './usePromptLanguage'

export interface PromptEditorHandle {
  /** Inserts text at the caret (at the end when the text changed since), spaced from its neighbours. */
  insert: (text: string) => void
  focus: () => void
}

interface Props {
  ref?: Ref<PromptEditorHandle>
  id?: string
  value: string
  onChange: (value: string) => void
  /** ⌘/Ctrl+Enter. */
  onSubmit?: () => void
  placeholder?: string
  rows?: number
  /** The selected model's mode; @ImageN and @AudioN tokens only mean something in reference mode. */
  kind: Kind
  /**
   * What the prompt is checked against, exactly as the main process checks it before sending (prompt-refs
   * validationContext of the form's params): reference count, mode, limits, the audio clips' lengths, whether a
   * sequence clip continues from the previous one.
   */
  checks: { referenceCount: number; options: ValidateOptions }
  /** Every reference image in the form, in order (also the ones past the model's limit). */
  references: PromptReference[]
  /** Every reference audio clip in the form, in order (also the ones that aren't sent). */
  audios: FormAudio[]
  /** The model's limit on reference images. */
  maxImages: number
  /** The library assets among the references, and what naming them inserts. */
  groups: AssetGroup[]
  /** The whole library, for "Lägg till från biblioteket" in the "@" menu. */
  library: Asset[]
  /**
   * Adds an asset's photos (and a character's default outfit) to the references, as many as fit. Returns
   * how to name it in the prompt with its new @ImageN numbers, or undefined when none of them fitted.
   */
  onAddFromLibrary?: (asset: Asset) => ReferenceGroup | undefined
  /** Offered as a quick fix when tokens are used outside reference mode. */
  onSwitchToReference?: () => void
  /** Opens the reference picker; offered when tokens are used without reference images. */
  onAddReferences?: () => void
  /** Takes audio clips (1-based @AudioN numbers) out of the form; offered when they are too long or not sent. */
  onRemoveAudio?: (indices: number[]) => void
  /** Switches to a reference model that takes audio (named `audioModelName`); offered when this one doesn't. */
  onUseAudioModel?: () => void
  audioModelName?: string
  /** Prompt language: the words between a character and its voice and clothes ("voice"/"röst", "wearing"/"i"). */
  language: PromptLanguage
  /** Shown right under the text field. */
  belowInput?: ReactNode
}

interface MenuState {
  /** The stretch a choice replaces: the "@word" being typed, or a wrong token. */
  start: number
  end: number
  query: string
  /** Opened by a quick fix to pick the picture (or clip) a wrong token should name. */
  replace: boolean
  /** Only pictures or only clips: what the wrong token is about. */
  only?: ReferenceKind
  /**
   * The word after the caret is part of the "@word" (the caret is inside one that was there already, as in
   * "@Ima|ge3"). Not for an "@" just typed in front of a word ("the @|beach"): choosing must keep "beach".
   */
  tail: boolean
}

/** How long "Ångra" is offered after the prompt was replaced from outside while the user was typing. */
const REPLACED_UNDO_MS = 30_000

/** "\r\n" (from an agent or a stored prompt) as the textarea has it: every offset is worked out on the text. */
function normalizeBreaks(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
}

/** Tokens: colour, background and underline only (no padding or weight), so the mirror's text lines up exactly. */
function markClass(mark: PromptMark, lit: string | undefined): string {
  const glow = lit !== undefined && markKey(mark.ref, mark.index) === lit ? ' ring-1 ring-white/50' : ''
  if (mark.tone === 'error') {
    return (
      'rounded-[3px] bg-accent/15 text-red-300 underline decoration-accent decoration-wavy underline-offset-[3px] ' +
      `[text-decoration-skip-ink:none]${glow}`
    )
  }
  if (mark.tone === 'warning') {
    return 'text-amber-200 underline decoration-amber-400/80 decoration-dotted underline-offset-[3px]'
  }
  // Clips are coloured by their asset like pictures, and underlined so a voice reads apart from a photo.
  const audio = mark.ref === 'audio' ? ' underline decoration-current/60 decoration-dotted underline-offset-[3px]' : ''
  return `rounded-[3px] ${mark.kind ? KIND_TONE[mark.kind].token : OWN_IMAGE_TOKEN}${audio}${glow}`
}

function sameRect(a: DOMRect | undefined, b: DOMRect | undefined): boolean {
  return !!a && !!b && a.left === b.left && a.top === b.top && a.bottom === b.bottom && a.right === b.right
}

/**
 * The prompt field. A transparent textarea (so typing, undo, IME, selection, spell check, resizing and
 * ⌘Enter stay native) over a mirror layer that renders the same text with the @ImageN and @AudioN tokens
 * coloured by the kind of asset they name, and wrong ones red with a wavy underline. Typing "@" opens a menu of
 * the references, the audio clips and library assets next to the caret. Below: the problems with quick fixes,
 * and the key to the reference images and clips with the ones the prompt doesn't mention marked.
 */
export default function PromptEditor({
  ref,
  id,
  value,
  onChange,
  onSubmit,
  placeholder,
  rows = 7,
  kind,
  checks,
  references,
  audios,
  maxImages,
  groups,
  library,
  onAddFromLibrary,
  onSwitchToReference,
  onAddReferences,
  onRemoveAudio,
  onUseAudioModel,
  audioModelName,
  language,
  belowInput
}: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const issuesId = useId()

  // ── Text ───────────────────────────────────────────────────────────────────
  // The field shows its own copy, updated synchronously while typing, so a parent that applies changes a
  // moment later can never move the caret. Values coming back from the parent are adopted unless they are
  // echoes of what this field sent (an older one may arrive after a newer keystroke); see further down.
  // Line breaks are kept as the textarea keeps them, so offsets into `text` are offsets into its value.
  const [text, setText] = useState(() => normalizeBreaks(value))
  const [seenValue, setSeenValue] = useState(value)
  const sent = useRef<string[]>([])
  /**
   * The text replaced from outside while the user was typing in the field, for one "Ångra". It stays offered
   * for a while even if they go on typing: the first keys after the switch are usually typed without noticing it.
   */
  const [replaced, setReplaced] = useState<string>()
  const focused = useRef(false)
  useEffect(() => {
    if (replaced === undefined) return
    const t = setTimeout(() => setReplaced(undefined), REPLACED_UNDO_MS)
    return () => clearTimeout(t)
  }, [replaced])

  const commit = (next: string): void => {
    setText(next)
    sent.current.push(next)
    if (sent.current.length > 50) sent.current.shift()
    onChange(next)
  }

  // Last caret position, tied to the text it was measured in so a stale one isn't reused.
  const caret = useRef<{ start: number; end: number; text: string } | null>(null)
  const rememberCaret = (): void => {
    const el = textarea.current
    if (el) caret.current = { start: el.selectionStart, end: el.selectionEnd, text: el.value }
  }

  // ── Checks and highlighting ──────────────────────────────────────────────────
  const reference = kind === 'reference-to-video'
  // The checks arrive as a fresh object with every render of the form; their content decides.
  const checksKey = JSON.stringify(checks)
  const issues = useMemo(
    () => validatePromptReferences(text, checks.referenceCount, checks.options),
    [text, checksKey]
  )
  const audioInput = reference && checks.options.audioInput !== false
  const maxAudios = checks.options.maxAudios ?? maxReferenceAudios('')
  const marks = useMemo(
    () => promptMarks(text, { references, audios, kind, maxImages, maxAudios, audioInput }, issues),
    [text, references, audios, kind, maxImages, maxAudios, audioInput, issues]
  )
  const segments = useMemo(() => segmentsOf(text.length, marks), [text, marks])
  const mentioned = useMemo(() => mentionedIndices(text), [text])
  const mentionedAudio = useMemo(() => mentionedAudioIndices(text), [text])
  const views = useMemo(
    () =>
      issueViews({
        prompt: text,
        issues,
        references,
        audios,
        groups,
        kind,
        language,
        canSwitchToReference: !!onSwitchToReference,
        canAddReferences: !!onAddReferences,
        canRemoveAudio: !!onRemoveAudio,
        audioModelName: onUseAudioModel ? audioModelName : undefined,
        library: onAddFromLibrary ? library : undefined,
        adviseUnused: true
      }),
    [
      text,
      issues,
      references,
      audios,
      groups,
      kind,
      language,
      !!onSwitchToReference,
      !!onAddReferences,
      !!onRemoveAudio,
      onUseAudioModel ? audioModelName : undefined,
      library,
      !!onAddFromLibrary
    ]
  )
  const hasError = views.some((v) => v.severity === 'error')

  // ── Mirror layer: same box, same scroll position as the textarea ─────────────
  const syncMirror = useCallback(() => {
    const el = textarea.current
    const m = mirror.current
    if (!el || !m) return
    m.style.top = `${el.offsetTop + el.clientTop}px`
    m.style.left = `${el.offsetLeft + el.clientLeft}px`
    m.style.width = `${el.clientWidth}px`
    m.style.height = `${el.clientHeight}px`
    m.scrollTop = el.scrollTop
    m.scrollLeft = el.scrollLeft
  }, [])
  // After every render: new text may have grown the mirror after the textarea already scrolled.
  useLayoutEffect(() => syncMirror())
  /** Measures where the "@" menu hangs again; set while the menu is open (see below). */
  const measureAnchor = useRef<(() => void) | undefined>(undefined)
  useEffect(() => {
    const el = textarea.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      syncMirror()
      // Measured on the mirror as it is now, not as it was when the window's resize event came.
      measureAnchor.current?.()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [syncMirror])

  // ── Hover card and linked highlighting ────────────────────────────────────────
  const [hover, setHover] = useState<{ mark: number; rect: DOMRect }>()
  /** The picture or clip ("image:3", "audio:1") hovered in the key below, whose tokens light up. */
  const [highlighted, setHighlighted] = useState<string>()
  // A hover is tied to the highlighting it was measured on.
  useEffect(() => setHover(undefined), [marks])
  const hoveredMark = hover ? marks[hover.mark] : undefined
  const lit = highlighted ?? (hoveredMark?.tone === 'valid' ? markKey(hoveredMark.ref, hoveredMark.index) : undefined)

  const onMouseMove = (x: number, y: number): void => {
    const m = mirror.current
    if (!m) return
    const hit = markAtPoint(m, x, y)
    setHover((cur) => (cur?.mark === hit?.mark && sameRect(cur?.rect, hit?.rect) ? cur : hit))
  }

  // ── "@" menu ─────────────────────────────────────────────────────────────────
  const [menu, setMenu] = useState<MenuState>()
  /** Index into the menu's items; -1 = the first one that can be chosen. */
  const [active, setActive] = useState(-1)
  /** The "@" whose menu was closed with Esc: it stays closed until another "@" is typed. */
  const dismissed = useRef<number | null>(null)
  /** Set while this editor edits the text itself, so its own insertion doesn't open the menu again. */
  const editing = useRef(false)

  if (value !== seenValue) {
    setSeenValue(value)
    const echo = sent.current.includes(value)
    if (value === sent.current[sent.current.length - 1]) sent.current = []
    const next = normalizeBreaks(value)
    if (!echo && next !== text) {
      // Replaced from outside (an agent's set_form, "Använd igen"). The menu's offsets belonged to the old text,
      // and what the user was typing is gone from the undo history, so it is kept for one "Ångra".
      if (focused.current && text.trim()) setReplaced(text)
      setText(next)
      setMenu(undefined)
      dismissed.current = null
    }
  }

  const sections = useMemo(
    () =>
      menu
        ? tokenMenuSections({
            query: menu.query,
            references,
            audios,
            groups,
            library: onAddFromLibrary ? library : undefined,
            maxImages,
            audioInput,
            only: menu.only
          })
        : [],
    [menu?.query, menu?.only, menu !== undefined, references, audios, groups, library, !!onAddFromLibrary, maxImages, audioInput]
  )
  const items = useMemo(() => sections.flatMap((s) => s.items), [sections])
  const activeIndex =
    active >= 0 && active < items.length && !isDisabled(items[active])
      ? active
      : items.findIndex((item) => !isDisabled(item))

  const openAt = (next: MenuState): void => {
    setMenu(next)
    setActive(-1)
    setHover(undefined)
  }

  /** After typing: open, follow or close the menu for the "@word" at the caret. `before`: the text before it. */
  const followTyping = (el: HTMLTextAreaElement, before: string): void => {
    if (editing.current) {
      setMenu(undefined)
      return
    }
    const q =
      reference && el.selectionStart === el.selectionEnd ? atQueryAt(el.value, el.selectionStart) : undefined
    if (!q) {
      dismissed.current = null
      setMenu(undefined)
    } else if (q.start === dismissed.current) setMenu(undefined)
    else {
      // The "@" was there before this keystroke: the caret is inside an "@word" being edited, all of it goes.
      const tail = menu && !menu.replace && menu.start === q.start ? menu.tail : before[q.start] === '@'
      const end = tail ? q.end : el.selectionStart
      if (!menu || menu.replace || menu.start !== q.start || menu.query !== q.query || menu.end !== end) {
        openAt({ ...q, end, replace: false, tail })
      }
    }
  }

  /** After the caret moved without typing: keep the menu only while the caret stays in its word. */
  const followCaret = (el: HTMLTextAreaElement): void => {
    if (!menu) return
    if (menu.replace) {
      if (el.selectionStart !== menu.start || el.selectionEnd !== menu.end) setMenu(undefined)
      return
    }
    const q = el.selectionStart === el.selectionEnd ? atQueryAt(el.value, el.selectionStart) : undefined
    if (!q || q.start !== menu.start) setMenu(undefined)
    else {
      const end = menu.tail ? q.end : el.selectionStart
      if (q.query !== menu.query || end !== menu.end) openAt({ ...q, end, replace: false, tail: menu.tail })
    }
  }

  // The menu only offers reference images; it goes when the mode changes away from reference mode.
  useEffect(() => {
    if (!reference) setMenu(undefined)
  }, [reference])

  const closeMenu = (escape: boolean): void => {
    if (escape && menu && !menu.replace) dismissed.current = menu.start
    setMenu(undefined)
  }

  // Where the menu hangs: under the "@" (or the token being replaced), following scrolling and resizing.
  const [anchor, setAnchor] = useState<DOMRect>()
  useLayoutEffect(() => {
    if (!menu) {
      setAnchor(undefined)
      return
    }
    const update = (): void => {
      const m = mirror.current
      const el = textarea.current
      const r = m && el ? textRect(m, menu.start, menu.replace ? menu.end : menu.start + 1) : undefined
      const box = el?.getBoundingClientRect()
      // Hidden while the "@" is scrolled out of the field.
      const visible = r && box && r.bottom > box.top && r.top < box.bottom
      setAnchor((cur) => (visible ? (sameRect(cur, r) ? cur : r) : undefined))
    }
    update()
    // Scrolling the field itself and resizing it are measured again once the mirror has followed (onScroll,
    // the ResizeObserver); these catch the page and the window.
    measureAnchor.current = update
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      if (measureAnchor.current === update) measureAnchor.current = undefined
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [menu, text])
  /** The menu is on screen; while its "@" is scrolled out of view, keys go to the text as usual. */
  const menuShown = !!menu && !!anchor

  // ── Edits ────────────────────────────────────────────────────────────────────

  /** Replaces text[start, end) undoably (see replaceRange); falls back to setting the value. */
  const edit = (start: number, end: number, insert: string): void => {
    const el = textarea.current
    if (!el) return
    const next = el.value.slice(0, start) + insert + el.value.slice(end)
    editing.current = true
    try {
      if (replaceRange(el, start, end, insert)) return
    } finally {
      editing.current = false
    }
    commit(next)
    const pos = start + insert.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const setValueUndoable = (next: string): void => {
    const el = textarea.current
    if (!el) return
    const change = diffEdit(el.value, next)
    if (change) edit(change.start, change.end, change.text)
  }

  const insertAtCaret = (insert: string): void => {
    const el = textarea.current
    if (!el) return
    const current = el.value
    const sel = caret.current?.text === current ? caret.current : { start: current.length, end: current.length }
    edit(sel.start, sel.end, spacedInsert(current.slice(0, sel.start), current.slice(sel.end), insert))
    rememberCaret()
  }

  useImperativeHandle(ref, () => ({
    insert: insertAtCaret,
    focus: () => textarea.current?.focus()
  }))

  const choose = (item: MenuItem): void => {
    const el = textarea.current
    const m = menu
    if (!el || !m || isDisabled(item)) return
    const before = el.value.slice(0, m.start)
    let insert: string
    if (item.type === 'image') insert = `@Image${item.reference.index}`
    else if (item.type === 'audio') insert = `@Audio${item.audio.index}`
    else if (item.type === 'group') insert = groupInsertText(item.group, language, before)
    else {
      const added = onAddFromLibrary?.(item.asset)
      if (!added) {
        setMenu(undefined)
        return
      }
      insert = groupInsertText(added, language, before)
    }
    const after = el.value.slice(m.end)
    // A space after it, unless punctuation follows or the brackets around it are being written by hand.
    if (!m.replace && !/\(\s*$/.test(before) && (!after || !/^[\s,.;:!?)]/.test(after))) insert += ' '
    setMenu(undefined)
    dismissed.current = null
    edit(m.start, m.end, insert)
    rememberCaret()
  }

  /** Selects a stretch of the prompt and scrolls it into view. */
  const reveal = (range: TextRange): void => {
    const el = textarea.current
    const m = mirror.current
    if (!el) return
    el.focus()
    el.setSelectionRange(range.start, range.end)
    syncMirror()
    const r = m && textRect(m, range.start, range.end)
    if (r) {
      const box = el.getBoundingClientRect()
      if (r.top < box.top + el.clientTop) el.scrollTop -= box.top + el.clientTop + 8 - r.top
      else if (r.bottom > box.top + el.clientTop + el.clientHeight) {
        el.scrollTop += r.bottom - (box.top + el.clientTop + el.clientHeight) + 8
      }
    }
    rememberCaret()
  }

  const runFix = (action: FixAction): void => {
    const el = textarea.current
    // Fixes are worked out for the text on screen; never apply them to anything else.
    if (!el || el.value !== text) return
    switch (action.type) {
      case 'edit':
        setValueUndoable(applyEdits(el.value, action.edits))
        break
      case 'remove':
        setValueUndoable(removeRanges(el.value, action.ranges))
        break
      case 'insert':
        insertAtCaret(action.text)
        break
      case 'add-asset': {
        const added = onAddFromLibrary?.(action.asset)
        if (added) {
          const { start, end } = action.range
          edit(start, end, groupInsertText(added, language, el.value.slice(0, start)))
          rememberCaret()
        }
        break
      }
      case 'choose':
        reveal(action.range)
        openAt({
          start: action.range.start,
          end: action.range.end,
          query: '',
          replace: true,
          tail: true,
          ...(action.ref ? { only: action.ref } : {})
        })
        break
      case 'switch-to-reference':
        onSwitchToReference?.()
        break
      case 'add-references':
        onAddReferences?.()
        break
      case 'remove-audio':
        onRemoveAudio?.(action.indices)
        break
      case 'use-audio-model':
        onUseAudioModel?.()
        break
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (menuShown) {
      const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && plain) {
        const enabled = items.flatMap((item, i) => (isDisabled(item) ? [] : [i]))
        if (!enabled.length) return
        e.preventDefault()
        const at = enabled.indexOf(activeIndex)
        const step = e.key === 'ArrowDown' ? 1 : -1
        const next = at === -1 ? (step === 1 ? 0 : enabled.length - 1) : (at + step + enabled.length) % enabled.length
        setActive(enabled[next])
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && plain) {
        const item = items[activeIndex]
        if (item) {
          e.preventDefault()
          choose(item)
          return
        }
        setMenu(undefined)
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeMenu(true)
        return
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      setMenu(undefined)
      onSubmit?.()
    }
  }

  const hoverReference =
    hoveredMark?.index !== undefined && reference && hoveredMark.ref !== 'audio'
      ? references[hoveredMark.index - 1]
      : undefined
  const hoverAudio =
    hoveredMark?.index !== undefined && reference && hoveredMark.ref === 'audio' ? audios[hoveredMark.index - 1] : undefined

  return (
    <div>
      <div className="relative rounded-md bg-raised">
        <div
          ref={mirror}
          aria-hidden
          className="pointer-events-none absolute overflow-hidden px-3 py-2 leading-relaxed text-text"
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'normal' }}
        >
          {segments.map((s) =>
            s.mark === undefined ? (
              <span key={s.start} data-start={s.start}>
                {text.slice(s.start, s.end)}
              </span>
            ) : (
              <span key={s.start} data-start={s.start} data-mark={s.mark} className={markClass(marks[s.mark], lit)}>
                {text.slice(s.start, s.end)}
              </span>
            )
          )}
          {/* Gives a trailing line break its line, and room so the mirror can scroll as far as the field. */}
          <span>{'\u200b'}</span>
          <div className="h-8" />
        </div>
        <textarea
          ref={textarea}
          id={id}
          value={text}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => {
            commit(e.target.value)
            rememberCaret()
            setHover(undefined)
            followTyping(e.currentTarget, text)
          }}
          onSelect={(e) => {
            rememberCaret()
            followCaret(e.currentTarget)
          }}
          onKeyDown={onKeyDown}
          onScroll={() => {
            syncMirror()
            measureAnchor.current?.()
            setHover(undefined)
          }}
          onMouseMove={(e) => onMouseMove(e.clientX, e.clientY)}
          onMouseLeave={() => setHover(undefined)}
          onFocus={() => {
            focused.current = true
            refreshPromptLanguage()
          }}
          onBlur={() => {
            focused.current = false
            setMenu(undefined)
          }}
          aria-autocomplete={reference ? 'list' : undefined}
          aria-controls={menuShown ? menuId : undefined}
          aria-activedescendant={menuShown && activeIndex >= 0 ? optionId(menuId, activeIndex) : undefined}
          aria-describedby={views.length ? issuesId : undefined}
          aria-invalid={hasError || undefined}
          className={`relative block w-full resize-y rounded-md border bg-transparent px-3 py-2 leading-relaxed text-transparent caret-text outline-none placeholder:text-muted selection:bg-sky-500/35 selection:text-transparent ${
            hasError ? 'border-accent/50 focus:border-accent/80' : 'border-line focus:border-muted'
          }`}
        />
      </div>

      {replaced !== undefined && replaced !== text && (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
          <span className="min-w-0 truncate">Prompten ersattes medan du skrev (av agenten eller Studio).</span>
          <button
            onClick={() => {
              setReplaced(undefined)
              setValueUndoable(replaced)
            }}
            className="ml-auto shrink-0 text-text hover:underline"
          >
            Ångra
          </button>
        </div>
      )}

      {belowInput}

      <PromptIssueList id={issuesId} issues={views} onFix={runFix} onReveal={reveal} />

      {reference && (
        <ReferenceStrip
          references={references}
          audios={audios}
          mentioned={mentioned}
          mentionedAudio={mentionedAudio}
          showUnused={!!text.trim()}
          maxImages={maxImages}
          highlighted={lit}
          onHighlight={setHighlighted}
          onInsert={insertAtCaret}
        />
      )}

      {menuShown && (
        <TokenMenu
          id={menuId}
          anchor={anchor}
          sections={sections}
          active={activeIndex}
          onActive={setActive}
          onChoose={choose}
          query={menu.query}
          replacing={menu.replace}
          only={menu.only}
          noReferences={!references.length}
        />
      )}

      {hover && hoveredMark && !menu && (
        <TokenHoverCard mark={hoveredMark} reference={hoverReference} audio={hoverAudio} rect={hover.rect} />
      )}
    </div>
  )
}
