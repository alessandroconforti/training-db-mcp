/**
 * write_daily.test.ts — Phase 4 (T012-T016) tests.
 *
 * A SpyDb routes SQL by substring to canned rows and records every call. tx()
 * runs the callback on the same Queryable; if the callback throws, tx rethrows
 * (rollback = error propagation). No live DB.
 *
 * Coverage focus:
 *   - log_session: enrich existing sleep-only row (UPDATE, no double row) vs INSERT
 *   - log_session_exercise: total_reps = sum(reps_array); cross-tenant NotFound
 *   - log_daily_metrics: second same-day weight => ConflictError (PK 23505 map);
 *     sleep-only => sessions enrich, no weight_log touch
 *   - log_food_entry: 7 snapshot macros copied; missing food => NotFound
 *   - set_nutrition_day_ai_comment: clear allowed only if user_comment exists
 *   - delete_session: tx deletes child session_exercises BEFORE the session
 *   - update_session_exercise: total_reps recomputed when reps_array changes
 *   - cross-tenant ids => NotFound, zero writes
 *   - no tool accepts user_id
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Db, Queryable } from '../db.js';
import type { ToolCtx, AnyToolModule } from '../registry.js';
import { NotFoundError, ConflictError, ValidationError } from '../errors.js';
import { writeSessionLogTools } from '../tools/write_session_log.js';
import { writeDailyMetricsTools } from '../tools/write_daily_metrics.js';
import { writeNutritionTools } from '../tools/write_nutrition.js';
import { writeProblemsTools } from '../tools/write_problems.js';
import { writeCorrectionsTools } from '../tools/write_corrections.js';
import { writeCatalogTools } from '../tools/write_catalog.js';

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

const has = (s: string, ...frags: string[]) => frags.every((f) => s.includes(f));
const isInsertInto = (sql: string, table: string) => has(sql, 'INSERT INTO', table);

const ALL_TOOLS = [
  ...writeSessionLogTools,
  ...writeDailyMetricsTools,
  ...writeNutritionTools,
  ...writeProblemsTools,
  ...writeCorrectionsTools,
];

// ── no tool accepts user_id ───────────────────────────────────────────────────

test('no Phase-4 tool accepts a user_id parameter', () => {
  for (const t of ALL_TOOLS) {
    const r = t.inputSchema.safeParse({ user_id: USER });
    assert.equal(r.success, false, `tool ${t.name} must reject user_id (strict)`);
  }
});

// ── log_session: enrich existing sleep-only row ───────────────────────────────

test('log_session: existing sleep-only row for date => UPDATE (no second INSERT)', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT id FROM sessions')) return [{ id: 55 }];
    return [];
  });
  const tool = byName(writeSessionLogTools, 'log_session');
  const res = (await call(
    tool,
    { date: '2026-05-22', day_type: 'push', duration_min: 60, condition: 'good' },
    db
  )) as { session_id: number; created: boolean };

  assert.equal(res.session_id, 55);
  assert.equal(res.created, false);
  // UPDATE, not INSERT
  assert.ok(calls.some((c) => has(c.sql, 'UPDATE sessions')));
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'sessions')));
});

test('log_session: no existing row => INSERT a new session', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT id FROM sessions')) return [];
    if (isInsertInto(sql, 'sessions')) return [{ id: 88 }];
    return [];
  });
  const tool = byName(writeSessionLogTools, 'log_session');
  const res = (await call(
    tool,
    { date: '2026-05-22', sleep_h: 7.5 },
    db
  )) as { session_id: number; created: boolean };

  assert.equal(res.session_id, 88);
  assert.equal(res.created, true);
  const ins = calls.find((c) => isInsertInto(c.sql, 'sessions'))!;
  // duration_min defaults to 0 for a sleep-only INSERT
  assert.ok(ins.sql.includes('duration_min'));
});

// ── log_session_exercise: total_reps + ownership ──────────────────────────────

test('log_session_exercise: total_reps = sum(reps_array)', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM sessions')) return [{ '?column?': 1 }];
    // exercise_id catalog accessibility check (FIX 2): exercise exists/owned.
    if (has(sql, 'SELECT 1 FROM exercises')) return [{ '?column?': 1 }];
    if (isInsertInto(sql, 'session_exercises')) return [{ id: 12 }];
    return [];
  });
  const tool = byName(writeSessionLogTools, 'log_session_exercise');
  const res = (await call(
    tool,
    {
      session_id: 55,
      exercise_id: 100,
      order_num: 1,
      weight_array: [80, 80, 75],
      reps_array: [8, 8, 7],
    },
    db
  )) as { session_exercise_id: number; total_reps: number };

  assert.equal(res.total_reps, 23);
  const ins = calls.find((c) => isInsertInto(c.sql, 'session_exercises'))!;
  // Column order: user_id, session_id, exercise_id, order_num, weight_array,
  // reps_array, total_reps, ... (user_id stamped first — ISSUE-1 fix).
  assert.equal(ins.params[0], USER); // user_id param (security fix)
  assert.equal(ins.params[6], 23); // total_reps param
  assert.deepEqual(ins.params[4], [80, 80, 75]); // weight_array
});

test('log_session_exercise: cross-tenant session_id => NotFound, zero writes', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM sessions')) return []; // not owned
    return [];
  });
  const tool = byName(writeSessionLogTools, 'log_session_exercise');
  await assert.rejects(
    () => call(tool, { session_id: 999, exercise_id: 1, order_num: 0 }, db),
    NotFoundError
  );
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'session_exercises')));
});

test('log_session_exercise: non-accessible exercise_id => ValidationError, zero writes (FIX 2)', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM sessions')) return [{ '?column?': 1 }]; // owned
    if (has(sql, 'SELECT 1 FROM exercises')) return []; // not in catalog
    return [];
  });
  const tool = byName(writeSessionLogTools, 'log_session_exercise');
  await assert.rejects(
    () => call(tool, { session_id: 55, exercise_id: 4242, order_num: 0 }, db),
    ValidationError
  );
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'session_exercises')));
});

test('log_session_exercise: cross-tenant linked_program_exercise_id => NotFound, zero writes (FIX 1)', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM sessions')) return [{ '?column?': 1 }]; // owned
    if (has(sql, 'SELECT 1 FROM exercises')) return [{ '?column?': 1 }]; // catalog ok
    if (has(sql, 'SELECT 1 FROM program_exercises')) return []; // not owned
    return [];
  });
  const tool = byName(writeSessionLogTools, 'log_session_exercise');
  await assert.rejects(
    () =>
      call(
        tool,
        {
          session_id: 55,
          exercise_id: 100,
          order_num: 0,
          linked_program_exercise_id: 9999,
        },
        db
      ),
    NotFoundError
  );
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'session_exercises')));
});

// ── log_daily_metrics: PK conflict mapping ────────────────────────────────────

test('log_daily_metrics: second same-day weight => ConflictError naming the date', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isInsertInto(sql, 'weight_log')) {
      const e = new Error('duplicate key value violates unique constraint "weight_log_pkey"');
      (e as unknown as { code: string }).code = '23505';
      throw e;
    }
    if (has(sql, 'SELECT weight_kg FROM weight_log')) return [{ weight_kg: 78.3 }];
    return [];
  });
  const tool = byName(writeDailyMetricsTools, 'log_daily_metrics');
  await assert.rejects(
    () => call(tool, { date: '2026-04-24', weight_kg: 79 }, db),
    (err: unknown) => {
      assert.ok(err instanceof ConflictError);
      assert.match((err as Error).message, /2026-04-24/);
      assert.match((err as Error).message, /78\.3 kg/);
      return true;
    }
  );
  // no sessions write happened
  assert.ok(!calls.some((c) => has(c.sql, 'sessions')));
});

test('log_daily_metrics: sleep_h only => sessions enrich, no weight_log touch', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT id FROM sessions')) return [{ id: 7 }];
    return [];
  });
  const tool = byName(writeDailyMetricsTools, 'log_daily_metrics');
  const res = (await call(tool, { date: '2026-05-22', sleep_h: 8 }, db)) as {
    weight_logged: boolean;
    session_id: number;
  };
  assert.equal(res.weight_logged, false);
  assert.equal(res.session_id, 7);
  assert.ok(!calls.some((c) => has(c.sql, 'weight_log')));
  assert.ok(calls.some((c) => has(c.sql, 'UPDATE sessions')));
});

test('log_daily_metrics: weight_kg only => weight_log INSERT, no sessions touch', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isInsertInto(sql, 'weight_log')) return [];
    return [];
  });
  const tool = byName(writeDailyMetricsTools, 'log_daily_metrics');
  const res = (await call(tool, { date: '2026-05-22', weight_kg: 79 }, db)) as {
    weight_logged: boolean;
  };
  assert.equal(res.weight_logged, true);
  assert.ok(!calls.some((c) => has(c.sql, 'sessions')));
});

// ── log_food_entry: snapshot copy ─────────────────────────────────────────────

/** A g/ml/pz food row, overridable for the dual-unit cases. */
function foodRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    canonical_name: 'Yogurt Greco',
    unit: 'g',
    reference_qty: 100,
    kcal: 59,
    protein_g: 10,
    carbs_g: 3.6,
    fat_g: 0.4,
    grams_per_piece: null,
    ...over,
  };
}

test('log_food_entry: copies the snapshot columns from foods (g default)', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM foods')) return [foodRow()];
    if (isInsertInto(sql, 'food_entries')) return [{ id: 33 }];
    return [];
  });
  const tool = byName(writeNutritionTools, 'log_food_entry');
  const res = (await call(
    tool,
    { date: '2026-05-22', meal: 'colazione', food_id: 5, quantity: 200 },
    db
  )) as { food_entry_id: number };

  assert.equal(res.food_entry_id, 33);
  const ins = calls.find((c) => isInsertInto(c.sql, 'food_entries'))!;
  // params: user, date, meal, food_id, quantity, name, unit, ref_qty, kcal, p, c, f,
  //         entry_unit, grams_per_piece_snapshot, notes
  assert.equal(ins.params[5], 'Yogurt Greco');
  assert.equal(ins.params[6], 'g');
  assert.equal(ins.params[7], 100);
  assert.equal(ins.params[8], 59);
  assert.equal(ins.params[9], 10);
  assert.equal(ins.params[10], 3.6);
  assert.equal(ins.params[11], 0.4);
  // entry_unit defaults to the food's base unit (g); gpp snapshot null for g/ml.
  assert.equal(ins.params[12], 'g');
  assert.equal(ins.params[13], null);
  // quantity stored RAW (not pre-converted).
  assert.equal(ins.params[4], 200);
});

test('log_food_entry: missing/cross-tenant food => NotFound, zero writes', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM foods')) return [];
    return [];
  });
  const tool = byName(writeNutritionTools, 'log_food_entry');
  await assert.rejects(
    () => call(tool, { date: '2026-05-22', meal: 'cena', food_id: 999, quantity: 1 }, db),
    NotFoundError
  );
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'food_entries')));
});

// ── log_food_entry: dual-unit Case A/B/C ──────────────────────────────────────

test('log_food_entry Case A: pz + grams_per_piece => snapshot gpp, quantity raw', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM foods')) return [foodRow({ unit: 'g', grams_per_piece: 125 })];
    if (isInsertInto(sql, 'food_entries')) return [{ id: 40 }];
    return [];
  });
  const tool = byName(writeNutritionTools, 'log_food_entry');
  await call(
    tool,
    { date: '2026-05-22', meal: 'snack', food_id: 5, quantity: 2, entry_unit: 'pz' },
    db
  );
  const ins = calls.find((c) => isInsertInto(c.sql, 'food_entries'))!;
  assert.equal(ins.params[12], 'pz'); // entry_unit
  assert.equal(ins.params[13], 125); // grams_per_piece_snapshot
  assert.equal(ins.params[4], 2); // quantity raw (pieces, NOT 250)
});

test('log_food_entry Case B: legacy pz food (no gpp) => snapshot null', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM foods'))
      return [foodRow({ unit: 'pz', reference_qty: 1, grams_per_piece: null })];
    if (isInsertInto(sql, 'food_entries')) return [{ id: 41 }];
    return [];
  });
  const tool = byName(writeNutritionTools, 'log_food_entry');
  // entry_unit omitted => defaults to the food's base unit 'pz'.
  await call(tool, { date: '2026-05-22', meal: 'snack', food_id: 5, quantity: 3 }, db);
  const ins = calls.find((c) => isInsertInto(c.sql, 'food_entries'))!;
  assert.equal(ins.params[12], 'pz');
  assert.equal(ins.params[13], null);
  assert.equal(ins.params[4], 3);
});

test('log_food_entry Case C: pz on g food with no gpp => Conflict, zero writes', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM foods')) return [foodRow({ unit: 'g', grams_per_piece: null })];
    return [];
  });
  const tool = byName(writeNutritionTools, 'log_food_entry');
  await assert.rejects(
    () =>
      call(
        tool,
        { date: '2026-05-22', meal: 'snack', food_id: 5, quantity: 1, entry_unit: 'pz' },
        db
      ),
    ConflictError
  );
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'food_entries')));
});

test('log_food_entry: explicit ml entry_unit => snapshot null', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM foods')) return [foodRow({ unit: 'ml', grams_per_piece: null })];
    if (isInsertInto(sql, 'food_entries')) return [{ id: 42 }];
    return [];
  });
  const tool = byName(writeNutritionTools, 'log_food_entry');
  await call(
    tool,
    { date: '2026-05-22', meal: 'pranzo', food_id: 5, quantity: 250, entry_unit: 'ml' },
    db
  );
  const ins = calls.find((c) => isInsertInto(c.sql, 'food_entries'))!;
  assert.equal(ins.params[12], 'ml');
  assert.equal(ins.params[13], null);
});

// ── set_nutrition_day_ai_comment: clear rule ──────────────────────────────────

test('set_nutrition_day_ai_comment: clear allowed when user_comment exists', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT user_comment FROM nutrition_day_notes'))
      return [{ user_comment: 'felt bloated' }];
    return [];
  });
  const tool = byName(writeNutritionTools, 'set_nutrition_day_ai_comment');
  await call(tool, { date: '2026-05-22', text: null }, db);
  assert.ok(calls.some((c) => has(c.sql, 'UPDATE nutrition_day_notes', 'ai_comment = NULL')));
});

test('set_nutrition_day_ai_comment: clear with no row => Conflict', async () => {
  const { db } = makeDb((sql) => {
    if (has(sql, 'SELECT user_comment FROM nutrition_day_notes')) return [];
    return [];
  });
  const tool = byName(writeNutritionTools, 'set_nutrition_day_ai_comment');
  await assert.rejects(() => call(tool, { date: '2026-05-22', text: null }, db), ConflictError);
});

test('set_nutrition_day_ai_comment: clear with no user_comment => Conflict', async () => {
  const { db } = makeDb((sql) => {
    if (has(sql, 'SELECT user_comment FROM nutrition_day_notes'))
      return [{ user_comment: null }];
    return [];
  });
  const tool = byName(writeNutritionTools, 'set_nutrition_day_ai_comment');
  await assert.rejects(() => call(tool, { date: '2026-05-22', text: null }, db), ConflictError);
});

test('set_nutrition_day_ai_comment: set text => UPSERT on (user,date)', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(writeNutritionTools, 'set_nutrition_day_ai_comment');
  await call(tool, { date: '2026-05-22', text: 'good adherence' }, db);
  assert.ok(
    calls.some((c) => has(c.sql, 'INSERT INTO nutrition_day_notes', 'ON CONFLICT (user_id, date)'))
  );
});

// ── nutrition phase: jsonb day target ─────────────────────────────────────────

test('create_nutrition_phase: per-day target serialized as jsonb', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isInsertInto(sql, 'nutrition_targets')) return [{ id: 3 }];
    return [];
  });
  const tool = byName(writeNutritionTools, 'create_nutrition_phase');
  const res = (await call(
    tool,
    {
      phase_name: 'cut_1',
      started_on: '2026-05-01',
      mon_target: { kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 60 },
    },
    db
  )) as { nutrition_target_id: number };
  assert.equal(res.nutrition_target_id, 3);
  const ins = calls.find((c) => isInsertInto(c.sql, 'nutrition_targets'))!;
  assert.ok(ins.sql.includes('mon_target'));
  assert.ok(ins.sql.includes('::jsonb'));
  // the jsonb is stringified
  assert.ok(ins.params.some((p) => typeof p === 'string' && p.includes('"kcal":2000')));
});

// ── problems ──────────────────────────────────────────────────────────────────

test('create_problem: related_exercises int[] passed through', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isInsertInto(sql, 'problems')) return [{ id: 9 }];
    return [];
  });
  const tool = byName(writeProblemsTools, 'create_problem');
  const res = (await call(
    tool,
    {
      title: 'left knee',
      status: 'active',
      started_on: '2026-05-10',
      related_exercises: [100, 101],
    },
    db
  )) as { problem_id: number };
  assert.equal(res.problem_id, 9);
  const ins = calls.find((c) => isInsertInto(c.sql, 'problems'))!;
  assert.deepEqual(ins.params[7], [100, 101]);
});

test('resolve_problem: sets status=resolved + resolved_on, requireOwned', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM problems')) return [{ '?column?': 1 }];
    return [];
  });
  const tool = byName(writeProblemsTools, 'resolve_problem');
  const res = (await call(tool, { id: 9, resolved_on: '2026-05-22' }, db)) as {
    status: string;
  };
  assert.equal(res.status, 'resolved');
  assert.ok(calls.some((c) => has(c.sql, 'UPDATE problems', "status = 'resolved'", 'updated_at = now()')));
});

test('update_problem: cross-tenant id => NotFound, zero writes', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM problems')) return []; // not owned
    return [];
  });
  const tool = byName(writeProblemsTools, 'update_problem');
  await assert.rejects(
    () => call(tool, { id: 999, fields: { status: 'resolved' } }, db),
    NotFoundError
  );
  assert.ok(!calls.some((c) => has(c.sql, 'UPDATE problems')));
});

// ── corrections: delete_session tx ordering ───────────────────────────────────

test('delete_session: tx deletes child session_exercises BEFORE the session', async () => {
  const order: string[] = [];
  const { db } = makeDb((sql) => {
    // The child DELETE now carries a parent EXISTS guard (FIX 3) that itself
    // contains "SELECT 1 FROM sessions", so match the DELETE clauses FIRST and
    // reserve the pure-SELECT branch for the requireOwned ownership check.
    if (has(sql, 'DELETE FROM session_exercises')) {
      order.push('children');
      return [];
    }
    if (has(sql, 'DELETE FROM sessions')) {
      order.push('session');
      return [];
    }
    if (has(sql, 'SELECT 1 FROM sessions')) return [{ '?column?': 1 }];
    return [];
  });
  const tool = byName(writeCorrectionsTools, 'delete_session');
  const res = (await call(tool, { session_id: 55 }, db)) as { deleted: boolean };
  assert.equal(res.deleted, true);
  assert.deepEqual(order, ['children', 'session']);
});

test('delete_session: cross-tenant id => NotFound, zero deletes', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM sessions')) return []; // not owned
    return [];
  });
  const tool = byName(writeCorrectionsTools, 'delete_session');
  await assert.rejects(() => call(tool, { session_id: 999 }, db), NotFoundError);
  assert.ok(!calls.some((c) => has(c.sql, 'DELETE FROM')));
});

// ── update_session_exercise: total_reps recompute ─────────────────────────────

test('update_session_exercise: recomputes total_reps when reps_array changes', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM session_exercises se JOIN sessions s')) return [{ '?column?': 1 }];
    return [];
  });
  const tool = byName(writeCorrectionsTools, 'update_session_exercise');
  await call(tool, { se_id: 12, fields: { reps_array: [10, 9, 8] } }, db);
  const upd = calls.find((c) => has(c.sql, 'UPDATE session_exercises'))!;
  assert.ok(upd.sql.includes('total_reps ='));
  // params: reps_array, total_reps, se_id
  assert.deepEqual(upd.params[0], [10, 9, 8]);
  assert.equal(upd.params[1], 27);
});

test('update_session_exercise: no reps_array change => no total_reps in SET', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM session_exercises se JOIN sessions s')) return [{ '?column?': 1 }];
    return [];
  });
  const tool = byName(writeCorrectionsTools, 'update_session_exercise');
  await call(tool, { se_id: 12, fields: { rpe: 9 } }, db);
  const upd = calls.find((c) => has(c.sql, 'UPDATE session_exercises'))!;
  assert.ok(!upd.sql.includes('total_reps ='));
});

test('update_session_exercise: cross-tenant se_id => NotFound, zero writes', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM session_exercises se JOIN sessions s')) return []; // not owned
    return [];
  });
  const tool = byName(writeCorrectionsTools, 'update_session_exercise');
  await assert.rejects(
    () => call(tool, { se_id: 999, fields: { rpe: 8 } }, db),
    NotFoundError
  );
  assert.ok(!calls.some((c) => has(c.sql, 'UPDATE session_exercises')));
});

test('update_session_exercise: non-accessible exercise_id => ValidationError, zero writes (FIX 2)', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM session_exercises se JOIN sessions s')) return [{ '?column?': 1 }];
    if (has(sql, 'SELECT 1 FROM exercises')) return []; // not in catalog
    return [];
  });
  const tool = byName(writeCorrectionsTools, 'update_session_exercise');
  await assert.rejects(
    () => call(tool, { se_id: 12, fields: { exercise_id: 4242 } }, db),
    ValidationError
  );
  assert.ok(!calls.some((c) => has(c.sql, 'UPDATE session_exercises')));
});

test('update_session_exercise: cross-tenant linked_program_exercise_id => NotFound, zero writes (FIX 1)', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM session_exercises se JOIN sessions s')) return [{ '?column?': 1 }];
    if (has(sql, 'SELECT 1 FROM program_exercises')) return []; // not owned
    return [];
  });
  const tool = byName(writeCorrectionsTools, 'update_session_exercise');
  await assert.rejects(
    () =>
      call(tool, { se_id: 12, fields: { linked_program_exercise_id: 9999 } }, db),
    NotFoundError
  );
  assert.ok(!calls.some((c) => has(c.sql, 'UPDATE session_exercises')));
});

// ── update_food_entry: snapshots untouched ────────────────────────────────────

test('update_food_entry: patches quantity/meal/notes only (no snapshot recompute)', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM food_entries')) return [{ '?column?': 1 }];
    return [];
  });
  const tool = byName(writeCorrectionsTools, 'update_food_entry');
  await call(tool, { id: 33, fields: { quantity: 250, meal: 'pranzo' } }, db);
  const upd = calls.find((c) => has(c.sql, 'UPDATE food_entries'))!;
  assert.ok(!upd.sql.includes('snapshot'));
  // No entry_unit passed => no JOIN-read of foods.
  assert.ok(!calls.some((c) => has(c.sql, 'JOIN foods')));
});

test('update_food_entry: entry_unit=pz on food with gpp => recomputes snapshot (Case A)', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM food_entries')) return [{ '?column?': 1 }];
    if (has(sql, 'JOIN foods')) return [{ unit: 'g', grams_per_piece: 80 }];
    return [];
  });
  const tool = byName(writeCorrectionsTools, 'update_food_entry');
  await call(tool, { id: 33, fields: { entry_unit: 'pz', quantity: 2 } }, db);
  const upd = calls.find((c) => has(c.sql, 'UPDATE food_entries'))!;
  assert.ok(upd.sql.includes('entry_unit ='));
  assert.ok(upd.sql.includes('grams_per_piece_snapshot ='));
  // grams_per_piece_snapshot value is the food's gpp (80).
  assert.ok(upd.params.includes(80));
  assert.ok(upd.params.includes('pz'));
});

test('update_food_entry: switching to g clears snapshot (Case g/ml)', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM food_entries')) return [{ '?column?': 1 }];
    if (has(sql, 'JOIN foods')) return [{ unit: 'g', grams_per_piece: 80 }];
    return [];
  });
  const tool = byName(writeCorrectionsTools, 'update_food_entry');
  await call(tool, { id: 33, fields: { entry_unit: 'g' } }, db);
  const upd = calls.find((c) => has(c.sql, 'UPDATE food_entries'))!;
  assert.ok(upd.sql.includes('entry_unit ='));
  assert.ok(upd.sql.includes('grams_per_piece_snapshot ='));
  // entry_unit set to 'g'; snapshot cleared to null.
  assert.ok(upd.params.includes('g'));
  assert.ok(upd.params.includes(null));
});

test('update_food_entry: entry_unit=pz on g food with no gpp => Conflict (Case C), no UPDATE', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM food_entries')) return [{ '?column?': 1 }];
    if (has(sql, 'JOIN foods')) return [{ unit: 'g', grams_per_piece: null }];
    return [];
  });
  const tool = byName(writeCorrectionsTools, 'update_food_entry');
  await assert.rejects(
    () => call(tool, { id: 33, fields: { entry_unit: 'pz' } }, db),
    ConflictError
  );
  assert.ok(!calls.some((c) => has(c.sql, 'UPDATE food_entries')));
});

test('update_food_entry: cross-tenant id => NotFound, no JOIN-read, no UPDATE', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM food_entries')) return []; // not owned
    return [];
  });
  const tool = byName(writeCorrectionsTools, 'update_food_entry');
  await assert.rejects(
    () => call(tool, { id: 999, fields: { entry_unit: 'pz' } }, db),
    NotFoundError
  );
  assert.ok(!calls.some((c) => has(c.sql, 'JOIN foods')));
  assert.ok(!calls.some((c) => has(c.sql, 'UPDATE food_entries')));
});

// ── create_food: grams_per_piece column ───────────────────────────────────────

test('create_food: includes grams_per_piece in INSERT when provided', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isInsertInto(sql, 'foods')) return [{ id: 70 }];
    return [];
  });
  const tool = byName(writeCatalogTools, 'create_food');
  const res = (await call(
    tool,
    {
      canonical_name: 'Uovo',
      unit: 'g',
      reference_qty: 100,
      kcal: 155,
      protein_g: 13,
      carbs_g: 1.1,
      fat_g: 11,
      grams_per_piece: 55,
    },
    db
  )) as { food_id: number };
  assert.equal(res.food_id, 70);
  const ins = calls.find((c) => isInsertInto(c.sql, 'foods'))!;
  assert.ok(ins.sql.includes('grams_per_piece'));
  // params: name, unit, ref_qty, kcal, p, c, f, grams_per_piece, aliases, notes, created_by
  assert.equal(ins.params[7], 55);
});

test('create_food: grams_per_piece null when omitted', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isInsertInto(sql, 'foods')) return [{ id: 71 }];
    return [];
  });
  const tool = byName(writeCatalogTools, 'create_food');
  await call(
    tool,
    {
      canonical_name: 'Riso',
      unit: 'g',
      reference_qty: 100,
      kcal: 130,
      protein_g: 2.7,
      carbs_g: 28,
      fat_g: 0.3,
    },
    db
  );
  const ins = calls.find((c) => isInsertInto(c.sql, 'foods'))!;
  assert.equal(ins.params[7], null);
});

test('create_food: rejects non-positive grams_per_piece', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(writeCatalogTools, 'create_food');
  await assert.rejects(
    () =>
      call(
        tool,
        {
          canonical_name: 'X',
          unit: 'g',
          reference_qty: 100,
          kcal: 1,
          protein_g: 0,
          carbs_g: 0,
          fat_g: 0,
          grams_per_piece: 0,
        },
        db
      ),
    ValidationError
  );
});

// ── delete_weight ─────────────────────────────────────────────────────────────

test('delete_weight: requireOwned by (user,date) then DELETE', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM weight_log')) return [{ '?column?': 1 }];
    return [];
  });
  const tool = byName(writeCorrectionsTools, 'delete_weight');
  const res = (await call(tool, { date: '2026-04-24' }, db)) as { deleted: boolean };
  assert.equal(res.deleted, true);
  assert.ok(calls.some((c) => has(c.sql, 'DELETE FROM weight_log')));
});
