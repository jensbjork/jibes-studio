import { useSyncExternalStore } from 'react'
import type { UpdateInfo, UpdateProgress } from '@shared/types'
import { ipcErrorMessage } from './hooks'
import { isMac, isWindows } from './platform'

// The window's side of updates (main's updates.ts): what the update notice shows – a newer release main found, the
// answer to Check for Updates… in the app menu, an install under way or one that failed – and what its buttons do.
// "Later" hides that version in this profile until a newer one comes (or the user asks again).

export interface UpdateNoticeState {
  /** What the notice is about; undefined while it is closed. */
  info?: UpdateInfo
  /** An install under way, or the one that failed. */
  progress?: UpdateProgress
}

const LATER_KEY = 'updates:later:v1'

let state: UpdateNoticeState = {}
const listeners = new Set<() => void>()

function set(next: UpdateNoticeState): void {
  state = next
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The notice's state, for UpdateNotice. */
export function useUpdateNotice(): UpdateNoticeState {
  return useSyncExternalStore(subscribe, () => state)
}

/** The version "Later" hid, in this profile. */
function laterVersion(): string | undefined {
  try {
    return localStorage.getItem(LATER_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function installing(): boolean {
  return !!state.progress && state.progress.stage !== 'failed'
}

let started = false

/**
 * Listens to main from the start (main.tsx calls it before the first render): the daily check's answer may come before
 * the notice mounts. Idempotent.
 */
export function startUpdateFeed(): void {
  if (started || typeof window === 'undefined' || typeof window.studio?.onUpdateAvailable !== 'function') return
  started = true
  window.studio.onUpdateAvailable((info) => {
    // The daily check doesn't bring back a version the user put off; asking (the menu, Settings) does.
    if (!info.requested && info.available && info.latest === laterVersion()) return
    // An install under way keeps the notice.
    if (installing()) return
    set({ info })
  })
  window.studio.onUpdateProgress((progress) => set({ ...state, progress }))
}

/** Update now: main downloads, checks and installs, then restarts Studio; a failure stays in the notice. */
export async function updateNow(): Promise<void> {
  if (installing()) return
  set({ ...state, progress: { stage: 'downloading', fraction: 0 } })
  try {
    await window.studio.installUpdate()
  } catch (e) {
    set({ ...state, progress: { stage: 'failed', error: ipcErrorMessage(e) } })
  }
}

/** Later: closes the notice and hides this version until a newer one is out. */
export function later(): void {
  const version = state.info?.available ? state.info.latest : undefined
  if (version) {
    try {
      localStorage.setItem(LATER_KEY, version)
    } catch {
      // Only a convenience: the version may be offered again tomorrow.
    }
  }
  set({})
}

/** Closes the notice (an answer, or a failed install). */
export function closeUpdateNotice(): void {
  if (installing()) return
  set({})
}

/** Shows an answer in the notice, as Check for Updates… does (Try again after a failed check). */
export function showUpdateAnswer(info: UpdateInfo): void {
  if (!installing()) set({ info })
}

// ── Words ────────────────────────────────────────────────────────────────────

/** What happens on Update now, in this system's words. */
export const UPDATE_HOW = isMac
  ? 'Studio downloads it, checks it and restarts by itself.'
  : isWindows
    ? 'Studio downloads it, checks it, closes and runs the installer, which opens Studio again.'
    : 'Studio downloads it, checks it and installs it.'

/** A stage of an install, in words. */
export function stageText(progress: UpdateProgress, version: string | undefined): string {
  const name = version ? `Studio ${version}` : 'the update'
  switch (progress.stage) {
    case 'downloading':
      return `Downloading ${name}…`
    case 'verifying':
      return 'Checking the download…'
    case 'installing':
      return isWindows ? 'Starting the installer…' : 'Installing…'
    case 'restarting':
      return isWindows ? 'Studio closes while the installer updates it.' : 'Restarting…'
    case 'failed':
      return 'The update didn’t go through'
  }
}

/** "18 Oct 2026", or undefined for no date. */
export function releaseDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined
  const date = new Date(iso)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
    : undefined
}
