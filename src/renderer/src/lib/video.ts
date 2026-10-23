/**
 * Spread on every `<video controls>`: the native player's controls without the extras of its ⋮ menu – Download (a
 * copy of a file that is already in the library), picture-in-picture, playback speed and casting.
 */
export const nativeVideoControls = {
  controls: true,
  controlsList: 'nodownload noplaybackrate noremoteplayback',
  disablePictureInPicture: true,
  disableRemotePlayback: true
} as const
