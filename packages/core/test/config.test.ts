import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@lakka/contracts';
import { DEFAULT_CATALOGUE_FEED_URL } from '../src/models/feed.ts';
import {
  credentialKeyFileVersion,
  fileSecretLister,
  fileSecretReader,
  loadConfig,
  loadProcessConfig,
  parseCredentialKeys,
} from '../src/config.ts';

const readFromFile = (name: string) => (name === 'database_password' ? 'from-file' : undefined);
const loadBadPort = () => loadConfig({ LAKKA_API_PORT: 'not-a-port-s3cr3t' });

describe('config', () => {
  it('NF-D3: every setting has a working default for the compose deployment', () => {
    const c = loadConfig({});
    expect(c.database).toEqual({
      host: 'postgres',
      port: 5432,
      user: 'lakka',
      database: 'lakka',
      password: undefined,
    });
    expect(c.cache).toEqual({ host: 'valkey', port: 6379, password: undefined });
    expect(c.api).toEqual({ host: '0.0.0.0', port: 3000 });
    expect(c.logLevel).toBe('info');
    expect(c.classifier.threads).toBe(1);
  });

  it('NF-A3: the classifier model is a setting with a bundled default', () => {
    expect(loadConfig({}).classifier.modelDir).toMatch(
      /[/\\]models[/\\]paraphrase-multilingual-MiniLM-L12-v2$/,
    );
    expect(loadConfig({ LAKKA_CLASSIFIER_MODEL_DIR: '/opt/other' }).classifier.modelDir).toBe(
      '/opt/other',
    );
  });

  it('reads overrides from env and coerces ports', () => {
    const c = loadConfig({ LAKKA_DATABASE_HOST: '127.0.0.1', LAKKA_DATABASE_PORT: '55432' });
    expect(c.database.host).toBe('127.0.0.1');
    expect(c.database.port).toBe(55432);
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ LAKKA_API_PORT: '' }).api.port).toBe(3000);
  });

  it('prefers an env secret over the secrets directory', () => {
    expect(loadConfig({}, readFromFile).database.password).toBe('from-file');
    expect(
      loadConfig({ LAKKA_DATABASE_PASSWORD: 'from-env' }, readFromFile).database.password,
    ).toBe('from-env');
  });

  it('NF-S5: names the invalid variable without echoing its value', () => {
    expect(loadBadPort).toThrow(ConfigError);
    expect(loadBadPort).toThrow(/LAKKA_API_PORT/);
    expect(loadBadPort).not.toThrow(/s3cr3t/);
  });

  it('reads trimmed secrets from files and treats missing files as unset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lakka-secrets-'));
    writeFileSync(join(dir, 'cache_password'), 'abc123\n');
    const read = fileSecretReader(dir);
    expect(read('cache_password')).toBe('abc123');
    expect(read('database_password')).toBeUndefined();
  });

  it('ADR 0008: the public URL defaults to the loopback port and trusts both loopback names', () => {
    const c = loadConfig({});
    expect(c.auth.publicUrl).toBe('http://localhost:8080');
    expect(c.auth.trustedOrigins).toEqual(['http://localhost:8080', 'http://127.0.0.1:8080']);
    expect(loadConfig({ LAKKA_HTTP_PORT: '9000' }).auth.publicUrl).toBe('http://localhost:9000');
  });

  it('ADR 0008: a domain makes the public URL https on that domain', () => {
    const c = loadConfig({ LAKKA_DOMAIN: 'ai.example.com' });
    expect(c.auth.publicUrl).toBe('https://ai.example.com');
    expect(c.auth.trustedOrigins).toEqual(['https://ai.example.com']);
  });

  it('an explicit public URL wins, and a subpath is refused (NF-C4 is not supported yet)', () => {
    expect(loadConfig({ LAKKA_PUBLIC_URL: 'https://x.example.com/' }).auth.publicUrl).toBe(
      'https://x.example.com',
    );
    expect(() => loadConfig({ LAKKA_PUBLIC_URL: 'https://x.example.com/ai' })).toThrow(ConfigError);
  });

  it('reads the auth secret from the secrets directory and rejects short ones', () => {
    const long = 'a'.repeat(43);
    expect(loadConfig({}, (n) => (n === 'auth_secret' ? long : undefined)).auth.secret).toBe(long);
    expect(() => loadConfig({}, (n) => (n === 'auth_secret' ? 'short' : undefined))).toThrow(
      /auth_secret/,
    );
  });

  it('ADR 0032: reads the credential key and lists private identity provider origins', () => {
    const key = 'k'.repeat(43);
    const c = loadConfig(
      { LAKKA_OIDC_PRIVATE_ORIGINS: 'http://dex.internal:5556, https://idp.corp.example' },
      (n) => (n === 'credential_master_key' ? key : undefined),
    );
    expect(c.credentials.keys).toEqual(new Map([[1, key]]));
    expect(c.credentials.source).toBe('secrets');
    expect(c.auth.privateIdpOrigins).toEqual([
      'http://dex.internal:5556',
      'https://idp.corp.example',
    ]);
    expect(loadConfig({}).auth.privateIdpOrigins).toEqual([]);
    expect(() => loadConfig({ LAKKA_OIDC_PRIVATE_ORIGINS: 'https://idp.example/path' })).toThrow(
      ConfigError,
    );
  });

  it('NF-S9: LAKKA_CREDENTIAL_KEYS parsing', () => {
    const one = 'a'.repeat(43);
    const two = 'B'.repeat(43);
    expect(parseCredentialKeys(`2:${two}, 1:${one}`)).toEqual(
      new Map([
        [2, two],
        [1, one],
      ]),
    );
    // Set, it replaces the single key and the files entirely.
    const c = loadConfig(
      { LAKKA_CREDENTIAL_KEYS: `2:${two}`, LAKKA_CREDENTIAL_KEY: one },
      (n) => (n === 'credential_master_key' ? one : undefined),
      () => ['credential_master_key', 'credential_master_key_v3'],
    );
    expect(c.credentials).toEqual({ keys: new Map([[2, two]]), source: 'env' });
    // Malformed, repeated or empty entries are refused by position, never echoing a key.
    for (const bad of [`2:${two},2:${one}`, `0:${one}`, `x:${one}`, '2:short', `2:${two},`, '']) {
      expect(() => parseCredentialKeys(bad)).toThrow(ConfigError);
      expect(() => parseCredentialKeys(bad)).not.toThrow(one);
      expect(() => parseCredentialKeys(bad)).not.toThrow(two);
    }
  });

  it('NF-S9: numbered key files join the original one from the secrets directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lakka-keys-'));
    const one = 'a'.repeat(43);
    const three = 'c'.repeat(43);
    writeFileSync(join(dir, 'credential_master_key'), one);
    writeFileSync(join(dir, 'credential_master_key_v3'), `${three}\n`);
    // Not key files: a temporary file, a second v1 and another secret.
    writeFileSync(join(dir, '.credential_master_key_v4.tmp'), 'x');
    writeFileSync(join(dir, 'credential_master_key_v1'), 'x');
    writeFileSync(join(dir, 'auth_secret'), 'x'.repeat(43));
    const c = loadProcessConfig({ LAKKA_SECRETS_DIR: dir });
    expect(c.credentials).toEqual({
      keys: new Map([
        [1, one],
        [3, three],
      ]),
      source: 'secrets',
    });
    expect(fileSecretLister(join(dir, 'missing'))()).toEqual([]);
    expect(credentialKeyFileVersion('credential_master_key_v12')).toBe(12);
    expect(credentialKeyFileVersion('credential_master_key_v01')).toBeUndefined();
  });

  it('TL-1, Q2: lists the private-network MCP server origins workspace admins may use', () => {
    expect(
      loadConfig({
        LAKKA_MCP_PRIVATE_ORIGINS: 'http://tools.internal:8080, https://mcp.corp.example',
      }).mcp.privateOrigins,
    ).toEqual(['http://tools.internal:8080', 'https://mcp.corp.example']);
    expect(loadConfig({}).mcp.privateOrigins).toEqual([]);
    expect(() => loadConfig({ LAKKA_MCP_PRIVATE_ORIGINS: 'https://mcp.example/mcp' })).toThrow(
      ConfigError,
    );
  });

  it('AD-1: reads the setup code from the environment first, then the secrets directory', () => {
    const fromFile = 's'.repeat(43);
    const read = (n: string) => (n === 'setup_code' ? fromFile : undefined);
    expect(loadConfig({}, read).setup.code).toBe(fromFile);
    expect(loadConfig({ LAKKA_SETUP_CODE: 'e'.repeat(20) }, read).setup.code).toBe('e'.repeat(20));
    expect(loadConfig({}).setup.code).toBeUndefined();
    expect(() => loadConfig({ LAKKA_SETUP_CODE: 'short' })).toThrow(/LAKKA_SETUP_CODE/);
  });
});

describe('sandbox settings (NF-S4, ADR 0118)', () => {
  it('NF-S4: stdio servers run in the sandbox by default, reached on its socket', () => {
    expect(loadConfig({}).sandbox).toEqual({
      toolHost: { kind: 'unix', path: '/run/lakka/tool-host/tool-host.sock' },
      egressProxyUrl: 'http://egress:3128',
      slots: 8,
    });
    expect(
      loadConfig({
        LAKKA_TOOL_HOST_URL: 'http://127.0.0.1:3100',
        LAKKA_EGRESS_PROXY_URL: 'http://127.0.0.1:3128/',
        LAKKA_SANDBOX_SLOTS: '2',
      }).sandbox,
    ).toEqual({
      toolHost: { kind: 'http', url: 'http://127.0.0.1:3100' },
      egressProxyUrl: 'http://127.0.0.1:3128',
      slots: 2,
    });
  });

  it('NF-S4: in-process is for development only; a production process refuses it', () => {
    expect(loadConfig({ LAKKA_TOOL_HOST_URL: 'in-process' }).sandbox.toolHost).toEqual({
      kind: 'in-process',
    });
    expect(() => loadConfig({ LAKKA_TOOL_HOST_URL: 'in-process', NODE_ENV: 'production' })).toThrow(
      /LAKKA_TOOL_HOST_URL cannot be in-process in production/,
    );
  });

  it('refuses a tool host or proxy address it cannot use', () => {
    for (const env of [
      { LAKKA_TOOL_HOST_URL: 'sandbox:3100' },
      { LAKKA_TOOL_HOST_URL: 'https://sandbox:3100' },
      { LAKKA_TOOL_HOST_URL: 'unix:relative.sock' },
      { LAKKA_EGRESS_PROXY_URL: 'http://user:pass@egress:3128' },
      { LAKKA_EGRESS_PROXY_URL: 'https://egress:3128' },
      { LAKKA_SANDBOX_SLOTS: '0' },
      { LAKKA_SANDBOX_SLOTS: '65' },
    ]) {
      expect(() => loadConfig(env)).toThrow(ConfigError);
    }
  });
});

describe('trace export settings (OB-5, NF-P1, ADR 0080)', () => {
  it('NF-P1: nothing is exported unless an endpoint is set, whatever OTEL_* says', () => {
    expect(loadConfig({}).otlp).toBeNull();
    expect(
      loadConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example.com/v1/traces',
      }).otlp,
    ).toBeNull();
  });

  it('OB-5: reads the endpoint and its headers, from env or the secrets directory', () => {
    expect(
      loadConfig({
        LAKKA_OTLP_ENDPOINT: 'https://collector.example.com/v1/traces',
        LAKKA_OTLP_HEADERS: 'authorization=Bearer abc=def, x-team = platform',
      }).otlp,
    ).toEqual({
      endpoint: 'https://collector.example.com/v1/traces',
      headers: { authorization: 'Bearer abc=def', 'x-team': 'platform' },
    });
    expect(
      loadConfig({ LAKKA_OTLP_ENDPOINT: 'http://collector:4318/v1/traces' }, (name) =>
        name === 'otlp_headers' ? 'api-key=from-a-file' : undefined,
      ).otlp?.headers,
    ).toEqual({ 'api-key': 'from-a-file' });
  });

  it('NF-S5: a malformed header or endpoint is named, never echoed', () => {
    const secret = 'super-secret-value';
    for (const env of [
      { LAKKA_OTLP_ENDPOINT: 'https://c.example.com/v1/traces', LAKKA_OTLP_HEADERS: secret },
      { LAKKA_OTLP_ENDPOINT: `ftp://${secret}` },
    ]) {
      const thrown = (() => {
        try {
          loadConfig(env);
          return undefined;
        } catch (error) {
          return error;
        }
      })();
      expect(thrown).toBeInstanceOf(ConfigError);
      const message = (thrown as Error).message;
      expect(message).toMatch(/LAKKA_OTLP_(HEADERS|ENDPOINT)/);
      expect(message).not.toContain(secret);
    }
  });

  it('BG-12: rate limit settings parse, 0 turns it off, invalid values refused', () => {
    expect(loadConfig({}).modelRateLimit).toEqual({ perMinute: 120, burst: 60 });
    expect(
      loadConfig({
        LAKKA_MODEL_REQUESTS_PER_MINUTE: '30',
        LAKKA_MODEL_REQUEST_BURST: '5',
      }).modelRateLimit,
    ).toEqual({ perMinute: 30, burst: 5 });
    expect(loadConfig({ LAKKA_MODEL_REQUESTS_PER_MINUTE: '0' }).modelRateLimit.perMinute).toBe(0);
    for (const [name, value] of [
      ['LAKKA_MODEL_REQUESTS_PER_MINUTE', '-1'],
      ['LAKKA_MODEL_REQUESTS_PER_MINUTE', '1.5'],
      ['LAKKA_MODEL_REQUESTS_PER_MINUTE', 'lots'],
      ['LAKKA_MODEL_REQUEST_BURST', '0'],
      ['LAKKA_MODEL_REQUEST_BURST', '-3'],
      ['LAKKA_MODEL_REQUEST_BURST', '2.5'],
    ] as const) {
      expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(name));
    }
  });
});

describe('the price feed address (PR-6, ADR 0116)', () => {
  it('PR-6: defaults to the project file, takes an https mirror, and "off" locks it', () => {
    expect(loadConfig({}).catalogueFeed.url).toBe(DEFAULT_CATALOGUE_FEED_URL);
    // compose passes it empty by default, which is unset.
    expect(loadConfig({ LAKKA_CATALOGUE_FEED_URL: '' }).catalogueFeed.url).toBe(
      DEFAULT_CATALOGUE_FEED_URL,
    );
    expect(
      loadConfig({ LAKKA_CATALOGUE_FEED_URL: 'https://mirror.example.com/feed.json' }).catalogueFeed
        .url,
    ).toBe('https://mirror.example.com/feed.json');
    expect(loadConfig({ LAKKA_CATALOGUE_FEED_URL: 'off' }).catalogueFeed.url).toBeNull();
  });

  it('PR-6: refuses plain http and credentials in the address', () => {
    for (const value of [
      'http://mirror.example.com/feed.json',
      'https://user:pass@mirror.example.com/feed.json',
      'mirror.example.com',
      'OFF',
    ]) {
      expect(() => loadConfig({ LAKKA_CATALOGUE_FEED_URL: value })).toThrow(
        /LAKKA_CATALOGUE_FEED_URL/,
      );
    }
  });
});
