import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { LakkaError } from '@lakka/contracts';
import { l2Normalize, meanPool, truncate } from './pooling.ts';

export interface Embedder {
  /**
   * Names the model and its exact weights, e.g. "paraphrase-multilingual-MiniLM-L12-v2@66fc00f5f29a". Stored next to
   * every embedding, so vectors from different models are never compared (ADR 0043).
   */
  readonly modelId: string;
  readonly dimensions: number;
  /** Returns a unit-length embedding. Never logs or stores the text. */
  embed(text: string): Promise<Float32Array>;
}

export interface OnnxEmbedderOptions {
  /** Directory holding model_quantized.onnx, tokenizer.json and tokenizer_config.json. */
  modelDir: string;
  /**
   * Tokens read per message. Unless given, the model's own training length, `max_seq_length`
   * in its sentence_bert_config.json (128 for the bundled model), or 256 without one: reading
   * past what a model was trained on costs time and adds nothing (ADR 0088).
   */
  maxTokens?: number;
  /** Intra-op threads per inference. One keeps a 2 vCPU host responsive under load. */
  threads?: number;
}

/** The classifier model could not be loaded. Routing is optional, so callers degrade. */
export class ClassifierUnavailableError extends LakkaError {
  readonly code = 'classifier_unavailable';
}

const MODEL_FILE = 'model_quantized.onnx';

/**
 * Loads the ONNX embedding model in process (RT-4: no network call). onnxruntime-node is
 * imported here rather than at module load, so processes that never classify never load the
 * native runtime (CLAUDE.md: lazily loaded).
 */
export async function loadOnnxEmbedder(options: OnnxEmbedderOptions): Promise<Embedder> {
  disableOnnxRuntimeTelemetry();
  try {
    const maxTokens = options.maxTokens ?? (await trainedLength(options.modelDir)) ?? 256;
    const [ort, { Tokenizer }, tokenizerJson, tokenizerConfig, weights] = await Promise.all([
      import('onnxruntime-node'),
      import('@huggingface/tokenizers'),
      readJson(join(options.modelDir, 'tokenizer.json')),
      readJson(join(options.modelDir, 'tokenizer_config.json')),
      readFile(join(options.modelDir, MODEL_FILE)),
    ]);
    const modelId = `${basename(options.modelDir)}@${createHash('sha256').update(weights).digest('hex').slice(0, 12)}`;
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    const session = await ort.InferenceSession.create(join(options.modelDir, MODEL_FILE), {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: options.threads ?? 1,
      interOpNumThreads: 1,
    });
    const wantsTokenTypes = session.inputNames.includes('token_type_ids');
    const outputName = session.outputNames[0];
    if (outputName === undefined) throw new Error('model declares no outputs');
    const dimensions = hiddenSize(session.outputMetadata, outputName);
    if (dimensions === undefined) throw new Error('model declares no fixed hidden size');

    return {
      modelId,
      dimensions,
      async embed(text) {
        const encoded = tokenizer.encode(text, { return_token_type_ids: true });
        const input = truncate(
          {
            ids: encoded.ids,
            attentionMask: encoded.attention_mask,
            tokenTypeIds: encoded.token_type_ids,
          },
          maxTokens,
        );
        const length = input.ids.length;
        const tensor = (values: number[]) =>
          new ort.Tensor(
            'int64',
            BigInt64Array.from(values, (v) => BigInt(v)),
            [1, length],
          );
        const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
          input_ids: tensor(input.ids),
          attention_mask: tensor(input.attentionMask),
        };
        if (wantsTokenTypes) feeds['token_type_ids'] = tensor(input.tokenTypeIds);
        const result = await session.run(feeds);
        const hidden = result[outputName];
        if (hidden === undefined || !(hidden.data instanceof Float32Array)) {
          throw new Error('unexpected model output');
        }
        return l2Normalize(meanPool(hidden.data, input.attentionMask, dimensions));
      },
    };
  } catch (error) {
    throw new ClassifierUnavailableError('the classifier model could not be loaded', {
      cause: error,
    });
  }
}

/**
 * ONNX Runtime 1.30 on Linux and macOS ships Microsoft's 1DS telemetry client, enabled by
 * default: it persists a device id under the user's cache directory and uploads events to
 * mobile.events.data.microsoft.com. That breaks CLAUDE.md invariant 8 (NF-P1). ORT reads
 * ORT_DISABLE_TELEMETRY from the process environment when it initializes and then never creates
 * the uploader or the device id. Set it before the native module loads, overriding any value the
 * environment supplied: this connection is never ours to enable (ADR 0024).
 */
export function disableOnnxRuntimeTelemetry(): void {
  process.env['ORT_DISABLE_TELEMETRY'] = '1';
}

async function readJson(path: string): Promise<object> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object')
    throw new Error(`${path} is not a JSON object`);
  return parsed;
}

/** A sentence-transformers model's training length, when the model says. */
/**
 * The embedding size a model's output declares, the last dimension of its token states: 384 for
 * MiniLM, 768 for mpnet (ADR 0123). Undefined when the output has no fixed, positive size.
 */
export function hiddenSize(
  metadata: readonly { name: string; isTensor: boolean; shape?: readonly (number | string)[] }[],
  outputName: string,
): number | undefined {
  const output = metadata.find((m) => m.name === outputName);
  const size = output?.isTensor === true ? output.shape?.at(-1) : undefined;
  return typeof size === 'number' && Number.isInteger(size) && size > 0 ? size : undefined;
}

export async function trainedLength(modelDir: string): Promise<number | undefined> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(modelDir, 'sentence_bert_config.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const length =
    config !== null && typeof config === 'object' && 'max_seq_length' in config
      ? config.max_seq_length
      : undefined;
  return typeof length === 'number' && Number.isInteger(length) && length > 0 ? length : undefined;
}
