/**
 * write_session_log.test.ts — Phase 4 (T012) regression for the user_id INSERT fix.
 *
 * SECURITY REGRESSION (ISSUE-1): log_session_exercise must stamp user_id from ctx
 * on the session_exercises INSERT. session_exercises is a per-user table
 * (user_id uuid NOT NULL); every read filters se.user_id. Omitting it either
 * fails the NOT NULL constraint or writes an unattributable, read-invisible row.
 *
 * A SpyDb records every (sql, params); no live DB. The focus:
 *   (1) requireOwned runs BEFORE the INSERT,
 *   (2) the INSERT includes a user_id column bound to ctx.userId (the FIRST col),
 *   (3) cross-tenant session_id => NotFound and NO INSERT issued,
 *   (4) total_reps is denormalized = sum(reps_array).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Db, Queryable } from '../db.js';
import type { ToolCtx, AnyToolModule } from '../registry.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { writeSessionLogTools } from '../tools/write_session_log.js';

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

async function call(tool: AnyToolModule, input: unknown, db: Db): Promise<unknown> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('input validation failed', parsed.error.issues);
  }
  return tool.handler(parsed.data, ctxFor(db));
}

const isOwnershipSelect = (sql: string) =>
  sql.includes('SELECT 1') && !sql.includes('INSERT');
const isInsert = (sql: string) => /INSERT INTO session_exercises/.test(sql);

// ── no tool exposes user_id ───────────────────────────────────────────────────

test('no session-log tool accepts a user_id parameter', () => {
  for (const t of writeSessionLogTools) {
    const r = t.inputSchema.safeParse({ user_id: USER });
    assert.equal(r.success, false, `tool ${t.name} must reject user_id (strict)`);
  }
});

// ── ISSUE-1 regression ────────────────────────────────────────────────────────

test('log_session_exercise: INSERT stamps user_id = ctx.userId as the first column', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isOwnershipSelect(sql)) return [{ '?column?': 1 }];
    if (isInsert(sql)) return [{ id: 77 }];
    return [];
  });
  const tool = byName(writeSessionLogTools, 'log_session_exercise');
  const res = await call(
    tool,
    {
      session_id: 3,
      exercise_id: 5,
      order_num: 0,
      weight_array: [80],
      reps_array: [8, 7, 6],
      rpe: 8,
      notes_text: 'ok',
      linked_program_exercise_id: 11,
    },
    db
  );

  // total_reps denormalized = 8+7+6.
  assert.deepEqual(res, { session_exercise_id: 77, total_reps: 21 });

  // ordering: ownership SELECT first, INSERT second.
  assert.ok(isOwnershipSelect(calls[0].sql), 'first call must be ownership check');
  const insert = calls.find((c) => isInsert(c.sql));
  assert.ok(insert, 'an INSERT must be issued');

  // INSERT lists user_id as the FIRST inserted column.
  assert.match(
    insert!.sql,
    /INSERT INTO session_exercises\s*\(\s*user_id\b/,
    'user_id must be the first inserted column'
  );
  // user_id is bound to ctx.userId as $1 (first param).
  assert.equal(insert!.params[0], USER, 'first INSERT param must be ctx.userId');
  // Full bound param order matches the column list.
  assert.deepEqual(insert!.params, [
    USER,
    3, // session_id
    5, // exercise_id
    0, // order_num
    [80], // weight_array
    [8, 7, 6], // reps_array
    21, // total_reps
    8, // rpe
    'ok', // notes_text
    11, // linked_program_exercise_id
  ]);
});

test('log_session_exercise: requireOwned BEFORE insert; cross-tenant session_id => NotFound, NO insert', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isOwnershipSelect(sql)) return []; // not owned
    return [{ id: 77 }];
  });
  const tool = byName(writeSessionLogTools, 'log_session_exercise');
  await assert.rejects(
    () => call(tool, { session_id: 999, exercise_id: 5, order_num: 0 }, db),
    NotFoundError
  );
  assert.equal(calls.length, 1, 'only the ownership SELECT must have run');
  assert.ok(!calls.some((c) => isInsert(c.sql)), 'no INSERT may be issued');
});

test('log_session_exercise: null reps_array => total_reps null, user_id still stamped', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isOwnershipSelect(sql)) return [{ '?column?': 1 }];
    if (isInsert(sql)) return [{ id: 5 }];
    return [];
  });
  const tool = byName(writeSessionLogTools, 'log_session_exercise');
  const res = await call(tool, { session_id: 3, exercise_id: 5, order_num: 0 }, db);
  assert.deepEqual(res, { session_exercise_id: 5, total_reps: null });
  const insert = calls.find((c) => isInsert(c.sql))!;
  assert.equal(insert.params[0], USER);
  assert.equal(insert.params[6], null, 'total_reps must be null');
});
