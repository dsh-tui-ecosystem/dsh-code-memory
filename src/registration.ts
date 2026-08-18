/**
 * Runtime registration of this plugin's session-event types.
 *
 * dsh-session's strict read paths (resume seed validation, persistence load)
 * refuse any log containing a type outside KNOWN_SESSION_EVENT_TYPES, and
 * `session.append()` exposes no ignorable marker — so every custom event this
 * plugin appends would make the whole session unresumable unless the type is
 * registered first. Upstream defers a registration surface "until such a
 * consumer exists"; this plugin is that consumer (same situation and same
 * solution as dsh-working-activity).
 *
 * Why "every reachable copy": a runtime can load dsh-session more than once
 * (CLI tree vs plugin profile tree resolve different physical copies under
 * pnpm), and the strict validators consult only THEIR copy's Set. So we
 * register into every copy reachable from several anchors:
 *
 *  - `import.meta.url` — the plugin's own tree (profile or dev-link).
 *  - `realpathSync(process.argv[1])` — the CLI entry. The global bin is
 *    usually a symlink shim (e.g. ~/.local/bin/dsh); resolving from the raw
 *    shim path walks up the wrong node_modules chain and silently finds
 *    nothing, so the realpath is the anchor that actually reaches the CLI
 *    tree's nested dsh-session — the copy the resume validator consults.
 *  - `resolve(process.cwd(), 'noop.js')` — harnesses launched from a checkout.
 *
 * Anchors that fail to resolve are skipped; registration is idempotent and
 * never throws.
 * @module dsh-code-memory/registration
 */
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** The session-event types this plugin publishes. Keep in sync with events.ts. */
const MEMORY_EVENT_TYPES = [
  'memory/captured',
  'memory/recalled',
  'memory/recall-used',
  'memory/superseded',
] as const

interface KnownTypesModule {
  KNOWN_SESSION_EVENT_TYPES?: Set<string>
}

/**
 * Register every `memory/*` session-event type in every reachable dsh-session
 * copy. Idempotent; silently skips anchors whose resolution fails.
 * @param extraAnchors - Additional absolute file paths to resolve from (tests
 *   inject fake CLI trees here); always combined with the real anchors.
 */
export function registerMemoryEventTypes(extraAnchors: readonly string[] = []): void {
  const anchors = new Set<string>([import.meta.url])
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1.length > 0) {
    try {
      anchors.add(realpathSync(argv1))
    } catch {
      anchors.add(argv1)
    }
  }
  try {
    anchors.add(resolve(process.cwd(), 'noop.js'))
  } catch {
    // cwd unresolvable — skip.
  }
  for (const anchor of extraAnchors) anchors.add(anchor)

  const registered = new Set<string>()
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      const resolved = req.resolve('@deepseek-ai/dsh-session')
      if (registered.has(resolved)) continue
      registered.add(resolved)
      const mod = req('@deepseek-ai/dsh-session') as KnownTypesModule
      for (const type of MEMORY_EVENT_TYPES) {
        mod.KNOWN_SESSION_EVENT_TYPES?.add(type)
      }
    } catch {
      // No resolvable dsh-session copy from this anchor — nothing to register into.
    }
  }
}
