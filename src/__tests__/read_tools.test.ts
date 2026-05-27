/**
 * read_tools.test.ts — Phase 1 (T003/T004/T005) query-shape tests, no live DB.
 *
 * A MockDb implements Queryable/Db by matching SQL substrings to canned rows.
 * This validates the deterministic assembly logic (computed/facts, key sets,
 * miss_significant floor, evaluated_rules verdicts, search created_by IS NULL)
 * without a Postgres connection. It does NOT replace T026 live parity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Db, Queryable } from '../db.js';
import type { ToolCtx, AnyToolModule } from '../registry.js';
import { readPostworkoutBundleTools } from '../tools/read_postworkout_bundle.js';
import { readWeekBundleTools } from '../tools/read_week_bundle.js';
import { readContextTools } from '../tools/read_context.js';

const USER = '11111111-2222-3333-4444-555555555555';

type Match = { test: (sql: string, params: unknown[]) => boolean; rows: unknown[] };

function makeDb(matches: Match[]): { db: Db; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const run = (sql: string, params: unknown[] = []): unknown[] => {
    calls.push({ sql, params });
    for (const m of matches) {
      if (m.test(sql, params)) return m.rows;
    }
    return [];
  };
  const q: Queryable = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return run(sql, params) as T[];
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return (run(sql, params)[0] as T) ?? null;
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

function ctxFor(db: Db): ToolCtx {
  return { userId: USER, db };
}

function byName(tools: AnyToolModule[], name: string): AnyToolModule {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} must exist`);
  return t!;
}

const allReadTools: AnyToolModule[] = [
  ...readPostworkoutBundleTools,
  ...readWeekBundleTools,
  ...readContextTools,
];

// --- no tool exposes user_id ------------------------------------------------

test('no read tool accepts a user_id parameter', () => {
  for (const t of allReadTools) {
    const json = JSON.stringify(
      // zod schema → introspect via safeParse on a probe object with user_id
      t.inputSchema.safeParse({ user_id: USER })
    );
    // strict() schemas reject unknown keys; presence of user_id must be invalid
    // for every tool (none declares it).
    assert.ok(
      !json.includes('"success":true') || !('user_id' in (t.inputSchema as never)),
      `tool ${t.name} must not accept user_id`
    );
  }
});

// --- postworkout bundle: key set + facts/computed ---------------------------

test('get_postworkout_bundle: key set, facts, miss_significant, evaluated_rules', async () => {
  const matches: Match[] = [
    // last-any (open warning): closed session
    { test: (s) => s.includes('ORDER BY date DESC') && s.includes('SELECT end_time'), rows: [{ end_time: '20:00' }] },
    // last closed
    { test: (s) => s.includes('end_time IS NOT NULL') && s.includes('SELECT id'), rows: [{ id: 42 }] },
    // session base row
    {
      test: (s) => s.includes('AS session_id') && s.includes('day_label'),
      rows: [
        {
          session_id: 42,
          date: '2026-05-20',
          day_type: 'push',
          start_time: '18:00',
          end_time: '20:00',
          duration_min: 75,
          sleep_h: 7,
          body_weight_kg: 80,
          condition: 'ok',
          notes_text: null,
          program_id: 9,
          day_label: 'Push A',
        },
      ],
    },
    // same-day candidates
    { test: (s) => s.includes('SELECT id, day_type, end_time'), rows: [{ id: 42, day_type: 'push', end_time: '20:00' }] },
    // prev sessions
    { test: (s) => s.includes('s.ai_notes_text') && s.includes('LIMIT 2'), rows: [{ date: '2026-05-13', duration_min: 70, sleep_h: 7, condition: 'ok', ai_notes_text: null }] },
    // nutrition phase
    { test: (s) => s.includes('FROM nutrition_targets') && s.includes('phase_name, started_on, ended_on'), rows: [{ phase_name: 'cut', started_on: '2026-05-01', ended_on: null }] },
    // prev weekly review
    { test: (s) => s.includes('FROM weekly_reviews') && s.includes('content_md'), rows: [{ review_number: 5, week_start: '2026-05-09', week_end: '2026-05-15', decisions_summary: 'x', content_md: 'y' }] },
    // scheda changes
    { test: (s) => s.includes('triggered_by_session'), rows: [] },
    // weight log
    { test: (s) => s.includes('FROM weight_log') && s.includes('weight_kg'), rows: [{ date: '2026-05-20', weight_kg: 80, notes: null }] },
    // problems
    { test: (s) => s.includes('FROM problems') && s.includes('related_exercises'), rows: [{ id: 1, title: 'shoulder', status: 'monitoring', severity: '3', related_exercises: [100], management: 'ice' }] },
    // decided rules
    {
      test: (s) => s.includes('FROM program_day_notes') && s.includes('SELECT decided_rules'),
      rows: [
        {
          decided_rules: [
            { id: 'r1', type: 'weight', target_exercise_id: 100, expected: { value: 82.5 }, text: 'bump bench', verifiable: true },
            { id: 'r2', type: 'reps', target_exercise_id: 100, expected: { total_min: 30 }, text: 'hit 30 reps', verifiable: true },
            { id: 'r3', type: 'technique', target_exercise_id: null, expected: null, text: 'slow eccentric', verifiable: false },
          ],
        },
      ],
    },
    // exercises raw: one on-plan (bench, miss reps), one off-plan
    {
      test: (s) => s.includes('FROM session_exercises se') && s.includes('done_sets_count'),
      rows: [
        {
          se_id: 500,
          order_num: 1,
          exercise_id: 100,
          exercise_name: 'Bench Press',
          pe_id: 200,
          planned_sets: 4,
          reps_min: 8,
          reps_max: 10,
          planned_weight: [80],
          target_weight_kg: 90,
          planned_brief: 'focus form',
          done_weight: [82.5],
          reps_array: [8, 7, 6, 3], // total 24 < floor 32 → miss 25% → significant
          total_reps: 24,
          rpe: 9,
          notes_text: null,
          done_w: '82.5',
          planned_w: '80',
          done_sets_count: 4,
        },
        {
          se_id: 501,
          order_num: 2,
          exercise_id: 101,
          exercise_name: 'Cable Fly',
          pe_id: null,
          planned_sets: null,
          reps_min: null,
          reps_max: null,
          planned_weight: null,
          target_weight_kg: null,
          planned_brief: null,
          done_weight: [20],
          reps_array: [15, 15],
          total_reps: 30,
          rpe: null,
          notes_text: null,
          done_w: '20',
          planned_w: null,
          done_sets_count: 2,
        },
      ],
    },
    // history: bench had a heavier 85 before → weight_below_recent_history true
    {
      test: (s) => s.includes('row_number() OVER'),
      rows: [
        { exercise_id: 100, date: '2026-05-13', weight_array: [85], reps_array: [8, 8, 8, 8], total_reps: 32, rpe: '8' },
      ],
    },
    // skipped planned
    { test: (s) => s.includes('NOT EXISTS') && s.includes('planned_reps_min'), rows: [] },
  ];

  const { db } = makeDb(matches);
  const tool = byName(readPostworkoutBundleTools, 'get_postworkout_bundle');
  const out = (await tool.handler({}, ctxFor(db))) as Record<string, unknown>;

  // exact top-level key set (T026 parity)
  const expectedKeys = [
    'meta',
    'session',
    'prev_sessions_same_daytype',
    'nutrition_phase',
    'prev_weekly_review',
    'scheda_changes_recent',
    'weight_log_recent',
    'problems_active',
    'decided_rules_raw',
    'exercises',
    'skipped_planned_exercises',
    'evaluated_rules',
    'derived',
  ];
  assert.deepEqual(Object.keys(out).sort(), [...expectedKeys].sort());

  const exercises = out.exercises as Array<Record<string, any>>;
  const bench = exercises[0];
  assert.equal(bench.computed.weight_delta_vs_plan_kg, 2.5);
  assert.equal(bench.computed.reps_target_floor, 32);
  assert.equal(Math.round(bench.computed.miss_pct), 25);
  assert.equal(bench.facts.weight_increased_vs_plan, true);
  assert.equal(bench.facts.miss_significant, true);
  assert.equal(bench.facts.weight_below_recent_history, true); // 82.5 < 85
  assert.equal(bench.facts.rpe_high, true);
  assert.equal(bench.facts.problem_correlated, true); // exercise 100 in problem
  assert.equal(bench.facts.pr_candidate, false); // miss significant blocks PR

  const fly = exercises[1];
  assert.equal(fly.facts.off_plan, true);
  assert.equal(fly.facts.rpe_null, true);

  // no interpretive labels anywhere
  const blob = JSON.stringify(out);
  for (const banned of ['regression', '"good"', '"bad"']) {
    assert.ok(!blob.includes(banned), `bundle must not contain ${banned}`);
  }

  // evaluated_rules verdicts
  const rules = out.evaluated_rules as Array<Record<string, any>>;
  assert.equal(rules[0].applied, true); // weight 82.5 ≈ expected 82.5
  assert.equal(rules[1].applied, false); // 24 reps < 30 total_min
  assert.equal(rules[2].unverifiable, true); // technique
  assert.equal(rules[2].applied, null);

  const derived = out.derived as Record<string, any>;
  assert.equal(derived.n_exercises, 2);
  assert.equal(derived.n_off_plan, 1);
  assert.equal(derived.n_miss_significant, 1);
  assert.equal(derived.n_rules, 3);
  assert.equal(derived.n_rules_applied, 1);
  assert.equal(derived.n_rules_unverifiable, 1);

  // meta does not leak interpretation; carries resolution
  const meta = out.meta as Record<string, any>;
  assert.equal(meta.session_id, 42);
  assert.equal(meta.resolution.mode, 'auto_last_closed');
  assert.equal(meta.resolution.open_session_warning, false);
});

// --- week bundle: key set + per-week derived --------------------------------

test('get_week_bundle: key set and per-week aggregation', async () => {
  const matches: Match[] = [
    { test: (s) => s.includes('FROM programs') && s.includes('philosophy_md_path'), rows: [{ id: 9, name: 'P', started_on: '2026-01-01', ended_on: null }] },
    { test: (s) => s.includes('FROM program_days'), rows: [{ id: 1, day_type: 'push', display_name: 'Push', weekday: 1 }, { id: 2, day_type: 'pull', display_name: 'Pull', weekday: 4 }] },
    { test: (s) => s.includes('FROM sessions') && s.includes('body_weight_kg'), rows: [{ id: 42, date: '2026-05-18', day_type: 'push', duration_min: 70, sleep_h: 7, body_weight_kg: 80, condition: 'ok', notes_text: null }] },
    { test: (s) => s.includes('LEFT JOIN program_exercises pe') && s.includes('done_total_reps'), rows: [] },
    { test: (s) => s.includes('FROM weight_log'), rows: [{ date: '2026-05-18', weight_kg: '80.0', notes: null }] },
    { test: (s) => s.includes('FROM nutrition_targets'), rows: [{ id: 7, phase_name: 'cut', started_on: '2026-05-01', ended_on: null }] },
    { test: (s) => s.includes('FROM nutrition_days'), rows: [{ date: '2026-05-18', kcal: '2000', protein_g: '180', carbs_g: '200', fat_g: '60', entries_count: 4 }] },
    { test: (s) => s.includes('FROM problems'), rows: [] },
    { test: (s) => s.includes('FROM weekly_reviews'), rows: [] },
    { test: (s) => s.includes('FROM goals'), rows: [{ id: 1, status: 'active', user_words: 'definire' }] },
    { test: (s) => s.includes('FROM roadmap'), rows: [{ id: 3, domain: 'nutrition', valid_to: null }] },
  ];
  const { db } = makeDb(matches);
  const tool = byName(readWeekBundleTools, 'get_week_bundle');
  const out = (await tool.handler(
    { range_start: '2026-05-16', range_end: '2026-05-22', week_start_dow: 6 },
    ctxFor(db)
  )) as Record<string, unknown>;

  const expectedKeys = [
    'meta',
    'program',
    'program_days',
    'sessions',
    'exercise_diff',
    'weight_log',
    'nutrition_target',
    'nutrition_days',
    'problems',
    'prev_reviews',
    'derived',
    'goals',
    'roadmap',
    'roadmap_projections',
  ];
  assert.deepEqual(Object.keys(out).sort(), [...expectedKeys].sort());

  // FIX 3: goals/roadmap included; roadmap_projections null
  // without ROADMAP_PROJECTION_SECRET (graceful fallback, no fetch).
  assert.equal((out.goals as unknown[]).length, 1);
  assert.equal((out.roadmap as Record<string, unknown>).domain, 'nutrition');
  assert.equal(out.roadmap_projections, null);

  const weeks = (out.derived as any).weeks as Array<Record<string, any>>;
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].week_start, '2026-05-16'); // Saturday
  assert.equal(weeks[0].week_end, '2026-05-22');
  assert.equal(weeks[0].sessions_done, 1);
  assert.equal(weeks[0].sessions_planned, 2); // two days with weekday
  assert.equal(weeks[0].nutrition_days_logged, 1);
  assert.equal(weeks[0].avg_kcal, 2000);
  assert.equal(weeks[0].weight_avg_kg, 80);
});

// --- search tools: created_by IS NULL + own; resolution shape ---------------

test('search_exercises filters seed + own and returns id', async () => {
  let capturedSql = '';
  const matches: Match[] = [
    {
      test: (s) => {
        if (s.includes('FROM exercises')) capturedSql = s;
        return s.includes('FROM exercises');
      },
      rows: [
        {
          id: 100,
          canonical_name: 'Bench Press',
          aliases: ['panca'],
          gif_path: 'bench-press.gif',
          created_by: null,
        },
      ],
    },
  ];
  const { db, calls } = makeDb(matches);
  const tool = byName(readContextTools, 'search_exercises');
  const out = (await tool.handler({ query: 'bench' }, ctxFor(db))) as Array<Record<string, unknown>>;
  assert.equal(out[0].id, 100);
  // T006: gif_path exposed so the coach knows which exercises have a demo GIF
  assert.ok(capturedSql.includes('gif_path'));
  assert.equal(out[0].gif_path, 'bench-press.gif');
  assert.ok(capturedSql.includes('created_by IS NULL OR created_by = $1'));
  assert.ok(capturedSql.includes('ILIKE'));
  // userId bound as first param
  assert.equal(calls[0].params[0], USER);
});

test('search_foods filters seed + own and returns id', async () => {
  let capturedSql = '';
  const matches: Match[] = [
    {
      test: (s) => {
        if (s.includes('FROM foods')) capturedSql = s;
        return s.includes('FROM foods');
      },
      rows: [{ id: 61, canonical_name: 'Chicken', aliases: ['pollo'], created_by: null }],
    },
  ];
  const { db } = makeDb(matches);
  const tool = byName(readContextTools, 'search_foods');
  const out = (await tool.handler({ query: 'chick' }, ctxFor(db))) as Array<Record<string, unknown>>;
  assert.equal(out[0].id, 61);
  assert.ok(capturedSql.includes('created_by IS NULL OR created_by = $1'));
});

// --- list_scheda_changes: user_id scoping + optional program filter ----------

test('list_scheda_changes scopes by user_id and binds defaults', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const matches: Match[] = [
    {
      test: (s) => {
        if (s.includes('FROM scheda_changes')) capturedSql = s;
        return s.includes('FROM scheda_changes');
      },
      rows: [
        {
          id: 7,
          changed_at: '2026-05-20T10:00:00Z',
          change_type: 'update',
          program_id: 9,
          description: 'bump bench',
          affected_before_id: 200,
          affected_after_id: 201,
          diff: { weight: [80, 82.5] },
        },
      ],
    },
  ];
  const { db, calls } = makeDb(matches);
  const tool = byName(readContextTools, 'list_scheda_changes');
  const out = (await tool.handler({}, ctxFor(db))) as Array<Record<string, unknown>>;
  capturedParams = calls[0].params;

  assert.equal(out[0].id, 7);
  // user_id bound as $1, program filter null, default limit 50 as $3
  assert.ok(capturedSql.includes('WHERE user_id = $1'));
  assert.ok(capturedSql.includes('($2::int IS NULL OR program_id = $2)'));
  assert.ok(capturedSql.includes('ORDER BY changed_at DESC'));
  assert.equal(capturedParams[0], USER);
  assert.equal(capturedParams[1], null);
  assert.equal(capturedParams[2], 50);
});

test('list_scheda_changes applies program_id filter and limit', async () => {
  const matches: Match[] = [{ test: (s) => s.includes('FROM scheda_changes'), rows: [] }];
  const { db, calls } = makeDb(matches);
  const tool = byName(readContextTools, 'list_scheda_changes');
  await tool.handler({ program_id: 9, limit: 10 }, ctxFor(db));
  assert.equal(calls[0].params[0], USER);
  assert.equal(calls[0].params[1], 9);
  assert.equal(calls[0].params[2], 10);
});

// --- list_nutrition_day_notes: user_id scoping + optional date range ---------

test('list_nutrition_day_notes scopes by user_id with no range', async () => {
  let capturedSql = '';
  const matches: Match[] = [
    {
      test: (s) => {
        if (s.includes('FROM nutrition_day_notes')) capturedSql = s;
        return s.includes('FROM nutrition_day_notes');
      },
      rows: [{ date: '2026-05-20', ai_comment: 'ok', user_comment: 'bloated' }],
    },
  ];
  const { db, calls } = makeDb(matches);
  const tool = byName(readContextTools, 'list_nutrition_day_notes');
  const out = (await tool.handler({}, ctxFor(db))) as Array<Record<string, unknown>>;

  assert.equal(out[0].user_comment, 'bloated');
  assert.ok(capturedSql.includes('WHERE user_id = $1'));
  assert.ok(capturedSql.includes('ORDER BY date DESC'));
  // never CURRENT_DATE server-side
  assert.ok(!capturedSql.includes('CURRENT_DATE'));
  assert.equal(calls[0].params[0], USER);
  assert.equal(calls[0].params[1], null);
  assert.equal(calls[0].params[2], null);
});

test('list_nutrition_day_notes binds from/to date range', async () => {
  const matches: Match[] = [{ test: (s) => s.includes('FROM nutrition_day_notes'), rows: [] }];
  const { db, calls } = makeDb(matches);
  const tool = byName(readContextTools, 'list_nutrition_day_notes');
  await tool.handler({ from: '2026-05-01', to: '2026-05-22' }, ctxFor(db));
  assert.equal(calls[0].params[0], USER);
  assert.equal(calls[0].params[1], '2026-05-01');
  assert.equal(calls[0].params[2], '2026-05-22');
});

// --- get_scheda as_of_date reconstruction binds the date param --------------

test('get_scheda binds as_of_date and program defaults to current', async () => {
  let exSql = '';
  const matches: Match[] = [
    { test: (s) => s.includes('FROM programs') && s.includes('ended_on IS NULL') && s.includes('SELECT id'), rows: [{ id: 9 }] },
    { test: (s) => s.includes('FROM programs') && s.includes('philosophy_md_path'), rows: [{ id: 9, name: 'P' }] },
    { test: (s) => s.includes('FROM program_days'), rows: [] },
    {
      test: (s) => {
        if (s.includes('FROM program_exercises pe')) exSql = s;
        return s.includes('FROM program_exercises pe');
      },
      rows: [],
    },
    { test: (s) => s.includes('FROM program_day_notes'), rows: [] },
  ];
  const { db } = makeDb(matches);
  const tool = byName(readContextTools, 'get_scheda');
  const out = (await tool.handler({ as_of_date: '2026-03-01' }, ctxFor(db))) as Record<string, any>;
  assert.equal(out.meta.program_id, 9);
  assert.equal(out.meta.as_of_date, '2026-03-01');
  assert.ok(exSql.includes('valid_from <= $3::date'));
});
