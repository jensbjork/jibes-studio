import type { SVGProps } from 'react'

// The window's own icons (sidebar, Activity), drawn on the same 16-unit grid as sequences/icons.tsx and
// editor/icons.tsx: 1.5 stroke, round caps. Sized in px; the sidebar shows every icon in a 16 px box.

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Sequences: a strip of film, clips one after the other. */
export function FilmIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
      <path d="M5 2.75v10.5M11 2.75v10.5M1.75 8h3.25M11 8h3.25" />
    </Icon>
  )
}

/** Media: a frame with a play mark in front of another, everything made gathered in one place. */
export function MediaIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.75" y="5" width="10" height="8.25" rx="1.5" />
      <path d="M4.75 2.75h8c.83 0 1.5.67 1.5 1.5v6.25" />
      <path d="M5.75 7.6v3.05l2.6-1.52z" fill="currentColor" strokeWidth={1} />
    </Icon>
  )
}

/** Prompts: a quotation mark, filled like the library's other kinds. */
export function QuoteIcon(props: IconProps) {
  return (
    <Icon {...props} fill="currentColor" stroke="none">
      <path d="M2 8.6C2 5.6 3.6 3.6 6.3 3l.5 1.2C5.3 4.8 4.6 5.8 4.5 7.2h1.6c.8 0 1.4.6 1.4 1.4v2.6c0 .8-.6 1.4-1.4 1.4H3.4c-.8 0-1.4-.6-1.4-1.4V8.6z" />
      <path d="M8.5 8.6c0-3 1.6-5 4.3-5.6l.5 1.2c-1.5.6-2.2 1.6-2.3 3h1.6c.8 0 1.4.6 1.4 1.4v2.6c0 .8-.6 1.4-1.4 1.4H9.9c-.8 0-1.4-.6-1.4-1.4V8.6z" />
    </Icon>
  )
}

/** Settings: a cog. */
export function GearIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.75v1.6M8 12.65v1.6M14.25 8h-1.6M3.35 8h-1.6M12.42 3.58l-1.13 1.13M4.71 11.29l-1.13 1.13M12.42 12.42l-1.13-1.13M4.71 4.71L3.58 3.58" />
      <circle cx="8" cy="8" r="4.6" />
    </Icon>
  )
}

/** Activity while nothing runs: an inbox tray, where finished work lands. */
export function TrayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 9.25l1.6-5.1c.2-.6.7-.9 1.3-.9h6.2c.6 0 1.1.3 1.3.9L14 9.25" />
      <path d="M2 9.25v3c0 .8.6 1.25 1.25 1.25h9.5c.65 0 1.25-.45 1.25-1.25v-3h-3.4l-.9 1.6H6.3l-.9-1.6H2z" />
    </Icon>
  )
}

/** The sidebar toggle: a window with its left column, as macOS draws "sidebar.left". */
export function SidebarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M6 2.75v10.5" />
      <path d="M3.6 5.4h0.9M3.6 7.4h0.9" strokeWidth={1.2} />
    </Icon>
  )
}

/** A picture (a still being made, a board picture) where there is no thumbnail yet. */
export function PictureIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1.2" />
      <path d="M2.5 12l3.8-3.6 2.6 2.4 1.9-1.7 2.7 2.4" />
    </Icon>
  )
}

/** A voice or a sound clip. */
export function WaveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 7v2M5 5v6M7.5 3v10M10 5.5v5M12.5 7v2" />
    </Icon>
  )
}

/** A file on its way in (an import, an agent's upload). */
export function ArrowInIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5v7.5M5 7l3 3 3-3" />
      <path d="M2.75 10.5v1.75c0 .7.55 1.25 1.25 1.25h8c.7 0 1.25-.55 1.25-1.25V10.5" />
    </Icon>
  )
}

/** "Mark as seen". */
export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 8.5l3 3 6-7" />
    </Icon>
  )
}
