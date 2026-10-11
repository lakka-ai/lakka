import { NotFoundError } from '@lakka/contracts';
import type {
  ContentCaptureBody,
  ContentCaptureView,
  GatewayRequest,
  Principal,
} from '@lakka/contracts';
import { findContentCapture, setContentCapture } from '@lakka/db';
import type { ContentCaptureRow } from '@lakka/db';
import type { ServiceContext } from '../context.ts';
import type { Logger } from '../logger.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';

/*
 * Content capture (OB-4, NF-P3, ADR 0077). Off unless a workspace admin turns it on; the change is
 * logged with who made it, and shown with the setting. While it is on, each model call's prompt
 * and reply are kept in span_content for the workspace's period, and nowhere else.
 */

/** Longer than any useful prompt or reply; beyond it, the text is cut and the cut is said. */
export const MAX_CAPTURED_CHARS = 256 * 1024;

function view(row: ContentCaptureRow): ContentCaptureView {
  return {
    enabled: row.enabled,
    retentionDays: row.retentionDays,
    changedAt: row.changedAt?.toISOString() ?? null,
    changedBy: row.changedBy,
  };
}

/** Anyone in the workspace may see whether what they say is recorded. */
export async function getContentCapture(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
): Promise<ContentCaptureView> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'workspace.read');
  const row = await findContentCapture(ctx.db, workspaceId);
  if (row === undefined) throw new NotFoundError('workspace not found');
  return view(row);
}

export async function changeContentCapture(
  ctx: ServiceContext & { logger: Logger },
  principal: Principal,
  workspaceId: string,
  body: ContentCaptureBody,
): Promise<ContentCaptureView> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'capture.manage');
  await setContentCapture(ctx.db, workspaceId, body, principal.actingUserId);
  // NF-P3: turning capture on is an explicit admin action, and it is logged.
  ctx.logger.info('workspace.content_capture_changed', {
    principal_id: principal.actingUserId,
    workspace_id: workspaceId,
    status: body.enabled ? 'on' : 'off',
    retention_days: body.retentionDays,
  });
  const row = await findContentCapture(ctx.db, workspaceId);
  if (row === undefined) throw new NotFoundError('workspace not found');
  return view(row);
}

/** A string, cut to the cap with a note of how much was left out. */
function capped(text: string): string {
  if (text.length <= MAX_CAPTURED_CHARS) return text;
  return `${text.slice(0, MAX_CAPTURED_CHARS)}\n[cut: ${text.length - MAX_CAPTURED_CHARS} more characters]`;
}

/**
 * The prompt as sent, for the record: messages with their text, tool calls and results. A file's
 * bytes are not kept, only what it was, since files are already stored with the conversation.
 */
export function capturedPrompt(request: GatewayRequest): unknown {
  return {
    messages: request.messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? capped(m.content)
          : m.content.map((part) =>
              part.type === 'text'
                ? { type: 'text', text: capped(part.text) }
                : {
                    type: 'file',
                    mediaType: part.mediaType,
                    ...(part.filename === undefined ? {} : { filename: part.filename }),
                    bytes: Buffer.byteLength(part.data, 'base64'),
                  },
            ),
      ...(m.role === 'assistant' && m.toolCalls !== undefined
        ? {
            toolCalls: m.toolCalls.map((c) => ({
              id: c.id,
              name: c.name,
              arguments: capped(c.arguments),
            })),
          }
        : {}),
      ...(m.role === 'tool' ? { toolCallId: m.toolCallId, toolName: m.toolName } : {}),
    })),
    ...(request.tools === undefined ? {} : { tools: request.tools.map((t) => t.name) }),
  };
}

/** What a model call produced so far, collected only while capture is on. */
export interface CapturedReply {
  text: string;
  reasoning: string;
  toolCalls: { name: string; arguments: string }[];
}

export function capturedResponse(reply: CapturedReply, finishReason: string | null): unknown {
  return {
    text: capped(reply.text),
    ...(reply.reasoning === '' ? {} : { reasoning: capped(reply.reasoning) }),
    ...(reply.toolCalls.length === 0
      ? {}
      : {
          toolCalls: reply.toolCalls.map((c) => ({ name: c.name, arguments: capped(c.arguments) })),
        }),
    finishReason,
  };
}
