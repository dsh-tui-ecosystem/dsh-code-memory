/**
 * Session→Agent lookup shared by the capture hooks (session/event carries
 * the session, but only the agent can inject). Entries are dropped on
 * agent/disposed and session/disposed.
 * @module dsh-code-memory/hooks/agent-map
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: resolves the agent/* cordis event declarations.
import type {} from '@deepseek-ai/dsh-agent'

export function trackAgents(ctx: Context): Map<Session, Agent> {
  const agents = new Map<Session, Agent>()
  ctx.on('agent/created', ({ agent }) => {
    agents.set(agent.session, agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    agents.delete(agent.session)
  })
  ctx.on('session/disposed', (session) => {
    agents.delete(session)
  })
  return agents
}
