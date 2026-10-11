// Values the integration global setup hands to tests through vitest's provide/inject.

export const POSTGRES_ADMIN_URL = 'postgresAdminUrl';
export const POSTGRES_IMAGE = 'postgresImage';
export const DEFAULT_POSTGRES_IMAGE = 'pgvector/pgvector:0.8.6-pg18-trixie';
export const VALKEY_HOST = 'valkeyHost';
export const VALKEY_PORT = 'valkeyPort';
export const VALKEY_IMAGE = 'valkey/valkey:9.1.2-trixie';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser connection to the shared test container's maintenance database. */
    [POSTGRES_ADMIN_URL]: string;
    [POSTGRES_IMAGE]: string;
    /** The shared Valkey test container. Tests keep to their own key prefixes. */
    [VALKEY_HOST]: string;
    [VALKEY_PORT]: number;
  }
}
