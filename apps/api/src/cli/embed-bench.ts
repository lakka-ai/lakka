import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { centroidOf, cosine, loadOnnxEmbedder, loadProcessConfig, scoreRoutes } from '@lakka/core';
import type { PolicySnapshot } from '@lakka/core';

/*
 * Spike A: prove the image boots the in-process classifier runtime, embeds text with
 * the bundled model, and does so fast enough, on amd64 and arm64, with no network (RT-4, NF-D4,
 * NF-D5). Prints one JSON report to stdout and exits 1 if any check fails.
 *
 *   lakka embed-bench [--iterations 200] [--threads 1] [--reference file] [--max-p95-ms 100]
 *   lakka embed-bench --write-reference file
 *
 * A reference file holds one vector per weight file, keyed by the file's sha256: each image
 * architecture has its own file (ADR 0124). --write-reference adds or replaces this file's
 * entry; --reference checks against the entry for the file the image loaded.
 *
 * It also times a whole classification as a request pays for it (M3 exit criterion: p95 under
 * 100 ms on reference hardware, 2 vCPU): embed a message not seen before, then score it against
 * eight routes (ADR 0043).
 *
 * The sample texts below are fixed strings written for this benchmark, not user content.
 */

const SAMPLES = {
  short: 'Summarize this meeting in three bullet points.',
  medium:
    'I have a TypeScript function that parses CSV files and it gets slow when the file has more ' +
    'than a hundred thousand rows. Can you suggest how to stream the input instead of loading ' +
    'everything into memory, and show an example using Node streams?',
  long: Array.from(
    { length: 6 },
    () =>
      'Please review the following product requirements and point out anything ambiguous, any ' +
      'missing acceptance criteria, and any requirement that conflicts with another one. The ' +
      'team is small and has no dedicated platform engineer, so operational simplicity matters.',
  ).join(' '),
} as const;

const REFERENCE_TEXT = 'How do I rotate the API key for my workspace?';

/** Eight routes with three example phrasings each, fixed strings written for this benchmark. */
const ROUTES: Record<string, string[]> = {
  code: [
    'Fix this TypeScript compile error',
    'Write a Python function that parses a CSV file',
    'Why does this SQL query run slowly?',
  ],
  writing: [
    'Draft a friendly email to a customer',
    'Write a short blog post about our launch',
    'Proofread this cover letter',
  ],
  summarize: [
    'Summarize this meeting transcript',
    'Give me the key points of this report',
    'Condense this article into a paragraph',
  ],
  translate: [
    'Translate this paragraph into German',
    'How do you say good morning in Japanese?',
    'Translate these instructions to Spanish',
  ],
  data: [
    'Which months had the highest sales in this table?',
    'Compute the average and median of these numbers',
    'Build a pivot of revenue by region',
  ],
  legal: [
    'Explain this clause in the contract',
    'Is this non-compete enforceable?',
    'Summarize the obligations in this agreement',
  ],
  support: [
    'A customer cannot log in, what should I check?',
    'How do I reset a user password?',
    'The dashboard shows an error after the update',
  ],
  brainstorm: [
    'Give me ten names for a coffee shop',
    'Ideas for a team offsite activity',
    'Suggest themes for our product launch party',
  ],
};
const RELATED = [
  'I forgot my password and cannot sign in.',
  'How can I reset my login credentials?',
];
const UNRELATED = 'The ferry to the island leaves every morning at nine.';

/** Where ORT 1.30's telemetry client keeps its device id and event queue. */
const xdgCache = process.env['XDG_CACHE_HOME'];
const ORT_TELEMETRY_DIR =
  process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/Microsoft/DeveloperTools/.onnxruntime')
    : join(
        xdgCache !== undefined && xdgCache.startsWith('/') ? xdgCache : join(homedir(), '.cache'),
        'Microsoft/DeveloperTools/.onnxruntime',
      );

const { values: args } = parseArgs({
  options: {
    iterations: { type: 'string', default: '200' },
    threads: { type: 'string' },
    reference: { type: 'string' },
    'write-reference': { type: 'string' },
    'max-p95-ms': { type: 'string' },
  },
});

const config = loadProcessConfig({
  ...process.env,
  ...(args.threads === undefined ? {} : { LAKKA_CLASSIFIER_THREADS: args.threads }),
});
const iterations = Number(args.iterations);
const modelPath = join(config.classifier.modelDir, 'model_quantized.onnx');

const telemetryBefore = ortTelemetryState();
const loadStarted = performance.now();
const embedder = await loadOnnxEmbedder({
  modelDir: config.classifier.modelDir,
  threads: config.classifier.threads,
});
const loadMs = performance.now() - loadStarted;

const firstStarted = performance.now();
const referenceVector = await embedder.embed(REFERENCE_TEXT);
const firstEmbedMs = performance.now() - firstStarted;
const rssMb = process.memoryUsage().rss / 1024 / 1024;

interface ReferenceEntry {
  model_sha256: string;
  produced_on: string;
  embedding: number[];
}

function readReferences(path: string): ReferenceEntry[] {
  if (!existsSync(path)) return [];
  const file = JSON.parse(readFileSync(path, 'utf8')) as {
    text: string;
    references: ReferenceEntry[];
  };
  if (file.text !== REFERENCE_TEXT) throw new Error(`${path} was made for another reference text`);
  return file.references;
}

if (args['write-reference'] !== undefined) {
  const path = args['write-reference'];
  const sha256 = sha256File(modelPath);
  const references = [
    ...readReferences(path).filter((r) => r.model_sha256 !== sha256),
    {
      model_sha256: sha256,
      produced_on: `${process.platform}/${process.arch}`,
      embedding: Array.from(referenceVector, (v) => Number(v.toFixed(6))),
    },
  ].toSorted((a, b) => a.model_sha256.localeCompare(b.model_sha256));
  writeFileSync(path, `${JSON.stringify({ text: REFERENCE_TEXT, references }, null, 2)}\n`);
  process.stdout.write(`reference for ${sha256.slice(0, 12)} written to ${path}\n`);
  process.exit(0);
}

const latency: Record<string, { chars: number; p50: number; p95: number; max: number }> = {};
for (const [name, text] of Object.entries(SAMPLES)) {
  for (let i = 0; i < 10; i += 1) await embedder.embed(text);
  const times: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    await embedder.embed(text);
    times.push(performance.now() - started);
  }
  latency[name] = { chars: text.length, ...summarize(times) };
}

// A whole classification: a message not seen before, embedded and scored against eight routes.
const snapshot: PolicySnapshot = {
  workspaceId: 'bench',
  capture: { enabled: false, retentionDays: 7 },
  version: 1,
  routingEnabled: true,
  defaultModel: null,
  pinnedModel: null,
  budgets: [],
  tools: [],
  routes: await Promise.all(
    Object.entries(ROUTES).map(async ([name, examples]) => {
      const vectors = await Promise.all(
        examples.map(async (e) => Array.from(await embedder.embed(e))),
      );
      return {
        id: name,
        name,
        model: 'bench:model',
        fallbacks: [],
        allowCrossProvider: false,
        thresholdDown: 0.75,
        thresholdUp: 0.55,
        enabled: true,
        signals: [],
        description: '',
        exampleCount: examples.length,
        centroid: {
          embedding: Float32Array.from(centroidOf(vectors)),
          model: embedder.modelId,
          source: 'examples' as const,
        },
        examples: [],
      };
    }),
  ),
};
const classifyTimes: number[] = [];
let correct = 0;
for (let i = 0; i < iterations; i += 1) {
  // A different message every time, so nothing is cached, as for a new conversation.
  const message = `Please fix the TypeScript error on line ${i} of this function`;
  const started = performance.now();
  const [best] = scoreRoutes(snapshot, await embedder.embed(message), embedder.modelId, 'centroid');
  classifyTimes.push(performance.now() - started);
  if (best?.name === 'code') correct += 1;
}
latency['classify'] = { chars: 60, ...summarize(classifyTimes) };

let norm = 0;
for (const v of referenceVector) norm += v * v;
const [relatedA, relatedB, unrelated] = await Promise.all([
  embedder.embed(RELATED[0] ?? ''),
  embedder.embed(RELATED[1] ?? ''),
  embedder.embed(UNRELATED),
]);
const relatedScore = cosine(relatedA, relatedB);
const unrelatedScore = cosine(relatedA, unrelated);

const checks: Record<string, { ok: boolean; [key: string]: unknown }> = {
  // The size the model declares, which the vectors must have (ADR 0123).
  dimensions: {
    ok: embedder.dimensions > 0 && referenceVector.length === embedder.dimensions,
    value: referenceVector.length,
  },
  unit_norm: { ok: Math.abs(Math.sqrt(norm) - 1) < 1e-3, value: round(Math.sqrt(norm), 6) },
  semantic: {
    ok: relatedScore > unrelatedScore + 0.2,
    related: round(relatedScore, 4),
    unrelated: round(unrelatedScore, 4),
  },
  classify_picks_code: { ok: correct === iterations, correct, of: iterations },
};

// ONNX Runtime must not create or touch its telemetry store (NF-P1, ADR 0022).
const telemetryAfter = ortTelemetryState();
checks['no_ort_telemetry_state'] = {
  ok: telemetryAfter === telemetryBefore,
  dir: ORT_TELEMETRY_DIR,
  before: telemetryBefore,
  after: telemetryAfter,
};

if (args.reference !== undefined) {
  const sha256 = sha256File(modelPath);
  const reference = readReferences(args.reference).find((r) => r.model_sha256 === sha256);
  const similarity = reference === undefined ? 0 : cosine(referenceVector, reference.embedding);
  // A vector made on another machine: INT8 kernels differ between CPUs, so outputs are close but
  // not bit-identical.
  checks['reference'] = {
    ok: reference !== undefined && similarity >= 0.995,
    cosine: round(similarity, 6),
    produced_on: reference?.produced_on ?? null,
    model_sha256: sha256,
  };
}

if (args['max-p95-ms'] !== undefined) {
  const limit = Number(args['max-p95-ms']);
  const worst = Math.max(...Object.values(latency).map((l) => l.p95));
  checks['p95_budget'] = { ok: worst <= limit, limit_ms: limit, worst_p95_ms: worst };
  const classify = latency['classify']?.p95 ?? Number.POSITIVE_INFINITY;
  checks['classify_p95_budget'] = { ok: classify <= limit, limit_ms: limit, p95_ms: classify };
}

const ok = Object.values(checks).every((c) => c.ok);
process.stdout.write(
  `${JSON.stringify(
    {
      ok,
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
      cpus: availableParallelism(),
      threads: config.classifier.threads,
      model: { dir: config.classifier.modelDir, sha256: sha256File(modelPath) },
      load_ms: round(loadMs, 1),
      first_embed_ms: round(firstEmbedMs, 1),
      rss_mb_after_load: round(rssMb, 1),
      iterations,
      latency_ms: latency,
      checks,
    },
    null,
    2,
  )}\n`,
);
process.exit(ok ? 0 : 1);

function summarize(times: number[]): { p50: number; p95: number; max: number } {
  const sorted = times.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
  return { p50: round(at(0.5), 2), p95: round(at(0.95), 2), max: round(sorted.at(-1) ?? 0, 2) };
}

/** 'absent', or the newest modification time of anything in the directory. */
function ortTelemetryState(): string {
  if (!existsSync(ORT_TELEMETRY_DIR)) return 'absent';
  const times = [
    ORT_TELEMETRY_DIR,
    ...readdirSync(ORT_TELEMETRY_DIR).map((f) => join(ORT_TELEMETRY_DIR, f)),
  ].map((p) => statSync(p).mtimeMs);
  return new Date(Math.max(...times)).toISOString();
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
