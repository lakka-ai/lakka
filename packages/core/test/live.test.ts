import { describe, expect, it } from 'vitest';
import { AccessRevokedError } from '@lakka/contracts';
import { createLogger } from '../src/logger.ts';
import { liveRequests } from '../src/pipeline/live.ts';
import type { LiveRequest } from '../src/pipeline/live.ts';
import type { PrincipalRevokedEvent } from '../src/events.ts';

/* Which live requests a revocation event ends (AC 6, ADR 0063). */

const { logger } = createLogger({ level: 'silent', service: 'test' });

const PERSON = '01a0de3a-0000-7000-8000-00000000000a';
const KEY = '01a0de3a-0000-7000-8000-00000000000b';
const OTHER = '01a0de3a-0000-7000-8000-00000000000c';
const ALPHA = '01a0de3a-0000-7000-8000-0000000000a1';
const BRAVO = '01a0de3a-0000-7000-8000-0000000000b2';

const requests: Record<string, LiveRequest> = {
  chatAlpha: {
    requestId: 'chat-alpha',
    principalId: PERSON,
    actingUserId: PERSON,
    workspaceId: ALPHA,
  },
  chatBravo: {
    requestId: 'chat-bravo',
    principalId: PERSON,
    actingUserId: PERSON,
    workspaceId: BRAVO,
  },
  keyAlpha: { requestId: 'key-alpha', principalId: KEY, actingUserId: PERSON, workspaceId: ALPHA },
  otherAlpha: {
    requestId: 'other-alpha',
    principalId: OTHER,
    actingUserId: OTHER,
    workspaceId: ALPHA,
  },
};

/** Tracks every request and reports which the event ended. */
function endedBy(event: Omit<PrincipalRevokedEvent, 'at'>): string[] {
  const live = liveRequests(logger);
  const ended: string[] = [];
  for (const [name, request] of Object.entries(requests)) {
    live.track(request, (reason) => {
      expect(reason).toBeInstanceOf(AccessRevokedError);
      ended.push(name);
    });
  }
  live.revoke({ ...event, at: new Date().toISOString() });
  return ended.toSorted();
}

describe('ending live requests on revocation (AC 6)', () => {
  it('AC 6: suspending a person ends their requests everywhere, their keys included', () => {
    expect(endedBy({ principalId: PERSON, reason: 'suspended', workspaceId: null })).toEqual([
      'chatAlpha',
      'chatBravo',
      'keyAlpha',
    ]);
  });

  it('AC 6: removing a person from one workspace ends only their requests there', () => {
    expect(
      endedBy({ principalId: PERSON, reason: 'membership_removed', workspaceId: ALPHA }),
    ).toEqual(['chatAlpha', 'keyAlpha']);
  });

  it("ID-5: revoking a key ends only the key's requests", () => {
    expect(endedBy({ principalId: KEY, reason: 'key_revoked', workspaceId: ALPHA })).toEqual([
      'keyAlpha',
    ]);
  });

  it('a finished request is no longer tracked, and each request ends once', () => {
    const live = liveRequests(logger);
    let ends = 0;
    const untrack = live.track(requests.chatAlpha as LiveRequest, () => (ends += 1));
    live.track(requests.chatBravo as LiveRequest, () => (ends += 1));
    untrack();
    expect(live.size).toBe(1);
    const event = { principalId: PERSON, reason: 'suspended', workspaceId: null } as const;
    expect(live.revoke({ ...event, at: '' })).toBe(1);
    expect(live.revoke({ ...event, at: '' })).toBe(0);
    expect(ends).toBe(1);
    expect(live.size).toBe(0);
  });
});
