export interface Chunk {
  index: number
  content: string
}

const DEFAULT_CHUNK_CHARS = 2000 // ~500 tokens
const DEFAULT_OVERLAP_CHARS = 200

/**
 * Splits document content into overlapping chunks, preferring to break on
 * paragraph or sentence boundaries near the target size so embeddings capture
 * coherent passages rather than mid-sentence fragments.
 */
export function chunkText(
  content: string,
  options: { chunkChars?: number; overlapChars?: number } = {}
): Chunk[] {
  const chunkChars = options.chunkChars ?? DEFAULT_CHUNK_CHARS
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const chunks: Chunk[] = []
  let start = 0
  let index = 0

  while (start < normalized.length) {
    let end = Math.min(start + chunkChars, normalized.length)

    if (end < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf('\n\n', end)
      const sentenceBreak = normalized.lastIndexOf('. ', end)
      const breakPoint = Math.max(paragraphBreak, sentenceBreak)
      if (breakPoint > start + chunkChars * 0.5) {
        end = breakPoint + 1
      }
    }

    const chunkContent = normalized.slice(start, end).trim()
    if (chunkContent) {
      chunks.push({ index: index++, content: chunkContent })
    }

    if (end >= normalized.length) break
    start = Math.max(end - overlapChars, start + 1)
  }

  return chunks
}
