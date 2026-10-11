import type { Db } from '@lakka/db';
import type { EventPublisher } from './events.ts';

/** What core services need from the process: the database and somewhere to publish events. */
export interface ServiceContext {
  db: Db;
  events: EventPublisher;
}
