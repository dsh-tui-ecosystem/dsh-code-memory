/**
 * Keyword relevance scoring — the always-available retrieval path (vector
 * search is an optional later milestone). Handles mixed Chinese/English text
 * and code identifiers: latin runs are split on separators and camelCase
 * boundaries (original token + sub-words both indexed), CJK runs become
 * bigrams. Memories may carry code anchors (paths/symbols); anchor hits
 * score like tag hits.
 * @module dsh-code-memory/recall/keyword
 */
import type { Memory } from '../types.js'

// Latin runs keep their case here so camelCase boundaries survive; each
// emitted token is lowercased at the end.
const TOKEN_RE = /[a-zA-Z0-9_./-]{2,}|[㐀-䶿一-鿿]+/gu
const CJK_RE = /^[㐀-䶿一-鿿]/u
// camelCase boundaries: fooBar → foo|Bar, HTMLParser → HTML|Parser.
const CAMEL_BOUNDARY_RE = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/u

/** Split one latin token into itself plus separator/camelCase sub-words. */
function expandLatinToken(raw: string): string[] {
  const out = [raw.toLowerCase()]
  for (const segment of raw.split(/[_./-]+/u)) {
    for (const word of segment.split(CAMEL_BOUNDARY_RE)) {
      if (word.length >= 2) out.push(word.toLowerCase())
    }
  }
  return [...new Set(out)]
}

/** Tokenize query or content into lowercase keywords (latin words + sub-words + CJK bigrams). */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0]
    if (CJK_RE.test(token)) {
      if (token.length <= 2) {
        tokens.push(token)
      } else {
        for (let i = 0; i < token.length - 1; i += 1) tokens.push(token.slice(i, i + 2))
      }
    } else {
      tokens.push(...expandLatinToken(token))
    }
  }
  return tokens
}

/**
 * Anchor token set of one memory: paths contribute the full path, basename,
 * and every segment (each identifier-split); symbols contribute the symbol
 * and its sub-words. Segments are split BEFORE lowercasing so camelCase
 * boundaries (src/loginHandler.ts → login, handler) survive; every emitted
 * token is lowercased at the end.
 */
export function anchorTokens(memory: Pick<Memory, 'paths' | 'symbols'>): Set<string> {
  const anchors = new Set<string>()
  for (const path of memory.paths) {
    anchors.add(path.toLowerCase())
    for (const segment of path.split('/')) {
      if (segment.length === 0) continue
      anchors.add(segment.toLowerCase())
      for (const token of expandLatinToken(segment)) anchors.add(token)
    }
  }
  for (const symbol of memory.symbols) {
    for (const token of expandLatinToken(symbol)) anchors.add(token)
  }
  return anchors
}

/**
 * Keyword relevance of one memory to pre-tokenized query terms, in [0, 1].
 * Curated hits weigh most (tags and code anchors), then body tokens.
 */
export function keywordRelevance(queryTokens: readonly string[], memory: Memory): number {
  if (queryTokens.length === 0) return 0
  const tags = new Set(memory.tags.map((tag) => tag.toLowerCase()))
  const anchors = anchorTokens(memory)
  const bodyTokens = new Set(tokenize(memory.body))
  let curatedHits = 0
  let bodyHits = 0
  for (const token of new Set(queryTokens)) {
    if (tags.has(token) || anchors.has(token)) curatedHits += 1
    else if (bodyTokens.has(token)) bodyHits += 1
  }
  const unique = new Set(queryTokens).size
  const curatedScore = curatedHits / unique
  const bodyScore = bodyHits / unique
  return Math.min(1, curatedScore * 0.7 + bodyScore * 0.5 + (curatedHits > 0 ? 0.2 : 0))
}
