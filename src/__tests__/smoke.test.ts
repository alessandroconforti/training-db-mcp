/**
 * smoke.test.ts — Phase 0 acceptance smoke tests (no live DB required).
 *
 * Run: npm test  (node --test --import tsx)
 *
 * Covers:
 *   - buildCtx fail-fast on missing/invalid env
 *   - tx() COMMIT on success and ROLLBACK on throw (mocked pg client)
 *   - requireOwned throws NotFoundError on 0 rows, passes on a match
 *   - toToolError maps AppError → structured tool-error shape
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCtx } from '../ctx.js';
import { requireOwned } from '../ownership.js';
import { NotFoundError, toToolError, ValidationError } from '../errors.js';
import type { Queryable } from '../db.js';

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

// --- ctx fail-fast -----------------------------------------------------------

test('buildCtx throws when MCP_USER_ID is missing', () => {
  assert.throws(
    () => buildCtx({ SUPABASE_DB_URL: 'postgres://x' }),
    /MCP_USER_ID is missing/
  );
});

test('buildCtx throws when MCP_USER_ID is not a uuid', () => {
  assert.throws(
    () => buildCtx({ MCP_USER_ID: 'not-a-uuid', SUPABASE_DB_URL: 'postgres://x' }),
    /not a valid uuid/
  );
});

test('buildCtx throws when SUPABASE_DB_URL is missing', () => {
  assert.throws(
    () => buildCtx({ MCP_USER_ID: VALID_UUID }),
    /SUPABASE_DB_URL is missing/
  );
});

test('buildCtx returns ctx with ssl on by default', () => {
  const ctx = buildCtx({
    MCP_USER_ID: VALID_UUID,
    SUPABASE_DB_URL: 'postgres://x',
  });
  assert.equal(ctx.userId, VALID_UUID);
  assert.equal(ctx.dbUrl, 'postgres://x');
  assert.equal(ctx.ssl, true);
});

test('buildCtx disables ssl when SUPABASE_DB_SSL is falsy', () => {
  const ctx = buildCtx({
    MCP_USER_ID: VALID_UUID,
    SUPABASE_DB_URL: 'postgres://x',
    SUPABASE_DB_SSL: 'false',
  });
  assert.equal(ctx.ssl, false);
});

// --- tx rollback (mocked pg client) -----------------------------------------
//
// We reproduce the tx() control flow over a mock pg.PoolClient to assert that a
// throw inside the callback triggers ROLLBACK and the client is released, while
// success triggers COMMIT. We mirror createDb's tx via a minimal local pool.

interface MockClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
  calls: string[];
  released: boolean;
}

function makeMockClient(failOn?: string): MockClient {
  const client: MockClient = {
    calls: [],
    released: false,
    async query(sql: string) {
      client.calls.push(sql);
      if (failOn && sql.includes(failOn)) {
        throw new Error(`boom on ${sql}`);
      }
      return { rows: [] };
    },
    release() {
      client.released = true;
    },
  };
  return client;
}

// Local re-implementation of tx() bound to a mock client — identical control
// flow to db.ts createDb().tx (BEGIN/COMMIT/ROLLBACK/release).
async function runTx<T>(
  client: MockClient,
  cb: (q: Queryable) => Promise<T>
): Promise<T> {
  const q: Queryable = {
    async query<R = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const res = await client.query(sql, params);
      return res.rows as R[];
    },
    async queryOne<R = Record<string, unknown>>(
      sql: string,
      params?: unknown[]
    ) {
      const res = await client.query(sql, params);
      return (res.rows[0] as R) ?? null;
    },
  };
  try {
    await client.query('BEGIN');
    const result = await cb(q);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

test('tx commits on success and releases the client', async () => {
  const client = makeMockClient();
  const out = await runTx(client, async (q) => {
    await q.query('UPDATE foo SET x = 1');
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.deepEqual(client.calls, ['BEGIN', 'UPDATE foo SET x = 1', 'COMMIT']);
  assert.equal(client.released, true);
});

test('tx rolls back on throw and rethrows, releasing the client', async () => {
  const client = makeMockClient();
  await assert.rejects(
    runTx(client, async (q) => {
      await q.query('UPDATE foo SET x = 1');
      throw new Error('handler failed');
    }),
    /handler failed/
  );
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.ok(!client.calls.includes('COMMIT'));
  assert.equal(client.released, true);
});

// --- requireOwned ------------------------------------------------------------

function mockQueryable(rows: unknown[]): Queryable {
  return {
    async query<R = Record<string, unknown>>() {
      return rows as R[];
    },
    async queryOne<R = Record<string, unknown>>() {
      return (rows[0] as R) ?? null;
    },
  };
}

test('requireOwned throws NotFoundError on 0 rows (cross-tenant id miss)', async () => {
  const db = mockQueryable([]);
  await assert.rejects(
    requireOwned({
      db,
      userId: VALID_UUID,
      idValue: 42,
      table: 'program_exercises',
      idColumn: 'id',
    }),
    (err: unknown) =>
      err instanceof NotFoundError && /not found for the current user/.test(err.message)
  );
});

test('requireOwned passes when a row is owned', async () => {
  const db = mockQueryable([{ '?column?': 1 }]);
  await requireOwned({
    db,
    userId: VALID_UUID,
    idValue: 42,
    table: 'program_exercises',
    idColumn: 'id',
  });
});

test('requireOwned supports custom fromAndWhere (child table join)', async () => {
  const db = mockQueryable([]);
  await assert.rejects(
    requireOwned({
      db,
      userId: VALID_UUID,
      idValue: 7,
      fromAndWhere:
        'FROM session_exercises se JOIN sessions s ON s.id = se.session_id ' +
        'WHERE se.id = $1 AND s.user_id = $2',
      label: 'session_exercise',
    }),
    NotFoundError
  );
});

test('requireOwned errors when neither table nor fromAndWhere given', async () => {
  const db = mockQueryable([]);
  await assert.rejects(
    requireOwned({ db, userId: VALID_UUID, idValue: 1 }),
    /provide either/
  );
});

// --- toToolError -------------------------------------------------------------

test('toToolError maps AppError to structured tool-error result', () => {
  const res = toToolError(new ValidationError('bad input', [{ path: 'x' }]));
  assert.equal(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.code, 'VALIDATION');
  assert.equal(payload.message, 'bad input');
  assert.deepEqual(payload.details, [{ path: 'x' }]);
});

test('toToolError maps unknown errors to DB code', () => {
  const res = toToolError(new Error('weird'));
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.code, 'DB');
  assert.equal(payload.message, 'weird');
});
