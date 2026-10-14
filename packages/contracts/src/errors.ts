/**
 * Base class for every error we raise on purpose. Surfaces map `code` to their own format
 * (HTTP status plus machine-readable code for the API, a plain message for chat).
 *
 * The message is written by us, so it is safe to log. Errors from third parties (providers,
 * drivers) are never LakkaErrors and their messages are never logged, because they can
 * echo request content.
 */
export abstract class LakkaError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Configuration is missing or invalid. The process should refuse to start. */
export class ConfigError extends LakkaError {
  readonly code = 'config_invalid';
}

/**
 * No chunk arrived from any attempt inside the commitment window. Nothing has reached the
 * client yet, so the surface can still answer with a normal error response.
 */
export class UpstreamUnavailableError extends LakkaError {
  readonly code = 'upstream_unavailable';
  /** The provider of the last model tried, for "Anthropic is not responding" (CH-7). */
  readonly provider: string | null;
  /** The provider limited the rate, and said how long to wait when it did. */
  readonly rateLimited: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options?: ErrorOptions & {
      provider?: string;
      rateLimited?: boolean;
      retryAfterSeconds?: number | null;
    },
  ) {
    super(message, options);
    this.provider = options?.provider ?? null;
    this.rateLimited = options?.rateLimited ?? false;
    this.retryAfterSeconds = options?.retryAfterSeconds ?? null;
  }
}

/**
 * The stream failed after the first chunk reached the client. Failover is no longer possible
 * (CLAUDE.md invariant 6); the surface reports the error inside the stream.
 */
export class StreamInterruptedError extends LakkaError {
  readonly code = 'stream_interrupted';
}

/**
 * The database schema does not match this version's migrations: the database has migrations
 * this version does not know (a downgrade or diverged history), an applied migration was edited,
 * or pending migrations cannot be applied in order. The process refuses to start (AD-4, NF-O1).
 */
export class SchemaMismatchError extends LakkaError {
  readonly code = 'schema_mismatch';
}

/** Another process held the migration lock for longer than the allowed wait. */
export class MigrationLockTimeoutError extends LakkaError {
  readonly code = 'migration_lock_timeout';
}

/*
 * The credential master key ring (NF-S1, NF-S9, ADR 0115). Messages name a key version, a
 * column or a row id, never key material.
 */

/** A stored credential names a key version this process was not given. */
export class CredentialKeyUnavailableError extends LakkaError {
  readonly code = 'credential_key_unavailable';
  readonly version: number;

  constructor(version: number, options?: ErrorOptions) {
    super(`credential key v${version} is not configured`, options);
    this.version = version;
  }
}

/** At startup: the key version the database says is active was not given. */
export class CredentialKeyMissingError extends LakkaError {
  readonly code = 'credential_key_missing';
  readonly version: number;

  constructor(version: number, options?: ErrorOptions) {
    super(
      `credential key v${version} is active in the database but was not given to this process`,
      options,
    );
    this.version = version;
  }
}

/** At startup: a key given for a version is not the key the database recorded for it. */
export class CredentialKeyMismatchError extends LakkaError {
  readonly code = 'credential_key_mismatch';
  readonly version: number;

  constructor(version: number, options?: ErrorOptions) {
    super(`credential key v${version} is not the key this database was encrypted with`, options);
    this.version = version;
  }
}

/** A stored credential could not be decrypted while rotating; nothing was changed. */
export class CredentialUnreadableError extends LakkaError {
  readonly code = 'credential_unreadable';
  readonly column: string;
  readonly rowId: string;

  constructor(column: string, rowId: string, options?: ErrorOptions) {
    super(`${column} in row ${rowId} could not be decrypted; nothing was changed`, options);
    this.column = column;
    this.rowId = rowId;
  }
}

/** An older key version still encrypts stored values, so it cannot be retired yet. */
export class CredentialKeyInUseError extends LakkaError {
  readonly code = 'credential_key_in_use';
  /** Each column that still holds older values, as table.column, with how many. */
  readonly columns: readonly { column: string; count: number }[];

  constructor(
    message: string,
    details: { columns: readonly { column: string; count: number }[] },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.columns = details.columns;
  }
}

/** A maintenance command needs the database to itself, and other connections are open. */
export class DatabaseInUseError extends LakkaError {
  readonly code = 'database_in_use';
  readonly connections: number;

  constructor(connections: number, options?: ErrorOptions) {
    super(
      `${connections} other connections to the database are open; stop the api and the worker first`,
      options,
    );
    this.connections = connections;
  }
}

/** No valid credential, or the principal behind it is suspended (HTTP 401). */
export class UnauthenticatedError extends LakkaError {
  readonly code = 'unauthenticated';
}

/** The principal may see the resource but not do this to it (HTTP 403). */
export class ForbiddenError extends LakkaError {
  readonly code = 'forbidden';
}

/**
 * The resource does not exist, or the principal may not know that it does (HTTP 404). Other
 * workspaces answer with this rather than 403, so their existence does not leak (AC 16).
 */
export class NotFoundError extends LakkaError {
  readonly code = 'not_found';
}

/**
 * A request in progress lost its access: its person was suspended or removed from the
 * workspace, or its key was revoked (AC 6, ADR 0063). The stream ends; what arrived stays.
 */
export class AccessRevokedError extends LakkaError {
  readonly code = 'access_revoked';
}

/** The request body or parameters are invalid. The message names fields, never values. */
export class InvalidRequestError extends LakkaError {
  readonly code = 'invalid_request';
}

export class SlugTakenError extends LakkaError {
  readonly code = 'slug_taken';
}

/** A typed confirmation, such as a workspace's name before deleting it, did not match (ID-8). */
export class ConfirmationMismatchError extends LakkaError {
  readonly code = 'confirmation_mismatch';
}

/** A workspace must keep at least one admin (ADR 0029). */
export class LastWorkspaceAdminError extends LakkaError {
  readonly code = 'last_workspace_admin';
}

/** Retention is already running, in the worker or for another admin (ADR 0097). */
export class RetentionRunningError extends LakkaError {
  readonly code = 'retention_running';
}

/**
 * The reset link does not exist, has expired, was used or replaced, or its maker may no longer
 * make one. One answer for all of these, as for invites (ADR 0098).
 */
export class PasswordResetInvalidError extends LakkaError {
  readonly code = 'reset_invalid';
}

/** The instance must keep at least one active instance admin (ADR 0097). */
export class LastInstanceAdminError extends LakkaError {
  readonly code = 'last_instance_admin';
}

/** An instance admin tried to suspend themselves, which could lock everyone out (ADR 0031). */
export class SelfSuspensionError extends LakkaError {
  readonly code = 'cannot_suspend_self';
}

/** An instance admin tried to delete themselves (NF-P4, ADR 0082). */
export class SelfDeletionError extends LakkaError {
  readonly code = 'cannot_delete_self';
}

/** First-run setup has already been completed; it can run only once (AD-1, ADR 0034). */
export class SetupCompleteError extends LakkaError {
  readonly code = 'setup_complete';
}

/**
 * The setup code is missing or wrong. The same answer for both, so it does not tell a caller
 * whether the instance has a code configured (ADR 0034).
 */
export class InvalidSetupCodeError extends LakkaError {
  readonly code = 'invalid_setup_code';
}

/**
 * The invite does not exist, has expired, was used, was revoked, or its creator may no longer
 * invite. One answer for all of these, so a link reveals nothing beyond being unusable (ID-7).
 */
export class InviteInvalidError extends LakkaError {
  readonly code = 'invite_invalid';
}

/** The person accepting an invite already belongs to its workspace. */
export class AlreadyMemberError extends LakkaError {
  readonly code = 'already_member';
}

/** A local account with this email address already exists. */
export class EmailTakenError extends LakkaError {
  readonly code = 'email_taken';
}

/**
 * Too many attempts from one client address, or too many model requests started by one person,
 * their keys included (BG-12); try again after `retryAfterSeconds`.
 */
export class RateLimitedError extends LakkaError {
  readonly code = 'rate_limited';
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number, options?: ErrorOptions) {
    super(message, options);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The model is neither in the catalogue nor added by an admin, so it has no price. Such a model
 * is refused rather than served unmetered (BG-4).
 */
export class UnknownModelError extends LakkaError {
  readonly code = 'unknown_model';
}

/** A custom model may not reuse the id of a catalogue model, whose price it would override. */
export class ModelExistsError extends LakkaError {
  readonly code = 'model_exists';
}

/** A price check was asked for while price updates are off (PR-6, ADR 0116). */
export class CatalogueFeedOffError extends LakkaError {
  readonly code = 'catalogue_feed_off';
}

/** The operator set LAKKA_CATALOGUE_FEED_URL=off, so price updates cannot be turned on. */
export class CatalogueFeedLockedError extends LakkaError {
  readonly code = 'catalogue_feed_locked';
}

/**
 * This build has no key to check a price feed's signature with, so price updates cannot be
 * turned on (ADR 0116).
 */
export class CatalogueFeedNoKeyError extends LakkaError {
  readonly code = 'catalogue_feed_no_key';
}

/** A credential with this name already exists in this scope (instance or workspace). */
export class ProviderExistsError extends LakkaError {
  readonly code = 'provider_exists';
}

/** A workspace already has an MCP server with that name (ADR 0067). */
export class McpServerExistsError extends LakkaError {
  readonly code = 'mcp_server_exists';
}

/**
 * The server's authorization server offers no dynamic registration, and no admin has entered a
 * client for it yet (ADR 0068).
 */
export class McpOAuthClientRequiredError extends LakkaError {
  readonly code = 'mcp_oauth_client_required';
}

/**
 * Connecting an account to an MCP server failed: its authorization server could not be found,
 * refused Lakka, or refused the code. The message says which, never the server's own words.
 */
export class McpOAuthFailedError extends LakkaError {
  readonly code = 'mcp_oauth_failed';
}

/**
 * An MCP server, or an authorization server one names, is at an origin no instance admin has
 * listed (NF-S4, ADR 0117). Nothing was sent there. `origin` is the one to list.
 */
export class McpOriginNotAllowedError extends LakkaError {
  readonly code = 'mcp_origin_not_allowed';
  readonly origin: string;

  constructor(origin: string, options?: ErrorOptions) {
    super(`${origin} is not on this instance's list of allowed tool server origins`, options);
    this.origin = origin;
  }
}

/** No credential, in the workspace or for the whole instance, can reach this model's provider. */
export class ProviderNotConfiguredError extends LakkaError {
  readonly code = 'provider_not_configured';
}

/**
 * The provider rejected the request itself (malformed, unsupported option). Retrying or failing
 * over would not help, so it is not attempted.
 */
export class ProviderRequestRejectedError extends LakkaError {
  readonly code = 'provider_rejected_request';
}

/** The provider refused the stored credential. An admin has to fix it; nothing is retried. */
export class ProviderAuthError extends LakkaError {
  readonly code = 'provider_auth_failed';
}

/**
 * The provider refused for its account's billing: a 402, or a refusal that says the account is
 * out of credit (CH-7, ADR 0127). An admin has to fix it; nothing is retried or failed over.
 * Never a 402 to clients: that status means a Lakka budget refused (API-5).
 */
export class ProviderBillingError extends LakkaError {
  readonly code = 'provider_billing';
  readonly provider: string;

  constructor(message: string, options: ErrorOptions & { provider: string }) {
    super(message, options);
    this.provider = options.provider;
  }
}

/**
 * Every model tried was one its provider does not know (CH-7, ADR 0127): Lakka has the model,
 * but the id after the colon is wrong. An admin has to fix the model. Unlike `unknown_model`,
 * which is a model Lakka itself does not have.
 */
export class ProviderModelNotFoundError extends LakkaError {
  readonly code = 'provider_model_not_found';
  readonly provider: string;
  /** The Lakka model reference of the last model tried, `provider:model`. */
  readonly model: string;

  constructor(message: string, options: ErrorOptions & { provider: string; model: string }) {
    super(message, options);
    this.provider = options.provider;
    this.model = options.model;
  }
}

/** The provider's content filter refused the request. Never retried, never failed over. */
export class ContentFilteredError extends LakkaError {
  readonly code = 'content_filtered';
}

/** The input is longer than every candidate model can take. */
export class ContextTooLongError extends LakkaError {
  readonly code = 'context_too_long';
}

/** The requested output is longer than every candidate model can produce. */
export class OutputTooLongError extends LakkaError {
  readonly code = 'output_too_long';
}

/** A route with this name already exists in the workspace. */
export class RouteExistsError extends LakkaError {
  readonly code = 'route_exists';
}

/**
 * A route example candidate is no longer offered (RT-10, ADR 0114): its message or recorded
 * content is gone, content capture was turned off, or an admin already added or dismissed it.
 */
export class CandidateGoneError extends LakkaError {
  readonly code = 'candidate_gone';
}

/** Another route in the workspace already claims this deterministic signal. */
export class SignalClaimedError extends LakkaError {
  readonly code = 'signal_claimed';
}

/** Nothing chose a model for the request and the workspace has no default model (RT-6). */
export class NoModelError extends LakkaError {
  readonly code = 'no_model';
}

/**
 * A request would take spend past a cap (BG-3). Refused before anything is sent. Names the scope
 * that refused and the headroom left in the tightest cap, which the fallback uses (BG-7).
 */
export class BudgetExceededError extends LakkaError {
  readonly code = 'budget_exceeded';
  readonly scope: 'instance' | 'workspace' | 'member' | 'key';
  readonly remainingMicroUsd: bigint;
  /** The most the request could have cost, which the cap had no room for (CH-4). */
  readonly requiredMicroUsd: bigint | null;

  constructor(
    message: string,
    details: {
      scope: BudgetExceededError['scope'];
      remainingMicroUsd: bigint;
      requiredMicroUsd?: bigint;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.scope = details.scope;
    this.remainingMicroUsd = details.remainingMicroUsd;
    this.requiredMicroUsd = details.requiredMicroUsd ?? null;
  }
}

/**
 * Budgets cannot be checked, because Postgres or Valkey is unreachable. The request is refused
 * rather than served unmetered (BG-4, invariant 3).
 */
export class BudgetUnavailableError extends LakkaError {
  readonly code = 'budget_unavailable';
}

/**
 * The request carries a file the model cannot read, an image for a model without vision or a PDF
 * for one without PDF support (CH-5). Checked before anything is sent.
 */
export class UnsupportedInputError extends LakkaError {
  readonly code = 'unsupported_input';
}
