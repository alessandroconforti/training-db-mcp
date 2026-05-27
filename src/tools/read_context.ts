/**
 * read_context.ts — Phase 1 (T005) read-only context tools.
 *
 * Every tool is user_id-scoped: the bound userId comes only from ctx (never an
 * input parameter). Every SELECT injects `WHERE user_id = $N` as a bound param.
 *
 * Catalog tables (exercises/foods) read open; the search_* tools additionally
 * surface `created_by IS NULL` seed rows plus the bound user's own rows — these
 * resolve exercise_id/food_id for later add/log tools (Phase 3/4 contract).
 *
 * Bitemporal reads:
 *   - current        : valid_to IS NULL
 *   - as_of_date = D : valid_from <= D AND (valid_to IS NULL OR valid_to > D)
 *
 * Shapes are coherent with lib/database.types.ts.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { NotFoundError, ValidationError } from '../errors.js';

// ── shared validators ────────────────────────────────────────────────────────

/** ISO date string YYYY-MM-DD (no time component). */
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be ISO YYYY-MM-DD');

const limitSchema = z.number().int().min(1).max(500).optional();

/**
 * Resolve the current (active) program id for the bound user, or null.
 * Active = ended_on IS NULL. If several somehow exist, pick the latest started.
 */
async function currentProgramId(ctx: ToolCtx): Promise<number | null> {
  const row = await ctx.db.queryOne<{ id: number }>(
    `SELECT id FROM programs
       WHERE user_id = $1 AND ended_on IS NULL
       ORDER BY started_on DESC, id DESC
       LIMIT 1`,
    [ctx.userId]
  );
  return row?.id ?? null;
}

// ── get_current_program ───────────────────────────────────────────────────────

const getCurrentProgramTool = defineTool({
  name: 'get_current_program',
  description:
    'Return the active program row (ended_on IS NULL) for the bound user, or null.',
  inputSchema: z.object({}).strict(),
  handler: async (_input, ctx) =>
    ctx.db.queryOne(
      `SELECT id, user_id, name, description, started_on, ended_on,
              philosophy_md_path, created_at
         FROM programs
         WHERE user_id = $1 AND ended_on IS NULL
         ORDER BY started_on DESC, id DESC
         LIMIT 1`,
      [ctx.userId]
    ),
});

// ── get_scheda ────────────────────────────────────────────────────────────────

const getSchedaTool = defineTool({
  name: 'get_scheda',
  description:
    'Return a program scheda: program row, its days (program_days), the exercises ' +
    'valid now (valid_to IS NULL) — or reconstructed at as_of_date — and per-day ' +
    'notes (program_day_notes.ai_notes_text + decided_rules). Defaults to the ' +
    'current program when program_id is omitted.',
  inputSchema: z
    .object({
      program_id: z.number().int().positive().optional(),
      as_of_date: dateStr.optional(),
    })
    .strict(),
  handler: async (input, ctx) => {
    const programId =
      input.program_id ?? (await currentProgramId(ctx));
    if (programId == null) {
      throw new NotFoundError('No active program for the current user.');
    }

    const program = await ctx.db.queryOne(
      `SELECT id, user_id, name, description, started_on, ended_on,
              philosophy_md_path, created_at
         FROM programs WHERE id = $1 AND user_id = $2`,
      [programId, ctx.userId]
    );
    if (program === null) {
      throw new NotFoundError(`Program ${programId} not found for the current user.`, {
        program_id: programId,
      });
    }

    const days = await ctx.db.query(
      `SELECT id, user_id, program_id, day_type, display_name, weekday, created_at
         FROM program_days
         WHERE user_id = $1 AND program_id = $2
         ORDER BY COALESCE(weekday, 99), day_type`,
      [ctx.userId, programId]
    );

    // Exercises: current (valid_to IS NULL) or reconstructed at as_of_date.
    const asOf = input.as_of_date ?? null;
    const exercises = await ctx.db.query(
      `SELECT pe.id, pe.user_id, pe.program_id, pe.day_type, pe.order_num,
              pe.exercise_id, e.canonical_name AS exercise_name,
              pe.sets, pe.reps_min, pe.reps_max,
              pe.current_weight_array, pe.target_weight_kg, pe.rest_sec,
              pe.valid_from, pe.valid_to, pe.metadata,
              pe.ai_notes_text, pe.alternative_exercise_text, pe.created_at
         FROM program_exercises pe
         JOIN exercises e ON e.id = pe.exercise_id
         WHERE pe.user_id = $1 AND pe.program_id = $2
           AND ($3::date IS NULL
                AND pe.valid_to IS NULL
                OR $3::date IS NOT NULL
                AND pe.valid_from <= $3::date
                AND (pe.valid_to IS NULL OR pe.valid_to > $3::date))
         ORDER BY pe.day_type, pe.order_num`,
      [ctx.userId, programId, asOf]
    );

    const dayNotes = await ctx.db.query(
      `SELECT user_id, program_id, day_type, ai_notes_text, decided_rules, generated_at
         FROM program_day_notes
         WHERE user_id = $1 AND program_id = $2`,
      [ctx.userId, programId]
    );

    return {
      meta: { program_id: programId, as_of_date: asOf },
      program,
      program_days: days,
      exercises,
      day_notes: dayNotes,
    };
  },
});

// ── get_day_notes ─────────────────────────────────────────────────────────────

const getDayNotesTool = defineTool({
  name: 'get_day_notes',
  description:
    'Return program_day_notes (ai_notes_text + decided_rules) for a specific ' +
    'day_type of a program (defaults to the current program). Null if none set.',
  inputSchema: z
    .object({
      day_type: z.string().min(1),
      program_id: z.number().int().positive().optional(),
    })
    .strict(),
  handler: async (input, ctx) => {
    const programId = input.program_id ?? (await currentProgramId(ctx));
    if (programId == null) {
      throw new NotFoundError('No active program for the current user.');
    }
    return ctx.db.queryOne(
      `SELECT user_id, program_id, day_type, ai_notes_text, decided_rules, generated_at
         FROM program_day_notes
         WHERE user_id = $1 AND program_id = $2 AND day_type = $3`,
      [ctx.userId, programId, input.day_type]
    );
  },
});

// ── get_session ───────────────────────────────────────────────────────────────

const getSessionTool = defineTool({
  name: 'get_session',
  description:
    'Return a session row + its session_exercises (with exercise canonical_name). ' +
    'NotFound if the session does not belong to the bound user.',
  inputSchema: z.object({ session_id: z.number().int().positive() }).strict(),
  handler: async (input, ctx) => {
    const session = await ctx.db.queryOne(
      `SELECT id, user_id, date, program_id, day_type, start_time, end_time,
              duration_min, sleep_h, body_weight_kg, condition, notes_text,
              metadata, ai_notes_text, created_at
         FROM sessions WHERE id = $1 AND user_id = $2`,
      [input.session_id, ctx.userId]
    );
    if (session === null) {
      throw new NotFoundError(
        `Session ${input.session_id} not found for the current user.`,
        { session_id: input.session_id }
      );
    }
    const exercises = await ctx.db.query(
      `SELECT se.id, se.user_id, se.session_id, se.exercise_id,
              e.canonical_name AS exercise_name, se.order_num,
              se.weight_array, se.reps_array, se.total_reps, se.rpe,
              se.notes_text, se.linked_program_exercise_id, se.metadata,
              se.ai_notes_text, se.created_at
         FROM session_exercises se
         JOIN exercises e ON e.id = se.exercise_id
         WHERE se.user_id = $1 AND se.session_id = $2
         ORDER BY se.order_num`,
      [ctx.userId, input.session_id]
    );
    return { session, exercises };
  },
});

// ── list_sessions ─────────────────────────────────────────────────────────────

const listSessionsTool = defineTool({
  name: 'list_sessions',
  description:
    'List sessions newest-first for the bound user, optionally filtered by day_type. ' +
    'Default limit 20 (max 500).',
  inputSchema: z
    .object({
      day_type: z.string().min(1).optional(),
      limit: limitSchema,
    })
    .strict(),
  handler: async (input, ctx) => {
    const limit = input.limit ?? 20;
    return ctx.db.query(
      `SELECT id, user_id, date, program_id, day_type, start_time, end_time,
              duration_min, sleep_h, body_weight_kg, condition, notes_text,
              ai_notes_text, created_at
         FROM sessions
         WHERE user_id = $1 AND ($2::text IS NULL OR day_type = $2)
         ORDER BY date DESC, COALESCE(end_time, start_time, '00:00') DESC, id DESC
         LIMIT $3`,
      [ctx.userId, input.day_type ?? null, limit]
    );
  },
});

// ── get_exercise_history ──────────────────────────────────────────────────────

const getExerciseHistoryTool = defineTool({
  name: 'get_exercise_history',
  description:
    'Return the last N executions (session_exercises joined to sessions) of a given ' +
    'exercise_id for the bound user, newest-first. Default limit 5 (max 500).',
  inputSchema: z
    .object({
      exercise_id: z.number().int().positive(),
      limit: limitSchema,
    })
    .strict(),
  handler: async (input, ctx) => {
    const limit = input.limit ?? 5;
    return ctx.db.query(
      `SELECT s.date, s.day_type, se.id AS se_id, se.session_id,
              se.weight_array, se.reps_array, se.total_reps, se.rpe,
              se.notes_text, se.linked_program_exercise_id, se.ai_notes_text
         FROM session_exercises se
         JOIN sessions s ON s.id = se.session_id AND s.user_id = se.user_id
         WHERE se.user_id = $1 AND se.exercise_id = $2
         ORDER BY s.date DESC, COALESCE(s.end_time, s.start_time, '00:00') DESC, se.id DESC
         LIMIT $3`,
      [ctx.userId, input.exercise_id, limit]
    );
  },
});

// ── list_problems ─────────────────────────────────────────────────────────────

const listProblemsTool = defineTool({
  name: 'list_problems',
  description:
    'List problems for the bound user, optionally filtered by status. Ordered by ' +
    'severity desc then id.',
  inputSchema: z.object({ status: z.string().min(1).optional() }).strict(),
  handler: async (input, ctx) =>
    ctx.db.query(
      `SELECT id, user_id, title, status, severity, started_on, resolved_on,
              description, management, related_exercises, metadata,
              created_at, updated_at
         FROM problems
         WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
         ORDER BY severity DESC NULLS LAST, id`,
      [ctx.userId, input.status ?? null]
    ),
});

// ── get_user_profile ──────────────────────────────────────────────────────────

const getUserProfileTool = defineTool({
  name: 'get_user_profile',
  description: 'Return the user_profiles row for the bound user (or null).',
  inputSchema: z.object({}).strict(),
  handler: async (_input, ctx) =>
    ctx.db.queryOne(`SELECT * FROM user_profiles WHERE user_id = $1`, [
      ctx.userId,
    ]),
});

// ── list_weight_log ───────────────────────────────────────────────────────────

const listWeightLogTool = defineTool({
  name: 'list_weight_log',
  description:
    'List weight_log rows for the bound user, optionally bounded by from/to dates ' +
    '(inclusive). Ordered by date ascending.',
  inputSchema: z
    .object({ from: dateStr.optional(), to: dateStr.optional() })
    .strict(),
  handler: async (input, ctx) =>
    ctx.db.query(
      `SELECT user_id, date, weight_kg, notes, created_at
         FROM weight_log
         WHERE user_id = $1
           AND ($2::date IS NULL OR date >= $2::date)
           AND ($3::date IS NULL OR date <= $3::date)
         ORDER BY date`,
      [ctx.userId, input.from ?? null, input.to ?? null]
    ),
});

// ── list_food_entries ─────────────────────────────────────────────────────────

const listFoodEntriesTool = defineTool({
  name: 'list_food_entries',
  description:
    'List food_entries (with macro snapshots) for the bound user, optionally for a ' +
    'single date. Ordered by date then id.',
  inputSchema: z.object({ date: dateStr.optional() }).strict(),
  handler: async (input, ctx) =>
    ctx.db.query(
      `SELECT id, user_id, date, meal, food_id, quantity, notes,
              food_name_snapshot, unit_snapshot, reference_qty_snapshot,
              kcal_snapshot, protein_g_snapshot, carbs_g_snapshot, fat_g_snapshot,
              entry_unit, grams_per_piece_snapshot, created_at
         FROM food_entries
         WHERE user_id = $1 AND ($2::date IS NULL OR date = $2::date)
         ORDER BY date, id`,
      [ctx.userId, input.date ?? null]
    ),
});

// ── get_nutrition_days ────────────────────────────────────────────────────────

const getNutritionDaysTool = defineTool({
  name: 'get_nutrition_days',
  description:
    'Return the nutrition_days aggregate view (kcal/macros per day) for the bound ' +
    'user across [from, to] inclusive. Days with no entries are simply absent.',
  inputSchema: z.object({ from: dateStr, to: dateStr }).strict(),
  handler: async (input, ctx) =>
    ctx.db.query(
      `SELECT user_id, date, kcal, protein_g, carbs_g, fat_g, entries_count
         FROM nutrition_days
         WHERE user_id = $1 AND date BETWEEN $2::date AND $3::date
         ORDER BY date`,
      [ctx.userId, input.from, input.to]
    ),
});

// ── get_active_nutrition_phase ────────────────────────────────────────────────

const getActiveNutritionPhaseTool = defineTool({
  name: 'get_active_nutrition_phase',
  description:
    'Return the nutrition_targets phase active at the given date (default: today, ' +
    'as supplied via date) — started_on <= date AND (ended_on IS NULL OR ended_on >= date). ' +
    'If date omitted, returns the most recent open phase. Null if none.',
  inputSchema: z.object({ date: dateStr.optional() }).strict(),
  handler: async (input, ctx) => {
    if (input.date) {
      return ctx.db.queryOne(
        `SELECT id, user_id, phase_name, started_on, ended_on,
                mon_target, tue_target, wed_target, thu_target,
                fri_target, sat_target, sun_target, notes, created_at
           FROM nutrition_targets
           WHERE user_id = $1
             AND started_on <= $2::date
             AND (ended_on IS NULL OR ended_on >= $2::date)
           ORDER BY started_on DESC LIMIT 1`,
        [ctx.userId, input.date]
      );
    }
    return ctx.db.queryOne(
      `SELECT id, user_id, phase_name, started_on, ended_on,
              mon_target, tue_target, wed_target, thu_target,
              fri_target, sat_target, sun_target, notes, created_at
         FROM nutrition_targets
         WHERE user_id = $1 AND ended_on IS NULL
         ORDER BY started_on DESC LIMIT 1`,
      [ctx.userId]
    );
  },
});

// ── list_nutrition_phases ─────────────────────────────────────────────────────

const listNutritionPhasesTool = defineTool({
  name: 'list_nutrition_phases',
  description:
    'List all nutrition_targets phases for the bound user, newest first by started_on.',
  inputSchema: z.object({}).strict(),
  handler: async (_input, ctx) =>
    ctx.db.query(
      `SELECT id, user_id, phase_name, started_on, ended_on,
              mon_target, tue_target, wed_target, thu_target,
              fri_target, sat_target, sun_target, notes, created_at
         FROM nutrition_targets
         WHERE user_id = $1
         ORDER BY started_on DESC, id DESC`,
      [ctx.userId]
    ),
});

// ── list_weekly_reviews ───────────────────────────────────────────────────────

const listWeeklyReviewsTool = defineTool({
  name: 'list_weekly_reviews',
  description:
    'List weekly_reviews for the bound user, newest first by review_number.',
  inputSchema: z.object({}).strict(),
  handler: async (_input, ctx) =>
    ctx.db.query(
      `SELECT id, user_id, review_number, week_start, week_end, adherence_pct,
              sessions_done, sessions_planned, sleep_avg_h, weight_avg_kg,
              weight_delta_kg, review_md_path, decisions_summary, content_md,
              source_conversation_id, created_at
         FROM weekly_reviews
         WHERE user_id = $1
         ORDER BY review_number DESC NULLS LAST, id DESC`,
      [ctx.userId]
    ),
});

// ── get_last_weekly_review ────────────────────────────────────────────────────

const getLastWeeklyReviewTool = defineTool({
  name: 'get_last_weekly_review',
  description:
    'Return the latest weekly_review (highest review_number) for the bound user, or null.',
  inputSchema: z.object({}).strict(),
  handler: async (_input, ctx) =>
    ctx.db.queryOne(
      `SELECT id, user_id, review_number, week_start, week_end, adherence_pct,
              sessions_done, sessions_planned, sleep_avg_h, weight_avg_kg,
              weight_delta_kg, review_md_path, decisions_summary, content_md,
              source_conversation_id, created_at
         FROM weekly_reviews
         WHERE user_id = $1
         ORDER BY review_number DESC NULLS LAST, id DESC
         LIMIT 1`,
      [ctx.userId]
    ),
});

// ── get_current_plan ──────────────────────────────────────────────────────────

const getCurrentPlanTool = defineTool({
  name: 'get_current_plan',
  description:
    'Return the current long_term_plans row (valid_to IS NULL) for the bound user, or null.',
  inputSchema: z.object({}).strict(),
  handler: async (_input, ctx) =>
    ctx.db.queryOne(
      `SELECT id, user_id, title, content_md, valid_from, valid_to, created_at
         FROM long_term_plans
         WHERE user_id = $1 AND valid_to IS NULL
         ORDER BY valid_from DESC, id DESC
         LIMIT 1`,
      [ctx.userId]
    ),
});

// ── list_plan_versions ────────────────────────────────────────────────────────

const listPlanVersionsTool = defineTool({
  name: 'list_plan_versions',
  description:
    'List every long_term_plans version for the bound user, newest first by valid_from.',
  inputSchema: z.object({}).strict(),
  handler: async (_input, ctx) =>
    ctx.db.query(
      `SELECT id, user_id, title, content_md, valid_from, valid_to, created_at
         FROM long_term_plans
         WHERE user_id = $1
         ORDER BY valid_from DESC, id DESC`,
      [ctx.userId]
    ),
});

// ── get_current_roadmap ───────────────────────────────────────────────────────

const getCurrentRoadmapTool = defineTool({
  name: 'get_current_roadmap',
  description:
    'Return the current roadmap row(s) (valid_to IS NULL) for the bound user. ' +
    'If domain is given, returns the single current roadmap for that domain (or null); ' +
    'otherwise returns the array of current roadmaps across domains.',
  inputSchema: z
    .object({ domain: z.enum(['nutrition', 'training']).optional() })
    .strict(),
  handler: async (input, ctx) => {
    if (input.domain) {
      return ctx.db.queryOne(
        `SELECT id, user_id, domain, goal_id, long_term_plan_id, horizon_start,
                horizon_target_date, timeline, valid_from, valid_to, created_at
           FROM roadmap
           WHERE user_id = $1 AND domain = $2 AND valid_to IS NULL
           ORDER BY valid_from DESC, id DESC
           LIMIT 1`,
        [ctx.userId, input.domain]
      );
    }
    return ctx.db.query(
      `SELECT id, user_id, domain, goal_id, long_term_plan_id, horizon_start,
              horizon_target_date, timeline, valid_from, valid_to, created_at
         FROM roadmap
         WHERE user_id = $1 AND valid_to IS NULL
         ORDER BY domain, valid_from DESC, id DESC`,
      [ctx.userId]
    );
  },
});

// ── list_goals ────────────────────────────────────────────────────────────────

const listGoalsTool = defineTool({
  name: 'list_goals',
  description:
    'List goals for the bound user, optionally filtered by status ' +
    '(active|resolved|abandoned). Newest first.',
  inputSchema: z
    .object({
      status: z.enum(['active', 'resolved', 'abandoned']).optional(),
    })
    .strict(),
  handler: async (input, ctx) =>
    ctx.db.query(
      `SELECT id, user_id, user_words, triage_class, mechanism_hypothesis, status,
              proxy_metric, proxy_target_value, proxy_target_date,
              created_at, updated_at
         FROM goals
         WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
         ORDER BY created_at DESC, id DESC`,
      [ctx.userId, input.status ?? null]
    ),
});

// ── list_scheda_changes ───────────────────────────────────────────────────────
//
// Audit trail of scheda edits for the bound user (the table carries its own
// user_id). Optionally narrow to a single program. Newest-first.

const listSchedaChangesTool = defineTool({
  name: 'list_scheda_changes',
  description:
    'List scheda_changes (audit trail of scheda edits) for the bound user, ' +
    'newest first by changed_at. Optionally filtered by program_id. ' +
    'Default limit 50 (max 200).',
  inputSchema: z
    .object({
      program_id: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  handler: async (input, ctx) => {
    const limit = input.limit ?? 50;
    return ctx.db.query(
      `SELECT id, changed_at, change_type, program_id, description,
              affected_before_id, affected_after_id, diff
         FROM scheda_changes
         WHERE user_id = $1 AND ($2::int IS NULL OR program_id = $2)
         ORDER BY changed_at DESC, id DESC
         LIMIT $3`,
      [ctx.userId, input.program_id ?? null, limit]
    );
  },
});

// ── list_nutrition_day_notes ──────────────────────────────────────────────────
//
// Per-day nutrition notes for the bound user (PK (user_id, date)). user_comment
// is the channel where the user leaves symptoms/context for the nutrition coach;
// ai_comment is what the IA wrote back. Optional UTC date range. Newest-first.

const listNutritionDayNotesTool = defineTool({
  name: 'list_nutrition_day_notes',
  description:
    'List nutrition_day_notes for the bound user (per-day ai_comment + ' +
    'user_comment), optionally bounded by from/to dates (inclusive, UTC ISO ' +
    'YYYY-MM-DD). user_comment carries user-left symptoms/context. ' +
    'Ordered by date descending.',
  inputSchema: z
    .object({ from: dateStr.optional(), to: dateStr.optional() })
    .strict(),
  handler: async (input, ctx) =>
    ctx.db.query(
      `SELECT date, ai_comment, user_comment
         FROM nutrition_day_notes
         WHERE user_id = $1
           AND ($2::date IS NULL OR date >= $2::date)
           AND ($3::date IS NULL OR date <= $3::date)
         ORDER BY date DESC`,
      [ctx.userId, input.from ?? null, input.to ?? null]
    ),
});

// ── search_exercises ──────────────────────────────────────────────────────────
//
// Resolution contract (Phase 3/4 depend on this): returns catalog exercises
// matching `query` against canonical_name OR any alias (ILIKE, substring). Only
// rows the bound user may use are returned: seed rows (created_by IS NULL) plus
// the user's own (created_by = userId). Results carry the `id` to feed into
// add_exercise / log_session_exercise / swap_exercise.

const searchExercisesTool = defineTool({
  name: 'search_exercises',
  description:
    'Search the exercises catalog by canonical_name or alias (case-insensitive ' +
    'substring). Returns seed exercises (created_by IS NULL) plus the bound user\'s ' +
    'own. Use the returned id as exercise_id for add/swap/log tools.',
  inputSchema: z.object({ query: z.string().min(1) }).strict(),
  handler: async (input, ctx) => {
    const q = input.query.trim();
    if (q === '') {
      throw new ValidationError('query must be non-empty');
    }
    const like = `%${q}%`;
    return ctx.db.query(
      `SELECT id, canonical_name, aliases, muscle_groups, equipment,
              is_bodyweight, notes, gif_path, created_by, created_at
         FROM exercises
         WHERE (created_by IS NULL OR created_by = $1)
           AND (canonical_name ILIKE $2
                OR EXISTS (
                  SELECT 1 FROM unnest(COALESCE(aliases, ARRAY[]::text[])) AS a
                  WHERE a ILIKE $2))
         ORDER BY (canonical_name ILIKE $2) DESC, canonical_name
         LIMIT 50`,
      [ctx.userId, like]
    );
  },
});

// ── search_foods ──────────────────────────────────────────────────────────────

const searchFoodsTool = defineTool({
  name: 'search_foods',
  description:
    'Search the foods catalog by canonical_name or alias (case-insensitive ' +
    'substring). Returns seed foods (created_by IS NULL) plus the bound user\'s own. ' +
    'Use the returned id as food_id for log_food_entry.',
  inputSchema: z.object({ query: z.string().min(1) }).strict(),
  handler: async (input, ctx) => {
    const q = input.query.trim();
    if (q === '') {
      throw new ValidationError('query must be non-empty');
    }
    const like = `%${q}%`;
    return ctx.db.query(
      `SELECT id, canonical_name, aliases, unit, reference_qty, kcal,
              protein_g, carbs_g, fat_g, grams_per_piece, notes,
              created_by, created_at
         FROM foods
         WHERE (created_by IS NULL OR created_by = $1)
           AND (canonical_name ILIKE $2
                OR EXISTS (
                  SELECT 1 FROM unnest(COALESCE(aliases, ARRAY[]::text[])) AS a
                  WHERE a ILIKE $2))
         ORDER BY (canonical_name ILIKE $2) DESC, canonical_name
         LIMIT 50`,
      [ctx.userId, like]
    );
  },
});

// ── list_observations ───────────────────────────────────────────────────────
//
// Observation store (Flusso 3). User-scoped SELECT over user_observations.
// Default (no status filter) excludes 'superseded' and 'discarded' (returns
// pending + promoted). Ordered by confidence rank (high > medium > low) then
// last_seen DESC — NOT alphabetical confidence DESC. limit default 50, max 200.

const listObservationsTool = defineTool({
  name: 'list_observations',
  description:
    'List user_observations for the bound user. Optional kind / status filters. ' +
    'Without a status filter, excludes superseded + discarded (returns pending + ' +
    'promoted). Ordered by confidence rank (high > medium > low) then last_seen ' +
    'descending. limit default 50, max 200.',
  inputSchema: z
    .object({
      kind: z
        .enum([
          'identity_anthro',
          'lifestyle',
          'training_behavior',
          'nutrition_behavior',
          'goal_hypothesis',
          'problem_signal',
          'preference_taste',
          'personality_communication',
          'life_context',
        ])
        .optional(),
      status: z
        .enum(['pending', 'promoted', 'superseded', 'discarded'])
        .optional(),
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  handler: async (input, ctx) => {
    const limit = input.limit ?? 50;
    return ctx.db.query(
      `SELECT id, user_id, kind, text, confidence, evidence_count, status,
              first_seen, last_seen, source_conversation_id, metadata,
              created_at, updated_at
         FROM user_observations
         WHERE user_id = $1
           AND ($2::text IS NULL OR kind = $2)
           AND ($3::text IS NULL OR status = $3)
           AND ($3::text IS NOT NULL
                OR status NOT IN ('superseded', 'discarded'))
         ORDER BY CASE confidence
                    WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
                  last_seen DESC
         LIMIT $4`,
      [ctx.userId, input.kind ?? null, input.status ?? null, limit]
    );
  },
});

/** All Phase 1 read-context tools (T005). */
export const readContextTools: AnyToolModule[] = [
  getCurrentProgramTool,
  getSchedaTool,
  getDayNotesTool,
  getSessionTool,
  listSessionsTool,
  getExerciseHistoryTool,
  listProblemsTool,
  listSchedaChangesTool,
  listNutritionDayNotesTool,
  getUserProfileTool,
  listWeightLogTool,
  listFoodEntriesTool,
  getNutritionDaysTool,
  getActiveNutritionPhaseTool,
  listNutritionPhasesTool,
  listWeeklyReviewsTool,
  getLastWeeklyReviewTool,
  getCurrentPlanTool,
  listPlanVersionsTool,
  getCurrentRoadmapTool,
  listGoalsTool,
  searchExercisesTool,
  searchFoodsTool,
  listObservationsTool,
];
