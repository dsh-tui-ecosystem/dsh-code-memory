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
 * pnpm), and the strict validators consult only THEIR copy's Set. Anchors:
 * this module (plugin/profile tree) and the process entry point (CLI tree).
 * A copy that cannot be resolved from an anchor simply is not there;
 * registration is idempotent and never throws.
 * @module dsh-code-memory/registration
 */
import { createRequire } from 'node:module'

/** The session-event types this plugin publishes. Keep in sync with events.ts. */
const MEMORY_EVENT_TYPES = [
  'memory/captured',
  'memory/recalled',
  'memory/superseded',
] as const

interface KnownTypesModule {
  KNOWN_SESSION_EVENT_TYPES?: Set<string>
}

/**
 * Register every `memory/*` session-event type in every reachable dsh-session
 * copy. Idempotent; silently skips anchors whose resolution fails.
 */
export function registerMemoryEventTypes(): void {
  const anchors = [import.meta.url, process.argv[1]].filter(
    (anchor): anchor is string => typeof anchor === 'string' && anchor.length > 0,
  )
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      const mod = req('@deepseek-ai/dsh-session') as KnownTypesModule
      for (const type of MEMORY_EVENT_TYPES) {
        mod.KNOWN_SESSION_EVENT_TYPES?.add(type)
      }
    } catch {
      // No resolvable dsh-session copy from this anchor — nothing to register into.
    }
  }
}
