/** Local scripted model used only by the real Loader retrieval workflow. */
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** Tool-capable deterministic model; all requests stay in this process. */
export class RetrievalFixtureModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  /** Monotonic adapter receipt times in the same order as `requests`. */
  readonly requestTimes: number[] = []
  readonly responses: StreamChunk[][] = []

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.requests.push(options)
    this.requestTimes.push(performance.now())
    const response = this.responses.shift()
    if (response === undefined) throw new Error('retrieval fixture model has no response')
    yield* response
  }

  /**
   * Queue a model tool call followed by its final answer.
   * @param name - registered tool.
   * @param args - model-generated JSON arguments.
   * @returns nothing.
   */
  call(name: string, args: object): void {
    const id = ToolCallId(`fixture-${this.requests.length + this.responses.length}`)
    const text = JSON.stringify(args)
    this.responses.push([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: text },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: text } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ], [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Reviewed the local tool result.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Reviewed the local tool result.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  }
}
