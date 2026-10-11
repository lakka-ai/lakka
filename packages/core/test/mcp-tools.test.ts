import { describe, expect, it } from 'vitest';
import type { McpToolView } from '@lakka/contracts';
import { syncedTool } from '../src/mcp/tools.ts';
import { toolModelName } from '../src/routing/snapshot.ts';

/* What a sync records for a tool, and the name the model sees (TL-3, TL-4, H1, H2, ADR 0069). */

const tool = (over: Partial<McpToolView> = {}): McpToolView => ({
  name: 'search',
  title: null,
  description: 'Searches.',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  annotations: {
    readOnlyHint: null,
    destructiveHint: null,
    idempotentHint: null,
    openWorldHint: null,
  },
  ...over,
});

describe('syncing a tool', () => {
  it('H2: only a tool marked read-only runs without asking, by default', () => {
    const hints = (readOnlyHint: boolean | null) => ({ ...tool().annotations, readOnlyHint });
    expect(syncedTool(tool({ annotations: hints(true) })).defaultApprovalRequired).toBe(false);
    expect(syncedTool(tool({ annotations: hints(false) })).defaultApprovalRequired).toBe(true);
    expect(syncedTool(tool()).defaultApprovalRequired).toBe(true);
  });

  it('TL-3: a tool without an object schema, or with a huge one, cannot be offered', () => {
    expect(syncedTool(tool()).unusableReason).toBeNull();
    const notObject = syncedTool(tool({ inputSchema: { type: 'string' } }));
    expect(notObject).toMatchObject({ unusableReason: 'schema', inputSchema: {} });
    const huge = { type: 'object', description: 'x'.repeat(70_000) };
    expect(syncedTool(tool({ inputSchema: huge })).unusableReason).toBe('schema');
  });

  it('cuts long descriptions and titles, so one server cannot flood the prompt', () => {
    const recorded = syncedTool(tool({ description: 'd'.repeat(5000), title: 't'.repeat(300) }));
    expect(recorded.description).toHaveLength(4000);
    expect(recorded.description?.endsWith('...')).toBe(true);
    expect(recorded.title).toHaveLength(200);
  });
});

describe('the name the model sees (H1)', () => {
  it('H1: is <server>__<tool> when that fits, and nothing otherwise', () => {
    expect(toolModelName('github', 'create_issue')).toBe('github__create_issue');
    expect(toolModelName('files', 'report.summary')).toBeNull();
    expect(toolModelName('files', 'x'.repeat(60))).toBeNull();
    expect(toolModelName('a', 'b-c_D9')).toBe('a__b-c_D9');
  });
});
