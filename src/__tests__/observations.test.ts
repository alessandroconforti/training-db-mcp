/**
 * observations.test.ts — T003 validation + query-shape tests for the
 * Observation store (Flusso 3): add_observation / reinforce_observation /
 * set_observation_status (write) and list_observations (read).
 *
 * A SpyDb records every (sql, params); no live DB. Focus:
 *   - add_observation INSERTs with defaults (low/pending/evidence_count=1),
 *     user_id from ctx (never input), parameterized.
 *   - strict zod rejects unknown keys (incl. user_id) + out-of-enum values +
 *     empty text as ValidationError (not DB error).
 *   - reinforce_observation increments evidence_count (+1), sets last_seen=now(),
 *     updates confidence only when passed (never lowers it), bump_evidence:false
 *     skips the increment; requireOwned; cross-tenant id => NotFound.
 *   - set_observation_status sets each valid status; out-of-enum rejected;
 *     requireOwned; cross-tenant => NotFound.
 *   - list_observations: CASE-based confidence rank (NOT ORDER BY confidence
 *     DESC); limit bounded (default 50, >200 rejected); default excludes
 *     superseded/discarded; kind/status filters applied; WHERE user_id bound.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Db, Queryable } from '../db.js';
import type { ToolCtx, AnyToolModule } from '../registry.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { writeObservationsTools } from '../tools/write_observations.js';
import { readContextTools } from '../tools/read_context.js';

const USER = '11111111-2222-3333-4444-555555555555';

type Responder = (sql: string, params: unknown[]) => unknown[];

function makeDb(responder: Responder): {
  db: Db;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const run = (sql: string, params: unknown[] = []): unknown[] => {
    calls.push({ sql, params });
    return responder(sql, params);
  };
  const q: Queryable = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return run(sql, params ?? []) as T[];
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return ((run(sql, params ?? [])[0] as T) ?? null) as T | null;
    },
  };
  const db: Db = {
    ...q,
    async tx<T>(cb: (c: Queryable) => Promise<T>) {
      return cb(q);
    },
    async end() {},
  };
  return { db, calls };
}

const ctxFor = (db: Db): ToolCtx => ({ userId: USER, db });

function byName(tools: AnyToolModule[], name: string): AnyToolModule {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} must exist`);
  return t!;
}

/** Parse via the tool's zod schema, then run handler (mirrors the registry). */
async function call(tool: AnyToolModule, input: unknown, db: Db): Promise<unknown> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('input validation failed', parsed.error.issues);
  }
  return tool.handler(parsed.data, ctxFor(db));
}

const isInsert = (sql: string) => /\bINSERT\b/.test(sql);
const isUpdate = (sql: string) => /\bUPDATE\b/.test(sql);
const isOwnershipSelect = (sql: string) =>
  /SELECT 1 FROM user_observations/.test(sql);

// ── add_observation ─────────────────────────────────────────────────────────

test('add_observation: INSERT with defaults (low/pending/evidence_count=1), bound user, parameterized', async () => {
  const { db, calls } = makeDb((sql) => (isInsert(sql) ? [{ id: 42 }] : []));
  const tool = byName(writeObservationsTools, 'add_observation');
  const res = await call(
    tool,
    { kind: 'lifestyle', text: 'Lavora di notte' },
    db
  );

  assert.deepEqual(res, { observation_id: 42 });
  assert.equal(calls.length, 1, 'exactly one statement');
  const { sql, params } = calls[0];
  assert.ok(isInsert(sql), 'must be an INSERT');
  assert.match(sql, /INSERT INTO user_observations/);
  assert.match(sql, /RETURNING id/);
  // defaults baked into SQL: evidence_count 1, status 'pending'
  assert.match(sql, /VALUES \(\$1, \$2, \$3, \$4, 1, 'pending', \$5, \$6\)/);
  // user_id from ctx is the FIRST param; confidence defaults to 'low'.
  assert.equal(params[0], USER, 'user_id is ctx-bound, first param');
  assert.equal(params[1], 'lifestyle');
  assert.equal(params[2], 'Lavora di notte');
  assert.equal(params[3], 'low', 'confidence default low');
  assert.equal(params[4], null, 'source_conversation_id default null');
  assert.equal(params[5], null, 'metadata default null');
});

test('add_observation: confidence + source_conversation_id + metadata passed through', async () => {
  const { db, calls } = makeDb((sql) => (isInsert(sql) ? [{ id: 7 }] : []));
  const tool = byName(writeObservationsTools, 'add_observation');
  const conv = '99999999-8888-7777-6666-555555555555';
  await call(
    tool,
    {
      kind: 'goal_hypothesis',
      text: 'Vuole perdere 5kg',
      confidence: 'high',
      source_conversation_id: conv,
      metadata: { topic: 'cut' },
    },
    db
  );
  const { params } = calls[0];
  assert.equal(params[3], 'high');
  assert.equal(params[4], conv);
  assert.deepEqual(params[5], { topic: 'cut' });
});

test('add_observation: user_id param rejected (server-bound only)', async () => {
  const tool = byName(writeObservationsTools, 'add_observation');
  assert.equal(
    tool.inputSchema.safeParse({
      user_id: USER,
      kind: 'lifestyle',
      text: 'x',
    }).success,
    false,
    'top-level user_id must be rejected (strict)'
  );
});

test('add_observation: unknown key rejected (strict)', async () => {
  const tool = byName(writeObservationsTools, 'add_observation');
  assert.equal(
    tool.inputSchema.safeParse({
      kind: 'lifestyle',
      text: 'x',
      foo: 'bar',
    }).success,
    false
  );
});

test('add_observation: out-of-enum kind => ValidationError, no DB call', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(writeObservationsTools, 'add_observation');
  await assert.rejects(
    () => call(tool, { kind: 'random_thing', text: 'x' }, db),
    ValidationError
  );
  assert.equal(calls.length, 0, 'no INSERT on validation failure');
});

test('add_observation: out-of-enum confidence => ValidationError', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(writeObservationsTools, 'add_observation');
  await assert.rejects(
    () => call(tool, { kind: 'lifestyle', text: 'x', confidence: 'certain' }, db),
    ValidationError
  );
});

test('add_observation: empty text => ValidationError', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(writeObservationsTools, 'add_observation');
  await assert.rejects(
    () => call(tool, { kind: 'lifestyle', text: '' }, db),
    ValidationError
  );
  assert.equal(calls.length, 0);
});

// ── reinforce_observation ─────────────────────────────────────────────────────

test('reinforce_observation: increments evidence_count, last_seen=now(), requireOwned first', async () => {
  const { db, calls } = makeDb((sql) =>
    isOwnershipSelect(sql)
      ? [{ '?column?': 1 }]
      : isUpdate(sql)
      ? [{ evidence_count: 4 }]
      : []
  );
  const tool = byName(writeObservationsTools, 'reinforce_observation');
  const res = await call(tool, { id: 10 }, db);

  assert.deepEqual(res, { observation_id: 10, evidence_count: 4 });
  // first call is the ownership SELECT, second is the UPDATE.
  assert.equal(calls.length, 2);
  assert.ok(isOwnershipSelect(calls[0].sql), 'requireOwned runs first');
  assert.deepEqual(calls[0].params, [10, USER]);

  const { sql, params } = calls[1];
  assert.ok(isUpdate(sql), 'second statement is the UPDATE');
  assert.match(sql, /UPDATE user_observations SET/);
  assert.match(sql, /last_seen = now\(\)/);
  assert.match(sql, /evidence_count = evidence_count \+ 1/);
  assert.match(sql, /WHERE id = \$\d+ AND user_id = \$\d+/);
  assert.match(sql, /RETURNING evidence_count/);
  // confidence NOT touched when omitted.
  assert.ok(!/confidence/.test(sql), 'confidence must not be set when omitted');
  // last two params: id then ctx user_id.
  assert.deepEqual(params, [10, USER]);
});

test('reinforce_observation: confidence updated only when passed (never lowered when omitted)', async () => {
  const { db, calls } = makeDb((sql) =>
    isOwnershipSelect(sql)
      ? [{ '?column?': 1 }]
      : isUpdate(sql)
      ? [{ evidence_count: 2 }]
      : []
  );
  const tool = byName(writeObservationsTools, 'reinforce_observation');
  await call(tool, { id: 5, confidence: 'high' }, db);
  const { sql, params } = calls[1];
  assert.match(sql, /confidence = \$1/);
  assert.equal(params[0], 'high', 'confidence value parameterized');
  assert.deepEqual(params, ['high', 5, USER]);
});

test('reinforce_observation: bump_evidence:false skips the increment', async () => {
  const { db, calls } = makeDb((sql) =>
    isOwnershipSelect(sql)
      ? [{ '?column?': 1 }]
      : isUpdate(sql)
      ? [{ evidence_count: 1 }]
      : []
  );
  const tool = byName(writeObservationsTools, 'reinforce_observation');
  await call(tool, { id: 9, bump_evidence: false }, db);
  const { sql } = calls[1];
  assert.ok(
    !/evidence_count = evidence_count \+ 1/.test(sql),
    'no increment when bump_evidence:false'
  );
  assert.match(sql, /last_seen = now\(\)/, 'last_seen still updated');
});

test('reinforce_observation: cross-tenant id (0-row ownership) => NotFound, no UPDATE', async () => {
  const { db, calls } = makeDb(() => []); // ownership SELECT returns 0 rows
  const tool = byName(writeObservationsTools, 'reinforce_observation');
  await assert.rejects(() => call(tool, { id: 123 }, db), NotFoundError);
  assert.equal(calls.length, 1, 'only the ownership SELECT ran');
  assert.ok(isOwnershipSelect(calls[0].sql));
});

test('reinforce_observation: out-of-enum confidence => ValidationError', async () => {
  const { db } = makeDb(() => [{ '?column?': 1 }]);
  const tool = byName(writeObservationsTools, 'reinforce_observation');
  await assert.rejects(
    () => call(tool, { id: 1, confidence: 'nope' }, db),
    ValidationError
  );
});

test('reinforce_observation: user_id / unknown key rejected (strict)', async () => {
  const tool = byName(writeObservationsTools, 'reinforce_observation');
  assert.equal(
    tool.inputSchema.safeParse({ id: 1, user_id: USER }).success,
    false
  );
  assert.equal(
    tool.inputSchema.safeParse({ id: 1, foo: true }).success,
    false
  );
});

// ── set_observation_status ─────────────────────────────────────────────────────

for (const status of ['pending', 'promoted', 'superseded', 'discarded'] as const) {
  test(`set_observation_status: ${status} sets status, requireOwned first`, async () => {
    const { db, calls } = makeDb((sql) =>
      isOwnershipSelect(sql) ? [{ '?column?': 1 }] : []
    );
    const tool = byName(writeObservationsTools, 'set_observation_status');
    const res = await call(tool, { id: 3, status }, db);

    assert.deepEqual(res, { observation_id: 3, status });
    assert.equal(calls.length, 2);
    assert.ok(isOwnershipSelect(calls[0].sql), 'requireOwned first');
    assert.deepEqual(calls[0].params, [3, USER]);
    const { sql, params } = calls[1];
    assert.match(sql, /UPDATE user_observations/);
    assert.match(sql, /SET status = \$1, updated_at = now\(\)/);
    assert.match(sql, /WHERE id = \$2 AND user_id = \$3/);
    assert.deepEqual(params, [status, 3, USER]);
  });
}

test('set_observation_status: out-of-enum status => ValidationError, no DB call', async () => {
  const { db, calls } = makeDb(() => [{ '?column?': 1 }]);
  const tool = byName(writeObservationsTools, 'set_observation_status');
  await assert.rejects(
    () => call(tool, { id: 1, status: 'archived' }, db),
    ValidationError
  );
  assert.equal(calls.length, 0);
});

test('set_observation_status: cross-tenant id => NotFound, no UPDATE', async () => {
  const { db, calls } = makeDb(() => []); // ownership returns 0 rows
  const tool = byName(writeObservationsTools, 'set_observation_status');
  await assert.rejects(
    () => call(tool, { id: 77, status: 'promoted' }, db),
    NotFoundError
  );
  assert.equal(calls.length, 1, 'only ownership SELECT ran');
});

test('set_observation_status: user_id / unknown key rejected (strict)', async () => {
  const tool = byName(writeObservationsTools, 'set_observation_status');
  assert.equal(
    tool.inputSchema.safeParse({ id: 1, status: 'pending', user_id: USER }).success,
    false
  );
});

// ── list_observations ─────────────────────────────────────────────────────────

test('list_observations: CASE-based confidence rank (NOT alphabetical confidence DESC), bound user, default limit 50, excludes superseded/discarded', async () => {
  const { db, calls } = makeDb(() => [{ id: 1 }]);
  const tool = byName(readContextTools, 'list_observations');
  await call(tool, {}, db);

  assert.equal(calls.length, 1);
  const { sql, params } = calls[0];
  assert.match(sql, /FROM user_observations/);
  assert.match(sql, /WHERE user_id = \$1/, 'user_id bound');
  // confidence ranking is CASE-based, not ORDER BY confidence DESC.
  assert.match(
    sql,
    /CASE confidence\s+WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC/
  );
  assert.ok(
    !/ORDER BY confidence DESC/.test(sql),
    'must NOT order alphabetically by confidence'
  );
  assert.match(sql, /last_seen DESC/);
  // default excludes superseded + discarded when no status filter.
  assert.match(sql, /status NOT IN \('superseded', 'discarded'\)/);
  // default limit 50.
  assert.equal(params[0], USER);
  assert.equal(params[3], 50, 'default limit 50');
});

test('list_observations: kind + status filters parameterized', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(readContextTools, 'list_observations');
  await call(tool, { kind: 'training_behavior', status: 'promoted', limit: 10 }, db);
  const { params } = calls[0];
  assert.equal(params[0], USER);
  assert.equal(params[1], 'training_behavior');
  assert.equal(params[2], 'promoted');
  assert.equal(params[3], 10);
});

test('list_observations: status filter overrides the default superseded/discarded exclusion', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(readContextTools, 'list_observations');
  await call(tool, { status: 'discarded' }, db);
  const { sql, params } = calls[0];
  // the exclusion is gated by ($3 IS NOT NULL OR ...), so a status filter bypasses it.
  assert.match(sql, /\$3::text IS NOT NULL\s+OR status NOT IN/);
  assert.equal(params[2], 'discarded');
});

test('list_observations: limit > 200 => ValidationError', async () => {
  const tool = byName(readContextTools, 'list_observations');
  assert.equal(tool.inputSchema.safeParse({ limit: 201 }).success, false);
  assert.equal(tool.inputSchema.safeParse({ limit: 0 }).success, false);
  assert.equal(tool.inputSchema.safeParse({ limit: 200 }).success, true);
});

test('list_observations: out-of-enum kind/status + user_id rejected (strict)', async () => {
  const tool = byName(readContextTools, 'list_observations');
  assert.equal(tool.inputSchema.safeParse({ kind: 'nope' }).success, false);
  assert.equal(tool.inputSchema.safeParse({ status: 'nope' }).success, false);
  assert.equal(tool.inputSchema.safeParse({ user_id: USER }).success, false);
});
