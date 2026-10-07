import type { AssetKind } from '@shared/types'

/**
 * The symbol of each kind (sidebar, empty states): the character glyph, a mountain for environments, a
 * shirt for outfits and a figure in mid-stride for poses. Sized in em, so it follows the surrounding font
 * size like the sidebar's text glyphs.
 */
export default function AssetIcon({ kind }: { kind: AssetKind }) {
  if (kind === 'character') return <span aria-hidden>◉</span>
  return (
    <svg width="1.05em" height="1.05em" viewBox="0 0 16 16" fill="currentColor" aria-hidden className="shrink-0">
      {kind === 'environment' ? (
        <path d="M1 13L6 4l3 5 2-3 4 7z" />
      ) : kind === 'outfit' ? (
        <path d="M5.5 1.5L1 4l1.5 3.2L4 6.5v8h8v-8l1.5.7L15 4l-4.5-2.5C10 2.7 9.1 3.3 8 3.3S6 2.7 5.5 1.5z" />
      ) : (
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
      )}
    </svg>
  )
}
