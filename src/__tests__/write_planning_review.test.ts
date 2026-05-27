/**
 * write_planning_review.test.ts — Phase 5 (T017/T018/T019) tests.
 *
 * Same SpyDb harness as write_structural.test.ts: route SQL by substring to
 * canned rows, record calls, run tx() on the same Queryable, rethrow on cb
 * throw (rollback). No live DB.
 *
 * Coverage focus:
 *   - update_profile_fields: whitelist only; anagrafica rejected (strict);
 *     review_week_start_dow range; metadata JSON-stringified; 0 rows => NotFound
 *   - create_goal: proxy all-or-none (only metric => ValidationError, neither =>
 *     ok, both => ok); triage_class enum guard
 *   - update_goal: merged proxy re-check; requireOwned; cross-tenant => NotFound
 *   - set_goal_status: enum guard
 *   - create_plan: closes current + inserts new (valid_to=valid_from); first plan
 *   - create_roadmap: domain enum; timeline LOUD validation; FK ownership; closes
 *     current per (user, domain) + inserts new
 *   - update_roadmap_timeline: in-place patch of current; malformed => error
 *   - create_weekly_review: review_number = MAX+1 (first => 1); review_md_path NULL
 *   - no Phase-5 tool accepts user_id
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Db, Queryable } from '../db.js';
import type { ToolCtx, AnyToolModule } from '../registry.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { writeProfileGoalsTools } from '../tools/write_profile_goals.js';
import { writePlanningTools } from '../tools/write_planning.js';
import { writeWeeklyReviewTools } from '../tools/write_weekly_review.js';

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

const VALID_TIMELINE = {
  phases: [
    { nutrition_target_id: 5, label: 'cut', started_on: '2026-05-01', ended_on: null },
  ],
  scheduled_events: [{ type: 'refeed', date: '2026-05-10', note: 'midweek' }],
  checkpoints: [
    { date: '2026-05-15', metric: 'body_weight', expected_value: 78.5 },
    {
      date: '2026-05-20',
      metric: 'bench',
      expected_value: 80,
      source: { type: 'exercise', exercise_id: 100, field: 'weight' },
    },
  ],
};

// ── no Phase-5 tool accepts user_id ─────────────────────────────────────────────

test('no Phase-5 tool accepts a user_id parameter', () => {
  const all = [
    ...writeProfileGoalsTools,
    ...writePlanningTools,
    ...writeWeeklyReviewTools,
  ];
  for (const t of all) {
    const r = t.inputSchema.safeParse({ user_id: USER });
    assert.equal(r.success, false, `tool ${t.name} must reject user_id (strict)`);
  }
});

// ── update_profile_fields ───────────────────────────────────────────────────────

test('update_profile_fields: whitelisted fields update, metadata JSON-stringified', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'UPDATE user_profiles')) return [{ user_id: USER }];
    return [];
  });
  const tool = byName(writeProfileGoalsTools, 'update_profile_fields');
  const res = (await call(
    tool,
    {
      fields: {
        request_initial_training_plan: true,
        review_week_start_dow: 6,
        metadata: { completion_warnings: ['x'] },
      },
    },
    db
  )) as { updated: boolean; fields: string[] };
  assert.equal(res.updated, true);
  const upd = calls.find((c) => has(c.sql, 'UPDATE user_profiles'))!;
  // last param is the bound userId; metadata is stringified
  assert.equal(upd.params[upd.params.length - 1], USER);
  assert.ok(upd.params.includes('{"completion_warnings":["x"]}'));
  assert.ok(has(upd.sql, 'request_initial_training_plan', 'review_week_start_dow', 'metadata'));
});

test('update_profile_fields: anagrafica field is rejected by the strict whitelist', async () => {
  const tool = byName(writeProfileGoalsTools, 'update_profile_fields');
  const r = tool.inputSchema.safeParse({ fields: { display_name: 'Jordan' } });
  assert.equal(r.success, false);
});

test('update_profile_fields: out-of-range review_week_start_dow rejected', async () => {
  const tool = byName(writeProfileGoalsTools, 'update_profile_fields');
  const r = tool.inputSchema.safeParse({ fields: { review_week_start_dow: 7 } });
  assert.equal(r.success, false);
});

test('update_profile_fields: 0 rows updated => NotFound', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(writeProfileGoalsTools, 'update_profile_fields');
  await assert.rejects(
    () => call(tool, { fields: { free_form_note: 'hi' } }, db),
    NotFoundError
  );
});

// ── create_goal ─────────────────────────────────────────────────────────────────

test('create_goal: proxy all-or-none — only metric => ValidationError, no INSERT', async () => {
  const { db, calls } = makeDb(() => [{ id: 1 }]);
  const tool = byName(writeProfileGoalsTools, 'create_goal');
  await assert.rejects(
    () =>
      call(
        tool,
        { user_words: 'lose belly', triage_class: 'nutritional', proxy_metric: 'waist_cm' },
        db
      ),
    ValidationError
  );
  assert.equal(calls.filter((c) => isInsertInto(c.sql, 'goals')).length, 0);
});

test('create_goal: neither proxy field => ok (insert), status active', async () => {
  const { db, calls } = makeDb(() => [{ id: 42 }]);
  const tool = byName(writeProfileGoalsTools, 'create_goal');
  const res = (await call(
    tool,
    { user_words: 'feel strong', triage_class: 'training' },
    db
  )) as { goal_id: number; status: string };
  assert.equal(res.goal_id, 42);
  assert.equal(res.status, 'active');
  const ins = calls.find((c) => isInsertInto(c.sql, 'goals'))!;
  assert.equal(ins.params[0], USER);
  assert.equal(ins.params[4], null); // proxy_metric
  assert.equal(ins.params[5], null); // proxy_target_value
});

test('create_goal: both proxy fields => ok (insert)', async () => {
  const { db, calls } = makeDb(() => [{ id: 43 }]);
  const tool = byName(writeProfileGoalsTools, 'create_goal');
  const res = (await call(
    tool,
    {
      user_words: 'cut to 78',
      triage_class: 'nutritional',
      proxy_metric: 'body_weight',
      proxy_target_value: 78,
      proxy_target_date: '2026-07-01',
    },
    db
  )) as { goal_id: number };
  assert.equal(res.goal_id, 43);
  const ins = calls.find((c) => isInsertInto(c.sql, 'goals'))!;
  assert.equal(ins.params[4], 'body_weight');
  assert.equal(ins.params[5], 78);
  assert.equal(ins.params[6], '2026-07-01');
});

test('create_goal: triage_class outside enum is rejected', async () => {
  const tool = byName(writeProfileGoalsTools, 'create_goal');
  const r = tool.inputSchema.safeParse({ user_words: 'x', triage_class: 'spiritual' });
  assert.equal(r.success, false);
});

// ── update_goal ─────────────────────────────────────────────────────────────────

test('update_goal: cross-tenant id => NotFound (requireOwned), zero writes', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM goals')) return []; // requireOwned miss
    return [];
  });
  const tool = byName(writeProfileGoalsTools, 'update_goal');
  await assert.rejects(
    () => call(tool, { id: 999, fields: { user_words: 'new' } }, db),
    NotFoundError
  );
  assert.equal(calls.filter((c) => has(c.sql, 'UPDATE goals')).length, 0);
});

test('update_goal: merged proxy half-state (clear value only) => ValidationError', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM goals')) return [{ '?column?': 1 }]; // requireOwned ok
    if (has(sql, 'SELECT proxy_metric'))
      return [{ proxy_metric: 'body_weight', proxy_target_value: 78 }];
    return [];
  });
  const tool = byName(writeProfileGoalsTools, 'update_goal');
  await assert.rejects(
    () => call(tool, { id: 1, fields: { proxy_target_value: null } }, db),
    ValidationError
  );
  assert.equal(calls.filter((c) => has(c.sql, 'UPDATE goals')).length, 0);
});

test('update_goal: valid partial patch updates the row', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM goals')) return [{ '?column?': 1 }];
    if (has(sql, 'SELECT proxy_metric'))
      return [{ proxy_metric: null, proxy_target_value: null }];
    if (has(sql, 'UPDATE goals')) return [{ id: 1 }];
    return [];
  });
  const tool = byName(writeProfileGoalsTools, 'update_goal');
  const res = (await call(
    tool,
    { id: 1, fields: { user_words: 'rewritten', triage_class: 'medical' } },
    db
  )) as { goal_id: number; updated: boolean };
  assert.equal(res.updated, true);
  const upd = calls.find((c) => has(c.sql, 'UPDATE goals'))!;
  assert.ok(has(upd.sql, 'user_words', 'triage_class'));
});

// ── set_goal_status ─────────────────────────────────────────────────────────────

test('set_goal_status: enum guard rejects bad status', async () => {
  const tool = byName(writeProfileGoalsTools, 'set_goal_status');
  const r = tool.inputSchema.safeParse({ id: 1, status: 'paused' });
  assert.equal(r.success, false);
});

test('set_goal_status: requireOwned then update', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM goals')) return [{ '?column?': 1 }];
    if (has(sql, 'UPDATE goals')) return [{ id: 7 }];
    return [];
  });
  const tool = byName(writeProfileGoalsTools, 'set_goal_status');
  const res = (await call(tool, { id: 7, status: 'resolved' }, db)) as {
    goal_id: number;
    status: string;
  };
  assert.equal(res.status, 'resolved');
  const upd = calls.find((c) => has(c.sql, 'UPDATE goals'))!;
  assert.equal(upd.params[0], 'resolved');
});

// ── create_plan ─────────────────────────────────────────────────────────────────

test('create_plan: closes current (valid_to=valid_from) then inserts new current', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'UPDATE long_term_plans', 'SET valid_to')) return [{ id: 10 }];
    if (isInsertInto(sql, 'long_term_plans')) return [{ id: 11 }];
    return [];
  });
  const tool = byName(writePlanningTools, 'create_plan');
  const res = (await call(
    tool,
    { title: 'Q3 plan', content_md: '# plan', valid_from: '2026-06-01' },
    db
  )) as { plan_id: number; closed_plan_ids: number[] };
  assert.equal(res.plan_id, 11);
  assert.deepEqual(res.closed_plan_ids, [10]);
  const close = calls.find((c) => has(c.sql, 'UPDATE long_term_plans', 'SET valid_to'))!;
  assert.equal(close.params[0], '2026-06-01'); // valid_to = new valid_from
  assert.equal(close.params[1], USER);
  const ins = calls.find((c) => isInsertInto(c.sql, 'long_term_plans'))!;
  assert.ok(has(ins.sql, 'valid_to')); // inserts with NULL valid_to (current)
});

test('create_plan: first plan (no current) inserts with empty closed list', async () => {
  const { db } = makeDb((sql) => {
    if (has(sql, 'UPDATE long_term_plans')) return []; // nothing to close
    if (isInsertInto(sql, 'long_term_plans')) return [{ id: 1 }];
    return [];
  });
  const tool = byName(writePlanningTools, 'create_plan');
  const res = (await call(
    tool,
    { title: 'first', content_md: 'x', valid_from: '2026-01-01' },
    db
  )) as { plan_id: number; closed_plan_ids: number[] };
  assert.equal(res.plan_id, 1);
  assert.deepEqual(res.closed_plan_ids, []);
});

// ── create_roadmap ──────────────────────────────────────────────────────────────

test('create_roadmap: domain enum, valid timeline, closes current per domain + inserts', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'UPDATE roadmap', 'SET valid_to')) return [{ id: 20 }];
    if (isInsertInto(sql, 'roadmap')) return [{ id: 21 }];
    return [];
  });
  const tool = byName(writePlanningTools, 'create_roadmap');
  const res = (await call(
    tool,
    {
      domain: 'nutrition',
      horizon_start: '2026-05-01',
      horizon_target_date: '2026-08-01',
      timeline: VALID_TIMELINE,
    },
    db
  )) as { roadmap_id: number; closed_roadmap_ids: number[]; domain: string };
  assert.equal(res.roadmap_id, 21);
  assert.equal(res.domain, 'nutrition');
  assert.deepEqual(res.closed_roadmap_ids, [20]);
  const close = calls.find((c) => has(c.sql, 'UPDATE roadmap', 'SET valid_to'))!;
  assert.equal(close.params[0], '2026-05-01'); // valid_to = horizon_start
  assert.equal(close.params[2], 'nutrition'); // scoped per domain
  const ins = calls.find((c) => isInsertInto(c.sql, 'roadmap'))!;
  // timeline param is JSON-stringified
  assert.ok(typeof ins.params[6] === 'string' && (ins.params[6] as string).includes('checkpoints'));
});

test('create_roadmap: malformed timeline (bad source) => ValidationError, no writes', async () => {
  const { db, calls } = makeDb(() => [{ id: 1 }]);
  const tool = byName(writePlanningTools, 'create_roadmap');
  await assert.rejects(
    () =>
      call(
        tool,
        {
          domain: 'nutrition',
          horizon_start: '2026-05-01',
          timeline: {
            phases: [],
            scheduled_events: [],
            checkpoints: [
              {
                date: '2026-05-10',
                expected_value: 80,
                source: { type: 'exercise', field: 'weight' }, // missing exercise_id
              },
            ],
          },
        },
        db
      ),
    ValidationError
  );
  assert.equal(calls.length, 0); // validation precedes any DB call
});

test('create_roadmap: domain outside enum rejected', async () => {
  const tool = byName(writePlanningTools, 'create_roadmap');
  const r = tool.inputSchema.safeParse({
    domain: 'sleep',
    horizon_start: '2026-05-01',
    timeline: VALID_TIMELINE,
  });
  assert.equal(r.success, false);
});

test('create_roadmap: cross-tenant goal_id => ValidationError, no insert', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM goals')) return []; // not owned
    return [];
  });
  const tool = byName(writePlanningTools, 'create_roadmap');
  await assert.rejects(
    () =>
      call(
        tool,
        {
          domain: 'nutrition',
          goal_id: 999,
          horizon_start: '2026-05-01',
          timeline: VALID_TIMELINE,
        },
        db
      ),
    ValidationError
  );
  assert.equal(calls.filter((c) => isInsertInto(c.sql, 'roadmap')).length, 0);
});

// ── update_roadmap_timeline ─────────────────────────────────────────────────────

test('update_roadmap_timeline: patches current row in place', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM roadmap')) return [{ '?column?': 1 }]; // requireOwned
    if (has(sql, 'UPDATE roadmap', 'SET timeline')) return [{ id: 30 }];
    return [];
  });
  const tool = byName(writePlanningTools, 'update_roadmap_timeline');
  const res = (await call(
    tool,
    { roadmap_id: 30, timeline: VALID_TIMELINE },
    db
  )) as { roadmap_id: number; updated: boolean };
  assert.equal(res.updated, true);
  const upd = calls.find((c) => has(c.sql, 'UPDATE roadmap', 'SET timeline'))!;
  assert.ok(has(upd.sql, 'valid_to IS NULL'));
});

test('update_roadmap_timeline: malformed timeline => ValidationError before any DB call', async () => {
  const { db, calls } = makeDb(() => [{ '?column?': 1 }]);
  const tool = byName(writePlanningTools, 'update_roadmap_timeline');
  await assert.rejects(
    () => call(tool, { roadmap_id: 1, timeline: { phases: [] } }, db),
    ValidationError
  );
  assert.equal(calls.length, 0);
});

test('update_roadmap_timeline: no current row => NotFound', async () => {
  const { db } = makeDb((sql) => {
    if (has(sql, 'SELECT 1 FROM roadmap')) return [{ '?column?': 1 }];
    if (has(sql, 'UPDATE roadmap')) return []; // no current row
    return [];
  });
  const tool = byName(writePlanningTools, 'update_roadmap_timeline');
  await assert.rejects(
    () => call(tool, { roadmap_id: 1, timeline: VALID_TIMELINE }, db),
    NotFoundError
  );
});

// ── create_weekly_review ────────────────────────────────────────────────────────

test('create_weekly_review: first review => review_number=1, review_md_path NULL', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'COALESCE(MAX(review_number)')) return [{ next_number: 1 }];
    if (isInsertInto(sql, 'weekly_reviews')) return [{ id: 100 }];
    return [];
  });
  const tool = byName(writeWeeklyReviewTools, 'create_weekly_review');
  const res = (await call(
    tool,
    { week_start: '2026-05-01', week_end: '2026-05-07', content_md: '# review' },
    db
  )) as { review_id: number; review_number: number; review_md_path: null };
  assert.equal(res.review_number, 1);
  assert.equal(res.review_md_path, null);
  const ins = calls.find((c) => isInsertInto(c.sql, 'weekly_reviews'))!;
  assert.equal(ins.params[1], 1); // review_number
  // review_md_path is hard-coded NULL in the SQL (not a param)
  assert.ok(has(ins.sql, 'NULL'));
});

test('create_weekly_review: subsequent review => MAX+1, stores optional metrics', async () => {
  const { db, calls } = makeDb((sql) => {
    if (has(sql, 'COALESCE(MAX(review_number)')) return [{ next_number: 4 }];
    if (isInsertInto(sql, 'weekly_reviews')) return [{ id: 200 }];
    return [];
  });
  const tool = byName(writeWeeklyReviewTools, 'create_weekly_review');
  const res = (await call(
    tool,
    {
      week_start: '2026-05-08',
      week_end: '2026-05-14',
      content_md: '# w4',
      adherence_pct: 88.5,
      sessions_done: 3,
      sessions_planned: 4,
      sleep_avg_h: 7.2,
      weight_avg_kg: 79.1,
      weight_delta_kg: -0.4,
      decisions_summary: 'hold calories',
      source_conversation_id: 55,
    },
    db
  )) as { review_number: number };
  assert.equal(res.review_number, 4);
  const ins = calls.find((c) => isInsertInto(c.sql, 'weekly_reviews'))!;
  assert.equal(ins.params[1], 4);
  assert.equal(ins.params[5], 88.5); // adherence_pct
});
