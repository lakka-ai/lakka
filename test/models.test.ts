import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { filesFor, noticeFor, targetArch } from '../scripts/models.ts';
import type { Manifest, Model } from '../scripts/models.ts';

/*
 * The classifier model manifest (ADR 0022, ADR 0124): every bundled model comes from a
 * repository that declares its license, and each image architecture gets exactly one weight file.
 */

const manifest = JSON.parse(readFileSync('models/manifest.json', 'utf8')) as Manifest;

describe('classifier model manifest (ADR 0124)', () => {
  it('pins every file by revision, size and sha256, from a publisher that declares the license', () => {
    expect(manifest.models.length).toBeGreaterThan(0);
    for (const model of manifest.models) {
      expect(model.source).toMatch(/^https:\/\/huggingface\.co\/sentence-transformers\//);
      expect(model.license).toBe('Apache-2.0');
      expect(readFileSync(`models/licenses/${model.license}.txt`, 'utf8')).toContain(
        'Apache License',
      );
      for (const file of model.files) {
        expect(file.url).toContain(`/resolve/${model.revision}/`);
        expect(file.url).not.toMatch(/xenova/i);
        expect(file.size).toBeGreaterThan(0);
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('gives each architecture exactly one weight file, its own', () => {
    for (const model of manifest.models) {
      const arm = filesFor(model, 'arm64');
      const amd = filesFor(model, 'amd64');
      const weights = (files: typeof arm) => files.filter((f) => f.path === 'model_quantized.onnx');
      expect(weights(arm)).toHaveLength(1);
      expect(weights(amd)).toHaveLength(1);
      expect(weights(arm)[0]?.url).toMatch(/model_qint8_arm64\.onnx$/);
      expect(weights(amd)[0]?.url).toMatch(/model_quint8_avx2\.onnx$/);
      expect(arm.map((f) => f.path).toSorted()).toEqual(amd.map((f) => f.path).toSorted());
    }
  });

  it("fetches for the image's TARGETARCH, else for this machine", () => {
    expect(targetArch({ TARGETARCH: 'amd64' }, 'arm64')).toBe('amd64');
    expect(targetArch({ TARGETARCH: 'arm64' }, 'x64')).toBe('arm64');
    expect(targetArch({}, 'x64')).toBe('amd64');
    expect(targetArch({ TARGETARCH: '' }, 'arm64')).toBe('arm64');
    expect(() => targetArch({ TARGETARCH: 'riscv64' }, 'x64')).toThrow(/unsupported TARGETARCH/);
    expect(() => targetArch({}, 'ia32')).toThrow(/no classifier model files/);
  });

  it('refuses a manifest that leaves an architecture without a file, or gives it two', () => {
    const model: Model = {
      name: 'm',
      description: 'd',
      source: 's',
      revision: 'r',
      license: 'Apache-2.0',
      files: [
        { path: 'model_quantized.onnx', arch: 'arm64', url: 'u', size: 1, sha256: 'x' },
        { path: 'tokenizer.json', url: 'u', size: 1, sha256: 'x' },
      ],
    };
    expect(() => filesFor(model, 'amd64')).toThrow(/has no file for amd64/);
    const twice: Model = {
      ...model,
      files: [...model.files, { path: 'tokenizer.json', url: 'v', size: 1, sha256: 'y' }],
    };
    expect(() => filesFor(twice, 'arm64')).toThrow(/listed twice for arm64/);
  });

  it('writes a NOTICE naming the source, revision, license and every file, unmodified', () => {
    for (const model of manifest.models) {
      const files = filesFor(model, 'amd64');
      const notice = noticeFor(model, files, 'amd64');
      expect(notice).toContain(model.source);
      expect(notice).toContain(model.revision);
      expect(notice).toContain('License: Apache-2.0, in LICENSE next to this file');
      expect(notice).toContain('unmodified');
      for (const file of files) expect(notice).toContain(file.url);
    }
  });
});
