import { useState } from 'react'
import type { LibraryFolderTarget } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import FolderIcon from './FolderIcon'

export type RevealTarget = LibraryFolderTarget

interface Props {
  target: RevealTarget
  /** A character, environment, outfit or sequence id, to open that one's own folder. */
  id?: string
  label?: string
  title?: string
  className?: string
  /** Show only the icon below the xl breakpoint, for crowded toolbars. */
  compact?: boolean
  onError: (message: string) => void
}

/** Opens a folder of the library in Finder. */
export default function OpenFolderButton({
  target,
  id,
  label = 'Öppna mapp',
  title = 'Visa mappen i Finder',
  className = '',
  compact,
  onError
}: Props) {
  const [opening, setOpening] = useState(false)

  const open = async () => {
    setOpening(true)
    try {
      await window.studio.revealLibraryFolder(target, id)
    } catch (e) {
      onError(ipcErrorMessage(e))
    } finally {
      setOpening(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={opening}
      title={title}
      aria-label={compact ? label : undefined}
      className={`flex items-center gap-1.5 whitespace-nowrap ${className}`}
    >
      <FolderIcon size={13} className="shrink-0" />
      <span className={compact ? 'hidden xl:inline' : undefined}>{label}</span>
    </button>
  )
}
