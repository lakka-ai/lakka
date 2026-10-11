import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClassifierUnavailableError,
  hiddenSize,
  loadOnnxEmbedder,
  trainedLength,
} from '../src/classifier/embedder.ts';

/** Output metadata as ONNX Runtime reports it for a sentence model's token states. */
function tokens(size: number | string) {
  return [
    { name: 'last_hidden_state', isTensor: true, shape: ['batch_size', 'sequence_length', size] },
  ];
}

describe('loadOnnxEmbedder', () => {
  it('NF-P1: turns off ONNX Runtime telemetry before the native runtime loads', async () => {
    process.env['ORT_DISABLE_TELEMETRY'] = '0';
    await expect(loadOnnxEmbedder({ modelDir: '/nonexistent/model' })).rejects.toThrow(
      'the classifier model could not be loaded',
    );
    expect(process.env['ORT_DISABLE_TELEMETRY']).toBe('1');
  });

  it('RT-11: a missing model raises a typed error that callers can degrade on', async () => {
    await expect(loadOnnxEmbedder({ modelDir: '/nonexistent/model' })).rejects.toBeInstanceOf(
      ClassifierUnavailableError,
    );
  });

  it('reads the embedding size from the model, 384 for MiniLM and 768 for mpnet', () => {
    expect(hiddenSize(tokens(384), 'last_hidden_state')).toBe(384);
    expect(hiddenSize(tokens(768), 'last_hidden_state')).toBe(768);
    expect(hiddenSize(tokens('hidden'), 'last_hidden_state')).toBeUndefined();
    expect(hiddenSize(tokens(0), 'last_hidden_state')).toBeUndefined();
    expect(hiddenSize(tokens(768), 'pooled')).toBeUndefined();
    expect(hiddenSize([{ name: 'last_hidden_state', isTensor: false }], 'last_hidden_state')).toBe(
      undefined,
    );
  });

  it('RT-4: reads as many tokens as the model was trained on, when it says', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lakka-model-'));
    try {
      expect(await trainedLength(dir)).toBeUndefined();
      writeFileSync(join(dir, 'sentence_bert_config.json'), '{"max_seq_length": 128}');
      expect(await trainedLength(dir)).toBe(128);
      for (const bad of ['{"max_seq_length": 0}', '{"max_seq_length": "128"}', 'not json']) {
        writeFileSync(join(dir, 'sentence_bert_config.json'), bad);
        expect(await trainedLength(dir)).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
