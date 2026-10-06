// Prompt library helpers shared by the main process (which stores titles) and the renderer (which previews them).

const AUTO_TITLE_LENGTH = 40

/** The title an untitled prompt gets: its first ~40 characters, cut at a word boundary when possible. */
export function titleFromBody(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= AUTO_TITLE_LENGTH) return flat
  const cut = flat.slice(0, AUTO_TITLE_LENGTH)
  const space = cut.lastIndexOf(' ')
  const head = space >= AUTO_TITLE_LENGTH / 2 ? cut.slice(0, space) : cut
  return head.replace(/[\s,.;:!?–-]+$/, '') + '…'
}
