import { decodedBytes, filesOf, TEXT_MEDIA_TYPE, textOf } from '@lakka/contracts';
import type { FilePart, GatewayRequest } from '@lakka/contracts';
import { textDocument } from './text-document.ts';

/*
 * Token estimates made without a provider tokenizer (ADR 0040). Two readings, because they are
 * wrong in opposite directions on purpose:
 *   - typical: about four bytes of UTF-8 per token, close for English prose. Used to check
 *     whether input fits a model's window; if it is too low, the provider refuses with a context
 *     overflow and dispatch fails over, so an underestimate costs one attempt.
 *   - upper: two bytes per token, above what real text tokenizes to. Used when a provider never
 *     reported usage and a cost has to be recorded anyway; an overestimate costs a little money,
 *     an underestimate could let spend pass a cap.
 * A per-message overhead covers role markers and formatting.
 *
 * Files cannot be counted without the provider (ADR 0058). An image costs a bounded number of
 * tokens whatever its size, so it gets a flat figure: typical is what common models charge for a
 * large image, upper is above any of them. A PDF's cost depends on its pages, which only the
 * provider sees, so it is estimated from its size; a low typical estimate costs one failed-over
 * attempt, a high upper one reserves a little too much. A text file is counted as the text the
 * model is given in its place.
 */

const MESSAGE_OVERHEAD_TOKENS = 8;

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

export function estimateTextTokens(text: string, reading: 'typical' | 'upper'): number {
  return Math.ceil(bytes(text) / (reading === 'typical' ? 4 : 2));
}

const IMAGE_TOKENS = { typical: 1_600, upper: 5_000 } as const;

function estimateFileTokens(file: FilePart, reading: 'typical' | 'upper'): number {
  if (file.mediaType.startsWith('image/')) return IMAGE_TOKENS[reading];
  // A text file reaches the model as text (ADR 0106), so it is counted as text, wrapping and all.
  if (file.mediaType === TEXT_MEDIA_TYPE) return estimateTextTokens(textDocument(file), reading);
  const size = decodedBytes(file.data);
  return reading === 'typical' ? Math.ceil(size / 100) : Math.max(5_000, Math.ceil(size / 25));
}

export function estimateInputTokens(request: GatewayRequest, reading: 'typical' | 'upper'): number {
  // Tool definitions and the model's earlier tool calls are input too (ADR 0071).
  const tools =
    request.tools === undefined ? 0 : estimateTextTokens(JSON.stringify(request.tools), reading);
  return request.messages.reduce(
    (sum, m) =>
      sum +
      MESSAGE_OVERHEAD_TOKENS +
      estimateTextTokens(textOf(m.content), reading) +
      (m.toolCalls === undefined ? 0 : estimateTextTokens(JSON.stringify(m.toolCalls), reading)) +
      filesOf(m.content).reduce((files, f) => files + estimateFileTokens(f, reading), 0),
    tools,
  );
}
