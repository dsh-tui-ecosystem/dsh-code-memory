/**
 * Core memory data model: the markdown file (YAML frontmatter + body) is the
 * single source of truth. Everything else — the storage-domain mirror, the
 * MEMORY.md index, any future vector index — is derived and rebuildable.
 * @module dsh-code-memory/types
 */
import { z } from 'zod'

/** CoALA-inspired memory types. `procedure` carries the most value for a coding agent. */
export const MEMORY_TYPES = ['fact', 'episode', 'procedure'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

/** Persistence scopes. Session-scoped memories never reach disk. */
export const MEMORY_SCOPES = ['global', 'project'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/**
 * Trust provenance, cheapest memory-poisoning defense:
 * user > agent-inferred > tool-output. Tool-output text is never written
 * verbatim; it must be distilled by the model through memory_write first.
 */
export const MEMORY_SOURCES = ['user', 'agent-inferred', 'tool-output'] as const
export type MemorySource = (typeof MEMORY_SOURCES)[number]

export const MEMORY_ID_RE = /^mem_[0-9A-HJKMNP-TV-Z]{26}$/

/** YAML frontmatter of one memory file. */
export const memoryFrontmatterSchema = z.object({
  id: z.string().regex(MEMORY_ID_RE),
  type: z.enum(MEMORY_TYPES),
  scope: z.enum(MEMORY_SCOPES),
  source: z.enum(MEMORY_SOURCES),
  importance: z.number().int().min(1).max(5),
  created: z.string(),
  lastConfirmed: z.string(),
  status: z.enum(['active', 'superseded']),
  supersededBy: z.string().regex(MEMORY_ID_RE).optional(),
  tags: z.array(z.string()).default([]),
})
export type MemoryFrontmatter = z.infer<typeof memoryFrontmatterSchema>

/** One memory as loaded from disk: frontmatter + body + its file location. */
export interface Memory extends MemoryFrontmatter {
  /** Markdown body below the frontmatter. */
  readonly body: string
  /** File path relative to the scope's memory dir (e.g. `facts/01K….md`). */
  readonly file: string
}

/** Per-scope directory names, by memory type. */
export const TYPE_DIRS: Record<MemoryType, string> = {
  fact: 'facts',
  episode: 'episodes',
  procedure: 'procedures',
}

/** Hard cap on a single memory body, so no memory grows into a mini-document. */
export const MEMORY_BODY_MAX_CHARS = 2000
