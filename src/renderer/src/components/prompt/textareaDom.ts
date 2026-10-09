// DOM helpers for the prompt editor: undoable edits in the textarea, and geometry read from the mirror
// layer (which renders the same text in the same place, one span per highlighted or plain stretch).

/**
 * Replaces textarea.value[start, end) with `text` the way typing would: the browser records it as one step
 * for ⌘Z and fires an input event, so React's onChange sees it like any other edit. Returns false when the
 * browser refused (the caller then sets the value itself, which can't be undone with ⌘Z).
 */
export function replaceRange(el: HTMLTextAreaElement, start: number, end: number, text: string): boolean {
  const expected = el.value.slice(0, start) + text + el.value.slice(end)
  if (document.activeElement !== el) el.focus()
  el.setSelectionRange(start, end)
  if (text) document.execCommand('insertText', false, text)
  else if (end > start) document.execCommand('delete')
  return el.value === expected
}

/** On-screen rectangle of prompt[start, end) (its first line when it wraps), measured in the mirror. */
export function textRect(mirror: HTMLElement, start: number, end: number): DOMRect | undefined {
  for (const child of Array.from(mirror.children)) {
    const el = child as HTMLElement
    const from = Number(el.dataset.start)
    const node = el.firstChild
    if (Number.isNaN(from) || !(node instanceof Text)) continue
    if (start < from || start >= from + node.length) continue
    const range = document.createRange()
    range.setStart(node, start - from)
    range.setEnd(node, Math.min(node.length, Math.max(start - from + 1, end - from)))
    return range.getClientRects()[0] ?? range.getBoundingClientRect()
  }
  return undefined
}

/** The highlighted stretch under the pointer: its mark index and the line box the pointer is on. */
export function markAtPoint(mirror: HTMLElement, x: number, y: number): { mark: number; rect: DOMRect } | undefined {
  const box = mirror.getBoundingClientRect()
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return undefined
  for (const el of Array.from(mirror.querySelectorAll<HTMLElement>('[data-mark]'))) {
    for (const r of Array.from(el.getClientRects())) {
      if (x >= r.left && x <= r.right && y >= r.top - 1 && y <= r.bottom + 1) {
        return { mark: Number(el.dataset.mark), rect: r }
      }
    }
  }
  return undefined
}

export interface FloatingPlace {
  top?: number
  bottom?: number
  left: number
  maxHeight: number
}

const GAP = 4
const MARGIN = 8

/** Where a floating panel goes next to `anchor`: below it unless there is clearly more room above. */
export function placeBeside(anchor: DOMRect, width: number, maxHeight: number, minBelow = 180): FloatingPlace {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.max(MARGIN, Math.min(anchor.left - MARGIN, vw - width - MARGIN))
  const below = vh - anchor.bottom - GAP - MARGIN
  const above = anchor.top - GAP - MARGIN
  if (below >= Math.min(maxHeight, minBelow) || below >= above) {
    return { top: anchor.bottom + GAP, left, maxHeight: Math.max(80, Math.min(maxHeight, below)) }
  }
  return { bottom: vh - anchor.top + GAP, left, maxHeight: Math.max(80, Math.min(maxHeight, above)) }
}

/** Styles a measuring copy needs to wrap text exactly like the textarea. */
const COPIED_STYLES = [
  'boxSizing',
  'width',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'wordSpacing',
  'tabSize'
] as const

/**
 * On-screen rectangle of the character at `index` in a plain textarea (one without the prompt editor's mirror):
 * measured in an invisible copy that wraps the text the same way, then moved to the textarea's place and scroll.
 */
export function caretRect(el: HTMLTextAreaElement, index: number): DOMRect | undefined {
  const style = getComputedStyle(el)
  const copy = document.createElement('div')
  for (const prop of COPIED_STYLES) copy.style[prop] = style[prop]
  copy.style.position = 'absolute'
  copy.style.visibility = 'hidden'
  copy.style.whiteSpace = 'pre-wrap'
  copy.style.overflowWrap = 'break-word'
  copy.style.top = '0'
  copy.style.left = '-9999px'
  copy.textContent = el.value.slice(0, index)
  const mark = document.createElement('span')
  mark.textContent = el.value.slice(index, index + 1) || '​'
  copy.appendChild(mark)
  document.body.appendChild(copy)
  try {
    const box = el.getBoundingClientRect()
    const top = box.top + mark.offsetTop - el.scrollTop
    const left = box.left + mark.offsetLeft - el.scrollLeft
    const height = parseFloat(style.lineHeight) || mark.offsetHeight
    if (top + height < box.top || top > box.bottom) return undefined
    return new DOMRect(left, top, Math.max(1, mark.offsetWidth), height)
  } finally {
    copy.remove()
  }
}
