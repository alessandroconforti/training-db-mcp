/**
 * write_session_log.ts — Phase 4 (T012) session logging.
 *
 * Two tools:
 *   - log_session: writes a `sessions` row. The "sessions exception": a session
 *     for a date may already exist (a sleep-only row created by the daily-metrics
 *     flow, or a
 *     prior workout). So we SELECT-first by (date, user) and UPDATE/enrich the
 *     existing row, otherwise INSERT. Returns the session_id.
 *   - log_session_exercise: appends a `session_exercises` row to an owned session.
 *     `total_reps` is denormalized = sum(reps_array), computed in this layer.
 *
 * sessions has no own historization; it is a plain mutable table. There is also
 * NO uniqueness on sessions.date, so the SELECT picks the lowest-id row for the
 * date (matching the app) and enriches it.
 *
 * Hard rules: no user_id param (bound from ctx); requireOwned on session_id
 * before inserting a child exercise; cross-tenant id => NotFound; UTC dates only
 * (the date is always passed in by the caller, never CURRENT_DATE server-side).
 *
 * Tables: sessions, session_exercises.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { requireOwned } from '../ownership.js';
import type { Queryable } from '../db.js';
import {
  isoDate,
  weightArray,
  orderNum,
  assertExerciseExists,
} from './write_exercise_versioned.js';

const sessionId = z.number().int().positive();
const exerciseId = z.number().int().positive();
const repsArray = z.array(z.number().int().min(0).max(1000)).min(1);

/**
 * Shared sleep/body-weight enrich for a date's sessions row. SELECT-first the
 * lowest-id session of (user, date); if present UPDATE only the provided
 * sleep/body-weight fields, else INSERT a minimal sleep-only row (day_type NULL,
 * duration_min 0). Returns { session_id, created }.
 *
 * Mirrors app `logDailyMetricsAction` semantics. Used by both log_session and
 * log_daily_metrics (T013).
 */
export async function enrichOrCreateSession(
  db: Queryable,
  userId: string,
  date: string,
  fields: {
    day_type?: string | null;
    start_time?: string | null;
    end_time?: string | null;
    duration_min?: number | null;
    sleep_h?: number | null;
    body_weight_kg?: number | null;
    condition?: string | null;
    notes_text?: string | null;
  }
): Promise<{ session_id: number; created: boolean }> {
  const existing = await db.queryOne<{ id: number }>(
    `SELECT id FROM sessions
      WHERE user_id = $1 AND date = $2
      ORDER BY id ASC LIMIT 1`,
    [userId, date]
  );

  // Build the column set from only the provided fields (undefined => omit).
  const cols: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, value: unknown) => {
    if (value !== undefined) {
      cols.push(col);
      vals.push(value);
    }
  };
  add('day_type', fields.day_type);
  add('start_time', fields.start_time);
  add('end_time', fields.end_time);
  add('duration_min', fields.duration_min);
  add('sleep_h', fields.sleep_h);
  add('body_weight_kg', fields.body_weight_kg);
  add('condition', fields.condition);
  add('notes_text', fields.notes_text);

  if (existing) {
    if (cols.length > 0) {
      const setSql = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      vals.push(existing.id, userId);
      await db.query(
        `UPDATE sessions SET ${setSql}
          WHERE id = $${cols.length + 1} AND user_id = $${cols.length + 2}`,
        vals
      );
    }
    return { session_id: existing.id, created: false };
  }

  // INSERT a fresh row. user_id + date always; duration_min defaults to 0 for a
  // sleep-only row unless explicitly provided. day_type stays NULL unless given.
  const insertCols = ['user_id', 'date'];
  const insertVals: unknown[] = [userId, date];
  const addIns = (col: string, value: unknown, fallback?: unknown) => {
    if (value !== undefined) {
      insertCols.push(col);
      insertVals.push(value);
    } else if (fallback !== undefined) {
      insertCols.push(col);
      insertVals.push(fallback);
    }
  };
  addIns('day_type', fields.day_type);
  addIns('start_time', fields.start_time);
  addIns('end_time', fields.end_time);
  addIns('duration_min', fields.duration_min, 0);
  addIns('sleep_h', fields.sleep_h);
  addIns('body_weight_kg', fields.body_weight_kg);
  addIns('condition', fields.condition);
  addIns('notes_text', fields.notes_text);

  const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await db.query<{ id: number }>(
    `INSERT INTO sessions (${insertCols.join(', ')})
     VALUES (${placeholders}) RETURNING id`,
    insertVals
  );
  return { session_id: rows[0].id, created: true };
}

// ── log_session ────────────────────────────────────────────────────────────────

const logSessionTool = defineTool({
  name: 'log_session',
  description:
    'Log a training session for a date (sessions exception): SELECT an existing ' +
    'session for (user, date) and UPDATE/enrich it if present (e.g. a sleep-only ' +
    'row already created by daily-metrics), otherwise INSERT a new row. Only the ' +
    'provided fields are written. Returns { session_id, created }. day_type NULL = ' +
    'rest / sleep-only. Dates are UTC ISO (never CURRENT_DATE).',
  inputSchema: z
    .object({
      date: isoDate,
      day_type: z.string().nullable().optional(),
      start_time: z.string().nullable().optional(),
      end_time: z.string().nullable().optional(),
      duration_min: z.number().int().min(0).nullable().optional(),
      sleep_h: z.number().min(0).max(24).nullable().optional(),
      body_weight_kg: z.number().min(0).max(400).nullable().optional(),
      condition: z.string().nullable().optional(),
      notes_text: z.string().nullable().optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const { date, ...fields } = input;
    const res = await enrichOrCreateSession(ctx.db, ctx.userId, date, fields);
    return { session_id: res.session_id, created: res.created };
  },
});

// ── log_session_exercise ─────────────────────────────────────────────────────

const logSessionExerciseTool = defineTool({
  name: 'log_session_exercise',
  description:
    'Append an executed exercise (session_exercises row) to an owned session. ' +
    'total_reps is denormalized = sum(reps_array), computed server-side. ' +
    'weight_array is per-set load (length 1 = same weight all sets, NULL = ' +
    'bodyweight). linked_program_exercise_id ties the executed row to the planned ' +
    'program_exercises version. Cross-tenant session_id => NotFound, zero writes.',
  inputSchema: z
    .object({
      session_id: sessionId,
      exercise_id: exerciseId,
      order_num: orderNum,
      weight_array: weightArray.nullable().optional(),
      reps_array: repsArray.nullable().optional(),
      rpe: z.number().min(0).max(10).nullable().optional(),
      notes_text: z.string().nullable().optional(),
      linked_program_exercise_id: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.session_id,
      table: 'sessions',
      idColumn: 'id',
      label: 'session',
    });

    // FIX 2: validate exercise_id against the catalog accessibility predicate
    // (created_by IS NULL OR created_by = $userId) — same check add_exercise /
    // swap_exercise apply before writing a program_exercises row. A cross-tenant
    // or non-existent exercise_id => ValidationError, zero writes.
    await assertExerciseExists(ctx.db, ctx.userId, input.exercise_id);

    // FIX 1: when linking an executed row to a planned program_exercises version,
    // verify that the linked program_exercise belongs to the bound user. Without
    // this the FK could point at another tenant's planned row. Cross-tenant id =>
    // NotFound, zero writes.
    if (
      input.linked_program_exercise_id !== null &&
      input.linked_program_exercise_id !== undefined
    ) {
      await requireOwned({
        db: ctx.db,
        userId: ctx.userId,
        idValue: input.linked_program_exercise_id,
        table: 'program_exercises',
        idColumn: 'id',
        label: 'program_exercise',
      });
    }

    const repsArr = input.reps_array ?? null;
    const totalReps =
      repsArr === null ? null : repsArr.reduce((acc, n) => acc + n, 0);

    // session_exercises is a per-user table (user_id uuid NOT NULL). The MCP
    // connects via a raw pg pooler (auth.uid() is NULL), so user_id must be
    // stamped explicitly from ctx — mirroring the app's own insert
    // (app/scheda/actions.ts: user_id: user.id). Omitting it either fails the
    // NOT NULL constraint or writes an unattributable, read-invisible row.
    const rows = await ctx.db.query<{ id: number }>(
      `INSERT INTO session_exercises
          (user_id, session_id, exercise_id, order_num, weight_array, reps_array,
           total_reps, rpe, notes_text, linked_program_exercise_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        ctx.userId,
        input.session_id,
        input.exercise_id,
        input.order_num,
        input.weight_array ?? null,
        repsArr,
        totalReps,
        input.rpe ?? null,
        input.notes_text ?? null,
        input.linked_program_exercise_id ?? null,
      ]
    );

    return { session_exercise_id: rows[0].id, total_reps: totalReps };
  },
});

export const writeSessionLogTools: AnyToolModule[] = [
  logSessionTool,
  logSessionExerciseTool,
];
