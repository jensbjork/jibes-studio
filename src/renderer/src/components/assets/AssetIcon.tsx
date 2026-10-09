import type { AssetKind } from '@shared/types'

interface Props {
  kind: AssetKind
  /**
   * Width and height: a CSS length or px. Default 1.05em, so it follows the surrounding font size (chips, tabs,
   * menus); the sidebar passes 16 to sit on its 16 px icon grid with the window's other icons.
   */
  size?: number | string
}

/**
 * The symbol of each kind (sidebar, picker tabs, chips, empty states), on the same 16-unit grid as the window's
 * other icons: a ringed dot for characters, a mountain for environments, a box for products, a shirt for outfits
 * and a figure in mid-stride for poses. Every kind has its own branch, so a kind added later can't silently take
 * another kind's symbol.
 */
export default function AssetIcon({ kind, size = '1.05em' }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden className="shrink-0">
      {kind === 'character' ? (
        // The circled dot the sidebar has always used for characters (◉), drawn so it lines up with the others.
        <>
          <circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" strokeWidth={1.5} />
          <circle cx="8" cy="8" r="3.1" />
        </>
      ) : kind === 'environment' ? (
        <path d="M1 13L6 4l3 5 2-3 4 7z" />
      ) : kind === 'product' ? (
        // A filled box seen from above at an angle; its inner edges are cut out in the panel colour so it reads as
        // a package at sidebar size.
        <>
          <path d="M8 1l6.5 3.2v7.6L8 15l-6.5-3.2V4.2z" />
          <path
            d="M1.5 4.2L8 7.4l6.5-3.2M8 7.4V15"
            fill="none"
            stroke="var(--color-panel)"
            strokeWidth={1.2}
            strokeLinejoin="round"
          />
        </>
      ) : kind === 'outfit' ? (
        <path d="M5.5 1.5L1 4l1.5 3.2L4 6.5v8h8v-8l1.5.7L15 4l-4.5-2.5C10 2.7 9.1 3.3 8 3.3S6 2.7 5.5 1.5z" />
      ) : kind === 'pose' ? (
        // A figure in mid-pose: one arm raised, one bent out, legs apart. Reads as "a body position" even at
        // sidebar size, where a second figure would blur into the first.
        <>
          <circle cx="8.4" cy="2.4" r="1.75" />
          <path
            d="M12.8 2.6L8.2 5.2 5 6.6 3 5.4M8.2 5.2l-.6 4.4-2.2 2.4-1 2.8M7.6 9.6l2.4 2 1.2 3"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
    </svg>
  )
}
