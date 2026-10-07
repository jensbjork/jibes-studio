/** Players that aren't in the document (the shared reference-clip preview), with how to stop them. */
const offPagePlayers = new Map<HTMLMediaElement, () => void>()

/** A player that plays without being in the document, so pauseOthers can't find it by querying the page. */
export function registerOffPagePlayer(el: HTMLMediaElement, stop: () => void): void {
  offPagePlayers.set(el, stop)
}

/**
 * Only one clip or sound plays at a time: when one starts, every other video and audio element in the window
 * pauses. Hovering a card and then opening the same clip in the detail drawer would otherwise play it twice.
 */
export function pauseOthers(playing: HTMLMediaElement): void {
  for (const el of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
    if (el !== playing && !el.paused) el.pause()
  }
  // Stopped even while still loading, so a preview that was just started doesn't begin once the clip plays.
  for (const [el, stop] of offPagePlayers) if (el !== playing) stop()
}
