// The app's buttons: four looks and four sizes, so the same kind of button looks the same in every view.
//   primary   – the accent fill, one per region (Generate, Export when it is next, an empty state's way in). Disabled
//               it turns neutral instead of a faded red that reads as an error. It is a `group`, so a price inside can
//               follow it with group-disabled:text-muted.
//   secondary – bordered, the everyday button.
//   ghost     – muted text with a hover background (toolbars, "＋ New").
//   danger    – the armed Delete of a confirmation, nowhere else.
// Sizes: inline (in a line of text or a row), sm (h-7, compact toolbars), md (h-8, the default), lg (h-9: only the
// Generate button and an empty state's way in).
//
// Disabled buttons still take the pointer: their tooltip says why they are disabled. They only lose the hover look.

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'inline' | 'sm' | 'md' | 'lg'

const BASE = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md transition'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'group bg-accent-fill font-medium text-white hover:bg-accent-hover disabled:bg-raised disabled:text-muted',
  secondary: 'border border-line hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent',
  ghost:
    'text-muted hover:bg-raised hover:text-text disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted',
  danger: 'bg-accent-fill font-medium text-white hover:bg-accent-hover disabled:opacity-60'
}

const SIZES: Record<ButtonSize, string> = {
  inline: 'px-1.5 py-0.5 text-[12px]',
  sm: 'h-7 px-2.5 text-[12px]',
  md: 'h-8 px-3',
  lg: 'h-9 px-4'
}

/** The classes of a button: `buttonClass()` is a secondary md one; add layout classes (w-full, ml-auto) after it. */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md'): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]}`
}
