import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeBody } from '@lakka/contracts';
import { createDb } from '../src/client.ts';
import type { Db } from '../src/client.ts';
import { migrate } from '../src/migrate.ts';
import { insertRoute, listRoutes, replaceCentroids, updateRoute } from '../src/queries/routing.ts';
import { principals, workspaces } from '../src/schema/identity.ts';
import { routeCentroids, routeExamples, routes } from '../src/schema/routing.ts';
import { createTestDatabase } from '../../../test/integration/postgres.ts';
import type { TestDatabase } from '../../../test/integration/postgres.ts';

/* pgvector embeddings on routing tables (ADR 0042) against real Postgres. */

let database: TestDatabase;
let db: Db;

beforeAll(async () => {
  database = await createTestDatabase();
  const pool = database.pool();
  await migrate(pool);
  db = createDb(pool);
});

afterAll(async () => {
  await database.drop();
});

describe('routing embeddings', () => {
  it('stores embeddings of any dimension as pgvector values and reads them back exactly', async () => {
    const [user] = await db
      .insert(principals)
      .values({
        kind: 'user',
        displayName: 'Ada',
        email: `ada-${randomBytes(3).toString('hex')}@example.com`,
      })
      .returning();
    const slug = `ws-${randomBytes(3).toString('hex')}`;
    const [ws] = await db.insert(workspaces).values({ name: slug, slug }).returning();
    if (user === undefined || ws === undefined) throw new Error('setup failed');
    const [route] = await db
      .insert(routes)
      .values({
        workspaceId: ws.id,
        name: 'code',
        model: 'fake:large',
        thresholdDown: 0.75,
        thresholdUp: 0.55,
        createdByPrincipalId: user.id,
      })
      .returning();
    if (route === undefined) throw new Error('setup failed');

    await db.insert(routeExamples).values({
      routeId: route.id,
      workspaceId: ws.id,
      text: 'Fix this bug',
      position: 0,
      embedding: [0.6, 0.8],
      embeddingModel: 'two-dim',
    });
    await db.insert(routeCentroids).values({
      routeId: route.id,
      workspaceId: ws.id,
      embedding: [0.25, -0.5, 0.75, 0.125],
      embeddingModel: 'four-dim',
      exampleCount: 1,
    });
    const [example] = await db
      .select()
      .from(routeExamples)
      .where(eq(routeExamples.routeId, route.id));
    const [centroid] = await db
      .select()
      .from(routeCentroids)
      .where(eq(routeCentroids.routeId, route.id));
    expect(example?.embedding).toEqual([0.6, 0.8]);
    expect(centroid?.embedding).toEqual([0.25, -0.5, 0.75, 0.125]);
    const type = await db.$client.query<{ type: string }>(
      'select pg_typeof(embedding)::text as type from route_centroids where route_id = $1',
      [route.id],
    );
    expect(type.rows[0]?.type).toBe('vector');
  });
});

async function workspaceWithRoutes() {
  const [user] = await db
    .insert(principals)
    .values({
      kind: 'user',
      displayName: 'Ada',
      email: `ada-${randomBytes(3).toString('hex')}@example.com`,
    })
    .returning();
  const slug = `ws-${randomBytes(3).toString('hex')}`;
  const [ws] = await db.insert(workspaces).values({ name: slug, slug }).returning();
  if (user === undefined || ws === undefined) throw new Error('setup failed');
  const trained = routeBody.parse({
    name: 'code',
    description: 'source code and errors',
    model: 'fake:large',
    examples: ['Fix this TypeScript error', 'Why is this query slow?'],
  });
  const described = routeBody.parse({
    name: 'legal',
    description: 'contracts, NDAs and GDPR',
    model: 'fake:large',
  });
  const plain = routeBody.parse({
    name: 'chat',
    model: 'fake:large',
    examples: ['Tell me a joke', 'How are you today?'],
  });
  const trainedId = await insertRoute(db, ws.id, trained, user.id);
  const describedId = await insertRoute(db, ws.id, described, user.id);
  const plainId = await insertRoute(db, ws.id, plain, user.id);
  const centroids = [
    {
      routeId: trainedId,
      embedding: [1, 0],
      exampleCount: 2,
      source: 'examples_and_description' as const,
    },
    { routeId: describedId, embedding: [0, 1], exampleCount: 0, source: 'description' as const },
    { routeId: plainId, embedding: [1, 1], exampleCount: 2, source: 'examples' as const },
  ];
  await replaceCentroids(db, ws.id, centroids, 'two-dim');
  // As compiling would leave them: one centroid per route, from what the route has.
  const recompile = () => replaceCentroids(db, ws.id, centroids, 'two-dim');
  return { ws, trained, described, plain, trainedId, describedId, plainId, recompile };
}

const sources = async (workspaceId: string) =>
  Object.fromEntries(
    (await listRoutes(db, workspaceId)).map((r) => [r.name, r.centroid?.source ?? null]),
  );

const compiled = { code: 'examples_and_description', legal: 'description', chat: 'examples' };

describe('description centroids (RT-12, ADR 0122, ADR 0125)', () => {
  it('RT-12: a centroid records whether it came from examples, the description or both', async () => {
    const { ws, trainedId, describedId } = await workspaceWithRoutes();
    expect(await sources(ws.id)).toEqual(compiled);
    // A description centroid has no examples behind it, and the other two have some.
    await expect(
      replaceCentroids(
        db,
        ws.id,
        [{ routeId: describedId, embedding: [0, 1], exampleCount: 1, source: 'description' }],
        'two-dim',
      ),
    ).rejects.toHaveProperty('cause.constraint', 'route_centroids_source_check');
    await expect(
      replaceCentroids(
        db,
        ws.id,
        [{ routeId: describedId, embedding: [0, 1], exampleCount: 0, source: 'examples' }],
        'two-dim',
      ),
    ).rejects.toHaveProperty('cause.constraint', 'route_centroids_source_check');
    await expect(
      replaceCentroids(
        db,
        ws.id,
        [
          {
            routeId: trainedId,
            embedding: [1, 0],
            exampleCount: 0,
            source: 'examples_and_description',
          },
        ],
        'two-dim',
      ),
    ).rejects.toHaveProperty('cause.constraint', 'route_centroids_source_check');
    // The failed replacements changed nothing.
    expect(await sources(ws.id)).toEqual(compiled);
  });

  it("RT-12: a described route's centroid goes when its name or description changes", async () => {
    const { ws, trained, described, plain, trainedId, describedId, plainId, recompile } =
      await workspaceWithRoutes();
    // Saving the same text keeps every centroid.
    await updateRoute(db, ws.id, describedId, described);
    await updateRoute(db, ws.id, trainedId, trained);
    await updateRoute(db, ws.id, plainId, plain);
    expect(await sources(ws.id)).toEqual(compiled);
    // A new description drops the description centroid.
    await updateRoute(db, ws.id, describedId, { ...described, description: 'contracts' });
    expect(await sources(ws.id)).toEqual({ ...compiled, legal: null });
    // So does a new name, which is part of the text a description centroid is embedded from.
    await recompile();
    await updateRoute(db, ws.id, describedId, {
      ...described,
      description: 'contracts',
      name: 'contracts',
    });
    expect(await sources(ws.id)).toMatchObject({ code: compiled.code, contracts: null });
  });

  it("RT-12: adding, editing or clearing a trained route's description drops its centroid", async () => {
    const { ws, trained, plain, trainedId, plainId, recompile } = await workspaceWithRoutes();
    // ADR 0125: the description is one of a trained route's examples, so a change to it is a
    // change to the centroid, as a changed example is.
    await updateRoute(db, ws.id, trainedId, { ...trained, description: 'programming' });
    expect(await sources(ws.id)).toEqual({ ...compiled, code: null });
    await recompile();
    await updateRoute(db, ws.id, trainedId, { ...trained, description: '' });
    expect(await sources(ws.id)).toEqual({ ...compiled, code: null });
    await recompile();
    await updateRoute(db, ws.id, plainId, { ...plain, description: 'small talk' });
    expect(await sources(ws.id)).toEqual({ ...compiled, chat: null });
    // A renamed trained route with a description changes its described text too.
    await updateRoute(db, ws.id, trainedId, trained);
    await recompile();
    expect(await sources(ws.id)).toEqual(compiled);
    await updateRoute(db, ws.id, trainedId, { ...trained, name: 'programming' });
    expect(await sources(ws.id)).toMatchObject({ programming: null });
  });

  it('RT-12: renaming a trained route with no description keeps its centroid', async () => {
    const { ws, plain, plainId } = await workspaceWithRoutes();
    await updateRoute(db, ws.id, plainId, { ...plain, name: 'smalltalk' });
    const { chat, ...rest } = compiled;
    expect(await sources(ws.id)).toEqual({ ...rest, smalltalk: chat });
  });
});
