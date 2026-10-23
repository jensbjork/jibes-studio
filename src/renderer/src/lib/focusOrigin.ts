// How the focused element got its focus: with the keyboard (Tab, arrow keys) or by a click. A player's keys go to a
// button only when it was reached with the keyboard; one that has focus because it was clicked leaves Space and the
// arrow keys to the player (the Editor, Sequences, the viewers), and the Editor's tabs only take ← → after Tab.
// Chromium's :focus-visible can't tell the two apart: any key press turns it on for the element that has focus, so
// the very Space meant for the player would press the clicked button again.

let lastInput: 'keyboard' | 'pointer' = 'pointer'
let keyboardFocused: EventTarget | null = null
/** What had focus when the window lost it: getting it back (switching apps) doesn't change how it got there. */
let leftWith: EventTarget | null = null
let installed = false

/** Starts following the input (once; capture-phase listeners on the window, before any handler of the page). */
export function trackFocusOrigin(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', () => (lastInput = 'keyboard'), true)
  window.addEventListener(
    'pointerdown',
    () => {
      lastInput = 'pointer'
      leftWith = null
    },
    true
  )
  window.addEventListener('blur', (e) => {
    if (e.target === window) leftWith = document.activeElement
  })
  window.addEventListener(
    'focusin',
    (e) => {
      const back = e.target === leftWith
      leftWith = null
      if (!back) keyboardFocused = lastInput === 'keyboard' ? e.target : null
    },
    true
  )
}

/** Whether `el` has focus and got it from the keyboard. */
export function focusedWithKeyboard(el: EventTarget | null): boolean {
  return !!el && el === keyboardFocused && el === document.activeElement
}

/**
 * Focus given back by code (a dialog closing returns it to where it was): `el` gets the focus if it hasn't, and
 * counts as reached the way it was before – not by the key that closed the dialog, which would otherwise make a
 * clicked button take the player's Space.
 */
export function refocused(el: HTMLElement, byKeyboard: boolean): void {
  if (document.activeElement !== el) el.focus({ preventScroll: true })
  if (document.activeElement === el) keyboardFocused = byKeyboard ? el : null
}
