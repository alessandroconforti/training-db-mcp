/**
 * intake.test.ts — T002 validation + query-shape tests for set_intake_profile.
 *
 * A SpyDb records every (sql, params); no live DB. The focus: (1) the happy path
 * emits a single UPDATE of the whitelisted columns, parameterized, with the bound
 * user_id in the WHERE clause and food_restrictions passed as a RAW JS array
 * (never JSON.stringify'd); (2) the strict zod schema rejects unknown keys
 * (including user_id) loudly; (3) out-of-bound enum/number/date values are clean
 * ValidationErrors, not DB errors; (4) user_id is server-bound from ctx, never
 * input; (5) an empty fields object is rejected; (6) an UPDATE of 0 rows => NotFound.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Db, Queryable } from '../db.js';
import type { ToolCtx, AnyToolModule } from '../registry.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { writeProfileGoalsTools, INTAKE_WHITELIST } from '../tools/write_profile_goals.js';

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

const isUpdate = (sql: string) => /\bUPDATE\b/.test(sql);
const okRow = () => [{ user_id: USER }];

// ── happy path ────────────────────────────────────────────────────────────────

test('set_intake_profile: single UPDATE of whitelisted cols, parameterized, bound user', async () => {
  const { db, calls } = makeDb((sql) => (isUpdate(sql) ? okRow() : []));
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  const res = await call(
    tool,
    {
      fields: {
        display_name: 'Jordan',
        sex: 'male',
        birth_date: '1990-01-15',
        height_cm: 180,
        work_activity: 'office_sedentary',
        training_days_per_week: 4,
        main_goal: 'recomp',
        diet_style: 'mediterranean',
        food_restrictions: ['lactose', 'shellfish'],
      },
    },
    db
  );

  // returns { updated:true, fields:<provided keys> }
  assert.deepEqual(res, {
    updated: true,
    fields: [
      'display_name',
      'sex',
      'birth_date',
      'height_cm',
      'work_activity',
      'training_days_per_week',
      'main_goal',
      'diet_style',
      'food_restrictions',
    ],
  });

  // exactly ONE statement, an UPDATE.
  assert.equal(calls.length, 1, 'exactly one statement must run');
  const { sql, params } = calls[0];
  assert.ok(isUpdate(sql), 'the statement must be an UPDATE');
  assert.ok(!/\bINSERT\b/.test(sql), 'no INSERT (UPSERT is UPDATE-only here)');

  // single UPDATE user_profiles SET ... WHERE user_id = $N RETURNING user_id
  assert.match(sql, /UPDATE user_profiles SET/);
  assert.match(sql, /WHERE user_id = \$(\d+)/);
  assert.match(sql, /RETURNING user_id/);

  // column names come ONLY from the whitelist.
  const setClause = sql.slice(sql.indexOf('SET'), sql.indexOf('WHERE'));
  const columns = [...setClause.matchAll(/(\w+)\s*=\s*\$\d+/g)].map((m) => m[1]);
  assert.equal(columns.length, 9);
  for (const col of columns) {
    assert.ok(
      (INTAKE_WHITELIST as readonly string[]).includes(col),
      `column ${col} must be in INTAKE_WHITELIST`
    );
  }

  // values are parameterized in order; user_id bound LAST from ctx.
  assert.equal(params.length, 10, '9 field values + bound user_id');
  assert.deepEqual(params.slice(0, 9), [
    'Jordan',
    'male',
    '1990-01-15',
    180,
    'office_sedentary',
    4,
    'recomp',
    'mediterranean',
    ['lactose', 'shellfish'],
  ]);
  assert.equal(params[9], USER, 'last param is the ctx-bound user_id');

  // food_restrictions is a RAW JS array, NOT JSON.stringified.
  const fr = params[8];
  assert.ok(Array.isArray(fr), 'food_restrictions must be a raw JS array');
  assert.deepEqual(fr, ['lactose', 'shellfish']);
});

test('set_intake_profile: partial fields => only those columns in SET', async () => {
  const { db, calls } = makeDb((sql) => (isUpdate(sql) ? okRow() : []));
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  const res = await call(tool, { fields: { height_cm: 175 } }, db);

  assert.deepEqual(res, { updated: true, fields: ['height_cm'] });
  const { sql, params } = calls[0];
  const setClause = sql.slice(sql.indexOf('SET'), sql.indexOf('WHERE'));
  const columns = [...setClause.matchAll(/(\w+)\s*=\s*\$\d+/g)].map((m) => m[1]);
  assert.deepEqual(columns, ['height_cm']);
  assert.deepEqual(params, [175, USER]);
});

// ── reject unknown keys (strict schema) ─────────────────────────────────────────

test('set_intake_profile: unknown field outside intake set => ValidationError', async () => {
  const { db, calls } = makeDb(() => okRow());
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  await assert.rejects(
    () => call(tool, { fields: { weight_kg: 80 } }, db),
    ValidationError
  );
  assert.equal(calls.length, 0, 'no UPDATE may run on validation failure');
});

test('set_intake_profile: anagrafica-shaped but unknown key => ValidationError', async () => {
  const { db } = makeDb(() => okRow());
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  // review_week_start_dow belongs to update_profile_fields, not this tool.
  await assert.rejects(
    () => call(tool, { fields: { review_week_start_dow: 3 } }, db),
    ValidationError
  );
});

test('set_intake_profile: a user_id param is rejected (server-bound only)', async () => {
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  // user_id at the top level (strict outer object).
  assert.equal(
    tool.inputSchema.safeParse({ user_id: USER, fields: { height_cm: 180 } }).success,
    false,
    'top-level user_id must be rejected (strict)'
  );
  // user_id smuggled inside fields (strict inner object).
  assert.equal(
    tool.inputSchema.safeParse({ fields: { user_id: USER, height_cm: 180 } }).success,
    false,
    'user_id inside fields must be rejected (strict)'
  );
});

// ── reject out-of-bound values ───────────────────────────────────────────────────

test('set_intake_profile: height_cm out of 80..250 => ValidationError', async () => {
  const { db } = makeDb(() => okRow());
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  await assert.rejects(() => call(tool, { fields: { height_cm: 79 } }, db), ValidationError);
  await assert.rejects(() => call(tool, { fields: { height_cm: 251 } }, db), ValidationError);
});

test('set_intake_profile: birth_date in the future => ValidationError', async () => {
  const { db } = makeDb(() => okRow());
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365)
    .toISOString()
    .slice(0, 10);
  await assert.rejects(
    () => call(tool, { fields: { birth_date: future } }, db),
    ValidationError
  );
});

test('set_intake_profile: sex not in enum => ValidationError', async () => {
  const { db } = makeDb(() => okRow());
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  await assert.rejects(
    () => call(tool, { fields: { sex: 'other' } }, db),
    ValidationError
  );
});

test('set_intake_profile: diet_style not in the 8-value enum => ValidationError', async () => {
  const { db } = makeDb(() => okRow());
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  await assert.rejects(
    () => call(tool, { fields: { diet_style: 'carnivore' } }, db),
    ValidationError
  );
});

test('set_intake_profile: training_days_per_week > 14 or non-int => ValidationError', async () => {
  const { db } = makeDb(() => okRow());
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  await assert.rejects(
    () => call(tool, { fields: { training_days_per_week: 15 } }, db),
    ValidationError
  );
  await assert.rejects(
    () => call(tool, { fields: { training_days_per_week: -1 } }, db),
    ValidationError
  );
  await assert.rejects(
    () => call(tool, { fields: { training_days_per_week: 3.5 } }, db),
    ValidationError
  );
});

test('set_intake_profile: work_activity / main_goal out-of-enum => ValidationError', async () => {
  const { db } = makeDb(() => okRow());
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  await assert.rejects(
    () => call(tool, { fields: { work_activity: 'astronaut' } }, db),
    ValidationError
  );
  await assert.rejects(
    () => call(tool, { fields: { main_goal: 'bulk' } }, db),
    ValidationError
  );
});

// ── tenant isolation ─────────────────────────────────────────────────────────────

test('set_intake_profile: WHERE clause binds ctx.userId, never an input value', async () => {
  const { db, calls } = makeDb((sql) => (isUpdate(sql) ? okRow() : []));
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  await call(tool, { fields: { display_name: 'X' } }, db);
  const { sql, params } = calls[0];
  // user_id appears ONLY in the WHERE clause, bound to the last param = ctx.userId.
  const whereMatch = sql.match(/WHERE user_id = \$(\d+)/);
  assert.ok(whereMatch, 'WHERE must bind user_id to a param');
  const idx = Number(whereMatch![1]) - 1;
  assert.equal(params[idx], USER, 'the WHERE user_id param must equal ctx.userId');
  assert.ok(!sql.includes('user_id ='.repeat(2)), 'user_id is not also a SET column');
});

// ── at least one field required ──────────────────────────────────────────────────

test('set_intake_profile: empty fields object => ValidationError', async () => {
  const { db, calls } = makeDb(() => okRow());
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  await assert.rejects(() => call(tool, { fields: {} }, db), ValidationError);
  assert.equal(calls.length, 0, 'no UPDATE may run when no field is provided');
});

// ── NotFound ─────────────────────────────────────────────────────────────────────

test('set_intake_profile: UPDATE affects 0 rows => NotFound', async () => {
  const { db } = makeDb(() => []); // row does not exist
  const tool = byName(writeProfileGoalsTools, 'set_intake_profile');
  await assert.rejects(
    () => call(tool, { fields: { display_name: 'Ghost' } }, db),
    NotFoundError
  );
});
