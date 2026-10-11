import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import { LastWorkspaceAdminError } from '@lakka/contracts';
import type { Db } from '../client.ts';
import { authUsers, authVerifications } from '../schema/auth.ts';
import { budgets } from '../schema/budgets.ts';
import { attachments, conversations, messages } from '../schema/conversations.ts';
import { apiKeys, memberships, principals, workspaces } from '../schema/identity.ts';
import {
  mcpCredentials,
  mcpOauthStates,
  mcpServers,
  toolApprovals,
  toolGrants,
  toolInvocations,
} from '../schema/mcp.ts';
import { spanContent, spans } from '../schema/observability.ts';
import { passwordResets } from '../schema/onboarding.ts';
import { usage } from '../schema/usage.ts';
import type { PrincipalRow } from './principals.ts';

/*
 * Everything linked to one person, for exporting it and for deleting it (NF-P4, ADR 0082). A
 * person spans workspaces, so the callers go through every workspace in turn and each query
 * here is scoped to one; the person's keys are principals of their own, found by owner.
 *
 * Deleting keeps a tombstone: the principal rows stay, without a name or email, so that usage,
 * reservations, spans and the ids on what they set up for a workspace still point somewhere.
 * Spend in the current period stays recorded, so no cap is lifted by deleting someone who
 * spent against it (invariant 5).
 */

export const DELETED_PERSON_NAME = 'Deleted person';
export const DELETED_KEY_NAME = 'Deleted key';

/**
 * Where the last page ended: its last row's key. Keys are ids, not timestamps, since a JS Date
 * drops the microseconds Postgres keeps and a page boundary would repeat rows.
 */
export type PageAfter = readonly string[];

export type WorkspaceRef = { id: string; name: string; slug: string };

/** Every workspace, for walking a person's data one workspace at a time. */
export async function listWorkspaceRefs(db: Db): Promise<WorkspaceRef[]> {
  return db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt));
}

/** The person, if they exist and are not deleted. */
export async function findLivePerson(
  db: Db,
  principalId: string,
): Promise<PrincipalRow | undefined> {
  const [row] = await db
    .select()
    .from(principals)
    .where(
      and(
        eq(principals.id, principalId),
        eq(principals.kind, 'user'),
        sql`${principals.status} <> 'deleted'`,
      ),
    )
    .limit(1);
  return row;
}

export async function listPersonMemberships(db: Db, principalId: string) {
  return db
    .select({
      workspaceId: memberships.workspaceId,
      role: memberships.role,
      since: memberships.createdAt,
    })
    .from(memberships)
    .where(eq(memberships.principalId, principalId));
}

/** The person's keys in one workspace: never the digest of the secret. */
export async function listPersonKeys(db: Db, workspaceId: string, principalId: string) {
  return db
    .select({
      id: apiKeys.id,
      principalId: apiKeys.principalId,
      name: principals.displayName,
      prefix: apiKeys.prefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .innerJoin(principals, eq(principals.id, apiKeys.principalId))
    .where(and(eq(apiKeys.workspaceId, workspaceId), eq(principals.ownerPrincipalId, principalId)))
    .orderBy(asc(apiKeys.createdAt));
}

/** The person's own principal and their keys' anywhere, for matching principal columns. */
export async function personPrincipalIds(db: Db, principalId: string): Promise<string[]> {
  const keys = await db
    .select({ id: principals.id })
    .from(principals)
    .where(eq(principals.ownerPrincipalId, principalId));
  return [principalId, ...keys.map((k) => k.id)];
}

/** Caps on the person or on their keys in one workspace. */
export async function listPersonBudgets(db: Db, workspaceId: string, principalIds: string[]) {
  return db
    .select({
      id: budgets.id,
      scope: budgets.scope,
      principalId: budgets.principalId,
      limitMicroUsd: budgets.limitMicroUsd,
      period: budgets.period,
      alertPercents: budgets.alertPercents,
      createdAt: budgets.createdAt,
      updatedAt: budgets.updatedAt,
    })
    .from(budgets)
    .where(and(eq(budgets.workspaceId, workspaceId), inArray(budgets.principalId, principalIds)));
}

/** The MCP servers the person connected their own account to: never the secret. */
export async function listPersonMcpConnections(db: Db, workspaceId: string, principalId: string) {
  return db
    .select({
      mcpServerId: mcpServers.id,
      server: mcpServers.name,
      createdAt: mcpCredentials.createdAt,
      updatedAt: mcpCredentials.updatedAt,
      expiresAt: mcpCredentials.expiresAt,
    })
    .from(mcpCredentials)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpCredentials.mcpServerId))
    .where(
      and(
        eq(mcpServers.workspaceId, workspaceId),
        eq(mcpCredentials.principalId, principalId),
        eq(mcpCredentials.kind, 'user'),
      ),
    );
}

export async function listPersonConversations(db: Db, workspaceId: string, principalId: string) {
  return db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.workspaceId, workspaceId), eq(conversations.principalId, principalId)),
    )
    .orderBy(asc(conversations.createdAt));
}

export async function listConversationMessages(
  db: Db,
  workspaceId: string,
  conversationId: string,
) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.workspaceId, workspaceId), eq(messages.conversationId, conversationId)))
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

/** What a conversation's files are, without their bytes. */
export async function listConversationAttachments(
  db: Db,
  workspaceId: string,
  conversationId: string,
) {
  return db
    .select({
      id: attachments.id,
      messageId: attachments.messageId,
      mediaType: attachments.mediaType,
      filename: attachments.filename,
      sizeBytes: attachments.sizeBytes,
      position: attachments.position,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(
      and(eq(attachments.workspaceId, workspaceId), eq(messages.conversationId, conversationId)),
    )
    .orderBy(asc(attachments.createdAt), asc(attachments.position));
}

/** One file's bytes, read one at a time so an export never holds them all. */
export async function readAttachmentData(
  db: Db,
  workspaceId: string,
  attachmentId: string,
): Promise<Buffer | undefined> {
  const [row] = await db
    .select({ data: attachments.data })
    .from(attachments)
    .where(and(eq(attachments.workspaceId, workspaceId), eq(attachments.id, attachmentId)))
    .limit(1);
  return row?.data;
}

/** Rows after the page's last one, by the query's key columns. */
function after(columns: readonly AnyColumn[], page?: PageAfter): SQL | undefined {
  if (page === undefined) return undefined;
  const key = sql.join(
    columns.map((c) => sql`${c}`),
    sql`, `,
  );
  const values = sql.join(
    page.map((v) => sql`${v}`),
    sql`, `,
  );
  return sql`(${key}) > (${values})`;
}

/** Usage records for the person's requests, directly or through their keys, by id (uuidv7, so
 * roughly oldest first). */
export async function pagePersonUsage(
  db: Db,
  workspaceId: string,
  principalId: string,
  limit: number,
  page?: PageAfter,
) {
  return db
    .select()
    .from(usage)
    .where(
      and(
        eq(usage.workspaceId, workspaceId),
        eq(usage.actingUserId, principalId),
        after([usage.id], page),
      ),
    )
    .orderBy(asc(usage.id))
    .limit(limit);
}

export async function pagePersonToolInvocations(
  db: Db,
  workspaceId: string,
  principalId: string,
  limit: number,
  page?: PageAfter,
) {
  return db
    .select()
    .from(toolInvocations)
    .where(
      and(
        eq(toolInvocations.workspaceId, workspaceId),
        eq(toolInvocations.actingUserId, principalId),
        after([toolInvocations.id], page),
      ),
    )
    .orderBy(asc(toolInvocations.id))
    .limit(limit);
}

export async function listPersonToolApprovals(db: Db, workspaceId: string, principalIds: string[]) {
  return db
    .select()
    .from(toolApprovals)
    .where(
      and(
        eq(toolApprovals.workspaceId, workspaceId),
        inArray(toolApprovals.principalId, principalIds),
      ),
    )
    .orderBy(asc(toolApprovals.createdAt));
}

export async function listPersonToolGrants(db: Db, workspaceId: string, principalIds: string[]) {
  return db
    .select()
    .from(toolGrants)
    .where(
      and(eq(toolGrants.workspaceId, workspaceId), inArray(toolGrants.principalId, principalIds)),
    )
    .orderBy(asc(toolGrants.grantedAt));
}

/** The person's requests in one workspace: every request span that acted as them. */
function personRequestIds(workspaceId: string, principalId: string): SQL {
  return sql`(
    select ${spans.requestId} from ${spans}
    where ${spans.workspaceId} = ${workspaceId} and ${spans.name} = 'request'
      and ${spans.attributes} ->> 'lakka.acting_user_id' = ${principalId}
    union
    select ${usage.requestId} from ${usage}
    where ${usage.workspaceId} = ${workspaceId} and ${usage.actingUserId} = ${principalId}
  )`;
}

/** What was recorded of the person's requests, where the workspace captured content (OB-4). */
export async function pagePersonCapturedContent(
  db: Db,
  workspaceId: string,
  principalId: string,
  limit: number,
  page?: PageAfter,
) {
  return db
    .select()
    .from(spanContent)
    .where(
      and(
        eq(spanContent.workspaceId, workspaceId),
        sql`${spanContent.requestId} in ${personRequestIds(workspaceId, principalId)}`,
        after([spanContent.traceId, spanContent.spanId], page),
      ),
    )
    .orderBy(asc(spanContent.traceId), asc(spanContent.spanId))
    .limit(limit);
}

/** The person's request spans, by trace; each request's other spans come separately. */
export async function pagePersonRequestSpans(
  db: Db,
  workspaceId: string,
  principalId: string,
  limit: number,
  page?: PageAfter,
) {
  return db
    .select()
    .from(spans)
    .where(
      and(
        eq(spans.workspaceId, workspaceId),
        eq(spans.name, 'request'),
        sql`${spans.attributes} ->> 'lakka.acting_user_id' = ${principalId}`,
        after([spans.traceId, spans.spanId], page),
      ),
    )
    .orderBy(asc(spans.traceId), asc(spans.spanId))
    .limit(limit);
}

export async function listSpansForRequests(db: Db, workspaceId: string, requestIds: string[]) {
  if (requestIds.length === 0) return [];
  return db
    .select()
    .from(spans)
    .where(and(eq(spans.workspaceId, workspaceId), inArray(spans.requestId, requestIds)))
    .orderBy(asc(spans.startedAt));
}

// ---- Deleting ----------------------------------------------------------------------------

export interface ErasedPerson {
  /** The person's keys, now revoked and tombstoned, for ending their live requests. */
  keyPrincipalIds: string[];
}

/**
 * Deletes everything that is the person's, keeps a tombstone for what records their spend, and
 * removes their sign-in, in one transaction. Throws LastWorkspaceAdminError, changing nothing,
 * when a workspace would be left without an admin. Returns undefined when there is no such
 * person to delete.
 */
export async function erasePerson(
  db: Db,
  principalId: string,
  deletedByPrincipalId: string,
): Promise<ErasedPerson | undefined> {
  return db.transaction(async (tx) => {
    const [person] = await tx
      .select()
      .from(principals)
      .where(
        and(
          eq(principals.id, principalId),
          eq(principals.kind, 'user'),
          sql`${principals.status} <> 'deleted'`,
        ),
      )
      .for('update');
    if (person === undefined) return undefined;

    const keys = await tx
      .select({ id: principals.id })
      .from(principals)
      .where(eq(principals.ownerPrincipalId, principalId));
    const keyIds = keys.map((k) => k.id);
    const everyId = [principalId, ...keyIds];

    const workspaceIds = (
      await tx.select({ id: workspaces.id }).from(workspaces).orderBy(asc(workspaces.id))
    ).map((w) => w.id);

    for (const workspaceId of workspaceIds) {
      const [membership] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(eq(memberships.workspaceId, workspaceId), eq(memberships.principalId, principalId)),
        )
        .for('update');
      if (membership?.role === 'admin') {
        // The same rule as removing a member: a workspace keeps at least one admin.
        await tx.execute(
          sql`select 1 from ${workspaces} where ${workspaces.id} = ${workspaceId} for update`,
        );
        const others = await tx
          .select({ id: memberships.principalId })
          .from(memberships)
          .where(
            and(
              eq(memberships.workspaceId, workspaceId),
              eq(memberships.role, 'admin'),
              sql`${memberships.principalId} <> ${principalId}`,
            ),
          )
          .limit(1);
        if (others.length === 0) {
          throw new LastWorkspaceAdminError(
            'the person is the only admin of a workspace; make someone else an admin first',
          );
        }
      }

      // What was said: conversations, with their messages and files, and captured content.
      await tx
        .delete(spanContent)
        .where(
          and(
            eq(spanContent.workspaceId, workspaceId),
            sql`${spanContent.requestId} in ${personRequestIds(workspaceId, principalId)}`,
          ),
        );
      const gone = await tx
        .delete(conversations)
        .where(
          and(
            eq(conversations.workspaceId, workspaceId),
            eq(conversations.principalId, principalId),
          ),
        )
        .returning({ id: conversations.id });
      if (gone.length > 0) {
        await tx
          .update(toolApprovals)
          .set({ status: 'expired' })
          .where(
            and(
              eq(toolApprovals.workspaceId, workspaceId),
              eq(toolApprovals.status, 'pending'),
              inArray(
                toolApprovals.conversationId,
                gone.map((c) => c.id),
              ),
            ),
          );
      }
      // The tool audit keeps who ran what and when; the arguments go (ADR 0082).
      await tx
        .update(toolInvocations)
        .set({ arguments: null })
        .where(
          and(
            eq(toolInvocations.workspaceId, workspaceId),
            eq(toolInvocations.actingUserId, principalId),
          ),
        );
      // Their own accounts on MCP servers. A shared credential they set is the workspace's.
      await tx
        .delete(mcpCredentials)
        .where(
          and(
            eq(mcpCredentials.principalId, principalId),
            eq(mcpCredentials.kind, 'user'),
            inArray(
              mcpCredentials.mcpServerId,
              tx
                .select({ id: mcpServers.id })
                .from(mcpServers)
                .where(eq(mcpServers.workspaceId, workspaceId)),
            ),
          ),
        );
      await tx
        .delete(mcpOauthStates)
        .where(
          and(
            eq(mcpOauthStates.workspaceId, workspaceId),
            eq(mcpOauthStates.principalId, principalId),
          ),
        );
      await tx
        .update(toolGrants)
        .set({ revokedAt: sql`now()`, revokedByPrincipalId: deletedByPrincipalId })
        .where(
          and(
            eq(toolGrants.workspaceId, workspaceId),
            inArray(toolGrants.principalId, everyId),
            isNull(toolGrants.revokedAt),
          ),
        );
      if (keyIds.length > 0) {
        await tx
          .update(apiKeys)
          .set({ revokedAt: sql`coalesce(${apiKeys.revokedAt}, now())` })
          .where(and(eq(apiKeys.workspaceId, workspaceId), inArray(apiKeys.principalId, keyIds)));
      }
      await tx
        .delete(memberships)
        .where(
          and(eq(memberships.workspaceId, workspaceId), eq(memberships.principalId, principalId)),
        );
    }

    const tombstone = {
      status: 'deleted' as const,
      deletedAt: sql`now()`,
      deletedByPrincipalId,
    };
    if (keyIds.length > 0) {
      await tx
        .update(principals)
        .set({ ...tombstone, displayName: DELETED_KEY_NAME })
        .where(inArray(principals.id, keyIds));
    }
    await tx
      .update(principals)
      .set({
        ...tombstone,
        displayName: DELETED_PERSON_NAME,
        email: null,
        authSubject: null,
        isInstanceAdmin: false,
      })
      .where(eq(principals.id, principalId));

    // Their sign-in: the Better Auth user, whose sessions and accounts go with it, and any
    // verification token issued to their address.
    // Reset links for them, or made by them, stop working (ADR 0098).
    await tx
      .delete(passwordResets)
      .where(
        or(
          eq(passwordResets.principalId, principalId),
          eq(passwordResets.createdByPrincipalId, principalId),
        ),
      );
    if (person.authSubject !== null) {
      const conditions = [eq(authVerifications.value, person.authSubject)];
      if (person.email !== null) {
        conditions.push(
          sql`lower(${authVerifications.identifier}) = ${person.email.toLowerCase()}`,
        );
      }
      await tx.delete(authVerifications).where(or(...conditions));
      await tx.delete(authUsers).where(eq(authUsers.id, person.authSubject));
    }
    return { keyPrincipalIds: keyIds };
  });
}
