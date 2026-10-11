import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Package boundaries from CLAUDE.md, checked on every `pnpm test` (ADR 0007). The oxlint
 * no-restricted-imports rules catch the same imports in the editor; this test also catches
 * forbidden entries in package.json and relative imports that reach across packages.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Boundary {
  pkg: string;
  forbidden: RegExp[];
  reason: string;
}

const HTTP_UI_AND_APPS = [
  /^fastify(\/|$)/,
  /^@fastify\//,
  /^react(-dom)?(\/|$)/,
  /^@tanstack\//,
  /^@lakka\/(api|web|worker)(\/|$)/,
];

// Provider SDKs live only in core's gateway (ADR 0036). The `ai` package is not used at all:
// it brings a client for Vercel's hosted gateway, and we call provider packages directly.
const PROVIDER_SDKS = [/^ai(\/|$)/, /^@ai-sdk\//];
const HOSTED_GATEWAY = [/^ai(\/|$)/, /^@ai-sdk\/gateway(\/|$)/];

const BOUNDARIES: Boundary[] = [
  {
    pkg: 'packages/core',
    forbidden: [...HTTP_UI_AND_APPS, ...HOSTED_GATEWAY],
    reason: 'core must not import fastify, react, @tanstack/* or any apps/* package (API-3)',
  },
  {
    pkg: 'packages/db',
    forbidden: [...HTTP_UI_AND_APPS, /^@lakka\/core(\/|$)/, ...PROVIDER_SDKS],
    reason: 'db sits below core and must not import core, HTTP, UI or app packages',
  },
  {
    pkg: 'packages/contracts',
    forbidden: [...HTTP_UI_AND_APPS, /^@lakka\/(core|db)(\/|$)/, ...PROVIDER_SDKS],
    reason: 'contracts is the leaf package and imports no other workspace package',
  },
  {
    pkg: 'apps/api',
    forbidden: PROVIDER_SDKS,
    reason: 'the api reaches providers only through core (ADR 0036)',
  },
  {
    pkg: 'apps/worker',
    forbidden: PROVIDER_SDKS,
    reason: 'the worker reaches providers only through core (ADR 0036)',
  },
  {
    pkg: 'apps/web',
    forbidden: [
      /^@lakka\/(core|db)(\/|$)/,
      /^pg(\/|$)/,
      /^@valkey\//,
      /^pino(\/|$)/,
      ...PROVIDER_SDKS,
    ],
    reason: 'web talks to api over HTTP only, never to core or db',
  },
];

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.output', '.tanstack'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function importsOf(source: string): string[] {
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) if (match[1]) found.push(match[1]);
  }
  return found;
}

function violations(boundary: Boundary): string[] {
  const pkgDir = join(ROOT, boundary.pkg);
  const found: string[] = [];

  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<
    string,
    Record<string, string> | undefined
  >;
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (boundary.forbidden.some((re) => re.test(name)))
        found.push(`package.json ${field}: ${name}`);
    }
  }

  for (const file of sourceFiles(pkgDir)) {
    const rel = relative(ROOT, file);
    for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
      if (boundary.forbidden.some((re) => re.test(specifier))) {
        found.push(`${rel}: ${specifier}`);
      } else if (specifier.startsWith('.')) {
        // A relative import must stay inside its own package. The one exception: test files may
        // use the shared integration harness in the repository's test/ directory.
        const absolute = resolve(dirname(file), specifier);
        const target = relative(pkgDir, absolute);
        const isSharedHarness =
          relative(join(pkgDir, 'test'), file).startsWith('..') === false &&
          relative(join(ROOT, 'test', 'integration'), absolute).startsWith('..') === false;
        if (target.startsWith('..') && !isSharedHarness) {
          found.push(`${rel}: ${specifier} (leaves ${boundary.pkg})`);
        }
      }
    }
  }
  return found;
}

describe('package boundaries', () => {
  for (const boundary of BOUNDARIES) {
    it(`API-3: ${boundary.reason}`, () => {
      expect(violations(boundary)).toEqual([]);
    });
  }

  it('recognizes every import form the check relies on', () => {
    const sample = [
      `import Fastify from 'fastify';`,
      `import type { X } from "@tanstack/react-router";`,
      `import 'react';`,
      `export { y } from '@lakka/api/thing';`,
      `const m = await import('@fastify/sse');`,
      `const r = require('react-dom');`,
    ].join('\n');
    expect(importsOf(sample).toSorted()).toEqual(
      [
        '@fastify/sse',
        '@lakka/api/thing',
        '@tanstack/react-router',
        'fastify',
        'react',
        'react-dom',
      ].toSorted(),
    );
  });
});
