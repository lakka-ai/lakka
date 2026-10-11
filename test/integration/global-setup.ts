import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import {
  DEFAULT_POSTGRES_IMAGE,
  POSTGRES_ADMIN_URL,
  POSTGRES_IMAGE,
  VALKEY_HOST,
  VALKEY_IMAGE,
  VALKEY_PORT,
} from './context.ts';

/**
 * Starts one Postgres and one Valkey container for the whole run. Tests create their own
 * databases in Postgres and keep to their own key prefixes in Valkey.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const image = process.env['LAKKA_TEST_POSTGRES_IMAGE'] ?? DEFAULT_POSTGRES_IMAGE;
  const [container, valkey] = await Promise.all([
    new PostgreSqlContainer(image)
      .withDatabase('postgres')
      .withUsername('lakka')
      .withPassword('integration-tests-only')
      .start(),
    new GenericContainer(VALKEY_IMAGE)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ]);
  project.provide(POSTGRES_ADMIN_URL, container.getConnectionUri());
  project.provide(POSTGRES_IMAGE, image);
  project.provide(VALKEY_HOST, valkey.getHost());
  project.provide(VALKEY_PORT, valkey.getMappedPort(6379));
  return async () => {
    await Promise.all([container.stop(), valkey.stop()]);
  };
}
