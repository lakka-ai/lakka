import { describe, expect, it } from 'vitest';
import { INVITE_TOKEN_PATTERN } from '@lakka/contracts';
import type { InviteLookupRow } from '@lakka/db';
import {
  generateInviteToken,
  hashInviteToken,
  INVITE_LIFETIME_MS,
  inviteUsable,
} from '../src/invites/service.ts';

const NOW = new Date('2026-09-25T12:00:00Z');

const invite = (overrides: Partial<InviteLookupRow> = {}): InviteLookupRow => ({
  id: 'i1',
  workspaceId: 'ws-1',
  workspaceName: 'Alpha',
  role: 'member',
  expiresAt: new Date(NOW.getTime() + INVITE_LIFETIME_MS),
  acceptedAt: null,
  revokedAt: null,
  creatorStatus: 'active',
  creatorName: 'Maja Lind',
  creatorIsInstanceAdmin: false,
  creatorRole: 'admin',
  ...overrides,
});

describe('invites', () => {
  it('ID-7: a token is 256 random bits in the link format, and only its digest is stored', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.token).toMatch(INVITE_TOKEN_PATTERN);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(hashInviteToken(a.token));
    expect(a.hash).not.toContain(a.token);
  });

  it('ID-7: an unused, unexpired invite from a current admin is usable', () => {
    expect(inviteUsable(invite(), NOW)).toBe(true);
    expect(inviteUsable(invite({ creatorRole: null, creatorIsInstanceAdmin: true }), NOW)).toBe(
      true,
    );
  });

  it('ID-7: a used, revoked or expired invite is not', () => {
    expect(inviteUsable(invite({ acceptedAt: NOW }), NOW)).toBe(false);
    expect(inviteUsable(invite({ revokedAt: NOW }), NOW)).toBe(false);
    expect(inviteUsable(invite({ expiresAt: NOW }), NOW)).toBe(false);
  });

  it('NF-S2: an invite stops working when its creator could no longer make it', () => {
    expect(inviteUsable(invite({ creatorStatus: 'suspended' }), NOW)).toBe(false);
    expect(inviteUsable(invite({ creatorRole: 'member' }), NOW)).toBe(false);
    expect(inviteUsable(invite({ creatorRole: null }), NOW)).toBe(false);
    expect(
      inviteUsable(
        invite({ creatorRole: null, creatorIsInstanceAdmin: true, creatorStatus: 'suspended' }),
        NOW,
      ),
    ).toBe(false);
  });
});
