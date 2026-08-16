/**
 * Keyword relevance scoring — the always-available retrieval path (vector
 * search is an optional later milestone). Handles mixed Chinese/English text:
 * latin runs become word tokens, CJK runs become bigrams.
 * @module dsh-code-memory/recall/keyword
 */
import type { Memory } from '../types.js'

const TOKEN_RE = /[a-z0-9_./-]{2,}|[㐀-䶿一-鿿]+/gu
const CJK_RE = /^[㐀-䶿一-鿿]/u

/** Tokenize query or content into lowercase keywords (latin words + CJK bigrams). */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.toLowerCase().matchAll(TOKEN_RE)) {
    const token = match[0]
    if (CJK_RE.test(token)) {
      if (token.length <= 2) {
        tokens.push(token)
      } else {
        for (let i = 0; i < token.length - 1; i += 1) tokens.push(token.slice(i, i + 2))
      }
    } else {
      tokens.push(token)
    }
  }
  return tokens
}

/**
 * Keyword relevance of one memory to pre-tokenized query terms, in [0, 1].
 * Tag hits weigh most (curated), then frontmatter-ish tokens, then body.
 */
export function keywordRelevance(queryTokens: readonly string[], memory: Memory): number {
  if (queryTokens.length === 0) return 0
  const tags = new Set(memory.tags.map((tag) => tag.toLowerCase()))
  const bodyTokens = new Set(tokenize(memory.body))
  let tagHits = 0
  let bodyHits = 0
  for (const token of new Set(queryTokens)) {
    if (tags.has(token)) tagHits += 1
    else if (bodyTokens.has(token)) bodyHits += 1
  }
  const unique = new Set(queryTokens).size
  const tagScore = tagHits / unique
  const bodyScore = bodyHits / unique
  return Math.min(1, tagScore * 0.7 + bodyScore * 0.5 + (tagHits > 0 ? 0.2 : 0))
}
