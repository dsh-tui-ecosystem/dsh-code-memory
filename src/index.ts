/**
 * dsh-code-memory — cross-session memory for DeepSeek Harness agents.
 *
 * Design (see docs/research-and-plan.md): markdown files are the single
 * source of truth; a small MEMORY.md index is injected at session start;
 * prompt-time recall rides the `agent/pre-step` waterfall; the model writes
 * memories itself through `memory_*` tools; rule-gated nudges and a
 * compaction rescue are the only automatic capture — nothing is written
 * without the model distilling it first.
 *
 * This module is a thin shell: registration, config, and wiring only.
 * @module dsh-code-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: resolves the session/* and agent/* cordis event declarations.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: resolves ctx.commands.
import type {} from '@deepseek-ai/dsh-commands'
// Type-only: resolves ctx.storageDomain / ctx.storage.domain.
import type {} from '@deepseek-ai/dsh-storage-domain'
// Type-only: resolves ctx.systemPrompt.
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: resolves ctx.tools.
import type {} from '@deepseek-ai/dsh-tools'
import { registerMemoryEventTypes } from './registration.js'
import { memoryDomainSpec } from './domain.js'
import { resolveConfig } from './config.js'
import { MemoryStore } from './store/store.js'
import { registerMemoryCommands } from './commands.js'
import { registerSessionStartRecall } from './hooks/session-start.js'
import { registerPreStepRecall } from './hooks/pre-step.js'
import { registerCapture } from './hooks/capture.js'
import { registerCompactionRescue } from './hooks/compaction.js'
import { registerMemoryTools } from './tools.js'
import { MEMORY_GUIDANCE } from './prompt.js'
// Re-export the event types + SessionEventMap merge: the package root must
// carry the declare-module side effect for consumers resolving the built d.ts.
export type * from './events.js'
export { Config } from './config.js'
import type { Config } from './config.js'

export const name = 'dsh-code-memory'

/**
 * Wire the memory plugin.
 * @param ctx - Cordis context (agent loop + session services composed).
 * @param config - Validated plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Register the event types BEFORE anything can publish or validate: the
  // strict read paths refuse logs with unknown non-ignorable types.
  // Registration is unconditional — it also protects READING logs written by
  // an earlier session in processes where this plugin's capture is off.
  registerMemoryEventTypes()

  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const store = new MemoryStore(resolved)

  // Storage domain: runtime toggles + derived mirror. Memory is an
  // enhancement, so a failed open degrades to file-only instead of crashing
  // the harness.
  ctx.inject(['storageDomain'], (ictx) => {
    const opened = ictx.storageDomain.open(memoryDomainSpec)
      .then((domain) => {
        store.attachDomain(domain)
        return domain
      })
    opened.catch((error: unknown) => {
      store.detachDomain()
      process.stderr.write(`[dsh-code-memory] storage domain unavailable, file-only mode: ${String(error)}\n`)
    })
    ictx.effect(
      () => async () => {
        const domain = await opened.catch(() => undefined)
        await domain?.close()
      },
      'dsh-code-memory storage domain',
    )
  })

  ctx.inject(['commands'], (ictx) => {
    registerMemoryCommands(ictx, store)
  })

  ctx.inject(['tools'], (ictx) => {
    registerMemoryTools(ictx, store, resolved)
  })

  // Tool discipline rides the stable system-prompt sections (order 150, the
  // tool-guidance band); injected when systemPrompt is composed, removed
  // with this fiber.
  ctx.inject(['systemPrompt'], (ictx) => {
    ictx.systemPrompt.section({
      name: 'code-memory:guidance',
      order: 150,
      text: MEMORY_GUIDANCE,
    })
  })

  registerSessionStartRecall(ctx, store, resolved)
  registerPreStepRecall(ctx, store, resolved)
  registerCapture(ctx, store, resolved)
  registerCompactionRescue(ctx, store, resolved)

  if (resolved.smokeEvent) {
    // Dev-only smoke test: one dummy memory/captured per session, so a
    // resume regression on unregistered event types is caught immediately.
    const smoked = new WeakSet<Session>()
    ctx.on('session/event', (session) => {
      if (smoked.has(session)) return
      smoked.add(session)
      // session/event callbacks run under the session's appending guard;
      // defer the append to a microtask (same constraint as working-activity).
      queueMicrotask(() => {
        try {
          session.append('memory/captured', {
            id: 'mem_01JZK0SM0KE0000000000000',
            type: 'fact',
            scope: 'global',
            source: 'user',
            file: 'facts/smoke.md',
          })
        } catch {
          // Session closed or guard still held: drop the smoke event.
        }
      })
    })
  }
}
