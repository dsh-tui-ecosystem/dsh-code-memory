/**
 * Scope directory resolution. Global memories live under $DSH_HOME/memory
 * (default ~/.dsh/memory); project memories live in `<git-root>/<projectDir>`
 * (default `.dsh/memory`), falling back to cwd when no git root exists.
 * @module dsh-code-memory/store/paths
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { MemoryScope } from '../types.js'

/** $DSH_HOME override or ~/.dsh — mirrors @deepseek-ai/dsh-home-paths behavior. */
export function dshHome(): string {
  const override = process.env.DSH_HOME
  return override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh')
}

export function globalMemoryDir(): string {
  return join(dshHome(), 'memory')
}

/** Walk up from cwd to the nearest directory containing `.git`; cwd if none. */
export function findProjectRoot(cwd: string): string {
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(cwd)
    dir = parent
  }
}

export function projectMemoryDir(cwd: string, projectDir: string): string {
  return join(findProjectRoot(cwd), projectDir)
}

/** Absolute memory directory for one scope. */
export function scopeDir(scope: MemoryScope, cwd: string, projectDir: string): string {
  return scope === 'global' ? globalMemoryDir() : projectMemoryDir(cwd, projectDir)
}
