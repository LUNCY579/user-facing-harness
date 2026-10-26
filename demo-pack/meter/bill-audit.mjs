#!/usr/bin/env node
/**
 * bill-audit.mjs — record agent requests, tool-call trajectories, and
 * official-list-price cost from a DeepSeek Harness session export.
 *
 * Input: logical session events as JSON (array, { events: [...] }) or JSONL
 * (one event per line), or a directory containing such files (the unzipped
 * output of the harness Web UI `/export` command).
 *
 * This is a LOG-REPLAY reporter, in the harness's own token-meter spirit:
 * it replays the durable log, makes no model calls, and never invents data.
 * Unknown models are reported as unpriced, never priced by guess.
 *
 * Event shapes consumed (from @deepseek-ai/dsh-token-meter source):
 * - request/context: sets the priced route. Model from data.model,
 *   data.modelId, data.model_id, or data.route.model.
 * - assistant/message: data.usage { inputTokens, outputTokens,
 *   cacheReadTokens?, cacheWriteTokens? } is the finalized sample for its
 *   (turn, step). Content blocks in data.blocks / data.content /
 *   data.message.content carry tool calls.
 * - assistant/attempt: usage is the LAST stream chunk carrying .usage.
 * - llm/retry-started: closes the replacement slot for its (turn, step),
 *   so the retried attempt ADDS to the totals instead of replacing.
 *
 * Within one (turn, step), samples replace each other (last wins) and count
 * as ONE agent request. A retry creates a NEW billed request.
 *
 * Cost convention (see prices.json): cost = inputTokens x cache-miss rate
 * + cacheReadTokens x cache-hit rate + outputTokens x output rate.
 * Cache-write tokens are not separately billed. DeepSeek peak/off-peak is
 * decided from each sample's UTC timestamp (weekday 01:00-04:00 and
 * 06:00-10:00 UTC = peak); Chinese-public-holiday exclusion is NOT applied
 * (no holiday calendar is bundled), which can only overstate peak cost.
 *
 * Usage:
 *   node bill-audit.mjs run --input <events.jsonl|dir> --out <dir> \
 *     --arm control|treatment --task <task-id> [--run-at <ISO>] [--success true|false]
 *   node bill-audit.mjs compare --control <meter.json> --treatment <meter.json> --out <dir>
 *   node bill-audit.mjs compare --control-dir <dir> --treatment-dir <dir> --out <dir>
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const round6 = (x) => Math.round(x * 1e6) / 1e6;

function loadPrices(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return raw;
}

function resolvePriceEntry(prices, model) {
  if (!model) return null;
  let entry = prices.models[model];
  const seen = new Set();
  while (entry && entry.alias_of && !seen.has(model)) {
    seen.add(model);
    model = entry.alias_of;
    entry = prices.models[model];
  }
  return entry && !entry.alias_of ? { id: model, ...entry } : null;
}

function isDeepSeekPeak(date) {
  const day = date.getUTCDay(); // 0 Sun .. 6 Sat
  if (day === 0 || day === 6) return false;
  const mins = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (mins >= 60 && mins < 240) || (mins >= 360 && mins < 600);
}

function priceSample(prices, model, sample, when) {
  const entry = resolvePriceEntry(prices, model);
  if (!entry) return { cost: null, entry: null, ratePeriod: null };
  const rate = (field) => {
    const v = entry[field];
    if (v && typeof v === 'object') {
      const assumed = entry.peak_rule === 'deepseek' && !when;
      const peak = entry.peak_rule === 'deepseek' ? (when ? isDeepSeekPeak(when) : true) : false;
      return { value: peak ? v.peak : v.off_peak, ratePeriod: peak ? (assumed ? 'peak-assumed' : 'peak') : 'off_peak', assumed };
    }
    return { value: v ?? 0, ratePeriod: null, assumed: false };
  };
  const miss = rate('input_cache_miss');
  const hit = rate('input_cache_hit');
  const out = rate('output');
  const cost = (sample.inputTokens || 0) * miss.value / 1e6
    + (sample.cacheReadTokens || 0) * hit.value / 1e6
    + (sample.outputTokens || 0) * out.value / 1e6;
  return { cost: round6(cost), entry, ratePeriod: miss.ratePeriod, assumedPeak: miss.assumed };
}

function eventTime(event, fallback) {
  const raw = event?.data?.timestamp ?? event?.timestamp ?? event?.ts ?? event?.data?.time ?? null;
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

function usageOf(event) {
  const data = event?.data ?? {};
  if (event.type === 'assistant/message' && data.usage) return data.usage;
  if (event.type === 'assistant/attempt') {
    if (data.usage) return data.usage;
    const stream = Array.isArray(data.stream) ? data.stream : (Array.isArray(data.streamChunks) ? data.streamChunks : null);
    if (stream) {
      for (let i = stream.length - 1; i >= 0; i -= 1) {
        if (stream[i] && stream[i].usage) return stream[i].usage;
      }
    }
  }
  return undefined;
}

function routeOf(event) {
  const data = event?.data ?? {};
  const model = data.model ?? data.modelId ?? data.model_id ?? data.route?.model ?? data.modelName ?? null;
  const provider = data.provider ?? data.route?.provider ?? null;
  return { model, provider };
}

function blocksOf(event) {
  const data = event?.data ?? {};
  for (const key of ['blocks', 'content']) {
    if (Array.isArray(data[key])) return data[key];
  }
  if (data.message && typeof data.message === 'object') {
    for (const key of ['blocks', 'content']) {
      if (Array.isArray(data.message[key])) return data.message[key];
    }
  }
  return [];
}

function toolNameOf(block) {
  if (!block || typeof block !== 'object') return null;
  const type = String(block.type ?? block.kind ?? '');
  const name = block.name ?? block.tool ?? block.toolName ?? block.function?.name ?? block.call?.name ?? null;
  const looksLikeToolCall = /tool/i.test(type) || name !== null;
  if (!looksLikeToolCall) return null;
  // Tool RESULT blocks are not calls: they carry results, not invocations.
  if (/result/i.test(type)) return null;
  return name ?? type;
}

function readEvents(inputPath) {
  const events = [];
  const readFile = (file) => {
    const text = readFileSync(file, 'utf8').trim();
    if (!text) return;
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) events.push(...parsed);
        else if (Array.isArray(parsed.events)) events.push(...parsed.events);
        else events.push(parsed);
        return;
      } catch { /* fall through to JSONL */ }
    }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t) events.push(JSON.parse(t));
    }
  };
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) walk(join(p, name));
    } else if (['.json', '.jsonl', '.ndjson'].includes(extname(p).toLowerCase())) {
      readFile(p);
    }
  };
  walk(inputPath);
  // Session order: seq when present, else file order (stable).
  const withSeq = events.every((e) => Number.isFinite(e?.seq));
  if (withSeq) events.sort((a, b) => a.seq - b.seq);
  return events;
}

function auditRun(events, prices, opts) {
  const runAt = opts.runAt ? new Date(opts.runAt) : null;
  let route = { model: null, provider: null };
  const slots = new Map(); // "turn:step" -> attempt row (live, replaceable)
  const distinctKeys = new Set();
  const attempts = [];
  const trajectory = [];
  const perTool = {};
  const warnings = [];
  const unpricedModels = new Set();
  let assumedPeak = false;
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let costUsd = 0;
  let pricedAttempts = 0;

  const addSample = (sample, into) => {
    into.inputTokens += sample.inputTokens || 0;
    into.outputTokens += sample.outputTokens || 0;
    into.cacheReadTokens += sample.cacheReadTokens || 0;
    into.cacheWriteTokens += sample.cacheWriteTokens || 0;
  };
  const subSample = (sample, from) => {
    from.inputTokens -= sample.inputTokens || 0;
    from.outputTokens -= sample.outputTokens || 0;
    from.cacheReadTokens -= sample.cacheReadTokens || 0;
    from.cacheWriteTokens -= sample.cacheWriteTokens || 0;
  };

  for (const event of events) {
    if (event.type === 'request/context') {
      const r = routeOf(event);
      if (r.model) route.model = r.model;
      if (r.provider) route.provider = r.provider;
      continue;
    }
    if (event.type === 'llm/retry-started') {
      const key = `${event?.data?.turn}:${event?.data?.step}`;
      slots.delete(key); // totals keep the closed attempt; the retry will add anew
      continue;
    }
    if (event.type === 'assistant/message') {
      // Tool-call trajectory: finalized message blocks only. Streaming
      // attempt chunks are deliberately NOT counted (they duplicate finals).
      const seq = event.seq ?? null;
      const turn = event?.data?.turn ?? null;
      const step = event?.data?.step ?? null;
      for (const block of blocksOf(event)) {
        const name = toolNameOf(block);
        if (!name) continue;
        trajectory.push({ seq, turn, step, tool: name });
        perTool[name] = (perTool[name] ?? 0) + 1;
      }
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    const sample = usageOf(event);
    if (!sample) continue;
    const turn = event?.data?.turn;
    const step = event?.data?.step;
    const key = (turn !== undefined && step !== undefined) ? `${turn}:${step}` : `seq:${event.seq ?? attempts.length}`;
    const when = eventTime(event, runAt);
    const evRoute = routeOf(event);
    const model = evRoute.model ?? route.model;
    const provider = evRoute.provider ?? route.provider;
    if (!model) unpricedModels.add('(no route recorded)');
    const priced = priceSample(prices, model, sample, when);
    if (model && priced.cost === null) unpricedModels.add(model);
    if (slots.has(key)) {
      const row = slots.get(key);
      subSample(row.tokens, totals);
      if (row.cost !== null) { costUsd -= row.cost; pricedAttempts -= 1; }
      row.tokens = { inputTokens: sample.inputTokens || 0, outputTokens: sample.outputTokens || 0, cacheReadTokens: sample.cacheReadTokens || 0, cacheWriteTokens: sample.cacheWriteTokens || 0 };
      row.model = model; row.provider = provider; row.cost = priced.cost; row.ratePeriod = priced.ratePeriod;
      addSample(sample, totals);
      if (priced.cost !== null) { costUsd += priced.cost; pricedAttempts += 1; }
    } else {
      distinctKeys.add(key);
      const row = {
        attempt: attempts.length + 1, turn: turn ?? null, step: step ?? null, seq: event.seq ?? null,
        model: model ?? null, provider: provider ?? null,
        tokens: { inputTokens: sample.inputTokens || 0, outputTokens: sample.outputTokens || 0, cacheReadTokens: sample.cacheReadTokens || 0, cacheWriteTokens: sample.cacheWriteTokens || 0 },
        cost: priced.cost, ratePeriod: priced.ratePeriod,
      };
      attempts.push(row);
      slots.set(key, row);
      addSample(sample, totals);
      if (priced.cost !== null) { costUsd += priced.cost; pricedAttempts += 1; }
    }
  }

  const retries = attempts.length - distinctKeys.size;
  assumedPeak = attempts.some((r) => r.ratePeriod === 'peak-assumed');
  if (assumedPeak) warnings.push('Some DeepSeek samples had no timestamp; priced at peak (upper bound). Pass --run-at or keep event timestamps to price time-accurately.');
  if (trajectory.length === 0) warnings.push('No tool-call blocks found in assistant messages; trajectory is empty. If this log records tool calls only as dedicated tool events, extend blocksOf() — see README known limitation.');
  if (unpricedModels.size > 0) warnings.push(`Unpriced models (cost excluded, tokens still counted): ${[...unpricedModels].join(', ')}`);
  return {
    version: 'bill-audit/1',
    run: { arm: opts.arm ?? null, task: opts.task ?? null, success: opts.success ?? null, runAt: runAt ? runAt.toISOString() : null },
    requests: { attempts: attempts.length, retries, distinctTurnSteps: distinctKeys.size },
    tokens: totals,
    cost: { usd: round6(costUsd), pricedAttempts, priceTable: prices.version, convention: prices.convention },
    trajectory: { toolCalls: trajectory.length, perTool, sequence: trajectory },
    attempts,
    warnings,
  };
}

function writeReport(meter, outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'meter.json'), JSON.stringify(meter, null, 2) + '\n');
  const t = meter.tokens;
  const lines = [
    `# Bill audit — ${meter.run.task ?? 'run'} (${meter.run.arm ?? 'unknown arm'})`,
    '',
    `- Agent requests (model-call attempts): **${meter.requests.attempts}** (retries: ${meter.requests.retries})`,
    `- Tool calls: **${meter.trajectory.toolCalls}** across ${Object.keys(meter.trajectory.perTool).length} tools`,
    `- Tokens: input ${t.inputTokens}, cache-read ${t.cacheReadTokens}, cache-write ${t.cacheWriteTokens}, output ${t.outputTokens}`,
    `- Cost at official list prices: **$${meter.cost.usd.toFixed(6)}** (${meter.cost.pricedAttempts}/${meter.requests.attempts} attempts priced; table ${meter.cost.priceTable})`,
    ...(meter.run.success !== null ? [`- Task success: ${meter.run.success ? 'YES' : 'NO'}`] : []),
    '',
    '## Tool-call trajectory',
    '',
    meter.trajectory.sequence.length > 0
      ? meter.trajectory.sequence.map((s, i) => `${i + 1}. ${s.tool}`).join('\n')
      : '(none recorded)',
    '',
    '## Per-tool counts',
    '',
    ...Object.entries(meter.trajectory.perTool).map(([k, v]) => `- ${k}: ${v}`),
    '',
    ...(meter.warnings.length > 0 ? ['## Warnings', '', ...meter.warnings.map((w) => `- ${w}`), ''] : []),
    '_Cost convention: see prices.json. Same model + same table both arms; unpriced models are excluded from cost, never guessed._',
    '',
  ];
  writeFileSync(join(outDir, 'report.md'), lines.join('\n'));
  return meter;
}

function compareMeters(control, treatment, outDir) {
  mkdirSync(outDir, { recursive: true });
  const rows = [];
  const pairUp = (cList, tList) => {
    const tByTask = new Map(tList.map((m) => [m.run.task, m]));
    for (const c of cList) {
      const t = tByTask.get(c.run.task);
      if (t) rows.push({ task: c.run.task, control: c, treatment: t });
    }
  };
  if (Array.isArray(control) && Array.isArray(treatment)) pairUp(control, treatment);
  else rows.push({ task: control.run.task, control, treatment });
  const sum = (list, f) => list.reduce((a, m) => a + f(m), 0);
  const cList = rows.map((r) => r.control);
  const tList = rows.map((r) => r.treatment);
  const totals = {
    tasks: rows.length,
    control: { requests: sum(cList, (m) => m.requests.attempts), toolCalls: sum(cList, (m) => m.trajectory.toolCalls), cost: round6(sum(cList, (m) => m.cost.usd)), success: cList.filter((m) => m.run.success === true).length },
    treatment: { requests: sum(tList, (m) => m.requests.attempts), toolCalls: sum(tList, (m) => m.trajectory.toolCalls), cost: round6(sum(tList, (m) => m.cost.usd)), success: tList.filter((m) => m.run.success === true).length },
  };
  const pct = (c, t) => (c === 0 ? null : round6((c - t) / c * 100));
  const comparison = {
    version: 'bill-audit/1',
    totals,
    savings: {
      costUsd: round6(totals.control.cost - totals.treatment.cost),
      costPct: pct(totals.control.cost, totals.treatment.cost),
      requestsPct: pct(totals.control.requests, totals.treatment.requests),
      toolCallsPct: pct(totals.control.toolCalls, totals.treatment.toolCalls),
    },
    rows: rows.map((r) => ({
      task: r.task,
      control: { requests: r.control.requests.attempts, toolCalls: r.control.trajectory.toolCalls, cost: r.control.cost.usd, success: r.control.run.success },
      treatment: { requests: r.treatment.requests.attempts, toolCalls: r.treatment.trajectory.toolCalls, cost: r.treatment.cost.usd, success: r.treatment.run.success },
    })),
  };
  writeFileSync(join(outDir, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
  const md = [
    '# Bill audit comparison — control vs treatment',
    '',
    `Tasks compared: ${totals.tasks}. Same prompt, same workspace snapshot, same model, same price table both arms.`,
    '',
    '| | Control (no predictive tooling) | Treatment (predictive tooling) | Saving |',
    '|---|---|---|---|',
    `| Cost (official list prices) | $${totals.control.cost.toFixed(6)} | $${totals.treatment.cost.toFixed(6)} | $${comparison.savings.costUsd.toFixed(6)} (${comparison.savings.costPct ?? 'n/a'}%) |`,
    `| Agent requests | ${totals.control.requests} | ${totals.treatment.requests} | ${comparison.savings.requestsPct ?? 'n/a'}% |`,
    `| Tool calls | ${totals.control.toolCalls} | ${totals.treatment.toolCalls} | ${comparison.savings.toolCallsPct ?? 'n/a'}% |`,
    `| Tasks succeeded | ${totals.control.success}/${totals.tasks} | ${totals.treatment.success}/${totals.tasks} | |`,
    '',
    '## Per-task',
    '',
    '| Task | Control req / tools / $ | Treatment req / tools / $ |',
    '|---|---|---|',
    ...comparison.rows.map((r) => `| ${r.task} | ${r.control.requests} / ${r.control.toolCalls} / $${r.control.cost.toFixed(6)} | ${r.treatment.requests} / ${r.treatment.toolCalls} / $${r.treatment.cost.toFixed(6)} |`),
    '',
    '_Read with the success rows: a cheaper failed run is not a win. Costs are equivalent official-list-price costs, not amounts billed — free routes may bill $0; the percentage is what transfers._',
    '',
  ];
  writeFileSync(join(outDir, 'comparison.md'), md.join('\n'));
  return comparison;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq >= 0) args[key.slice(0, eq)] = key.slice(eq + 1);
      else args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    } else args._.push(a);
  }
  return args;
}

function loadMeter(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function loadMeterDir(dir) {
  const out = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) { for (const n of readdirSync(p).sort()) walk(join(p, n)); }
    else if (basename(p) === 'meter.json') out.push(loadMeter(p));
  };
  walk(dir);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const pricesPath = args.prices ?? join(HERE, 'prices.json');
  if (!existsSync(pricesPath)) { console.error(`prices.json not found: ${pricesPath}`); process.exit(1); }
  const prices = loadPrices(pricesPath);
  if (cmd === 'run') {
    if (!args.input || !args.out) { console.error('Usage: bill-audit.mjs run --input <events|dir> --out <dir> --arm control|treatment --task <id> [--run-at <ISO>] [--success true|false]'); process.exit(1); }
    const events = readEvents(args.input);
    const meter = auditRun(events, prices, {
      arm: args.arm ?? null, task: args.task ?? null,
      success: args.success === undefined ? null : args.success === 'true',
      runAt: args['run-at'] ?? null,
    });
    writeReport(meter, args.out);
    console.log(`events=${events.length} attempts=${meter.requests.attempts} retries=${meter.requests.retries} toolCalls=${meter.trajectory.toolCalls} cost=$${meter.cost.usd.toFixed(6)}`);
    if (meter.warnings.length > 0) for (const w of meter.warnings) console.log(`warning: ${w}`);
  } else if (cmd === 'compare') {
    if (!args.out) { console.error('Usage: bill-audit.mjs compare --control <meter.json> --treatment <meter.json> --out <dir>  OR  --control-dir <dir> --treatment-dir <dir>'); process.exit(1); }
    const c = args['control-dir'] ? loadMeterDir(args['control-dir']) : [loadMeter(args.control)];
    const t = args['treatment-dir'] ? loadMeterDir(args['treatment-dir']) : [loadMeter(args.treatment)];
    const cmp = compareMeters(c, t, args.out);
    console.log(`tasks=${cmp.totals.tasks} control=$${cmp.totals.control.cost.toFixed(6)} treatment=$${cmp.totals.treatment.cost.toFixed(6)} saving=$${cmp.savings.costUsd.toFixed(6)} (${cmp.savings.costPct ?? 'n/a'}%)`);
  } else {
    console.error('Usage: bill-audit.mjs run|compare ... (see header comment)');
    process.exit(1);
  }
}

main();
