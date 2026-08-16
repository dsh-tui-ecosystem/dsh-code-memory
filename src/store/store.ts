/**
 * MemoryStore — the single facade every surface (commands, tools, hooks)
 * talks to. Files are authoritative; the storage-domain mirror and the
 * MEMORY.md index are refreshed as derived artifacts on every mutation.
 * @module dsh-code-memory/store/store
 */
import { ulid } from 'ulid'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { ResolvedConfig } from '../config.js'
import { MEMORY_BODY_MAX_CHARS, memoryFrontmatterSchema } from '../types.js'
import type { Memory, MemoryFrontmatter, MemoryScope, MemorySource, MemoryType } from '../types.js'
import { keywordRelevance, tokenize } from '../recall/keyword.js'
import { rankMemories } from '../recall/scorer.js'
import type { ScoredMemory } from '../recall/scorer.js'
import { deleteMemoryFile, memoryFilePath, scanMemories, writeMemoryFile } from './files.js'
import { writeIndex } from './index-file.js'
import { scopeDir } from './paths.js'
import { MEMORY_GLOBAL_INITIAL, memoryDomainSpec } from '../domain.js'
import type { MemoryGlobal } from '../domain.js'

type MemoryDomain = Domain<typeof memoryDomainSpec>

export interface AddInput {
  readonly content: string
  readonly type: MemoryType
  readonly scope: MemoryScope
  readonly source: MemorySource
  readonly tags?: readonly string[]
  readonly importance?: number
}

export interface AddResult {
  readonly memory: Memory
  /** Active same-scope memories that look related; the caller decides whether to supersede. */
  readonly conflicts: Memory[]
  /** True when the body had to be cut to MEMORY_BODY_MAX_CHARS. */
  readonly truncated: boolean
}

export interface ListFilter {
  readonly scope?: MemoryScope
  readonly type?: MemoryType
  /** Include superseded memories (default: active only). */
  readonly all?: boolean
}

export interface ListResult {
  readonly memories: Memory[]
  readonly warnings: string[]
}

export class MemoryStore {
  private domain: MemoryDomain | undefined
  private readonly domainReady: Promise<void>
  private resolveReady!: () => void

  constructor(private readonly config: ResolvedConfig) {
    this.domainReady = new Promise((resolve) => {
      this.resolveReady = resolve
    })
  }

  attachDomain(domain: MemoryDomain): void {
    this.domain = domain
    this.resolveReady()
  }

  /** Domain open failed; toggles fall back to defaults, everything else is file-only. */
  detachDomain(): void {
    this.resolveReady()
  }

  whenReady(): Promise<void> {
    return this.domainReady
  }

  private dirFor(scope: MemoryScope, cwd: string): string {
    return scopeDir(scope, cwd, this.config.projectDir)
  }

  /** Absolute global-scope memory dir (public for recall hooks). */
  globalDir(): string {
    return this.dirFor('global', process.cwd())
  }

  /** Absolute project-scope memory dir for a session cwd. */
  projectDir(cwd: string): string {
    return this.dirFor('project', cwd)
  }

  private enabledScopes(): MemoryScope[] {
    const scopes: MemoryScope[] = []
    if (this.config.scopes.global) scopes.push('global')
    if (this.config.scopes.project) scopes.push('project')
    return scopes
  }

  /** Write a new memory file, refresh the index and mirror, report conflicts. */
  add(input: AddInput, cwd: string): AddResult {
    const dir = this.dirFor(input.scope, cwd)
    const truncated = input.content.trim().length > MEMORY_BODY_MAX_CHARS
    const body = input.content.trim().slice(0, MEMORY_BODY_MAX_CHARS)
    const now = new Date().toISOString()
    const id = `mem_${ulid()}`
    const frontmatter: MemoryFrontmatter = memoryFrontmatterSchema.parse({
      id,
      type: input.type,
      scope: input.scope,
      source: input.source,
      importance: input.importance ?? 3,
      created: now,
      lastConfirmed: now,
      status: 'active',
      tags: input.tags ?? [],
    })
    const file = writeMemoryFile(dir, frontmatter, body, memoryFilePath(input.type, id))
    const memory: Memory = { ...frontmatter, body, file }

    const { memories } = scanMemories(dir)
    const bodyTokens = tokenize(body)
    const inputTags = new Set((input.tags ?? []).map((tag) => tag.toLowerCase()))
    const conflicts = memories.filter((candidate) => {
      if (candidate.id === id || candidate.status !== 'active') return false
      if (candidate.tags.some((tag) => inputTags.has(tag.toLowerCase()))) return true
      return keywordRelevance(bodyTokens, candidate) >= 0.5
    })

    this.refreshIndex(input.scope, cwd, memories)
    void this.mirrorPut(memory, cwd)
    return { memory, conflicts, truncated }
  }

  /** List memories across enabled scopes (or one), active first. */
  list(cwd: string, filter: ListFilter = {}): ListResult {
    const scopes = filter.scope === undefined ? this.enabledScopes() : [filter.scope]
    const memories: Memory[] = []
    const warnings: string[] = []
    for (const scope of scopes) {
      const scanned = scanMemories(this.dirFor(scope, cwd))
      warnings.push(...scanned.warnings.map((warning) => `[${scope}] ${warning}`))
      memories.push(...scanned.memories)
    }
    const filtered = memories.filter((memory) =>
      (filter.all === true || memory.status === 'active')
      && (filter.type === undefined || memory.type === filter.type))
    filtered.sort((a, b) =>
      (Number(a.status === 'superseded') - Number(b.status === 'superseded'))
      || (b.importance - a.importance)
      || b.lastConfirmed.localeCompare(a.lastConfirmed))
    return { memories: filtered, warnings }
  }

  /** Find one memory by id across enabled scopes. */
  get(id: string, cwd: string): Memory | undefined {
    for (const scope of this.enabledScopes()) {
      const found = scanMemories(this.dirFor(scope, cwd)).memories.find((memory) => memory.id === id)
      if (found !== undefined) return found
    }
    return undefined
  }

  /** Delete a memory file outright (distinct from supersede: no history kept). */
  remove(id: string, cwd: string): Memory | undefined {
    const memory = this.get(id, cwd)
    if (memory === undefined) return undefined
    deleteMemoryFile(this.dirFor(memory.scope, cwd), memory.file)
    this.refreshIndex(memory.scope, cwd)
    void this.mirrorDelete(id)
    return memory
  }

  /**
   * Mark an existing memory superseded by a newer one — never delete: the
   * old file stays on disk with status/supersededBy updated, keeping the
   * timeline auditable.
   */
  supersede(oldId: string, replacement: Memory, cwd: string): Memory | undefined {
    const old = this.get(oldId, cwd)
    if (old === undefined) return undefined
    const updated: Memory = { ...old, status: 'superseded', supersededBy: replacement.id }
    const { body, file, ...rest } = updated
    const frontmatter: MemoryFrontmatter = { ...rest }
    writeMemoryFile(this.dirFor(old.scope, cwd), frontmatter, body, file)
    this.refreshIndex(old.scope, cwd)
    void this.mirrorPut(updated, cwd)
    return updated
  }

  /** Keyword search across enabled scopes; relevance-ranked, active only. */
  search(queryText: string, cwd: string, filter: ListFilter = {}, nowMs = Date.now()): ScoredMemory[] {
    const { memories } = this.list(cwd, { ...filter, all: false })
    return rankMemories(memories, tokenize(queryText), nowMs)
  }

  /** Rewrite MEMORY.md for every enabled scope and resync the mirror from disk. */
  rebuild(cwd: string): { indexes: string[]; warnings: string[] } {
    const indexes: string[] = []
    const warnings: string[] = []
    for (const scope of this.enabledScopes()) {
      const dir = this.dirFor(scope, cwd)
      const scanned = scanMemories(dir)
      warnings.push(...scanned.warnings.map((warning) => `[${scope}] ${warning}`))
      writeIndex(dir, scanned.memories, this.config.recall.maxTokens, scope)
      indexes.push(dir)
    }
    void this.mirrorResync(cwd)
    return { indexes, warnings }
  }

  /** Runtime toggles (storage-domain global); defaults when the domain is down. */
  async toggles(): Promise<MemoryGlobal> {
    await this.whenReady()
    return this.domain?.global.get() ?? MEMORY_GLOBAL_INITIAL
  }

  async setToggles(patch: Partial<MemoryGlobal>): Promise<boolean> {
    await this.whenReady()
    if (this.domain === undefined) return false
    await this.domain.global.set({ ...this.domain.global.get(), ...patch })
    return true
  }

  private refreshIndex(scope: MemoryScope, cwd: string, alreadyScanned?: Memory[]): void {
    const dir = this.dirFor(scope, cwd)
    const memories = alreadyScanned ?? scanMemories(dir).memories
    writeIndex(dir, memories, this.config.recall.maxTokens, scope)
  }

  private async mirrorPut(memory: Memory, cwd: string): Promise<void> {
    await this.whenReady()
    if (this.domain === undefined) return
    const { body: _body, ...meta } = memory
    await this.domain.table('meta').put(memory.id, {
      ...meta,
      ...(memory.scope === 'project' ? { root: this.dirFor('project', cwd) } : {}),
    })
  }

  private async mirrorDelete(id: string): Promise<void> {
    await this.whenReady()
    await this.domain?.table('meta').delete(id)
  }

  private async mirrorResync(cwd: string): Promise<void> {
    await this.whenReady()
    if (this.domain === undefined) return
    const { memories } = this.list(cwd, { all: true })
    const live = new Set(memories.map((memory) => memory.id))
    const table = this.domain.table('meta')
    for (const key of table.keys()) {
      if (!live.has(key)) await table.delete(key)
    }
    for (const memory of memories) await this.mirrorPut(memory, cwd)
  }
}
