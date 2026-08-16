/**
 * YAML frontmatter parse/serialize for memory files. Parsing is fault
 * tolerant: a malformed file never breaks listing — it is skipped and
 * reported as a warning.
 * @module dsh-code-memory/store/frontmatter
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { memoryFrontmatterSchema } from '../types.js'
import type { Memory, MemoryFrontmatter } from '../types.js'

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export type ParseResult =
  | { readonly ok: true; readonly memory: Memory }
  | { readonly ok: false; readonly file: string; readonly error: string }

/** Serialize frontmatter + body into the on-disk markdown format. */
export function serializeMemory(frontmatter: MemoryFrontmatter, body: string): string {
  const yaml = stringifyYaml(frontmatter, { indent: 2 }).trimEnd()
  const trimmedBody = body.replace(/\s+$/u, '')
  return `---\n${yaml}\n---\n\n${trimmedBody}\n`
}

/**
 * Parse one memory file's raw text. `file` is the scope-dir-relative path,
 * carried onto the resulting Memory.
 */
export function parseMemory(raw: string, file: string): ParseResult {
  const match = FM_RE.exec(raw)
  if (match === null) {
    return { ok: false, file, error: 'missing or malformed frontmatter block' }
  }
  let data: unknown
  try {
    data = parseYaml(match[1] ?? '')
  } catch (error) {
    return { ok: false, file, error: `frontmatter YAML: ${String(error)}` }
  }
  const parsed = memoryFrontmatterSchema.safeParse(data)
  if (!parsed.success) {
    return { ok: false, file, error: `frontmatter schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` }
  }
  return { ok: true, memory: { ...parsed.data, body: (match[2] ?? '').trim(), file } }
}
