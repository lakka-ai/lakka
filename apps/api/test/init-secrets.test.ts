import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initSandboxKey, initSecrets, SECRETS } from '../src/cli/init-secrets.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'lakka-init-'));

describe('initSecrets', () => {
  it('NF-D1: generates every missing secret on first run', () => {
    const dir = tempDir();
    const result = initSecrets(dir);
    expect(result.created).toEqual([...SECRETS]);
    for (const name of SECRETS) {
      const value = readFileSync(join(dir, name), 'utf8');
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o444);
    }
  });

  it('keeps existing secrets on later runs', () => {
    const dir = tempDir();
    initSecrets(dir);
    const before = readFileSync(join(dir, 'database_password'), 'utf8');
    const second = initSecrets(dir);
    expect(second.created).toEqual([]);
    expect(second.existing).toEqual([...SECRETS]);
    expect(readFileSync(join(dir, 'database_password'), 'utf8')).toBe(before);
  });

  it('writes the Valkey config from the cache password', () => {
    const dir = tempDir();
    initSecrets(dir, () => 'fixed-value');
    expect(readFileSync(join(dir, 'valkey.conf'), 'utf8')).toBe('requirepass fixed-value\n');
  });

  it('NF-S9: init does not recreate a retired v1 key', () => {
    const dir = tempDir();
    initSecrets(dir);
    // Rotated to v2, then v1 retired: its file is gone.
    writeFileSync(join(dir, 'credential_master_key_v2'), 'k'.repeat(43), { mode: 0o444 });
    unlinkSync(join(dir, 'credential_master_key'));
    const again = initSecrets(dir);
    expect(again.created).toEqual([]);
    expect(existsSync(join(dir, 'credential_master_key'))).toBe(false);
    expect(readFileSync(join(dir, 'credential_master_key_v2'), 'utf8')).toBe('k'.repeat(43));
  });

  it('NF-S4: writes a sandbox key readable by owner and group only, and keeps it', () => {
    const dir = tempDir();
    expect(initSandboxKey(dir, 'tool_host_token')).toBe('created');
    const path = join(dir, 'tool_host_token');
    const first = readFileSync(path, 'utf8');
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(path).mode & 0o777).toBe(0o440);
    expect(statSync(dir).mode & 0o777).toBe(0o750);
    expect(initSandboxKey(dir, 'tool_host_token')).toBe('existing');
    expect(readFileSync(path, 'utf8')).toBe(first);
    // A lost key is made anew: nothing was encrypted with it.
    unlinkSync(path);
    expect(initSandboxKey(dir, 'tool_host_token')).toBe('created');
    expect(readFileSync(path, 'utf8')).not.toBe(first);
  });
});
