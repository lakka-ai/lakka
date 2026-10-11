import { queryOptions } from '@tanstack/react-query';
import type {
  McpAllowedOriginsView,
  AlertWebhookView,
  CatalogueFeedView,
  ContentCaptureView,
  RequestListView,
  RequestOutcome,
  RetentionView,
  TraceExportView,
  TraceView,
  AvailableToolView,
  BudgetAlertView,
  BudgetStatusView,
  McpConnectionView,
  McpServerView,
  ToolGrantView,
  WorkspaceToolView,
  BudgetView,
  ConversationSummaryView,
  ConversationView,
  InviteView,
  KeyView,
  MemberView,
  ModelView,
  MeView,
  Principal,
  ProviderConfigView,
  ProviderCoverageView,
  PublicSsoProvider,
  RemainingBudgetView,
  RequestableView,
  RouteCandidatesView,
  RoutingOverridesView,
  RoutingPolicyView,
  SetupStatus,
  SpendReport,
  WorkspaceBudgetsView,
  SsoProviderView,
  UserAdminView,
  WorkspaceView,
} from '@lakka/contracts';
import { api, ApiError } from './api.ts';

/* Shared query definitions, so loaders and components use the same cache keys. */

export const meQuery = queryOptions({
  queryKey: ['me'],
  // The principal, with the person's own email for the account menu.
  queryFn: () =>
    api<MeView>('/api/me').then((r): Principal & { email: string | null } => ({
      ...r.principal,
      email: r.email,
    })),
  retry: false,
});

export const workspacesQuery = queryOptions({
  queryKey: ['workspaces'],
  queryFn: () => api<{ workspaces: WorkspaceView[] }>('/api/workspaces').then((r) => r.workspaces),
});

export const workspaceQuery = (id: string) =>
  queryOptions({
    queryKey: ['workspaces', id],
    queryFn: () =>
      api<{ workspace: WorkspaceView }>(`/api/workspaces/${id}`).then((r) => r.workspace),
  });

export const membersQuery = (id: string) =>
  queryOptions({
    queryKey: ['workspaces', id, 'members'],
    queryFn: () =>
      api<{ members: MemberView[] }>(`/api/workspaces/${id}/members`).then((r) => r.members),
  });

export const keysQuery = (id: string) =>
  queryOptions({
    queryKey: ['workspaces', id, 'keys'],
    queryFn: () => api<{ keys: KeyView[] }>(`/api/workspaces/${id}/keys`).then((r) => r.keys),
  });

export const usersQuery = queryOptions({
  queryKey: ['users'],
  queryFn: () => api<{ users: UserAdminView[] }>('/api/users').then((r) => r.users),
});

export const ssoProvidersQuery = queryOptions({
  queryKey: ['sso-providers'],
  queryFn: () =>
    api<{ providers: SsoProviderView[] }>('/api/sso/providers').then((r) => r.providers),
});

export const publicSsoProvidersQuery = queryOptions({
  queryKey: ['sso-providers', 'public'],
  queryFn: () =>
    api<{ providers: PublicSsoProvider[] }>('/api/sso/providers/public').then((r) => r.providers),
});

export const setupStatusQuery = queryOptions({
  queryKey: ['setup'],
  queryFn: () => api<SetupStatus>('/api/setup'),
});

export const invitesQuery = (id: string) =>
  queryOptions({
    queryKey: ['workspaces', id, 'invites'],
    queryFn: () =>
      api<{ invites: InviteView[] }>(`/api/workspaces/${id}/invites`).then((r) => r.invites),
  });

export const modelsQuery = queryOptions({
  queryKey: ['models'],
  queryFn: () => api<{ models: ModelView[] }>('/api/models').then((r) => r.models),
});

/** Price updates from the signed feed (PR-6, ADR 0116). */
export const catalogueFeedQuery = queryOptions({
  queryKey: ['models', 'catalogue-feed'],
  queryFn: () => api<{ feed: CatalogueFeedView }>('/api/models/catalogue-feed').then((r) => r.feed),
});

/** Provider credentials for the instance (null) or one workspace. */
export const providersPath = (workspaceId: string | null) =>
  workspaceId === null ? '/api/providers' : `/api/workspaces/${workspaceId}/providers`;

export const providersQuery = (workspaceId: string | null) =>
  queryOptions({
    queryKey: ['providers', workspaceId ?? 'instance'],
    queryFn: () =>
      api<{ providers: ProviderConfigView[] }>(providersPath(workspaceId)).then((r) => r.providers),
  });

/** Whose key each first-party provider uses in a workspace (PR-2, ADR 0096). */
export const providerCoverageQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['providers', workspaceId, 'coverage'],
    queryFn: () =>
      api<{ coverage: ProviderCoverageView[] }>(
        `/api/workspaces/${workspaceId}/providers/coverage`,
      ).then((r) => r.coverage),
  });

/** The workspace's routing settings and routes (RT-1, RT-11). */
export const routingPolicyQuery = (id: string) =>
  queryOptions({
    queryKey: ['workspaces', id, 'routing'],
    queryFn: () => api<RoutingPolicyView>(`/api/workspaces/${id}/routing`),
  });

/** Models the workspace can use: priced, with a credential for their provider. */
export const workspaceModelsQuery = (id: string) =>
  queryOptions({
    queryKey: ['workspaces', id, 'models'],
    queryFn: () =>
      api<{ models: ModelView[] }>(`/api/workspaces/${id}/models`).then((r) => r.models),
  });

/** Overrides per route over the last 30 days (RT-10). */
export const routingOverridesQuery = (id: string) =>
  queryOptions({
    queryKey: ['workspaces', id, 'routing', 'overrides'],
    queryFn: () => api<RoutingOverridesView>(`/api/workspaces/${id}/routing/overrides`),
  });

/**
 * Messages people moved away from a route on, offered as route examples while the workspace
 * records content (RT-10, ADR 0114), over the same 30 days as the overrides.
 */
export const routingCandidatesQuery = (id: string) =>
  queryOptions({
    queryKey: ['workspaces', id, 'routing', 'candidates'],
    queryFn: () => api<RouteCandidatesView>(`/api/workspaces/${id}/routing/candidates`),
  });

/** The instance cap (instance admins only). */
export const instanceBudgetQuery = queryOptions({
  queryKey: ['budgets', 'instance'],
  queryFn: () => api<{ budget: BudgetView | null }>('/api/budgets/instance').then((r) => r.budget),
});

/** Every cap in a workspace that the caller may see (BG-1, F5). */
export const workspaceBudgetsQuery = (id: string) =>
  queryOptions({
    queryKey: ['workspaces', id, 'budgets'],
    queryFn: () => api<WorkspaceBudgetsView>(`/api/workspaces/${id}/budgets`),
  });

/** The alert webhook for the instance (null) or a workspace (BG-10). */
export const webhookPath = (workspaceId: string | null) =>
  workspaceId === null ? '/api/budgets/webhook' : `/api/workspaces/${workspaceId}/budgets/webhook`;

export const webhookQuery = (workspaceId: string | null) =>
  queryOptions({
    queryKey: ['webhook', workspaceId ?? 'instance'],
    queryFn: () =>
      api<{ webhook: AlertWebhookView | null }>(webhookPath(workspaceId)).then((r) => r.webhook),
  });

/** Spend for the instance (null) or a workspace, over whole UTC days (BG-11). */
export const spendQuery = (
  workspaceId: string | null,
  range: { from: string; to: string } | null,
) =>
  queryOptions({
    queryKey: ['spend', workspaceId ?? 'instance', range?.from ?? '', range?.to ?? ''],
    queryFn: () =>
      api<SpendReport>(
        `${workspaceId === null ? '/api/spend' : `/api/workspaces/${workspaceId}/spend`}${
          range === null ? '' : `?from=${range.from}&to=${range.to}`
        }`,
      ),
  });

/** The caller's own conversations in a workspace, most recently changed first (CH-1). */
export const conversationsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'conversations'],
    queryFn: () =>
      api<{ conversations: ConversationSummaryView[] }>(
        `/api/workspaces/${workspaceId}/conversations`,
      ).then((r) => r.conversations),
  });

/** One conversation with its messages (CH-1, CH-2). */
export const conversationQuery = (workspaceId: string, conversationId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'conversations', conversationId],
    queryFn: () =>
      api<{ conversation: ConversationView }>(
        `/api/workspaces/${workspaceId}/conversations/${conversationId}`,
      ).then((r) => r.conversation),
  });

/** What the caller can still spend here, or null when no cap applies (CH-4). */
export const remainingBudgetQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['budgets', 'remaining', workspaceId],
    queryFn: () =>
      api<{ remaining: RemainingBudgetView | null }>(
        `/api/workspaces/${workspaceId}/budgets/remaining`,
      ).then((r) => r.remaining),
  });

/**
 * Whether budgets can be checked now (BG-4). Asked again every 15 seconds while they cannot, so
 * the banner goes when the store is back.
 */
export const budgetStatusQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['budgets', 'status', workspaceId],
    queryFn: () =>
      api<{ status: BudgetStatusView }>(`/api/workspaces/${workspaceId}/budgets/status`).then(
        (r) => r.status,
      ),
    refetchInterval: (query) => (query.state.data?.available === false ? 15_000 : false),
  });

/**
 * What chat may ask for, the same list /v1/models gives an API client (G1): "auto", the routes,
 * then model references, each with the kinds of file it can read (CH-5, ADR 0062).
 */
export const requestableQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'requestable'],
    queryFn: () => api<RequestableView>(`/api/workspaces/${workspaceId}/requestable`),
  });

/** The workspace's MCP servers, for its admins (TL-1, ADR 0067). */
export const mcpServersQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'mcp-servers'],
    queryFn: () =>
      api<{ servers: McpServerView[] }>(`/api/workspaces/${workspaceId}/mcp-servers`).then(
        (r) => r.servers,
      ),
  });

/** Every tool synced from the workspace's servers, with the admin's decisions (TL-3, TL-4). */
export const workspaceToolsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'tools'],
    queryFn: () =>
      api<{ tools: WorkspaceToolView[] }>(`/api/workspaces/${workspaceId}/tools`).then(
        (r) => r.tools,
      ),
  });

/** The tools the caller can use now (ADR 0069). */
export const availableToolsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'tools', 'available'],
    queryFn: () =>
      api<{ tools: AvailableToolView[] }>(`/api/workspaces/${workspaceId}/tools/available`).then(
        (r) => r.tools,
      ),
  });

/** Standing approvals (TL-5): the caller's own, or everyone's for a workspace admin. */
export const toolGrantsQuery = (workspaceId: string, scope: 'mine' | 'all') =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'tool-grants', scope],
    queryFn: () =>
      api<{ grants: ToolGrantView[] }>(
        scope === 'mine'
          ? `/api/workspaces/${workspaceId}/tool-grants`
          : `/api/workspaces/${workspaceId}/tools/grants`,
      ).then((r) => r.grants),
  });

/** The workspace's OAuth servers, and whether the caller has connected to each (TL-2). */
export const mcpConnectionsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'mcp-connections'],
    queryFn: () =>
      api<{ connections: McpConnectionView[] }>(
        `/api/workspaces/${workspaceId}/mcp-connections`,
      ).then((r) => r.connections),
  });

/** Whether the workspace records prompts and replies, and for how long (OB-4, ADR 0077). */
export const contentCaptureQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'content-capture'],
    queryFn: () =>
      api<{ capture: ContentCaptureView }>(`/api/workspaces/${workspaceId}/content-capture`).then(
        (r) => r.capture,
      ),
  });

/** How long each kind of record is kept, for the instance (OB-6, NF-P5, ADR 0078). */
/** The instance's allowlist of MCP origins (NF-S4), for instance admins. */
export const mcpOriginsQuery = queryOptions({
  queryKey: ['admin', 'mcp-origins'],
  queryFn: () =>
    api<{ allowlist: McpAllowedOriginsView }>('/api/admin/mcp-origins').then((r) => r.allowlist),
});

export const retentionQuery = queryOptions({
  queryKey: ['retention'],
  queryFn: () => api<{ retention: RetentionView }>('/api/retention').then((r) => r.retention),
});

/** Budget alerts and what became of them, for the instance (null) or a workspace (BG-10). */
export const alertHistoryQuery = (workspaceId: string | null) =>
  queryOptions({
    queryKey: ['alerts', workspaceId ?? 'instance'],
    queryFn: () =>
      api<{ alerts: BudgetAlertView[] }>(
        workspaceId === null
          ? '/api/budgets/alerts'
          : `/api/workspaces/${workspaceId}/budgets/alerts`,
      ).then((r) => r.alerts),
  });

/** The workspace's requests, newest first, a page at a time (OB-1, ADR 0079). */
/** What the request list is filtered by (OB-1, ADR 0095); absent means all. */
export interface RequestFilters {
  person?: string;
  surface?: 'chat' | 'api' | 'mcp';
  outcome?: RequestOutcome;
  from?: string;
  to?: string;
}

/** One page of a workspace's requests, newest first, after `before` when given (OB-1). */
export const requestsQuery = (
  workspaceId: string,
  filters: RequestFilters,
  before: string | null,
) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'requests', 'list', filters, before],
    queryFn: () => {
      const params = new URLSearchParams(
        Object.entries({ ...filters, ...(before === null ? {} : { before }) }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const query = params.toString();
      return api<RequestListView>(
        `/api/workspaces/${workspaceId}/requests${query === '' ? '' : `?${query}`}`,
      );
    },
    placeholderData: (previous) => previous,
  });

/**
 * One request's trace. Spans are written about a second after a request ends, so a trace opened
 * straight from its reply may not be there yet: a missing one is asked for again, for a few
 * seconds, before the page says so.
 */
export const traceQuery = (workspaceId: string, requestId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'requests', 'trace', requestId],
    retry: (count, error) => error instanceof ApiError && error.status === 404 && count < 6,
    retryDelay: 1000,
    queryFn: () =>
      api<{ trace: TraceView }>(`/api/workspaces/${workspaceId}/requests/${requestId}`).then(
        (r) => r.trace,
      ),
  });

/** Whether traces also leave the instance, and to where (OB-5, NF-P2, ADR 0080). */
export const traceExportQuery = queryOptions({
  queryKey: ['observability', 'export'],
  queryFn: () =>
    api<{ export: TraceExportView }>('/api/observability/export').then((r) => r.export),
});
