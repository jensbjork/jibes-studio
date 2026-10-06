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
