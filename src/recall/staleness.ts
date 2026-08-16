/**
 * Anchor staleness — the dominant rot mode of code memories is the referenced
 * file/symbol disappearing (rename, refactor, deletion). A memory whose
 * anchored paths ALL vanished from disk is stale: penalized and labeled at
 * recall time, never auto-deleted (the model/user decides via supersede/rm).
 * Checks are lazy (recall-time existsSync) — no watchers, no index drift.
 * @module dsh-code-memory/recall/staleness
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Memory } from '../types.js'
import { findProjectRoot } from '../store/paths.js'

/**
 * True when the memory anchors at least one path and none of them exist.
 * Paths are repo-relative; absolute paths are honored as-is. Global-scope
 * memories are checked against the current project root (best effort).
 */
export function pathsStale(memory: Pick<Memory, 'paths'>, cwd: string): boolean {
  if (memory.paths.length === 0) return false
  const root = findProjectRoot(cwd)
  return memory.paths.every((path) => !existsSync(isAbsolute(path) ? path : join(root, path)))
}
