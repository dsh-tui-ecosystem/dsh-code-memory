/**
 * Plugin configuration (schemastery). Every key has a sane default, so the
 * bundle patch mounts the plugin with no config row at all. Users override by
 * id in the profile's own cordis.patch.yml (wholesale per-id replacement —
 * restate every key).
 * @module dsh-code-memory/config
 */
import z from '@deepseek-ai/schemastery'

export type Config = {
  /** Master switch; false unloads every hook. */
  enabled?: boolean
  /** Which scopes persist and recall. */
  scopes?: { global?: boolean; project?: boolean }
  recall?: {
    /** Hard token budget for injected memory text (index + recall block). */
    maxTokens?: number
    /** Max memories injected per pre-step recall. */
    topK?: number
    /** Inject the MEMORY.md index when a session starts/resumes/compacts. */
    onSessionStart?: boolean
    /** Recall on each user-prompt step via the pre-step waterfall. */
    onPreStep?: boolean
  }
  capture?: {
    /** Rule-gated nudges asking the model to consider memory_write. */
    salienceGated?: boolean
    /** Nudge to rescue decisions/open issues before compaction. */
    compactionRescue?: boolean
  }
  /** Project-scope memory dir, relative to the git root (or cwd). */
  projectDir?: string
  /** Dev-only: append one dummy memory/captured event per session to smoke-test
   *  event-type registration and session resumability. */
  smokeEvent?: boolean
}

// Explicit annotation: inferred schemastery output types can reference
// pnpm-virtual paths that break portable declaration emit (TS2883). The
// global `Schemastery` interface comes from schemastery's own d.ts.
export const Config: Schemastery<Config> = z.object({
  enabled: z.boolean().default(true),
  scopes: z.object({
    global: z.boolean().default(true),
    project: z.boolean().default(true),
  }).default({ global: true, project: true }),
  recall: z.object({
    maxTokens: z.number().step(100).min(200).max(8000).default(1200),
    topK: z.number().step(1).min(1).max(10).default(3),
    onSessionStart: z.boolean().default(true),
    onPreStep: z.boolean().default(true),
  }).default({ maxTokens: 1200, topK: 3, onSessionStart: true, onPreStep: true }),
  capture: z.object({
    salienceGated: z.boolean().default(true),
    compactionRescue: z.boolean().default(true),
  }).default({ salienceGated: true, compactionRescue: true }),
  projectDir: z.string().default('.dsh/memory'),
  smokeEvent: z.boolean().default(false),
})

/** Fully-resolved config (every optional key defaulted). */
export interface ResolvedConfig {
  enabled: boolean
  scopes: { global: boolean; project: boolean }
  recall: { maxTokens: number; topK: number; onSessionStart: boolean; onPreStep: boolean }
  capture: { salienceGated: boolean; compactionRescue: boolean }
  projectDir: string
  smokeEvent: boolean
}

export function resolveConfig(config: Config): ResolvedConfig {
  return {
    enabled: config.enabled ?? true,
    scopes: {
      global: config.scopes?.global ?? true,
      project: config.scopes?.project ?? true,
    },
    recall: {
      maxTokens: config.recall?.maxTokens ?? 1200,
      topK: config.recall?.topK ?? 3,
      onSessionStart: config.recall?.onSessionStart ?? true,
      onPreStep: config.recall?.onPreStep ?? true,
    },
    capture: {
      salienceGated: config.capture?.salienceGated ?? true,
      compactionRescue: config.capture?.compactionRescue ?? true,
    },
    projectDir: config.projectDir ?? '.dsh/memory',
    smokeEvent: config.smokeEvent ?? false,
  }
}
