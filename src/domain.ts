/**
 * Storage-domain declaration: a derived, rebuildable mirror of the memory
 * files (for fast listing and on/off toggles), persisted by dsh-storage to
 * `~/.dsh/storages/memory.json`. The markdown files stay authoritative; on
 * any mismatch the mirror is rebuilt from disk at startup.
 * @module dsh-code-memory/domain
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { memoryFrontmatterSchema } from './types.js'

/** Mirror record for one memory file: frontmatter plus its location. */
export const memoryMetaSchema = memoryFrontmatterSchema.extend({
  /** File path relative to the scope memory dir. */
  file: z.string(),
  /** Absolute project root for project-scope entries (disambiguates repos). */
  root: z.string().optional(),
})
export type MemoryMeta = z.infer<typeof memoryMetaSchema>

/** Runtime toggles, shared across sessions and editable via `/memory on|off`. */
export const memoryGlobalSchema = z.object({
  recallEnabled: z.boolean(),
  captureEnabled: z.boolean(),
})
export type MemoryGlobal = z.infer<typeof memoryGlobalSchema>

export const MEMORY_GLOBAL_INITIAL: MemoryGlobal = {
  recallEnabled: true,
  captureEnabled: true,
}

export const memoryDomainSpec = defineDomain({
  name: 'memory',
  version: 1,
  global: {
    schema: memoryGlobalSchema,
    initial: MEMORY_GLOBAL_INITIAL,
  },
  tables: {
    meta: domainTable(memoryMetaSchema),
  },
})

export type MemoryDomainSpec = typeof memoryDomainSpec
