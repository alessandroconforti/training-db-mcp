/**
 * write_tools.test.ts — Phase 2 (T006/T007/T008) validation + query-shape tests.
 *
 * A SpyDb records every (sql, params) and lets each test stub responses. No live
 * DB. The focus: (1) zod/wrapper validation rejects malformed input loudly,
 * (2) requireOwned runs BEFORE every mutation, (3) ownership miss => NotFound and
 * NO UPDATE issued, (4) patch SQL targets the current row only / clears on null,
 * (5) decided_rules `verifiable` is derived and UPSERT overwrites the set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Db, Queryable } from '../db.js';
import type { ToolCtx, AnyToolModule } from '../registry.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { writeExercisePatchTools } from '../tools/write_exercise_patch.js';
import { writeDayNotesTools } from '../tools/write_day_notes.js';
import { writeSessionNotesTools } from '../tools/write_session_notes.js';

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

const isOwnershipSelect = (sql: string) =>
  sql.includes('SELECT 1') && !sql.includes('UPDATE') && !sql.includes('INSERT');
const isUpdate = (sql: string) => /\bUPDATE\b/.test(sql);

// ── no write tool exposes user_id ─────────────────────────────────────────────

test('no write tool accepts a user_id parameter', () => {
  const all = [
    ...writeExercisePatchTools,
    ...writeDayNotesTools,
    ...writeSessionNotesTools,
  ];
  for (const t of all) {
    const r = t.inputSchema.safeParse({ user_id: USER });
    assert.equal(r.success, false, `tool ${t.name} must reject user_id (strict)`);
  }
});

// ── T006 set_exercise_weight ──────────────────────────────────────────────────

test('set_exercise_weight: requireOwned BEFORE update, patches current row', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isOwnershipSelect(sql)) return [{ '?column?': 1 }];
    if (isUpdate(sql)) return [{ id: 42 }];
    return [];
  });
  const tool = byName(writeExercisePatchTools, 'set_exercise_weight');
  const res = await call(tool, { pe_id: 42, current_weight_array: [82.5] }, db);

  assert.deepEqual(res, { pe_id: 42, updated: true });
  // ordering: ownership SELECT first, UPDATE second.
  assert.ok(isOwnershipSelect(calls[0].sql), 'first call must be ownership check');
  assert.ok(isUpdate(calls[1].sql), 'second call must be the UPDATE');
  // UPDATE constrained to current row + bound user.
  assert.ok(calls[1].sql.includes('valid_to IS NULL'));
  assert.ok(calls[1].sql.includes('user_id = $3'));
  assert.deepEqual(calls[1].params, [[82.5], 42, USER]);
});

test('set_exercise_weight: cross-tenant id => NotFound, NO update issued', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isOwnershipSelect(sql)) return []; // not owned
    return [{ id: 42 }];
  });
  const tool = byName(writeExercisePatchTools, 'set_exercise_weight');
  await assert.rejects(
    () => call(tool, { pe_id: 42, current_weight_array: [80] }, db),
    NotFoundError
  );
  assert.equal(calls.length, 1, 'only the ownership SELECT must have run');
  assert.ok(!calls.some((c) => isUpdate(c.sql)), 'no UPDATE may be issued');
});

test('set_exercise_weight: null clears (passed through to UPDATE)', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isOwnershipSelect(sql)) return [{ '?column?': 1 }];
    return [{ id: 42 }];
  });
  const tool = byName(writeExercisePatchTools, 'set_exercise_weight');
  await call(tool, { pe_id: 42, current_weight_array: null }, db);
  assert.deepEqual(calls[1].params, [null, 42, USER]);
});

test('set_exercise_weight: rejects empty array and out-of-range values', async () => {
  const { db } = makeDb(() => [{ '?column?': 1 }]);
  const tool = byName(writeExercisePatchTools, 'set_exercise_weight');
  await assert.rejects(
    () => call(tool, { pe_id: 1, current_weight_array: [] }, db),
    ValidationError
  );
  await assert.rejects(
    () => call(tool, { pe_id: 1, current_weight_array: [1001] }, db),
    ValidationError
  );
  await assert.rejects(
    () => call(tool, { pe_id: 1, current_weight_array: [-1] }, db),
    ValidationError
  );
});

test('set_exercise_note: null clears ai_notes_text on current row', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isOwnershipSelect(sql)) return [{ '?column?': 1 }];
    return [{ id: 42 }];
  });
  const tool = byName(writeExercisePatchTools, 'set_exercise_note');
  await call(tool, { pe_id: 42, ai_notes_text: null }, db);
  assert.ok(calls[1].sql.includes('ai_notes_text = $1'));
  assert.ok(calls[1].sql.includes('valid_to IS NULL'));
  assert.deepEqual(calls[1].params, [null, 42, USER]);
});

test('set_exercise_alternative: patches alternative_exercise_text', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isOwnershipSelect(sql)) return [{ '?column?': 1 }];
    return [{ id: 7 }];
  });
  const tool = byName(writeExercisePatchTools, 'set_exercise_alternative');
  await call(tool, { pe_id: 7, alternative_exercise_text: 'leg press' }, db);
  assert.ok(calls[1].sql.includes('alternative_exercise_text = $1'));
  assert.deepEqual(calls[1].params, ['leg press', 7, USER]);
});

test('set_exercise_weight: owned but no current row => NotFound', async () => {
  const { db } = makeDb((sql) => {
    if (isOwnershipSelect(sql)) return [{ '?column?': 1 }];
    if (isUpdate(sql)) return []; // no current row updated
    return [];
  });
  const tool = byName(writeExercisePatchTools, 'set_exercise_weight');
  await assert.rejects(
    () => call(tool, { pe_id: 42, current_weight_array: [80] }, db),
    NotFoundError
  );
});

// ── T006 reorder_day (transaction) ────────────────────────────────────────────

test('reorder_day: each pe_id ownership-checked then updated, scoped to day', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isOwnershipSelect(sql)) return [{ '?column?': 1 }];
    if (isUpdate(sql)) return [{ id: 1 }];
    return [];
  });
  const tool = byName(writeExercisePatchTools, 'reorder_day');
  const res = await call(
    tool,
    {
      program_id: 9,
      day_type: 'push',
      items: [
        { pe_id: 11, order_num: 0 },
        { pe_id: 12, order_num: 1 },
      ],
    },
    db
  );
  assert.deepEqual(res, { program_id: 9, day_type: 'push', reordered: 2 });
  // sequence: own(11), update(11), own(12), update(12)
  assert.ok(isOwnershipSelect(calls[0].sql));
  assert.ok(isUpdate(calls[1].sql));
  assert.ok(isOwnershipSelect(calls[2].sql));
  assert.ok(isUpdate(calls[3].sql));
  // update constrained to program_id + day_type + current row.
  assert.ok(calls[1].sql.includes('program_id = $4'));
  assert.ok(calls[1].sql.includes('day_type = $5'));
  assert.ok(calls[1].sql.includes('valid_to IS NULL'));
  assert.deepEqual(calls[1].params, [0, 11, USER, 9, 'push']);
});

test('reorder_day: unowned pe_id aborts (no update for it)', async () => {
  const { db, calls } = makeDb((sql, params) => {
    if (isOwnershipSelect(sql)) {
      return params[0] === 11 ? [{ '?column?': 1 }] : [];
    }
    return [{ id: 1 }];
  });
  const tool = byName(writeExercisePatchTools, 'reorder_day');
  await assert.rejects(
    () =>
      call(
        tool,
        {
          program_id: 9,
          day_type: 'push',
          items: [
            { pe_id: 11, order_num: 0 },
            { pe_id: 99, order_num: 1 },
          ],
        },
        db
      ),
    NotFoundError
  );
  // own(11), update(11), own(99)->fail. No update for 99.
  const updates = calls.filter((c) => isUpdate(c.sql));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[1], 11);
});

test('reorder_day: rejects empty items', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(writeExercisePatchTools, 'reorder_day');
  await assert.rejects(
    () => call(tool, { program_id: 1, day_type: 'push', items: [] }, db),
    ValidationError
  );
});

// ── T007 set_day_brief ────────────────────────────────────────────────────────

test('set_day_brief: UPSERT on composite key, null => empty string', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(writeDayNotesTools, 'set_day_brief');
  const res = await call(tool, { program_id: 9, day_type: 'push', text: null }, db);
  assert.deepEqual(res, { program_id: 9, day_type: 'push', ai_notes_text: '' });
  const sql = calls[0].sql;
  assert.ok(sql.includes('INSERT INTO program_day_notes'));
  assert.ok(sql.includes('ON CONFLICT (user_id, program_id, day_type)'));
  // ai_notes_text param is "" (avoids NOT NULL violation on fresh row).
  assert.deepEqual(calls[0].params, [USER, 9, 'push', '']);
});

// ── T007 set_decided_rules (wrapper validation) ───────────────────────────────

const weightRule = {
  id: 'r1',
  type: 'weight',
  target_exercise_id: 5,
  expected: { value: 80 },
  text: 'hold 80kg',
};
const repsRule = {
  id: 'r2',
  type: 'reps',
  target_exercise_id: 5,
  expected: { total_min: 30 },
  text: 'hit 30 total reps',
};
const techniqueRule = {
  id: 'r3',
  type: 'technique',
  target_exercise_id: null,
  expected: null,
  text: 'slow eccentric',
};

test('set_decided_rules: valid set stored, verifiable derived, UPSERT overwrites', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(writeDayNotesTools, 'set_decided_rules');
  const res = (await call(
    tool,
    {
      program_id: 9,
      day_type: 'push',
      rules: [weightRule, repsRule, techniqueRule],
    },
    db
  )) as { n_rules: number; decided_rules: Array<{ type: string; verifiable: boolean }> };

  assert.equal(res.n_rules, 3);
  // verifiable derived: weight/reps => true, technique => false (ignoring input).
  const byType = Object.fromEntries(res.decided_rules.map((r) => [r.type, r.verifiable]));
  assert.equal(byType.weight, true);
  assert.equal(byType.reps, true);
  assert.equal(byType.technique, false);
  // UPSERT shape.
  const sql = calls[0].sql;
  assert.ok(sql.includes('ON CONFLICT (user_id, program_id, day_type)'));
  assert.ok(sql.includes('decided_rules = EXCLUDED.decided_rules'));
});

test('set_decided_rules: derives verifiable=true even if client sends false', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(writeDayNotesTools, 'set_decided_rules');
  const res = (await call(
    tool,
    {
      program_id: 9,
      day_type: 'push',
      rules: [{ ...weightRule, verifiable: false }],
    },
    db
  )) as { decided_rules: Array<{ verifiable: boolean }> };
  assert.equal(res.decided_rules[0].verifiable, true);
});

test('set_decided_rules: empty list clears the set', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(writeDayNotesTools, 'set_decided_rules');
  const res = (await call(tool, { program_id: 9, day_type: 'push', rules: [] }, db)) as {
    n_rules: number;
  };
  assert.equal(res.n_rules, 0);
  assert.equal(calls[0].params[3], '[]');
});

test('set_decided_rules: unknown type => ValidationError, nothing stored', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(writeDayNotesTools, 'set_decided_rules');
  await assert.rejects(
    () =>
      call(
        tool,
        {
          program_id: 9,
          day_type: 'push',
          rules: [{ id: 'x', type: 'bogus', target_exercise_id: null, text: 'hi' }],
        },
        db
      ),
    ValidationError
  );
  assert.equal(calls.length, 0, 'no INSERT may run on validation failure');
});

test('set_decided_rules: weight rule with wrong expected shape => ValidationError', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(writeDayNotesTools, 'set_decided_rules');
  await assert.rejects(
    () =>
      call(
        tool,
        {
          program_id: 9,
          day_type: 'push',
          rules: [{ id: 'r', type: 'weight', target_exercise_id: 1, expected: { total_min: 5 }, text: 'x' }],
        },
        db
      ),
    ValidationError
  );
});

test('set_decided_rules: reps rule requires {total_min:int}', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(writeDayNotesTools, 'set_decided_rules');
  await assert.rejects(
    () =>
      call(
        tool,
        {
          program_id: 9,
          day_type: 'push',
          rules: [{ id: 'r', type: 'reps', target_exercise_id: 1, expected: { value: 5 }, text: 'x' }],
        },
        db
      ),
    ValidationError
  );
});

test('set_decided_rules: qualitative rule with non-null expected => ValidationError', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(writeDayNotesTools, 'set_decided_rules');
  await assert.rejects(
    () =>
      call(
        tool,
        {
          program_id: 9,
          day_type: 'push',
          rules: [{ id: 'r', type: 'rest', target_exercise_id: null, expected: { value: 1 }, text: 'x' }],
        },
        db
      ),
    ValidationError
  );
});

test('set_decided_rules: weight rule accepts {array:[...]}', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(writeDayNotesTools, 'set_decided_rules');
  const res = (await call(
    tool,
    {
      program_id: 9,
      day_type: 'push',
      rules: [{ id: 'r', type: 'weight', target_exercise_id: 1, expected: { array: [60, 57.5] }, text: 'x' }],
    },
    db
  )) as { n_rules: number };
  assert.equal(res.n_rules, 1);
});

test('set_decided_rules: duplicate ids => ValidationError', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(writeDayNotesTools, 'set_decided_rules');
  await assert.rejects(
    () =>
      call(
        tool,
        { program_id: 9, day_type: 'push', rules: [weightRule, { ...repsRule, id: 'r1' }] },
        db
      ),
    ValidationError
  );
  assert.equal(calls.length, 0);
});

// ── T008 session notes ────────────────────────────────────────────────────────

test('set_session_ai_note: requireOwned before update, null clears', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isOwnershipSelect(sql)) return [{ '?column?': 1 }];
    return [{ id: 3 }];
  });
  const tool = byName(writeSessionNotesTools, 'set_session_ai_note');
  await call(tool, { session_id: 3, ai_notes_text: null }, db);
  assert.ok(isOwnershipSelect(calls[0].sql));
  assert.ok(calls[0].sql.includes('FROM sessions'));
  assert.ok(isUpdate(calls[1].sql));
  assert.deepEqual(calls[1].params, [null, 3, USER]);
});

test('set_session_ai_note: cross-tenant => NotFound, no update', async () => {
  const { db, calls } = makeDb((sql) => (isOwnershipSelect(sql) ? [] : [{ id: 3 }]));
  const tool = byName(writeSessionNotesTools, 'set_session_ai_note');
  await assert.rejects(
    () => call(tool, { session_id: 3, ai_notes_text: 'hi' }, db),
    NotFoundError
  );
  assert.ok(!calls.some((c) => isUpdate(c.sql)));
});

test('set_session_exercise_ai_note: ownership via JOIN to sessions, then update', async () => {
  const { db, calls } = makeDb((sql) => {
    if (isOwnershipSelect(sql)) return [{ '?column?': 1 }];
    return [{ id: 8 }];
  });
  const tool = byName(writeSessionNotesTools, 'set_session_exercise_ai_note');
  await call(tool, { se_id: 8, ai_notes_text: 'good form' }, db);
  // ownership SELECT joins session_exercises -> sessions.
  assert.ok(calls[0].sql.includes('session_exercises se JOIN sessions s'));
  assert.ok(calls[0].sql.includes('s.user_id = $2'));
  // UPDATE is itself join-guarded by s.user_id.
  assert.ok(calls[1].sql.includes('s.user_id = $3'));
  assert.deepEqual(calls[1].params, ['good form', 8, USER]);
});

test('set_session_exercise_ai_note: cross-tenant => NotFound, no update', async () => {
  const { db, calls } = makeDb((sql) => (isOwnershipSelect(sql) ? [] : [{ id: 8 }]));
  const tool = byName(writeSessionNotesTools, 'set_session_exercise_ai_note');
  await assert.rejects(
    () => call(tool, { se_id: 8, ai_notes_text: 'x' }, db),
    NotFoundError
  );
  assert.ok(!calls.some((c) => isUpdate(c.sql)));
});
