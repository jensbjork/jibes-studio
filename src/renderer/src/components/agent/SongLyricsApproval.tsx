import { formatSongTime } from '@shared/song'
import type { ApprovalSongRequest } from '@shared/types'

/**
 * A 'song-lyrics' request (request_song_lyrics): which song is transcribed, from what, with which model, and what
 * becomes of the lyrics it has. The price is the dialog's own line below.
 */
export function SongLyricsSummary({ request }: { request: ApprovalSongRequest }) {
  return (
    <section className="space-y-2">
      <p className="font-medium">
        Transcribe the lyrics of “{request.songName}” ({formatSongTime(request.duration)})
      </p>
      <p className="text-[12px] text-muted">
        {request.fromVocals ? 'From the separated vocals' : 'From the whole song (its vocals aren’t separated)'} ·{' '}
        {request.modelName ?? request.model}
        {request.language ? ` · Language: ${request.language}` : ''}
      </p>
      <p className="text-[12px] leading-relaxed text-muted">
        Every word gets its time in the song, so the clips know the words sung in them. Misheard words can be corrected
        afterwards, for free.
        {request.replaces ? ' The song’s lyrics are replaced, corrections too.' : ''}
      </p>
    </section>
  )
}
