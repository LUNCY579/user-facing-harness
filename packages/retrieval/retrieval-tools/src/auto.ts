/**
 * Automatic retrieval in front of a model request. One passage block is appended to the messages of
 * a turn's first step, under the same data-not-instructions framing the tools use, and a failure
 * here never costs the turn its context window.
 * @module @deepseek-ai/dsh-retrieval-tools/auto
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import { RetrievalError, contentHash, type Candidate, type RetrievalQuery } from '@deepseek-ai/dsh-retrieval'
import type {} from '@deepseek-ai/dsh-session-query'
import type { ResolveIdentity } from './identity.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Retrieved context attribution; readers preserve message text and metadata without this producer.
     * Only the producer uses `fingerprint` for duplicate suppression; it grants no authority.
     * @persistenceAttribution
     */
    'retrieval-tools': {
      kind: 'retrieval-tools'
      /** Digest of selected record IDs, content hashes, and memory versions, independent of ranking. */
      fingerprint: string
    } & ContextFormed
  }
}

/** Deployment choices for automatic retrieval. */
export interface AutoConfig {
  /** Append retrieved passages to a turn's first step. */
  enabled: boolean
  /** Passage ceiling for one automatic query. */
  topK: number
  /** Relevance floor; below it nothing is injected. */
  minScore: number
  /** Token ceiling for the appended block. */
  budgetTokens: number
  /** Queries shorter than this are treated as chatter and retrieve nothing. */
  minQueryChars: number
}

/**
 * Install automatic retrieval for every agent this scope sees.
 * @param ctx - scope that resolved the retrieval services.
 * @param config - conservative limits for one injection.
 * @param resolveIdentity - fixed host identity shared with explicit tool calls.
 * @returns nothing; the listener is owned by this scope's fiber.
 */
export function installAutoRetrieval(ctx: Context, config: AutoConfig, resolveIdentity: ResolveIdentity): void {
  if (!config.enabled) return
  const history = ctx.get('sessionQuery')
  if (history === undefined) throw new RetrievalError('invalid_input', 'Automatic retrieval requires the sessionQuery service')
  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted || payload.step !== 1) return decision
    const query = queryOf(decision.messages)
    if (query.length < config.minQueryChars) return decision
    let text: string
    let fingerprint: string
    try {
      const identity = await resolveIdentity(payload.agent, payload.signal)
      const search: RetrievalQuery = {
        mode: 'hybrid',
        text: query,
        topK: config.topK,
        scopes: ['workspace', 'session', 'agent', 'user'],
        pathPrefixes: [],
        minScore: config.minScore,
        budgetTokens: config.budgetTokens,
        signal: payload.signal,
      }
      const packet = await ctx.retrieval.search(search, identity)
      text = ctx.retrieval.renderInjection(packet)
      fingerprint = selectionFingerprint(packet.candidates)
      if (text.length === 0) return decision
      payload.signal.throwIfAborted()
      const logged = await history.readSession(payload.agent.session.id)
      payload.signal.throwIfAborted()
      const alreadyLogged = logged.events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'retrieval-tools'
        && event.data.source.fingerprint === fingerprint)
      if (alreadyLogged) return decision
    } catch (error) {
      // Automatic retrieval is an optimization: a backend, embedding, or authorization failure
      // leaves the turn with its own messages, and `memory_status` still reports the cause.
      ctx.logger.warn(`retrieval-tools: automatic retrieval skipped: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'retrieval-tools', fingerprint, form: 'snapshot', sections: [{ name: 'retrieval', text }] },
        }),
      ],
    }
  })
}

/** Identify the selected facts without query-dependent scores or result order. */
function selectionFingerprint(candidates: readonly Candidate[]): string {
  const records = candidates.map(({ record }) => JSON.stringify([
    record.id,
    record.contentHash,
    record.kind === 'memory' ? record.version : null,
  ]))
  return contentHash(records.sort().join('\n'))
}

/**
 * Take the searchable text of the messages entering a step.
 * @param messages - the batch the inbox claimed.
 * @returns joined user text, excluding earlier retrieval context.
 */
function queryOf(messages: readonly UserMessage[]): string {
  const text = messages
    .filter(message => message.source.kind !== 'retrieval-tools')
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => ('text' in block ? block.text : ''))
    .join('\n')
    .trim()
  return text
}
