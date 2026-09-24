/**
 * Runtime-checked views of the DSH/cordis contexts this plugin is handed.
 *
 * DSH augments the cordis event map at link time (`agent/created`,
 * `agent/status`, `agent/pre-step`, `system-prompt/assemble`, `agent/request`,
 * …) and its agent registry takes branded identifiers this plugin never
 * mints. The plugin's own build does not link those declarations, so from
 * here every hook name is a runtime string and every handed-in context is
 * structurally unknown. Rather than casting each context at each call site,
 * the shapes the plugin relies on are declared once here and checked once at
 * the boundary: a context that lacks a method is a wiring fault the caller
 * can report, not a TypeError inside a listener.
 *
 * Leaf module: no project imports.
 */

/** Anything with a cordis-style `on()`: the root plugin context (agent
 *  lifecycle events) or one agent's scoped context (status, pre-step, prompt
 *  assembly, request waterfall). Handlers are typed per event at the call
 *  site; the returned value is the unsubscribe function when cordis provides
 *  one. */
export interface HookSource {
  on(name: string, handler: (...args: never[]) => unknown, options?: { prepend?: boolean }): (() => void) | void
}

/** The scoped context of one agent as the candidate setup sees it: hooks
 *  plus service lookup and the session the setup writes policy events into. */
export interface AgentScope extends HookSource {
  get(name: string): unknown
  agent?: { session: { append(type: string, data: Record<string, unknown>): void } }
}

/** The one call this plugin makes into DSH's agent registry. Options are a
 *  plain object on this side of the seam (DSH validates and brands them);
 *  the returned agent is opaque until the candidate factory asserts the
 *  handle shape it needs. */
export type AgentCreate = (options: Record<string, unknown>) => Promise<{ agent: unknown; dispose(): Promise<void> }>

export function isHookSource(value: unknown): value is HookSource {
  return typeof value === 'object' && value !== null && 'on' in value && typeof value.on === 'function'
}

export function isAgentScope(value: unknown): value is AgentScope {
  return isHookSource(value) && 'get' in value && typeof value.get === 'function'
}

/** Narrow or fail loudly: used where a missing hook surface means the plugin
 *  cannot do its job at all (the root context at start()). */
export function requireHookSource(value: unknown, what: string): HookSource {
  if (!isHookSource(value)) throw new Error('dsh-context: ' + what + ' exposes no on(); the plugin cannot subscribe to agent events')
  return value
}
