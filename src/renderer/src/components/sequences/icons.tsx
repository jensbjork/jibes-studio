import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 14, children, ...rest }: IconProps) {
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
      {...rest}
    >
      {children}
    </svg>
  )
}

export function LinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 9.5l3-3" />
      <path d="M7.2 4.6l1.1-1.1a2.6 2.6 0 013.7 3.7l-1.1 1.1" />
      <path d="M8.8 11.4l-1.1 1.1A2.6 2.6 0 014 8.8l1.1-1.1" />
    </Icon>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3v10M3 8h10" />
    </Icon>
  )
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props} fill="currentColor" stroke="none">
      <path d="M4.5 2.8v10.4a.6.6 0 00.9.5l8.2-5.2a.6.6 0 000-1L5.4 2.3a.6.6 0 00-.9.5z" />
    </Icon>
  )
}

export function PauseIcon(props: IconProps) {
  return (
    <Icon {...props} fill="currentColor" stroke="none">
      <rect x="3.5" y="2.5" width="3" height="11" rx=".6" />
      <rect x="9.5" y="2.5" width="3" height="11" rx=".6" />
    </Icon>
  )
}

export function PrevIcon(props: IconProps) {
  return (
    <Icon {...props} fill="currentColor" stroke="none">
      <rect x="2.5" y="3" width="1.8" height="10" rx=".5" />
      <path d="M13 3.6v8.8a.6.6 0 01-.9.5L5.6 8.5a.6.6 0 010-1l6.5-4.4a.6.6 0 01.9.5z" />
    </Icon>
  )
}

export function NextIcon(props: IconProps) {
  return (
    <Icon {...props} fill="currentColor" stroke="none">
      <rect x="11.7" y="3" width="1.8" height="10" rx=".5" />
      <path d="M3 3.6v8.8a.6.6 0 00.9.5l6.5-4.4a.6.6 0 000-1L3.9 3.1a.6.6 0 00-.9.5z" />
    </Icon>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  )
}

export function FilmIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 3v10M11 3v10M2 6.3h3M2 9.7h3M11 6.3h3M11 9.7h3" />
    </Icon>
  )
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 8h10.5M9.5 4.5L13 8l-3.5 3.5" />
    </Icon>
  )
}

/** Drag handle: two columns of dots. */
export function GripIcon(props: IconProps) {
  return (
    <Icon {...props} fill="currentColor" stroke="none">
      <circle cx="6" cy="4" r="1.1" />
      <circle cx="10" cy="4" r="1.1" />
      <circle cx="6" cy="8" r="1.1" />
      <circle cx="10" cy="8" r="1.1" />
      <circle cx="6" cy="12" r="1.1" />
      <circle cx="10" cy="12" r="1.1" />
    </Icon>
  )
}

/** "Gör om mellan grannarna": a clip redone between two fixed neighbours. */
export function BridgeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.5" y="5" width="3" height="6" rx=".8" />
      <rect x="11.5" y="5" width="3" height="6" rx=".8" />
      <path d="M6.5 9.5a2 2 0 003 0M6.5 6.5a2 2 0 013 0" strokeDasharray="1.6 1.4" />
    </Icon>
  )
}

export function MoreIcon(props: IconProps) {
  return (
    <Icon {...props} fill="currentColor" stroke="none">
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </Icon>
  )
}

export function ImageIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1.2" />
      <path d="M2.5 12l3.8-3.6 2.6 2.4 1.9-1.7 2.7 2.4" />
    </Icon>
  )
}

/** The storyboard view: panels in a grid. */
export function GridIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="2.5" width="5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="5" height="4.5" rx="1" />
      <rect x="2" y="9" width="5" height="4.5" rx="1" />
      <rect x="9" y="9" width="5" height="4.5" rx="1" />
    </Icon>
  )
}

/** The timeline view: clips in a row. */
export function StripIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.5" y="4.5" width="4" height="7" rx="1" />
      <rect x="6" y="4.5" width="4" height="7" rx="1" />
      <rect x="10.5" y="4.5" width="4" height="7" rx="1" />
    </Icon>
  )
}

export function SparkleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3z" />
      <path d="M12.5 11v3M11 12.5h3" />
    </Icon>
  )
}
