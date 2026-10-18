import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from 'react'
import type { PromptBlockContext } from '@shared/prompt-blocks'
import { usePrompts } from '../../lib/hooks'
import BlockMenu, { blockOptionId } from './BlockMenu'
import { blockChips, blockInsertion, blockSections, slashQueryAt, useLearnings, type BlockItem } from './blocks'

/** The chip that opens every group at once ("More…"). */
export const ALL = 'all'

interface Options {
  context: PromptBlockContext
  textarea: RefObject<HTMLTextAreaElement | null>
  /** Replaces value[start, end) with `text` as one undoable step and puts the caret after it. */
  edit: (start: number, end: number, text: string) => void
  /** Where the character at `index` is on screen (the "/" the menu hangs under); undefined when scrolled away. */
  measure: (index: number) => DOMRect | undefined
}

interface SlashState {
  start: number
  query: string
}

interface ChipState {
  group: string
  anchor: DOMRect
  search: string
  /** The selection when the chip was clicked: the block goes there. */
  at: { start: number; end: number; text: string }
}

export interface BlockMenuControls {
  /** After typing (onChange): opens, follows or closes the "/" menu. */
  onInput: (el: HTMLTextAreaElement) => void
  /** After the caret moved (onSelect): closes the "/" menu when the caret leaves its word. */
  onSelect: (el: HTMLTextAreaElement) => void
  /** Call first in the field's onKeyDown; true when the menu used the key. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  onBlur: () => void
  /** The "/" menu is on screen (for aria-controls / aria-activedescendant on the field). */
  slashOpen: boolean
  menuId: string
  activeId?: string
  /** The chips under the field, and opening one. */
  chips: { id: string; label: string }[]
  openChip: (group: string, button: HTMLElement) => void
  openChipId?: string
  /** The menu itself, to render anywhere (it is a portal). */
  menu: ReactNode
}

/**
 * The building blocks of a prompt field: typing "/" opens a menu at the caret, filtered by what follows; the
 * chips under the field open the same menu for one group, with a search box. Either way the chosen phrase goes in
 * as one step ⌘Z can undo, spaced and comma-separated from the text around it.
 */
export function useBlockMenu({ context, textarea, edit, measure }: Options): BlockMenuControls {
  const menuId = useId()
  const prompts = usePrompts()
  const [slash, setSlash] = useState<SlashState>()
  const [chip, setChip] = useState<ChipState>()
  const [active, setActive] = useState(0)
  /** The "/" whose menu was closed with Esc stays closed until another "/" is typed. */
  const dismissed = useRef<number | null>(null)
  /** Set while a block is being inserted, so the insertion itself doesn't reopen the menu. */
  const inserting = useRef(false)

  const visual = context === 'video' || context === 'image'
  const learnings = useLearnings(visual && (!!slash || !!chip))

  const query = chip ? chip.search : (slash?.query ?? '')
  const sections = useMemo(
    () =>
      slash || chip
        ? blockSections({
            context,
            query,
            group: chip && !chip.search && chip.group !== ALL ? chip.group : undefined,
            prompts,
            learnings
          })
        : [],
    [slash, chip, context, query, prompts, learnings]
  )
  const items = useMemo(() => sections.flatMap((s) => s.items), [sections])
  const activeIndex = items.length ? Math.min(active, items.length - 1) : -1

  // Measured after the text is on screen (the "/" just typed isn't laid out while rendering), again as the query
  // grows; hidden while the "/" is scrolled out of the field.
  const [slashAnchor, setSlashAnchor] = useState<DOMRect>()
  const measureRef = useRef(measure)
  measureRef.current = measure
  useLayoutEffect(() => {
    setSlashAnchor(slash ? measureRef.current(slash.start) : undefined)
  }, [slash])
  const anchor = slash ? slashAnchor : chip?.anchor

  const close = useCallback(() => {
    setSlash(undefined)
    setChip(undefined)
  }, [])

  const insert = (item: BlockItem): void => {
    const el = textarea.current
    if (!el) return
    const value = el.value
    let start: number
    let end: number
    if (slash) {
      start = slash.start
      end = el.selectionStart
    } else if (chip) {
      const at = chip.at.text === value ? chip.at : { start: value.length, end: value.length }
      start = at.start
      end = at.end
    } else return
    const insertion = blockInsertion(value, start, end, item.text)
    dismissed.current = null
    close()
    inserting.current = true
    try {
      edit(insertion.start, insertion.end, insertion.text)
    } finally {
      inserting.current = false
    }
  }

  const follow = (el: HTMLTextAreaElement): void => {
    if (inserting.current) return
    const q = el.selectionStart === el.selectionEnd ? slashQueryAt(el.value, el.selectionStart) : undefined
    if (!q) {
      dismissed.current = null
      setSlash(undefined)
      return
    }
    if (q.start === dismissed.current) return
    setChip(undefined)
    if (slash && slash.start === q.start && slash.query === q.query) return
    setActive(0)
    setSlash(q)
  }

  const move = (step: number): void => {
    if (!items.length) return
    setActive((activeIndex + step + items.length) % items.length)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!slash || !anchor || e.nativeEvent.isComposing) return false
    const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && plain) {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
      return true
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && plain && activeIndex >= 0) {
      e.preventDefault()
      insert(items[activeIndex])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      dismissed.current = slash.start
      setSlash(undefined)
      return true
    }
    return false
  }

  const openChip = (group: string, button: HTMLElement): void => {
    const el = textarea.current
    if (!el) return
    if (chip?.group === group) {
      setChip(undefined)
      return
    }
    setSlash(undefined)
    setActive(0)
    setChip({
      group,
      anchor: button.getBoundingClientRect(),
      search: '',
      at: { start: el.selectionStart, end: el.selectionEnd, text: el.value }
    })
  }

  const chips = useMemo(
    () => blockChips(context, prompts.some((p) => p.body.trim()), visual),
    [context, prompts, visual]
  )

  const menu =
    anchor && (slash || chip) ? (
      <BlockMenu
        id={menuId}
        anchor={anchor}
        sections={sections}
        active={activeIndex}
        onActive={setActive}
        onChoose={insert}
        query={query}
        search={
          chip
            ? {
                value: chip.search,
                onChange: (search) => {
                  setActive(0)
                  setChip((c) => (c ? { ...c, search } : c))
                },
                onKeyDown: (e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    move(e.key === 'ArrowDown' ? 1 : -1)
                  } else if (e.key === 'Enter' && activeIndex >= 0) {
                    e.preventDefault()
                    insert(items[activeIndex])
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    setChip(undefined)
                    textarea.current?.focus()
                  }
                },
                onClose: () => setChip(undefined)
              }
            : undefined
        }
      />
    ) : null

  return {
    onInput: follow,
    onSelect: (el) => {
      if (slash) follow(el)
    },
    onKeyDown,
    onBlur: () => setSlash(undefined),
    slashOpen: !!slash && !!anchor,
    menuId,
    activeId: slash && anchor && activeIndex >= 0 ? blockOptionId(menuId, activeIndex) : undefined,
    chips,
    openChip,
    openChipId: chip?.group,
    menu
  }
}
