// Compile-time contract between the plugin's hand-declared views of DSH
// agents and DSH's published declarations (review R6 6.6).
//
// src/ deliberately never imports @deepseek-ai/dsh-agent: the plugin's build
// does not link DSH's augmented declarations, so the shapes it relies on are
// declared once in its own terms (src/host.ts `Agent`, src/dsh-context.ts
// `AgentCreate`, src/selection/candidates.ts `SelectionAgentHandle`) and
// checked at runtime at the boundary. Nothing used to tie those views to the
// real types: R4's relay-consumption fix rests on `Agent.status` and
// `Agent.inbox`, and was verified by reading the .d.ts by hand. This file is
// type-checked in CI (`npm run check:contract`) against the installed peer,
// so a DSH release that renames or reshapes any of them fails the build
// instead of silently disabling a runtime-checked code path.
import type { Agent as DshAgent, AgentHandle, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent as PluginSourceAgent } from '../../src/host.js'
import type { SelectionAgentHandle } from '../../src/selection/candidates.js'
import type { AgentCreate } from '../../src/dsh-context.js'

type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

// R4 4.1: "the source agent is not running" and "the relay is no longer in
// the inbox" are read from these two members.
export type StatusHasRunning = Assert<Extends<'running', AgentStatus>>
export type StatusHasIdle = Assert<Extends<'idle', AgentStatus>>
export type SourceAgentView = Assert<Extends<DshAgent, PluginSourceAgent>>

// The registry's create() result is what the candidate factory narrows.
export type CreateResultView = Assert<Extends<AgentHandle, Awaited<ReturnType<AgentCreate>>>>

// Candidate agents: everything but followup's parameter matches structurally.
// This assertion caught review R6 6.6: the view declared `cancel?: () => void`
// while DSH requires a cause, and newer agent loops throw without one.
type CandidateAgent = SelectionAgentHandle['agent']
export type CandidateAgentView = Assert<Extends<DshAgent, Omit<CandidateAgent, 'followup'>>>
// followup: DSH brands message ids (`MessageId`), and the plugin mints plain
// UUID strings. The brand is erased at runtime: dsh-llm's `MessageId(id)`
// returns `id` unvalidated, and DSH mints its own ids from randomUUID too.
// Every other part of the plugin's message must be a valid UserMessage.
type PluginMessage = Parameters<CandidateAgent['followup']>[0]
export type FollowupMessage = Assert<Extends<Omit<PluginMessage, 'id'> & { id: MessageId }, UserMessage>>
