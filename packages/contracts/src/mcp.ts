import { z } from 'zod';

/*
 * MCP servers a workspace's tools come from (TL-1, ADR 0066, ADR 0067). A Streamable HTTP server
 * is reached at a URL; a stdio server is a command the api runs, which only instance admins may
 * configure (Q2). Credentials are write-only: a view says whether one is set, never what it is.
 */

export const MCP_SERVER_NAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const name = z
  .string()
  .regex(MCP_SERVER_NAME, 'lowercase letters, digits and hyphens, up to 32 characters');

/** http(s), no credentials in it and no fragment. */
const serverUrl = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return url.username === '' && url.password === '' && url.hash === '';
  }, 'no credentials or fragment');

/** What people see a server as, such as "GitHub" (ADR 0096). */
const displayName = z.string().trim().min(1).max(80);

/** A name for people made from a server's slug: "jira-cloud" -> "Jira cloud". */
export function mcpServerDisplayName(slug: string): string {
  const words = slug.replaceAll('-', ' ');
  return words.slice(0, 1).toUpperCase() + words.slice(1);
}

const credentialEnv = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,63}$/, 'an environment variable name, such as API_TOKEN');

/**
 * How Lakka authenticates to the server: not at all, with one credential an admin sets, or
 * with each person's own, through OAuth (TL-2, ADR 0068). OAuth is for HTTP servers only.
 */
export const mcpAuthMode = z.enum(['none', 'shared', 'oauth']);
const stdioAuthMode = z.enum(['none', 'shared']);

/** Space-separated OAuth scopes to ask for, instead of the ones the server advertises. */
const oauthScope = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[\x21-\x7e]+( [\x21-\x7e]+)*$/, 'space-separated scopes');

const streamableHttpServer = z
  .object({
    transport: z.literal('streamable_http'),
    name,
    displayName: displayName.optional(),
    url: serverUrl,
    authMode: mcpAuthMode,
    oauthScope: oauthScope.optional(),
  })
  .strict();

const stdioServer = z
  .object({
    transport: z.literal('stdio'),
    name,
    displayName: displayName.optional(),
    command: z.string().trim().min(1).max(500),
    args: z.array(z.string().max(1000)).max(50).default([]),
    authMode: stdioAuthMode,
    /** For a shared credential: the environment variable the command receives it in. */
    credentialEnv: credentialEnv.optional(),
  })
  .strict();

export const newMcpServerBody = z
  .discriminatedUnion('transport', [streamableHttpServer, stdioServer])
  .superRefine((body, ctx) => {
    if (
      body.transport === 'streamable_http' &&
      body.oauthScope !== undefined &&
      body.authMode !== 'oauth'
    ) {
      ctx.addIssue({ code: 'custom', path: ['oauthScope'], message: 'only for OAuth' });
    }
    if (
      body.transport === 'stdio' &&
      (body.authMode === 'shared') !== (body.credentialEnv !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['credentialEnv'],
        message: 'required with a shared credential, and only then',
      });
    }
  });
export type NewMcpServerBody = z.infer<typeof newMcpServerBody>;

/** A change to a server; its transport stays. Fields that do not fit it are refused. */
export const mcpServerChangeBody = z
  .object({
    name: name.optional(),
    /** Null goes back to the name made from the slug. */
    displayName: displayName.nullable().optional(),
    url: serverUrl.optional(),
    command: z.string().trim().min(1).max(500).optional(),
    args: z.array(z.string().max(1000)).max(50).optional(),
    authMode: mcpAuthMode.optional(),
    credentialEnv: credentialEnv.nullable().optional(),
    oauthScope: oauthScope.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');
export type McpServerChangeBody = z.infer<typeof mcpServerChangeBody>;

export const mcpSharedCredentialBody = z.object({ secret: z.string().min(1).max(8192) }).strict();

/**
 * The client Lakka uses with an authorization server that does not offer dynamic
 * registration, registered by an admin (ADR 0068). Write-only, like a credential.
 */
export const mcpOAuthClientBody = z
  .object({
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(2000).optional(),
  })
  .strict();

export const mcpServerParams = z.object({ workspaceId: z.uuid(), serverId: z.uuid() });

/**
 * What a test found at the server; the last one is kept on the server. 'not_allowed': its origin,
 * or one its authorization server uses, is not on the instance's allowlist (NF-S4).
 */
export type McpTestStatus = 'ok' | 'auth_failed' | 'unreachable' | 'not_allowed' | 'error';

/**
 * What a test says, which may be that there was nothing to test with: the tester has not
 * connected their own account to an OAuth server, or a shared credential is not set. Those say
 * nothing about the server, so they are not kept as its last test.
 */
export type McpTestOutcome = McpTestStatus | 'not_connected' | 'no_credential';

export interface McpServerView {
  id: string;
  workspaceId: string;
  name: string;
  /** Its own display name, or one made from the name. */
  displayName: string;
  /** Whether the display name was set rather than made. */
  displayNameSet: boolean;
  transport: 'stdio' | 'streamable_http';
  url: string | null;
  command: string | null;
  args: string[];
  authMode: 'none' | 'shared' | 'oauth';
  credentialEnv: string | null;
  /** Whether a shared credential is set; never the credential. */
  hasSharedCredential: boolean;
  /** Whether the URL may resolve to a private address (Q2). */
  allowPrivate: boolean;
  /** For OAuth: the scopes asked for, or null for the server's own. */
  oauthScope: string | null;
  /** For OAuth: how the client is registered, or null until someone first connects. */
  oauthClient: 'registered' | 'admin' | null;
  lastTestedAt: string | null;
  lastTestStatus: McpTestStatus | null;
  /** When its tools were last synced, and why that failed, as our own code, if it did. */
  lastSync: { at: string; error: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

/** A tool as its server describes it. Every field is the server's word, not ours. */
export interface McpToolView {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean | null;
    destructiveHint: boolean | null;
    idempotentHint: boolean | null;
    openWorldHint: boolean | null;
  };
}

export interface McpServerTestView {
  status: McpTestOutcome;
  /** The server's tools, when it could be reached. */
  tools: McpToolView[];
}

/**
 * A server in the workspace, how it signs in, and for an OAuth server whether the caller has
 * connected to it (TL-2). No address or command, since everyone reads it.
 */
export interface McpConnectionView {
  serverId: string;
  name: string;
  displayName: string;
  authMode: 'none' | 'shared' | 'oauth';
  /** For a shared server: whether its admin has set the credential. */
  hasSharedCredential: boolean;
  /** For an OAuth server: whether the caller has connected. */
  connected: boolean;
  /** When the caller's access token expires; it is refreshed when needed. */
  expiresAt: string | null;
}

/** Where to send the person to authorize (ADR 0068). */
export interface McpConnectStartView {
  authorizationUrl: string;
}

/** An admin's decision about one tool: on the allowlist or not, and whether it asks first. */
export const workspaceToolChangeBody = z
  .object({ enabled: z.boolean().optional(), approvalRequired: z.boolean().optional() })
  .strict()
  .refine((b) => b.enabled !== undefined || b.approvalRequired !== undefined, 'nothing to change');
export type WorkspaceToolChangeBody = z.infer<typeof workspaceToolChangeBody>;

export const workspaceToolParams = z.object({ workspaceId: z.uuid(), toolId: z.uuid() });

/** A tool as an admin reviews it (TL-3, TL-4, ADR 0069). */
export interface WorkspaceToolView {
  id: string;
  serverId: string;
  serverName: string;
  serverDisplayName: string;
  name: string;
  /** What the model calls it, or null when the name cannot be given to a model (H1). */
  modelName: string | null;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  annotations: McpToolView['annotations'];
  /** Why the tool cannot be enabled, if it cannot. */
  unusable: 'name' | 'schema' | null;
  enabled: boolean;
  approvalRequired: boolean;
  syncedAt: string;
}

export interface McpToolSyncView {
  added: number;
  updated: number;
  removed: number;
  tools: WorkspaceToolView[];
}

/**
 * An enabled tool, and whether the caller can use it now (TL-2, TL-5): its server may need the
 * caller to connect their own account first, or its admin to set the shared credential.
 */
export interface AvailableToolView {
  modelName: string;
  /** The tool's own name on its server. */
  name: string;
  serverId: string;
  serverName: string;
  serverDisplayName: string;
  title: string | null;
  description: string | null;
  approvalRequired: boolean;
  /** Null when the caller can use it now. */
  blockedBy: 'not_connected' | 'no_credential' | null;
  /** The caller always allows it (ADR 0071). */
  standingApproval: boolean;
}

export const toolGrantParams = z.object({ workspaceId: z.uuid(), grantId: z.uuid() });

/** A standing approval: this principal lets this tool run without asking (TL-5, ADR 0071). */
export interface ToolGrantView {
  id: string;
  principalId: string;
  principalName: string;
  modelName: string;
  /** The tool's own name on its server. */
  toolName: string;
  serverName: string;
  serverDisplayName: string;
  grantedAt: string;
}

/**
 * The origins MCP servers and their authorization servers may be at, for the whole instance
 * (NF-S4, ADR 0117). An origin is a scheme, host and port, with no path: what a browser's
 * `URL.origin` gives. Instance admins list them.
 */
export const mcpAllowedOriginBody = z
  .object({
    origin: z
      .string()
      .trim()
      .max(255)
      .refine(
        (value) =>
          /^https?:\/\/[^/?#@]+\/?$/i.test(value) &&
          URL.canParse(value) &&
          new URL(value).username === '',
        'an origin only, such as https://mcp.example.com, with no path',
      ),
  })
  .strict();
export type McpAllowedOriginBody = z.infer<typeof mcpAllowedOriginBody>;

export interface McpAllowedOriginView {
  origin: string;
  /** Listed by an instance admin, or by the upgrade that introduced the list. */
  source: 'admin' | 'upgrade';
  /** Who listed it; null for the upgrade's. */
  addedBy: string | null;
  createdAt: string;
}

/**
 * The allowlist: what instance admins listed, and the origins the operator set in
 * LAKKA_MCP_PRIVATE_ORIGINS, which count as listed and are changed only there.
 */
export interface McpAllowedOriginsView {
  origins: McpAllowedOriginView[];
  configured: string[];
}
