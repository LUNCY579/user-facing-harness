/**
 * Synthetic relevance cases and pre-declared quality targets for local embedding
 * routes. Text is authored here as reviewed constants: no workspace file,
 * conversation, credential, or private document is read.
 *
 * Targets are fixed before any measurement. A route that misses them is recorded
 * as a failure rather than having its thresholds relaxed afterwards.
 */

/** Case families the evaluation must cover. */
export type CaseCategory = 'paraphrase' | 'hard-negative' | 'identifier' | 'multilingual' | 'missing-evidence'

/** One indexed passage. `source` and lines make every hit a checkable citation. */
export interface EvalPassage {
  id: string
  text: string
  source: string
  startLine: number
  endLine: number
}

/** One query with the passages that answer it, ordered from best match. */
export interface EvalQuery {
  id: string
  category: CaseCategory
  text: string
  /** Answer passage ids, best first. Empty means no evidence exists in the corpus. */
  relevant: string[]
  /** Ids that share surface tokens with the query but must not outrank the answer. */
  confusables: string[]
}

const P = (id: string, text: string, source: string, startLine = 1, endLine = 3): EvalPassage => ({ id, text, source, startLine, endLine })

/** Corpus: 35 passages spanning retries, budgets, storage, identity, licensing, and one code symbol. */
export const passages: EvalPassage[] = [
  P('receipt-gate', 'export function refundPayment(hasReceipt: boolean) returns RECEIPT_REQUIRED when the receipt flag is false and APPROVED otherwise.', 'lib/billing/refund-payment.ts'),
  P('rate-limit-pause', 'The client sleeps for a backoff interval before it issues the next attempt after an upstream reply carries a retry-after hint. Repeated throttled replies widen `retryBackoffMs` up to `retryMaxBackoffMs`.', 'lib/retry/backoff.ts'),
  P('budget-ceiling', 'A request may not exceed the configured token allowance. When the remaining allowance cannot fit the next passage, packing stops early and marks the packet as truncated.', 'lib/context/pack.ts'),
  P('vector-space-refusal', 'Records that were produced by a different encoder are never compared with the current ones. The store reports a mismatch and refuses the operation instead of mixing the two sets.', 'lib/retrieval/gateway.ts'),
  P('owner-is-host-supplied', 'Only the host may decide whose facts a caller may read. Values that a model types into an argument carry no authority at all, and a forged identifier is discarded before the query runs.', 'lib/retrieval/identity.ts'),
  P('forget-leaves-backups', 'Removing a searchable entry does not touch copies that other systems already keep. Old transcripts, snapshots, and archive files can still repeat the same sentence afterwards.', 'lib/retrieval/forget.ts'),
  P('staged-activation', 'A corrected entry stays hidden until its predecessor is marked as replaced. If the process stops between the two steps, the pending record is completed on the next authorized read.', 'lib/retrieval/engine.ts', 40, 44),
  P('expiry-sweep', 'A dated entry disappears from results the moment its deadline passes, yet its row survives until a sweep that matches the expired selector deletes it.', 'lib/retrieval/memory.ts'),
  P('compression-quality', 'Four-bit packing keeps more of the ranked list than two-bit packing on the same corpus, so the narrower setting is offered only as an experiment.', 'lib/retrieval/accelerator.ts'),
  P('hash-not-semantics', 'The default encoder projects tokens into fixed buckets with a digest. Two sentences that mean the same thing but share no word therefore land far apart.', 'lib/embeddings/local.ts'),
  P('loopback-only-transport', 'The local encoder talks to an address on this machine and rejects any redirect away from it, so indexed sentences are never forwarded to a remote host.', 'lib/embeddings/remote.ts'),
  P('remote-consent-flag', 'Sending text to a hosted encoder needs `allowRemoteEmbeddings: true` plus a credential named by `apiKeyEnv`. Both default to off.', 'lib/embeddings/config.ts'),
  P('writer-lease', 'One process may hold the durable index at a time. A second attempt is refused while the first is alive, and the reservation is released when that process exits. The directory named by `indexDir` holds the lease.', 'lib/retrieval/lock.ts'),
  P('worker-ephemeral', 'The optional reranking helper keeps no authoritative copy of its own. Losing its process costs only the compressed projection, which is rebuilt from the durable records.', 'lib/retrieval/turbovec.ts'),
  P('cancel-between-batches', 'A caller may abandon work that has not started yet. Long native kernels already inside a call cannot be interrupted, so batches stay small enough to abandon between calls.', 'lib/retrieval/indexing.ts'),
  P('path-exclusion', 'Directories of generated output and version-control metadata are skipped before any file is opened. Credential files are matched by name, while an embedded secret in an ordinary source file cannot be detected.', 'lib/retrieval/scan.ts'),
  P('reindex-is-explicit', 'A query never walks the filesystem. Freshness depends on an explicit synchronize call after edits, renames, or deletions.', 'lib/retrieval/indexing.ts', 60, 62),
  P('hnsw-depth', 'Raising `hnswEf` widens the candidate frontier and recovers entries that a shallow pass misses, at a measured latency cost per query.', 'lib/retrieval/schema.ts'),
  P('multilingual-encoder', 'The selected neural encoder was trained on more than one hundred languages and places a question and its foreign-language paraphrase near one another.', 'docs/embeddings/bge-m3.md'),
  P('no-query-instruction', 'This encoder expects the sentence exactly as written. Prefixing it with an instruction string shifts the vector and degrades ranking.', 'docs/embeddings/bge-m3.md', 6, 7),
  P('mit-license', 'The encoder weights are distributed under a permissive license that allows local redistribution inside a private application build without a separate grant.', 'docs/embeddings/bge-m3.md', 9, 10),
  P('ten-twenty-four-dims', 'Each sentence is summarised as a vector of one thousand and twenty-four components, and `dimension` must be configured to that number while `modelRevision` pins the weights behind it.', 'docs/embeddings/bge-m3.md', 11, 12),
  P('untrusted-evidence', 'A fetched passage arrives labelled as data. The framing text instructs the reader to treat its contents as evidence rather than as an order to follow.', 'lib/retrieval/prompt.ts'),
  P('evidence-fingerprint', 'Evidence already delivered in a session is not delivered twice, unless its content or version changes and produces a new fingerprint.', 'lib/retrieval/auto.ts'),
  P('auto-threshold', 'Automatic delivery is limited to a small number of passages above `autoMinScore` and inside `autoBudgetTokens`, and it only fires for questions of at least `autoMinQueryLength` characters.', 'lib/retrieval/auto.ts', 12, 15),
  P('scope-matrix', 'A workspace fact is reachable inside its own directory; a personal fact needs the persistence switch; a session fact needs the cross-session switch before another session may see it.', 'docs/user/local-retrieval.md'),
  P('accelerator-default', 'The durable store answers by default. The experimental reranker needs `useAccelerator: true`, and a missing or failing helper falls back to the durable answer.', 'lib/retrieval/engine.ts', 70, 72),
  P('dedup-exact-case', 'Two identical sentences written with different capitalisation are stored as two entries, because the deduplication test is case-sensitive on purpose.', 'lib/retrieval/memory.ts', 20, 22),
  P('session-log-read-only', 'Reading an authorized conversation to build the projection never rewrites the log; the transcript bytes stay exactly as the writer left them.', 'lib/retrieval/scan.ts', 30, 32),
  P('linux-support', 'Prebuilt native packages exist for Linux on both 64-bit x86 and ARM, for the two C libraries, and for macOS and Windows.', 'docs/platform/matrix.md'),
  P('python-floor', 'The optional helper needs Python 3.11 or newer in a private environment, with the pinned package pair installed there.', 'docs/platform/turbovec.md'),
  P('symlink-reject', 'A session opened through an alias to its directory is refused, because restarting through the alias could move its authority to another directory.', 'lib/retrieval/identity.ts', 44, 46),
  P('outcome-pending', 'When a write cannot be confirmed either way, the operation reports `outcome_pending` and stops dependent work rather than guessing.', 'lib/retrieval/errors.ts'),
  P('batch-width', 'Sentences are grouped before encoding, and the group size bounds one request body so a large synchronize cannot grow without limit.', 'lib/embeddings/config.ts', 20, 22),
  P('status-health', 'The status call names the encoder space, the durable record counts, and whether the optional helper answered.', 'lib/retrieval/status.ts'),
]

const Q = (id: string, category: CaseCategory, text: string, relevant: string[], confusables: string[] = []): EvalQuery =>
  ({ id, category, text, relevant, confusables })

/** 45 queries: 12 paraphrase, 10 hard-negative, 8 identifier, 10 multilingual, 5 missing-evidence. */
export const queries: EvalQuery[] = [
  // Paraphrase: no distinctive content word is shared with the answer.
  Q('para-throttled', 'paraphrase', 'How does the caller decide how long to wait when the server says it is too busy?', ['rate-limit-pause'], ['batch-width']),
  Q('para-allowance', 'paraphrase', 'What stops a prompt from growing past the ceiling agreed for one turn?', ['budget-ceiling'], ['auto-threshold']),
  Q('para-mixed-vectors', 'paraphrase', 'What happens if numbers computed by an older encoder reach the current index?', ['vector-space-refusal'], ['hnsw-depth']),
  Q('para-who-may-read', 'paraphrase', 'Can an agent widen its own reach by naming somebody else in an argument?', ['owner-is-host-supplied'], ['scope-matrix']),
  Q('para-old-copies', 'paraphrase', 'After a fact is deleted, where can the same sentence still be found?', ['forget-leaves-backups'], ['session-log-read-only']),
  Q('para-crash-midwrite', 'paraphrase', 'If the program dies halfway through replacing an entry, who finishes the job?', ['staged-activation'], ['outcome-pending']),
  Q('para-dated-entry', 'paraphrase', 'When does an entry with a deadline stop being offered, and when does its row actually go away?', ['expiry-sweep'], ['forget-leaves-backups']),
  Q('para-narrow-packing', 'paraphrase', 'Which shrinking setting loses the most of the ranked list?', ['compression-quality'], ['hnsw-depth']),
  Q('para-meaningless-similarity', 'paraphrase', 'Why can two sentences with the same meaning end up far apart by default?', ['hash-not-semantics'], ['multilingual-encoder']),
  Q('para-no-egress', 'paraphrase', 'What keeps my indexed prose from leaving this machine?', ['loopback-only-transport'], ['remote-consent-flag']),
  Q('para-two-processes', 'paraphrase', 'What occurs when a second instance opens the same durable index?', ['writer-lease'], ['worker-ephemeral']),
  Q('para-abandon', 'paraphrase', 'Is it possible to stop a long indexing run partway through?', ['cancel-between-batches'], ['reindex-is-explicit']),
  // Hard negatives: heavy token overlap with the wrong passage.
  Q('hard-consent-vs-transport', 'hard-negative', 'Which switch must be turned on before text is sent to a hosted encoder, and which variable supplies its credential?', ['remote-consent-flag'], ['loopback-only-transport']),
  Q('hard-scope-vs-identity', 'hard-negative', 'Inside which directory may a workspace fact be recalled, and what switch is required for another session to see a session fact?', ['scope-matrix'], ['owner-is-host-supplied']),
  Q('hard-depth-vs-budget', 'hard-negative', 'Which knob widens the candidate frontier and raises per-query latency?', ['hnsw-depth'], ['budget-ceiling']),
  Q('hard-ephemeral-vs-lease', 'hard-negative', 'Which component holds no authoritative copy and is rebuilt from durable records after its process dies?', ['worker-ephemeral'], ['writer-lease', 'forget-leaves-backups']),
  Q('hard-dims-vs-instruction', 'hard-negative', 'How many components does one vector carry, and what must the store be configured to match?', ['ten-twenty-four-dims'], ['no-query-instruction', 'vector-space-refusal']),
  Q('hard-py-vs-node', 'hard-negative', 'Which runtime needs a private environment with a pinned package pair installed?', ['python-floor'], ['linux-support', 'worker-ephemeral']),
  Q('hard-exclusion-vs-symlink', 'hard-negative', 'Which directories are skipped before a file is opened, and what happens to a credential file found by name?', ['path-exclusion'], ['symlink-reject']),
  Q('hard-fingerprint-vs-threshold', 'hard-negative', 'When is already-delivered evidence delivered again?', ['evidence-fingerprint'], ['auto-threshold', 'untrusted-evidence']),
  Q('hard-dedup-vs-expiry', 'hard-negative', 'Why do two spellings that differ only in letter case both survive?', ['dedup-exact-case'], ['expiry-sweep', 'hash-not-semantics']),
  Q('hard-status-vs-consent', 'hard-negative', 'Which call reports whether the optional helper answered?', ['status-health'], ['worker-ephemeral', 'accelerator-default']),
  // Identifiers: exact symbol or configuration-key lookup.
  Q('id-refundpayment', 'identifier', 'refundPayment', ['receipt-gate']),
  Q('id-hnswe-f', 'identifier', 'hnswEf', ['hnsw-depth']),
  Q('id-allow-remote', 'identifier', 'allowRemoteEmbeddings', ['remote-consent-flag']),
  Q('id-outcome-pending', 'identifier', 'outcome_pending', ['outcome-pending']),
  Q('id-auto-min-score', 'identifier', 'autoMinScore', ['auto-threshold']),
  Q('id-model-revision', 'identifier', 'modelRevision', ['ten-twenty-four-dims']),
  Q('id-use-accelerator', 'identifier', 'useAccelerator', ['accelerator-default']),
  Q('id-index-dir', 'identifier', 'indexDir', ['writer-lease']),
  // Multilingual: same intent expressed in another language.
  Q('ml-zh-wait', 'multilingual', '服务器太忙时，调用方要等待多久才重试？', ['rate-limit-pause']),
  Q('ml-zh-dimension', 'multilingual', '每个句子被压缩成多少个分量？', ['ten-twenty-four-dims'], ['no-query-instruction']),
  Q('ml-zh-license', 'multilingual', '这份权重的许可协议允许在私有构建里再分发吗？', ['mit-license']),
  Q('ml-ja-pii', 'multilingual', 'ドキュメントの内容がこの computer の外へ出るのを何が止めていますか？', ['loopback-only-transport']),
  Q('ml-ja-second-instance', 'multilingual', '二つ目のプロセスが同じ index を開こうとするとどうなりますか？', ['writer-lease']),
  Q('ml-es-budget', 'multilingual', '¿Qué impide que un aviso supere el límite acordado para un turno?', ['budget-ceiling']),
  Q('ml-es-delete', 'multilingual', 'Después de borrar un dato, ¿dónde puede seguir apareciendo la misma frase?', ['forget-leaves-backups']),
  Q('ml-fr-instruction', 'multilingual', 'Faut-il ajouter une instruction devant la phrase avant de l’encoder ?', ['no-query-instruction'], ['multilingual-encoder']),
  Q('ml-de-languages', 'multilingual', 'Wie viele Sprachen deckt der gewählte Encoder ab?', ['multilingual-encoder']),
  Q('ml-ru-expiry', 'multilingual', 'Когда запись с датой перестает выдаваться и когда удаляется её строка?', ['expiry-sweep']),
  // Missing evidence: nothing in the corpus answers these.
  Q('miss-kubernetes', 'missing-evidence', 'How do I rotate a Kubernetes service account token?', []),
  Q('miss-sql-join', 'missing-evidence', 'Which SQL join returns unmatched rows from both tables?', []),
  Q('miss-gpu-temp', 'missing-evidence', 'What is the safe GPU temperature limit for this laptop?', []),
  Q('miss-invoice', 'missing-evidence', 'When is the vendor invoice for last quarter due?', []),
  Q('miss-zig-build', 'missing-evidence', 'How do I cross-compile a Zig release binary for RISC-V?', []),
]

/** Pre-declared quality targets, authored before any measurement was taken. */
export const targets = {
  /** Retrieval must find an answering passage in the top ten. */
  recallAt10: { paraphrase: { dense: 0.75, hybrid: 0.70, hashed: 0.10, keyword: 0.10 }, 'hard-negative': { dense: 0.80, hybrid: 0.85, hashed: 0.80, keyword: 0.85 }, identifier: { dense: 0.50, hybrid: 0.75, hashed: 0.60, keyword: 0.60 }, multilingual: { dense: 0.60, hybrid: 0.60, hashed: 0.20, keyword: 0.35 } },
  /** Rank of the best answer, averaged over answered queries. */
  mrr: { dense: 0.60, hybrid: 0.60, hashed: 0.30, keyword: 0.40 },
  /** Fraction of no-evidence queries that must yield no accepted passage. */
  missingEvidence: { abstentionRate: 0.80, maxMeanTopScore: 0.60 },
  /** Citation integrity: every accepted candidate must resolve to a corpus passage. */
  citationValidity: 1,
  /** Margins a neural route must beat the lexical routes by before a default change is considered. */
  defaultChangeMargin: { denseOverHashedRecallAt10: 0.15, hybridOverDenseHardNegativeMrr: 0.05 },
} as const

/** Shared query settings for every route, so only the encoder and mode differ. */
export const conditions = { topK: 10, minScore: 0.2, budgetTokens: 4000, hnswEf: 2048, runs: 1, seed: 421337 } as const

/** Routes compared: lexical full-text, feature-hash dense, neural dense, and fused hybrid. */
export type EvalRoute = 'keyword' | 'hashed' | 'dense' | 'hybrid'

export const routes: EvalRoute[] = ['keyword', 'hashed', 'dense', 'hybrid']

/** Verdict record for one route against one target family. */
export interface TargetCheck {
  metric: string
  category?: CaseCategory
  route: EvalRoute
  target: number
  measured: number
  passed: boolean
}
