/**
 * write_structural.test.ts — Phase 3 (T009/T010/T011) tests.
 *
 * A SpyDb routes SQL by substring to canned rows and records every call. tx()
 * runs the callback on the same Queryable; if the callback throws, tx rethrows
 * (rollback = no COMMIT) — we assert the thrown error and that the expected
 * pre-failure work was/ wasn't issued. No live DB.
 *
 * Coverage focus:
 *   - versioning chain: revise closes row + inserts new current + audit before/after
 *   - inheritance of non-overridden fields
 *   - swap changes exercise_id (+ FK check), remove only closes
 *   - cross-tenant pe_id => NotFound, zero writes
 *   - FK-missing (bad day_type / exercise_id) => loud error, rollback
 *   - replace_program: full payload, day_type-not-in-payload guard, invalid
 *     exercise_id => rollback (no program insert committed past the failure)
 *   - one-active-program invariant (create_program conflict + end_current)
 *   - catalog create_* stamps created_by = userId
 *   - no tool accepts user_id
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Db, Queryable } from '../db.js';
import type { ToolCtx, AnyToolModule } from '../registry.js';
import { NotFoundError, ValidationError, ConflictError } from '../errors.js';
import { writeExerciseVersionedTools } from '../tools/write_exercise_versioned.js';
import { writeProgramTools } from '../tools/write_program.js';
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
const isInsertInto = (sql: string, table: string) =>
  has(sql, 'INSERT INTO', table);

// canonical current pe row used by versioned tests (pe_id 42)
const CURRENT_42 = {
  id: 42,
  user_id: USER,
  program_id: 9,
  day_type: 'push',
  order_num: 2,
  exercise_id: 100,
  sets: 3,
  reps_min: 8,
  reps_max: 12,
  current_weight_array: [60],
  target_weight_kg: 70,
  rest_sec: 90,
  metadata: { foo: 'bar' },
  ai_notes_text: 'keep tight',
  alternative_exercise_text: 'machine press',
  valid_from: '2026-05-01',
  valid_to: null,
};

// ── no tool accepts user_id ───────────────────────────────────────────────────

test('no Phase-3 tool accepts a user_id parameter', () => {
  const all = [
    ...writeExerciseVersionedTools,
    ...writeProgramTools,
    ...writeCatalogTools,
  ];
  for (const t of all) {
    const r = t.inputSchema.safeParse({ user_id: USER });
    assert.equal(r.success, false, `tool ${t.name} must reject user_id (strict)`);
  }
});

// ── revise_exercise ───────────────────────────────────────────────────────────

test('revise_exercise: closes row 42, inserts new current with sets=4, inherits the rest, one audit before=42/after=new', async () => {
  let newPeId = 0;
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM program_exercises')) return [{ '?column?': 1 }]; // requireOwned
    if (has(sql, 'SELECT', 'FROM program_exercises', 'valid_to IS NULL')) return [CURRENT_42];
    if (has(sql, 'UPDATE program_exercises', 'SET valid_to')) return [{ id: 42 }];
    if (isInsertInto(sql, 'program_exercises')) {
      newPeId = 77;
      return [{ id: 77 }];
    }
    if (isInsertInto(sql, 'scheda_changes')) return [{ id: 500 }];
    return [];
  });
  const tool = byName(writeExerciseVersionedTools, 'revise_exercise');
  const res = (await call(
    tool,
    { pe_id: 42, fields: { sets: 4 }, valid_from: '2026-05-22', change_description: 'progress sets' },
    db
  )) as { pe_id: number; previous_pe_id: number; change_id: number; diff: Record<string, unknown> };

  assert.equal(res.previous_pe_id, 42);
  assert.equal(res.pe_id, 77);
  assert.equal(res.change_id, 500);
  // diff only has the changed field
  assert.deepEqual(Object.keys(res.diff), ['sets']);
  assert.deepEqual(res.diff.sets, { before: 3, after: 4 });

  // close set valid_to = new valid_from
  const close = calls.find((c) => has(c.sql, 'UPDATE program_exercises', 'SET valid_to'))!;
  assert.equal(close.params[0], '2026-05-22');
  assert.equal(close.params[1], 42);
  assert.equal(close.params[2], USER);

  // INSERT inherits non-overridden fields (order_num 2, exercise_id 100, weight [60], reps 8/12)
  const ins = calls.find((c) => isInsertInto(c.sql, 'program_exercises'))!;
  // params order: user, program_id, day_type, order_num, exercise_id, sets, reps_min, reps_max, weight, target, rest, metadata, ai, alt, valid_from
  assert.equal(ins.params[0], USER);
  assert.equal(ins.params[1], 9); // program_id inherited
  assert.equal(ins.params[2], 'push');
  assert.equal(ins.params[3], 2); // order_num inherited
  assert.equal(ins.params[4], 100); // exercise_id inherited
  assert.equal(ins.params[5], 4); // sets overridden
  assert.equal(ins.params[6], 8); // reps_min inherited
  assert.deepEqual(ins.params[8], [60]); // weight inherited
  assert.equal(ins.params[13], 'machine press'); // alternative inherited
  assert.equal(ins.params[14], '2026-05-22'); // valid_from

  // exactly one audit row, before=42, after=77, change_type=update
  const audits = calls.filter((c) => isInsertInto(c.sql, 'scheda_changes'));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].params[1], 'update'); // change_type
  assert.equal(audits[0].params[2], 9); // program_id derived from pe row
  assert.equal(audits[0].params[4], 42); // before
  assert.equal(audits[0].params[5], 77); // after
  void newPeId;
});

test('revise_exercise: cross-tenant pe_id => NotFound, zero writes', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM program_exercises')) return []; // not owned
    return [];
  });
  const tool = byName(writeExerciseVersionedTools, 'revise_exercise');
  await assert.rejects(
    () => call(tool, { pe_id: 42, fields: { sets: 4 }, valid_from: '2026-05-22', change_description: 'x' }, db),
    NotFoundError
  );
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'program_exercises')));
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'scheda_changes')));
  assert.ok(!calls.some((c) => has(c.sql, 'UPDATE program_exercises', 'SET valid_to')));
});

// ── add_exercise ──────────────────────────────────────────────────────────────

test('add_exercise: validates FKs then inserts current row + add audit', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM program_days')) return [{ '?column?': 1 }];
    if (has(sql, 'FROM exercises')) return [{ '?column?': 1 }];
    if (isInsertInto(sql, 'program_exercises')) return [{ id: 88 }];
    if (isInsertInto(sql, 'scheda_changes')) return [{ id: 501 }];
    return [];
  });
  const tool = byName(writeExerciseVersionedTools, 'add_exercise');
  const res = (await call(
    tool,
    { program_id: 9, day_type: 'push', order_num: 5, exercise_id: 100, sets: 3, valid_from: '2026-05-22' },
    db
  )) as { pe_id: number; change_id: number; change_type: string };
  assert.equal(res.pe_id, 88);
  assert.equal(res.change_id, 501);
  assert.equal(res.change_type, 'add');
  const audit = calls.find((c) => isInsertInto(c.sql, 'scheda_changes'))!;
  assert.equal(audit.params[1], 'add');
  assert.equal(audit.params[5], 88); // affected_after_id
});

test('add_exercise: missing day_type FK => ValidationError, no insert', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM program_days')) return []; // FK miss
    return [{ '?column?': 1 }];
  });
  const tool = byName(writeExerciseVersionedTools, 'add_exercise');
  await assert.rejects(
    () =>
      call(tool, { program_id: 9, day_type: 'nope', order_num: 1, exercise_id: 100, valid_from: '2026-05-22' }, db),
    ValidationError
  );
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'program_exercises')));
});

test('add_exercise: missing exercise_id => ValidationError, no insert', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'FROM program_days')) return [{ '?column?': 1 }];
    if (has(sql, 'FROM exercises')) return []; // FK miss
    return [];
  });
  const tool = byName(writeExerciseVersionedTools, 'add_exercise');
  await assert.rejects(
    () =>
      call(tool, { program_id: 9, day_type: 'push', order_num: 1, exercise_id: 999, valid_from: '2026-05-22' }, db),
    ValidationError
  );
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'program_exercises')));
});

// ── swap_exercise ─────────────────────────────────────────────────────────────

test('swap_exercise: changes exercise_id, validates new id, audit change_type=swap', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM program_exercises')) return [{ '?column?': 1 }];
    if (has(sql, 'SELECT', 'FROM program_exercises', 'valid_to IS NULL')) return [CURRENT_42];
    if (has(sql, 'FROM exercises')) return [{ '?column?': 1 }];
    if (has(sql, 'UPDATE program_exercises', 'SET valid_to')) return [{ id: 42 }];
    if (isInsertInto(sql, 'program_exercises')) return [{ id: 90 }];
    if (isInsertInto(sql, 'scheda_changes')) return [{ id: 502 }];
    return [];
  });
  const tool = byName(writeExerciseVersionedTools, 'swap_exercise');
  const res = (await call(
    tool,
    { pe_id_out: 42, exercise_id_in: 200, fields: {}, valid_from: '2026-05-22', change_description: 'swap to incline' },
    db
  )) as { pe_id: number; diff: Record<string, unknown> };
  assert.equal(res.pe_id, 90);
  assert.deepEqual(res.diff.exercise_id, { before: 100, after: 200 });
  const ins = calls.find((c) => isInsertInto(c.sql, 'program_exercises'))!;
  assert.equal(ins.params[4], 200); // new exercise_id
  const audit = calls.find((c) => isInsertInto(c.sql, 'scheda_changes'))!;
  assert.equal(audit.params[1], 'swap');
});

// ── remove_exercise ───────────────────────────────────────────────────────────

test('remove_exercise: closes row only (no new row), audit change_type=remove before=pe', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM program_exercises')) return [{ '?column?': 1 }];
    if (has(sql, 'SELECT', 'FROM program_exercises', 'valid_to IS NULL')) return [CURRENT_42];
    if (has(sql, 'UPDATE program_exercises', 'SET valid_to')) return [{ id: 42 }];
    if (isInsertInto(sql, 'scheda_changes')) return [{ id: 503 }];
    return [];
  });
  const tool = byName(writeExerciseVersionedTools, 'remove_exercise');
  const res = (await call(
    tool,
    { pe_id: 42, valid_to: '2026-05-22', change_description: 'drop it' },
    db
  )) as { change_type: string };
  assert.equal(res.change_type, 'remove');
  // no new program_exercises insert
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'program_exercises')));
  const audit = calls.find((c) => isInsertInto(c.sql, 'scheda_changes'))!;
  assert.equal(audit.params[1], 'remove');
  assert.equal(audit.params[4], 42); // before
  assert.equal(audit.params[5], null); // after null
});

// ── create_program (one-active invariant) ─────────────────────────────────────

test('create_program: conflict when an active program exists', async () => {
  const { db } = makeDb((sql) => {
    if (has(sql, 'SELECT id FROM programs', 'ended_on IS NULL')) return [{ id: 3 }];
    return [];
  });
  const tool = byName(writeProgramTools, 'create_program');
  await assert.rejects(
    () => call(tool, { name: 'New', started_on: '2026-05-22' }, db),
    ConflictError
  );
});

test('create_program: end_current closes active then inserts new', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'UPDATE programs SET ended_on')) return [{ id: 3 }];
    if (isInsertInto(sql, 'programs')) return [{ id: 4 }];
    return [];
  });
  const tool = byName(writeProgramTools, 'create_program');
  const res = (await call(
    tool,
    { name: 'New', started_on: '2026-05-22', end_current: true },
    db
  )) as { program_id: number; ended_program_ids: number[] };
  assert.equal(res.program_id, 4);
  assert.deepEqual(res.ended_program_ids, [3]);
  // ordering: end first, insert second
  assert.ok(has(calls[0].sql, 'UPDATE programs SET ended_on'));
  assert.ok(isInsertInto(calls[1].sql, 'programs'));
});

// ── create_day / delete_day ───────────────────────────────────────────────────

test('create_day: conflict on duplicate (program_id, day_type)', async () => {
  const { db } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM programs')) return [{ '?column?': 1 }]; // owns program
    if (has(sql, 'SELECT id FROM program_days')) return [{ id: 1 }]; // already exists
    return [];
  });
  const tool = byName(writeProgramTools, 'create_day');
  await assert.rejects(
    () => call(tool, { program_id: 9, day_type: 'push', display_name: 'Push' }, db),
    ConflictError
  );
});

test('delete_day: blocked (CONFLICT) when current exercises remain', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT id FROM program_exercises')) return [{ id: 42 }]; // blocker
    return [];
  });
  const tool = byName(writeProgramTools, 'delete_day');
  await assert.rejects(
    () => call(tool, { program_id: 9, day_type: 'push' }, db),
    ConflictError
  );
  assert.ok(!calls.some((c) => has(c.sql, 'DELETE FROM program_days')));
});

test('delete_day: deletes when empty', async () => {
  const { db } = makeDb((sql) => {
    if (has(sql, 'SELECT id FROM program_exercises')) return []; // no blocker
    if (has(sql, 'DELETE FROM program_days')) return [{ id: 7 }];
    return [];
  });
  const tool = byName(writeProgramTools, 'delete_day');
  const res = (await call(tool, { program_id: 9, day_type: 'push' }, db)) as {
    deleted: boolean;
  };
  assert.equal(res.deleted, true);
});

// ── replace_program ───────────────────────────────────────────────────────────

const goodPayload = {
  program: { name: 'Block 2', started_on: '2026-05-22' },
  days: [{ day_type: 'push', display_name: 'Push' }],
  exercises: [{ day_type: 'push', order_num: 0, exercise_id: 100, sets: 3 }],
};

test('replace_program: end + create program + day + exercise + audit, all wired', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'UPDATE programs SET ended_on')) return [{ id: 1 }];
    if (isInsertInto(sql, 'programs')) return [{ id: 50 }];
    if (has(sql, 'SELECT id FROM program_days')) return []; // no dup
    if (isInsertInto(sql, 'program_days')) return [{ id: 60 }];
    if (has(sql, 'FROM program_days')) return [{ '?column?': 1 }]; // assertDayExists
    if (has(sql, 'FROM exercises')) return [{ '?column?': 1 }];
    if (isInsertInto(sql, 'program_exercises')) return [{ id: 70 }];
    if (isInsertInto(sql, 'scheda_changes')) return [{ id: 80 }];
    return [];
  });
  const tool = byName(writeProgramTools, 'replace_program');
  const res = (await call(tool, { payload: goodPayload }, db)) as {
    program_id: number;
    ended_program_ids: number[];
    day_count: number;
    pe_ids: number[];
    change_ids: number[];
  };
  assert.equal(res.program_id, 50);
  assert.deepEqual(res.ended_program_ids, [1]);
  assert.equal(res.day_count, 1);
  assert.deepEqual(res.pe_ids, [70]);
  assert.deepEqual(res.change_ids, [80]);
});

test('replace_program: exercise day_type not in payload.days => NotFound, no program insert', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(writeProgramTools, 'replace_program');
  const bad = {
    program: { name: 'X', started_on: '2026-05-22' },
    days: [{ day_type: 'push', display_name: 'Push' }],
    exercises: [{ day_type: 'pull', order_num: 0, exercise_id: 100 }],
  };
  await assert.rejects(() => call(tool, { payload: bad }, db), NotFoundError);
  // guard runs before tx → nothing inserted
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'programs')));
});

test('replace_program: invalid exercise_id => rollback (error propagates, no audit)', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'UPDATE programs SET ended_on')) return [{ id: 1 }];
    if (isInsertInto(sql, 'programs')) return [{ id: 50 }];
    if (has(sql, 'SELECT id FROM program_days')) return [];
    if (isInsertInto(sql, 'program_days')) return [{ id: 60 }];
    if (has(sql, 'FROM program_days')) return [{ '?column?': 1 }];
    if (has(sql, 'FROM exercises')) return []; // exercise_id miss
    return [];
  });
  const tool = byName(writeProgramTools, 'replace_program');
  await assert.rejects(() => call(tool, { payload: goodPayload }, db), ValidationError);
  // failed before the exercise insert + audit; tx would ROLLBACK the program/day inserts
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'program_exercises')));
  assert.ok(!calls.some((c) => isInsertInto(c.sql, 'scheda_changes')));
});

// ── catalog ───────────────────────────────────────────────────────────────────

test('create_exercise: stamps created_by = userId, returns id', async () => {
  const { db, calls } = makeDb((sql) => (isInsertInto(sql, 'exercises') ? [{ id: 300 }] : []));
  const tool = byName(writeCatalogTools, 'create_exercise');
  const res = (await call(
    tool,
    { canonical_name: 'Pendlay Row', muscle_groups: ['back'], aliases: ['pendlay'] },
    db
  )) as { exercise_id: number; created: boolean };
  assert.equal(res.exercise_id, 300);
  assert.equal(res.created, true);
  const ins = calls.find((c) => isInsertInto(c.sql, 'exercises'))!;
  assert.equal(ins.params[ins.params.length - 1], USER); // created_by last
});

test('create_food: stamps created_by = userId, returns id', async () => {
  const { db, calls } = makeDb((sql) => (isInsertInto(sql, 'foods') ? [{ id: 400 }] : []));
  const tool = byName(writeCatalogTools, 'create_food');
  const res = (await call(
    tool,
    {
      canonical_name: 'Skyr',
      unit: 'g',
      reference_qty: 100,
      kcal: 63,
      protein_g: 11,
      carbs_g: 4,
      fat_g: 0.2,
    },
    db
  )) as { food_id: number; created: boolean };
  assert.equal(res.food_id, 400);
  const ins = calls.find((c) => isInsertInto(c.sql, 'foods'))!;
  assert.equal(ins.params[ins.params.length - 1], USER); // created_by last
});

test('create_food: rejects negative kcal', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(writeCatalogTools, 'create_food');
  await assert.rejects(
    () =>
      call(
        tool,
        { canonical_name: 'x', unit: 'g', reference_qty: 100, kcal: -1, protein_g: 0, carbs_g: 0, fat_g: 0 },
        db
      ),
    ValidationError
  );
});
