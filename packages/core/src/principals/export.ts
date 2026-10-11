import { NotFoundError } from '@lakka/contracts';
import type { Principal } from '@lakka/contracts';
import {
  findLivePerson,
  listConversationAttachments,
  listConversationMessages,
  listPersonBudgets,
  listPersonConversations,
  listPersonKeys,
  listPersonMcpConnections,
  listPersonMemberships,
  listPersonToolApprovals,
  listPersonToolGrants,
  listSpansForRequests,
  listWorkspaceRefs,
  pagePersonCapturedContent,
  pagePersonRequestSpans,
  pagePersonToolInvocations,
  pagePersonUsage,
  personPrincipalIds,
  readAttachmentData,
} from '@lakka/db';
import type { Db, PageAfter, WorkspaceRef } from '@lakka/db';
import type { ServiceContext } from '../context.ts';
import type { TarEntry } from '../export/tar.ts';
import { requireInstanceAdmin } from './service.ts';

/*
 * Exporting everything linked to a person (NF-P4, ADR 0082): a tar.gz an instance admin
 * downloads, so the person can have a copy of their data before, or instead of, deleting it.
 *
 *   lakka-export/manifest.json          what this is, when, and by whom
 *   lakka-export/person.json            profile, memberships, keys (never secrets), caps
 *                                          on them, and the MCP servers they connected
 *   lakka-export/workspaces/<slug>/
 *     conversations/<id>.json              a conversation and its messages
 *     attachments/<id>/<filename>          the files sent in them, as they were sent
 *     usage/part-NNNN.jsonl                usage records, one per line
 *     tool-invocations/part-NNNN.jsonl     tool calls and their arguments (TL-6)
 *     tool-approvals.json, tool-grants.json
 *     captured-content/part-NNNN.jsonl     prompts and replies, where the workspace recorded them
 *     requests/part-NNNN.jsonl             each request's spans: timings and ids, no content
 *
 * The archive is read from Postgres as it is written, one file at a time, so an export holds
 * one file in memory, never all of a person's history. Secrets are never selected: key digests,
 * MCP credentials and sign-in material stay out by construction, not by redaction.
 */

const ROOT = 'lakka-export';
const PAGE_ROWS = 1000;

export interface PersonExport {
  principalId: string;
  /** The name to offer the download under. */
  filename: string;
  entries(): AsyncGenerator<TarEntry>;
}

function json(value: unknown): Buffer {
  return Buffer.from(
    `${JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
  );
}

function jsonLines(rows: readonly unknown[]): Buffer {
  return Buffer.from(
    rows
      .map((r) =>
        JSON.stringify(r, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      )
      .join('\n') + '\n',
  );
}

/** A file name that is safe inside the archive, keeping as much of the original as it can. */
export function archiveFilename(name: string | null): string {
  const cleaned = (name ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  return cleaned === '' || /^\.+$/.test(cleaned) ? 'file' : cleaned;
}

function part(n: number): string {
  return `part-${String(n).padStart(4, '0')}.jsonl`;
}

/** Pages through rows and writes each page as one numbered JSON Lines file. */
async function* pagedFiles<T>(options: {
  dir: string;
  page: (after?: PageAfter) => Promise<T[]>;
  key: (row: T) => PageAfter;
  /** What each page's rows become in the file; the rows themselves unless given. */
  lines?: (rows: T[]) => Promise<unknown[]>;
  now: Date;
}): AsyncGenerator<TarEntry> {
  let after: PageAfter | undefined;
  for (let n = 1; ; n += 1) {
    const rows = await options.page(after);
    const last = rows.at(-1);
    if (last === undefined) return;
    const lines = options.lines === undefined ? rows : await options.lines(rows);
    yield { name: `${options.dir}/${part(n)}`, data: jsonLines(lines), mtime: options.now };
    if (rows.length < PAGE_ROWS) return;
    after = options.key(last);
  }
}

async function* workspaceEntries(
  db: Db,
  workspace: WorkspaceRef,
  principalId: string,
  principalIds: string[],
  now: Date,
): AsyncGenerator<TarEntry> {
  const dir = `${ROOT}/workspaces/${workspace.slug}`;
  const w = workspace.id;

  for (const conversation of await listPersonConversations(db, w, principalId)) {
    const [messages, files] = await Promise.all([
      listConversationMessages(db, w, conversation.id),
      listConversationAttachments(db, w, conversation.id),
    ]);
    const pathOf = (f: { id: string; filename: string | null }) =>
      `${dir}/attachments/${f.id}/${archiveFilename(f.filename)}`;
    yield {
      name: `${dir}/conversations/${conversation.id}.json`,
      data: json({
        ...conversation,
        messages: messages.map((m) => ({
          ...m,
          attachments: files
            .filter((f) => f.messageId === m.id)
            .map((f) => ({ ...f, file: pathOf(f).slice(ROOT.length + 1) })),
        })),
      }),
      mtime: conversation.updatedAt,
    };
    for (const file of files) {
      const data = await readAttachmentData(db, w, file.id);
      if (data !== undefined) yield { name: pathOf(file), data, mtime: file.createdAt };
    }
  }

  yield* pagedFiles({
    dir: `${dir}/usage`,
    page: (after) => pagePersonUsage(db, w, principalId, PAGE_ROWS, after),
    key: (r) => [r.id],
    now,
  });
  yield* pagedFiles({
    dir: `${dir}/tool-invocations`,
    page: (after) => pagePersonToolInvocations(db, w, principalId, PAGE_ROWS, after),
    key: (r) => [r.id],
    now,
  });
  const [approvals, grants] = await Promise.all([
    listPersonToolApprovals(db, w, principalIds),
    listPersonToolGrants(db, w, principalIds),
  ]);
  if (approvals.length > 0) {
    yield { name: `${dir}/tool-approvals.json`, data: json(approvals), mtime: now };
  }
  if (grants.length > 0) yield { name: `${dir}/tool-grants.json`, data: json(grants), mtime: now };
  yield* pagedFiles({
    dir: `${dir}/captured-content`,
    page: (after) => pagePersonCapturedContent(db, w, principalId, PAGE_ROWS, after),
    key: (r) => [r.traceId, r.spanId],
    now,
  });
  yield* pagedFiles({
    dir: `${dir}/requests`,
    page: (after) => pagePersonRequestSpans(db, w, principalId, PAGE_ROWS, after),
    key: (r) => [r.traceId, r.spanId],
    lines: async (roots) => {
      const requestIds = roots.flatMap((r) => (r.requestId === null ? [] : [r.requestId]));
      const all = await listSpansForRequests(db, w, requestIds);
      return roots.map((root) => ({
        request: root,
        spans: all.filter((s) => s.requestId === root.requestId && s.spanId !== root.spanId),
      }));
    },
    now,
  });
}

/**
 * Checks the caller may export this person, and returns the archive's entries to stream.
 * Refusals come before the first byte, so they reach the caller as ordinary errors.
 */
export async function exportPerson(
  ctx: ServiceContext,
  principal: Principal,
  targetPrincipalId: string,
  now: Date = new Date(),
): Promise<PersonExport> {
  requireInstanceAdmin(principal);
  const person = await findLivePerson(ctx.db, targetPrincipalId);
  if (person === undefined) throw new NotFoundError('no user with this id');
  const db = ctx.db;
  const stamp = now.toISOString().slice(0, 10);

  return {
    principalId: person.id,
    filename: `lakka-export-${stamp}-${person.id}.tar.gz`,
    async *entries() {
      const workspaces = await listWorkspaceRefs(db);
      const byId = new Map(workspaces.map((w) => [w.id, w]));
      const principalIds = await personPrincipalIds(db, person.id);
      const ref = (id: string) => {
        const w = byId.get(id);
        return w === undefined ? { id } : { id: w.id, name: w.name, slug: w.slug };
      };

      yield {
        name: `${ROOT}/manifest.json`,
        data: json({
          format: 'lakka.person-export',
          version: 1,
          exportedAt: now.toISOString(),
          exportedByPrincipalId: principal.actingUserId,
          principalId: person.id,
        }),
        mtime: now,
      };

      const keys = [];
      const budgets = [];
      const mcpConnections = [];
      for (const w of workspaces) {
        const [k, b, m] = await Promise.all([
          listPersonKeys(db, w.id, person.id),
          listPersonBudgets(db, w.id, principalIds),
          listPersonMcpConnections(db, w.id, person.id),
        ]);
        keys.push(...k.map((x) => ({ ...x, workspace: ref(w.id) })));
        budgets.push(...b.map((x) => ({ ...x, workspace: ref(w.id) })));
        mcpConnections.push(...m.map((x) => ({ ...x, workspace: ref(w.id) })));
      }
      const memberships = await listPersonMemberships(db, person.id);
      yield {
        name: `${ROOT}/person.json`,
        data: json({
          id: person.id,
          displayName: person.displayName,
          email: person.email,
          status: person.status,
          isInstanceAdmin: person.isInstanceAdmin,
          createdAt: person.createdAt,
          memberships: memberships.map((m) => ({
            workspace: ref(m.workspaceId),
            role: m.role,
            since: m.since,
          })),
          keys,
          budgets,
          mcpConnections,
        }),
        mtime: now,
      };

      for (const w of workspaces) yield* workspaceEntries(db, w, person.id, principalIds, now);
    },
  };
}
