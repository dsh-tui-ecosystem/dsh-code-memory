/**
 * Memory file CRUD over one scope directory. Every function is synchronous
 * (local disk, tiny files) and fault tolerant: unreadable entries are
 * collected as warnings instead of throwing.
 * @module dsh-code-memory/store/files
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TYPE_DIRS } from '../types.js'
import type { Memory, MemoryFrontmatter, MemoryType } from '../types.js'
import { parseMemory, serializeMemory } from './frontmatter.js'

export interface ScanResult {
  readonly memories: Memory[]
  /** Human-readable warnings for skipped files. */
  readonly warnings: string[]
}

/** Write (or overwrite) one memory file; returns the scope-relative path. */
export function writeMemoryFile(dir: string, frontmatter: MemoryFrontmatter, body: string, file: string): string {
  const abs = join(dir, file)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, serializeMemory(frontmatter, body), { mode: 0o600 })
  return file
}

/** Scope-relative path for a new memory of the given type and ulid. */
export function memoryFilePath(type: MemoryType, id: string): string {
  return `${TYPE_DIRS[type]}/${id.replace(/^mem_/u, '')}.md`
}

/** Read and parse every memory file under one scope dir (missing dir = empty). */
export function scanMemories(dir: string): ScanResult {
  const memories: Memory[] = []
  const warnings: string[] = []
  for (const typeDir of Object.values(TYPE_DIRS)) {
    const abs = join(dir, typeDir)
    let names: string[]
    try {
      names = readdirSync(abs)
    } catch {
      continue // type dir (or whole scope dir) does not exist yet
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const file = `${typeDir}/${name}`
      let raw: string
      try {
        raw = readFileSync(join(dir, file), 'utf8')
      } catch (error) {
        warnings.push(`${file}: unreadable (${String(error)})`)
        continue
      }
      const parsed = parseMemory(raw, file)
      if (parsed.ok) memories.push(parsed.memory)
      else warnings.push(`${parsed.file}: ${parsed.error}`)
    }
  }
  return { memories, warnings }
}

/** Delete one memory file by its scope-relative path. */
export function deleteMemoryFile(dir: string, file: string): void {
  rmSync(join(dir, file), { force: true })
}
