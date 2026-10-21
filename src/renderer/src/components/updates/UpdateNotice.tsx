import { useEffect, useState, type ReactNode } from 'react'
import type { UpdateInfo, UpdateProgress } from '@shared/types'
import { useAgentWorking } from '../../lib/agent'
import { ipcErrorMessage } from '../../lib/hooks'
import {
  closeUpdateNotice,
  later,
  releaseDate,
  showUpdateAnswer,
  stageText,
  UPDATE_HOW,
  updateNow,
  useUpdateNotice
} from '../../lib/updates'
import { CloseIcon } from '../sequences/icons'

/** An answer that needs nothing from the user (up to date, a development build) closes by itself after this long. */
const ANSWER_MS = 10_000

/**
 * The update notice, in the bottom right corner of the window: "Studio 0.3.0 is available" with Update now, Release
 * notes and Later; then the install's progress, or why it failed. Check for Updates… in the app menu also shows its
 * answer here (up to date, a development build, a failed check). Calm: no sound, no badge, nothing in the way of work
 * – lifted above the agent's pill while an agent works.
 */
export default function UpdateNotice() {
  const { info, progress } = useUpdateNotice()
  const lifted = useAgentWorking().length > 0
  const quiet = !!info && !progress && !info.available && !info.error
  useEffect(() => {
    if (!quiet) return
    const timer = window.setTimeout(closeUpdateNotice, ANSWER_MS)
    return () => window.clearTimeout(timer)
  }, [quiet, info])
  if (!info && !progress) return null

  return (
    <div className={`pointer-events-none fixed right-5 z-40 flex justify-end ${lifted ? 'bottom-20' : 'bottom-5'}`}>
      <div
        role="status"
        aria-live="polite"
        className="no-drag pointer-events-auto w-[340px] rounded-xl border border-line bg-panel/95 p-4 text-sm shadow-2xl shadow-black/50 backdrop-blur"
      >
        {progress ? <Progress progress={progress} info={info} /> : info && <Answer info={info} />}
      </div>
    </div>
  )
}

function Answer({ info }: { info: UpdateInfo }) {
  if (info.error) {
    return (
      <>
        <Heading onClose={closeUpdateNotice}>Couldn’t check for updates</Heading>
        <p className="mt-1 leading-relaxed text-muted select-text">{info.error}</p>
        <Buttons>
          <TryAgain />
          <SecondaryButton onClick={closeUpdateNotice}>Close</SecondaryButton>
        </Buttons>
      </>
    )
  }
  if (!info.available) {
    // Asked for from the app menu: up to date, or a development build.
    const dev = !!info.installBlocked
    return (
      <>
        <Heading onClose={closeUpdateNotice}>{dev ? 'Development build' : 'Studio is up to date'}</Heading>
        <p className="mt-1 leading-relaxed text-muted">
          {dev ? 'Updates come from git.' : `${info.current} is the newest version.`}
        </p>
      </>
    )
  }
  const released = releaseDate(info.publishedAt)
  return (
    <>
      <Heading dot>Studio {info.latest} is available</Heading>
      <p className="mt-1 leading-relaxed text-muted">
        You have {info.current}
        {released ? ` · released ${released}` : ''}.
      </p>
      {info.installBlocked && <p className="mt-2 leading-relaxed text-muted select-text">{info.installBlocked}</p>}
      <Buttons>
        {!info.installBlocked && <PrimaryButton onClick={() => void updateNow()}>Update now</PrimaryButton>}
        <NotesLink href={info.notesUrl} />
        <SecondaryButton onClick={later} title="Hide this version until a newer one is out">
          Later
        </SecondaryButton>
      </Buttons>
    </>
  )
}

function Progress({ progress, info }: { progress: UpdateProgress; info: UpdateInfo | undefined }) {
  const version = info?.available ? info.latest : undefined
  if (progress.stage === 'failed') {
    return (
      <>
        <Heading onClose={closeUpdateNotice}>{stageText(progress, version)}</Heading>
        <p className="mt-1 leading-relaxed text-muted select-text">{progress.error ?? 'Something went wrong.'}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">This Studio wasn’t changed.</p>
        <Buttons>
          <PrimaryButton onClick={() => void updateNow()}>Try again</PrimaryButton>
          {info?.notesUrl && <NotesLink href={info.notesUrl} />}
          <SecondaryButton onClick={closeUpdateNotice}>Close</SecondaryButton>
        </Buttons>
      </>
    )
  }
  const fraction = progress.stage === 'downloading' ? progress.fraction : undefined
  const indeterminate = fraction === undefined && progress.stage !== 'restarting'
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="min-w-0 truncate font-medium">{stageText(progress, version)}</h2>
        {fraction !== undefined && (
          <span className="shrink-0 text-[12px] text-muted tabular-nums">{Math.floor(fraction * 100)}%</span>
        )}
      </div>
      <div
        className="mt-2.5 h-1 w-full overflow-hidden rounded bg-bg"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === undefined ? undefined : Math.floor(fraction * 100)}
      >
        <div
          className={`h-full bg-accent transition-[width] duration-300 ${indeterminate ? 'animate-pulse' : ''}`}
          style={{ width: `${Math.round((fraction ?? 1) * 100)}%` }}
        />
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">{UPDATE_HOW}</p>
    </>
  )
}

function TryAgain() {
  const [checking, setChecking] = useState(false)
  return (
    <PrimaryButton
      disabled={checking}
      onClick={() => {
        setChecking(true)
        window.studio
          .checkForUpdates()
          .then(
            (info) => showUpdateAnswer({ ...info, requested: true }),
            (e: unknown) =>
              showUpdateAnswer({
                current: '',
                latest: '',
                available: false,
                notesUrl: '',
                requested: true,
                error: ipcErrorMessage(e)
              })
          )
          .finally(() => setChecking(false))
      }}
    >
      {checking ? 'Checking…' : 'Try again'}
    </PrimaryButton>
  )
}

function Heading({ children, dot, onClose }: { children: ReactNode; dot?: boolean; onClose?: () => void }) {
  return (
    <div className="flex items-start gap-2">
      {dot && <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}
      <h2 className="min-w-0 flex-1 font-medium">{children}</h2>
      {onClose && (
        <button
          onClick={onClose}
          title="Close"
          aria-label="Close"
          className="-mr-1.5 -mt-1 rounded-full p-1.5 text-muted transition hover:bg-raised hover:text-text"
        >
          <CloseIcon size={11} />
        </button>
      )}
    </div>
  )
}

function Buttons({ children }: { children: ReactNode }) {
  return <div className="mt-3.5 flex flex-wrap items-center gap-2">{children}</div>
}

function PrimaryButton({
  children,
  onClick,
  disabled
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md bg-accent px-3 py-1.5 font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function SecondaryButton({
  children,
  onClick,
  title
}: {
  children: ReactNode
  onClick: () => void
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded-md px-3 py-1.5 text-muted transition hover:bg-raised hover:text-text"
    >
      {children}
    </button>
  )
}

/** Opens the release's page on GitHub in the browser (the window hands every link there). */
function NotesLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded-md border border-line px-3 py-1.5 text-text transition hover:bg-raised"
    >
      Release notes
    </a>
  )
}
