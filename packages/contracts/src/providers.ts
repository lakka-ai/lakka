import { z } from 'zod';
import { COMPATIBLE_FIRST_PARTY_KINDS, providerKind } from './gateway.ts';
import type { ProviderKind } from './gateway.ts';
import { providerNamespace } from './models.ts';

/*
 * Model provider credentials (PR-1, PR-2, PR-3, PR-8, ADR 0038). A credential belongs to the
 * whole instance or to one workspace; a workspace's own credential wins. Its name is the provider
 * part of model references: the provider kind for first-party providers, or the name an instance
 * admin gives an OpenAI-compatible endpoint. The API key is write-only: no response carries it.
 */

export const FIRST_PARTY_KINDS = [
  'anthropic',
  'openai',
  'google',
  ...COMPATIBLE_FIRST_PARTY_KINDS,
] as const;
export type FirstPartyKind = (typeof FIRST_PARTY_KINDS)[number];

export function isFirstParty(kind: ProviderKind): kind is FirstPartyKind {
  return (FIRST_PARTY_KINDS as readonly string[]).includes(kind);
}

const apiKey = z.string().trim().min(1).max(4096);

/** http(s) only, no credentials, query or fragment; a trailing slash is dropped. */
export const providerBaseUrl = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  }, 'no credentials, query or fragment')
  .transform((value) => value.replace(/\/+$/, ''));

export const createProviderBody = z
  .object({
    kind: providerKind,
    /** Required for OpenAI-compatible endpoints; first-party providers are named by their kind. */
    name: providerNamespace.optional(),
    baseUrl: providerBaseUrl.optional(),
    apiKey: apiKey.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (isFirstParty(body.kind)) {
      if (body.name !== undefined && body.name !== body.kind) {
        ctx.addIssue({ code: 'custom', path: ['name'], message: 'must be the provider kind' });
      }
      if (body.apiKey === undefined) {
        ctx.addIssue({ code: 'custom', path: ['apiKey'], message: 'required' });
      }
    } else {
      if (body.name === undefined) {
        ctx.addIssue({ code: 'custom', path: ['name'], message: 'required' });
      } else if ((FIRST_PARTY_KINDS as readonly string[]).includes(body.name)) {
        ctx.addIssue({ code: 'custom', path: ['name'], message: 'reserved' });
      }
      if (body.baseUrl === undefined) {
        ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'required' });
      }
    }
  });
export type CreateProviderBody = z.infer<typeof createProviderBody>;

/** Replaces the key and, where allowed, the address. Kind and name never change. */
export const updateProviderBody = z
  .object({
    apiKey: apiKey.optional(),
    baseUrl: providerBaseUrl.nullable().optional(),
  })
  .strict();
export type UpdateProviderBody = z.infer<typeof updateProviderBody>;

export const providerParams = z.object({ providerId: z.uuid() });
export const workspaceProviderParams = z.object({ workspaceId: z.uuid(), providerId: z.uuid() });

export type ProviderTestStatus = 'ok' | 'auth_failed' | 'unreachable' | 'error';

export interface ProviderTestResult {
  status: ProviderTestStatus;
  /** The provider's HTTP status, when it answered. */
  httpStatus: number | null;
  testedAt: string;
}

/**
 * Which key a workspace's requests to a first-party provider use (PR-2, ADR 0096): its own, the
 * instance's, or none. Whether the instance has one is all a workspace admin learns of it.
 */
export interface ProviderCoverageView {
  kind: FirstPartyKind;
  source: 'workspace' | 'instance' | 'none';
  /** Whether the instance has a key for it, which requests use without the workspace's. */
  instanceKey: boolean;
}

export interface ProviderConfigView {
  id: string;
  /** Null for an instance-wide credential. */
  workspaceId: string | null;
  kind: ProviderKind;
  name: string;
  /** Null means the provider's standard address. */
  baseUrl: string | null;
  /** Whether a key is stored. The key itself is never returned (PR-3). */
  hasKey: boolean;
  createdAt: string;
  updatedAt: string;
  lastTest: ProviderTestResult | null;
}
