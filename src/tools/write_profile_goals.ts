/**
 * write_profile_goals.ts — Phase 5 (T017) profile patch + goals lifecycle.
 *
 * FOUR concerns, all bound to ctx.userId (never a user_id param):
 *
 *   1. update_profile_fields(fields) — UPSERT the existing (user_id) row of
 *      user_profiles, WHITELISTING only the AI-editable fields (review
 *      preferences, plan flags, free-form note, metadata). The anagrafica
 *      (display_name/sex/birth_date/height_cm) is OWNED by the user via
 *      onboarding and is intentionally EXCLUDED — even if the agent tries to
 *      send it, the strict zod schema rejects the unknown key loudly. Any
 *      whitelisted enum'd field (review_week_start_dow) is range-checked before
 *      it can hit the DB CHECK.
 *
 *   2. create_goal(...) — INSERT into goals. triage_class validated against the
 *      CHECK enum (nutritional|psychological|medical|training); the proxy
 *      all-or-none rule (proxy_metric present-or-absent together with
 *      proxy_target_value) is enforced in code → ValidationError BEFORE the DB
 *      CHECK goals_proxy_all_or_none ever fires.
 *
 *   3. update_goal(id, ...) / set_goal_status(id, status) — partial edits +
 *      status transition (active|resolved|abandoned). requireOwned first;
 *      cross-tenant id => NotFound, zero writes. update_goal re-checks the proxy
 *      all-or-none against the MERGED (existing + patch) row so a partial patch
 *      can never leave the goal in a half-proxy state.
 *
 *   4. set_intake_profile(...) — UPSERT the ONBOARDING-OWNED anagrafica/goal
 *      fields of the existing (user_id) row of user_profiles, for the "cold"
 *      genesis branch that needs to populate what the nutrition-coach + program
 *      builder consume. WHITELIST: display_name, sex, birth_date, height_cm,
 *      work_activity, training_days_per_week, main_goal, diet_style,
 *      food_restrictions. These are intentionally DISJOINT from concern (1):
 *      update_profile_fields rejects them, this tool owns them. The enum'd
 *      fields (sex, work_activity, main_goal, diet_style) are zod-validated so a
 *      bad value is a clean ValidationError, not the DB CHECK's DbError — even
 *      where the DB column type is a permissive string;
 *      birth_date may not be in the future; height_cm is bound 80..250;
 *      training_days_per_week is 0..14. Weight is NOT here — it flows through
 *      log_daily_metrics. The row must already exist (created at signup) → an
 *      UPDATE of 0 rows ⇒ NotFound (no INSERT logic).
 *
 * Tables: user_profiles (UPSERT on the PK user_id), goals.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { requireOwned } from '../ownership.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { Queryable } from '../db.js';

// ── enums (mirror the DB CHECK constraints) ───────────────────────────────────

const TRIAGE_CLASSES = [
  'nutritional',
  'psychological',
  'medical',
  'training',
] as const;
const GOAL_STATUSES = ['active', 'resolved', 'abandoned'] as const;

const goalId = z.number().int().positive();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

// ── update_profile_fields ─────────────────────────────────────────────────────

/**
 * The WHITELIST of AI-editable user_profiles columns. Anything outside this set
 * (especially anagrafica: display_name/sex/birth_date/height_cm) is rejected by
 * the strict schema. review_week_start_dow is range-checked (0..6) to pre-empt
 * the DB CHECK.
 */
const profileFields = z
  .object({
    request_initial_training_plan: z.boolean().optional(),
    request_initial_nutrition_plan: z.boolean().optional(),
    review_week_start_dow: z
      .number()
      .int()
      .min(0, 'review_week_start_dow must be 0..6 (0=Sun..6=Sat)')
      .max(6, 'review_week_start_dow must be 0..6 (0=Sun..6=Sat)')
      .nullable()
      .optional(),
    free_form_note: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()
  .refine((f) => Object.keys(f).length > 0, 'at least one field required');

/** The column names this tool is allowed to write (single source of truth). */
const PROFILE_WHITELIST = [
  'request_initial_training_plan',
  'request_initial_nutrition_plan',
  'review_week_start_dow',
  'free_form_note',
  'metadata',
] as const;

const updateProfileFieldsTool = defineTool({
  name: 'update_profile_fields',
  description:
    'UPSERT the AI-editable fields of the bound user_profiles row (PK user_id). ' +
    'Whitelist ONLY: request_initial_training_plan, request_initial_nutrition_plan, ' +
    'review_week_start_dow (0=Sun..6=Sat or null), free_form_note, metadata. ' +
    'Anagrafica (display_name/sex/birth_date/height_cm) is owned by the user via ' +
    'onboarding and is rejected (strict schema). review_week_start_dow is ' +
    'range-checked before the DB CHECK. The row must already exist (created at ' +
    'onboarding); if it does not, an UPDATE affects 0 rows => NotFound.',
  inputSchema: z.object({ fields: profileFields }).strict(),
  handler: async (input, ctx: ToolCtx) => {
    const f = input.fields as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    for (const col of PROFILE_WHITELIST) {
      if (f[col] === undefined) continue;
      if (col === 'metadata') {
        sets.push(`${col} = $${i++}`);
        params.push(f[col] === null ? null : JSON.stringify(f[col]));
      } else {
        sets.push(`${col} = $${i++}`);
        params.push(f[col]);
      }
    }
    // updated_at is maintained by the user_profiles_set_updated_at trigger.
    params.push(ctx.userId);
    const rows = await ctx.db.query<{ user_id: string }>(
      `UPDATE user_profiles SET ${sets.join(', ')}
        WHERE user_id = $${i}
        RETURNING user_id`,
      params
    );
    if (rows.length === 0) {
      throw new NotFoundError(
        `user_profiles row for the bound user does not exist (created at onboarding).`,
        { user_id: ctx.userId }
      );
    }
    return { updated: true, fields: Object.keys(f) };
  },
});

// ── proxy all-or-none guard (shared) ───────────────────────────────────────────

/**
 * Enforce the goals_proxy_all_or_none invariant in code, BEFORE the DB CHECK:
 * proxy_metric and proxy_target_value must be present-or-absent together.
 * `null` counts as absent. Throws ValidationError if exactly one is present.
 */
function assertProxyAllOrNone(
  proxyMetric: string | null,
  proxyTargetValue: number | null
): void {
  const metricPresent = proxyMetric !== null && proxyMetric !== undefined;
  const valuePresent =
    proxyTargetValue !== null && proxyTargetValue !== undefined;
  if (metricPresent !== valuePresent) {
    throw new ValidationError(
      'proxy is all-or-none: proxy_metric and proxy_target_value must both be ' +
        'present or both absent.',
      { proxy_metric: proxyMetric, proxy_target_value: proxyTargetValue }
    );
  }
}

// ── create_goal ────────────────────────────────────────────────────────────────

const createGoalTool = defineTool({
  name: 'create_goal',
  description:
    'Create a goal (qualitative destination in the user words). triage_class is ' +
    'validated against the enum (nutritional|psychological|medical|training). The ' +
    'proxy is ALL-OR-NONE: proxy_metric and proxy_target_value must both be present ' +
    'or both absent (enforced in code before the DB CHECK). proxy_target_date is ' +
    'optional even when the proxy is set. status defaults to "active".',
  inputSchema: z
    .object({
      user_words: z.string().min(1),
      triage_class: z.enum(TRIAGE_CLASSES),
      mechanism_hypothesis: z.string().nullable().optional(),
      proxy_metric: z.string().min(1).nullable().optional(),
      proxy_target_value: z.number().nullable().optional(),
      proxy_target_date: isoDate.nullable().optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const proxyMetric = input.proxy_metric ?? null;
    const proxyTargetValue = input.proxy_target_value ?? null;
    assertProxyAllOrNone(proxyMetric, proxyTargetValue);

    const rows = await ctx.db.query<{ id: number }>(
      `INSERT INTO goals
          (user_id, user_words, triage_class, mechanism_hypothesis,
           proxy_metric, proxy_target_value, proxy_target_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        ctx.userId,
        input.user_words,
        input.triage_class,
        input.mechanism_hypothesis ?? null,
        proxyMetric,
        proxyTargetValue,
        input.proxy_target_date ?? null,
      ]
    );
    return { goal_id: rows[0].id, status: 'active' as const };
  },
});

// ── update_goal ────────────────────────────────────────────────────────────────

interface GoalProxyRow {
  proxy_metric: string | null;
  proxy_target_value: number | string | null;
}

const updateGoalFields = z
  .object({
    user_words: z.string().min(1).optional(),
    triage_class: z.enum(TRIAGE_CLASSES).optional(),
    mechanism_hypothesis: z.string().nullable().optional(),
    proxy_metric: z.string().min(1).nullable().optional(),
    proxy_target_value: z.number().nullable().optional(),
    proxy_target_date: isoDate.nullable().optional(),
  })
  .strict()
  .refine((f) => Object.keys(f).length > 0, 'at least one field required');

const updateGoalTool = defineTool({
  name: 'update_goal',
  description:
    'Patch a goal (user_words/triage_class/mechanism_hypothesis/proxy_metric/' +
    'proxy_target_value/proxy_target_date). Only the provided fields change. ' +
    'triage_class re-validated against the enum. The proxy all-or-none rule is ' +
    're-checked against the MERGED (existing + patch) row, so a partial patch can ' +
    'never leave a half-proxy. requireOwned first; cross-tenant id => NotFound, ' +
    'zero writes. Use set_goal_status for the status lifecycle.',
  inputSchema: z
    .object({ id: goalId, fields: updateGoalFields })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.id,
      table: 'goals',
      idColumn: 'id',
      label: 'goal',
    });

    return ctx.db.tx(async (tx: Queryable) => {
      // Load the current proxy so we can validate the MERGED state.
      const before = await tx.queryOne<GoalProxyRow>(
        `SELECT proxy_metric, proxy_target_value FROM goals
          WHERE id = $1 AND user_id = $2`,
        [input.id, ctx.userId]
      );
      if (before === null) {
        throw new NotFoundError(`goal ${input.id} not found.`, { id: input.id });
      }

      const f = input.fields;
      const mergedMetric =
        f.proxy_metric !== undefined ? f.proxy_metric : before.proxy_metric;
      const mergedValue =
        f.proxy_target_value !== undefined
          ? f.proxy_target_value
          : before.proxy_target_value === null
            ? null
            : Number(before.proxy_target_value);
      assertProxyAllOrNone(mergedMetric, mergedValue);

      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      const push = (col: string, val: unknown) => {
        sets.push(`${col} = $${i++}`);
        params.push(val);
      };
      if (f.user_words !== undefined) push('user_words', f.user_words);
      if (f.triage_class !== undefined) push('triage_class', f.triage_class);
      if (f.mechanism_hypothesis !== undefined)
        push('mechanism_hypothesis', f.mechanism_hypothesis);
      if (f.proxy_metric !== undefined) push('proxy_metric', f.proxy_metric);
      if (f.proxy_target_value !== undefined)
        push('proxy_target_value', f.proxy_target_value);
      if (f.proxy_target_date !== undefined)
        push('proxy_target_date', f.proxy_target_date);

      params.push(input.id, ctx.userId);
      const rows = await tx.query<{ id: number }>(
        `UPDATE goals SET ${sets.join(', ')}
          WHERE id = $${i++} AND user_id = $${i}
          RETURNING id`,
        params
      );
      if (rows.length === 0) {
        throw new NotFoundError(`goal ${input.id} not found.`, { id: input.id });
      }
      return { goal_id: input.id, updated: true };
    });
  },
});

// ── set_goal_status ─────────────────────────────────────────────────────────────

const setGoalStatusTool = defineTool({
  name: 'set_goal_status',
  description:
    'Set a goal status (active|resolved|abandoned). status validated against the ' +
    'enum. requireOwned first; cross-tenant id => NotFound, zero writes.',
  inputSchema: z
    .object({ id: goalId, status: z.enum(GOAL_STATUSES) })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.id,
      table: 'goals',
      idColumn: 'id',
      label: 'goal',
    });
    const rows = await ctx.db.query<{ id: number }>(
      `UPDATE goals SET status = $1
        WHERE id = $2 AND user_id = $3
        RETURNING id`,
      [input.status, input.id, ctx.userId]
    );
    if (rows.length === 0) {
      throw new NotFoundError(`goal ${input.id} not found.`, { id: input.id });
    }
    return { goal_id: input.id, status: input.status };
  },
});

// ── set_intake_profile ──────────────────────────────────────────────────────

const SEXES = ['male', 'female', 'unspecified'] as const;
const WORK_ACTIVITIES = [
  'office_sedentary',
  'home_sedentary',
  'mixed',
  'manual',
  'shift_worker',
] as const;
const MAIN_GOALS = [
  'lose_weight',
  'gain_mass',
  'recomp',
  'performance',
  'general_health',
] as const;
const DIET_STYLES = [
  'omnivore',
  'vegetarian',
  'vegan',
  'pescatarian',
  'flexitarian',
  'keto',
  'mediterranean',
  'other',
] as const;

/**
 * The WHITELIST of onboarding-owned user_profiles columns this tool writes
 * (single source of truth). DISJOINT from PROFILE_WHITELIST: update_profile_fields
 * rejects these, set_intake_profile owns them. food_restrictions is a Postgres
 * text[] column — the JS array is passed straight as a param (pg handles text[]),
 * never JSON.stringify'd.
 */
const INTAKE_WHITELIST = [
  'display_name',
  'sex',
  'birth_date',
  'height_cm',
  'work_activity',
  'training_days_per_week',
  'main_goal',
  'diet_style',
  'food_restrictions',
] as const;

const intakeFields = z
  .object({
    display_name: z.string().optional(),
    sex: z.enum(SEXES).optional(),
    birth_date: isoDate
      .refine(
        (d) => d <= new Date().toISOString().slice(0, 10),
        'birth_date must not be in the future'
      )
      .optional(),
    height_cm: z
      .number()
      .min(80, 'height_cm must be 80..250')
      .max(250, 'height_cm must be 80..250')
      .optional(),
    work_activity: z.enum(WORK_ACTIVITIES).optional(),
    training_days_per_week: z
      .number()
      .int()
      .min(0, 'training_days_per_week must be 0..14')
      .max(14, 'training_days_per_week must be 0..14')
      .optional(),
    main_goal: z.enum(MAIN_GOALS).optional(),
    diet_style: z.enum(DIET_STYLES).optional(),
    food_restrictions: z.array(z.string()).optional(),
  })
  .strict()
  .refine((f) => Object.keys(f).length > 0, 'at least one field required');

const setIntakeProfileTool = defineTool({
  name: 'set_intake_profile',
  description:
    'UPSERT the ONBOARDING-OWNED anagrafica/goal fields of the bound ' +
    'user_profiles row (PK user_id) — for the "cold" genesis branch that ' +
    'populates what the nutrition-coach + program builder consume. Whitelist ' +
    'ONLY: display_name, sex (male|female|unspecified), birth_date ' +
    '(YYYY-MM-DD, not in the future), height_cm (80..250), work_activity ' +
    '(office_sedentary|home_sedentary|mixed|manual|shift_worker), ' +
    'training_days_per_week (0..14), main_goal ' +
    '(lose_weight|gain_mass|recomp|performance|general_health), diet_style ' +
    '(omnivore|vegetarian|vegan|pescatarian|flexitarian|keto|mediterranean|' +
    'other), food_restrictions (string[]). user_id is server-bound (never a ' +
    'param). ' +
    'Strict schema: unknown keys are rejected loudly. Weight is NOT here — it ' +
    'goes via log_daily_metrics. The row must already exist (created at ' +
    'signup); if it does not, an UPDATE affects 0 rows => NotFound.',
  inputSchema: z.object({ fields: intakeFields }).strict(),
  handler: async (input, ctx: ToolCtx) => {
    const f = input.fields as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    for (const col of INTAKE_WHITELIST) {
      if (f[col] === undefined) continue;
      // food_restrictions is a text[] column — pass the JS array directly.
      sets.push(`${col} = $${i++}`);
      params.push(f[col]);
    }
    // updated_at is maintained by the user_profiles_set_updated_at trigger.
    params.push(ctx.userId);
    const rows = await ctx.db.query<{ user_id: string }>(
      `UPDATE user_profiles SET ${sets.join(', ')}
        WHERE user_id = $${i}
        RETURNING user_id`,
      params
    );
    if (rows.length === 0) {
      throw new NotFoundError(
        `user_profiles row for the bound user does not exist (created at signup).`,
        { user_id: ctx.userId }
      );
    }
    return { updated: true, fields: Object.keys(f) };
  },
});

export const writeProfileGoalsTools: AnyToolModule[] = [
  updateProfileFieldsTool,
  createGoalTool,
  updateGoalTool,
  setGoalStatusTool,
  setIntakeProfileTool,
];

// Reused by write_planning.ts (FK ownership of goal_id) and tests.
export { isoDate, PROFILE_WHITELIST, INTAKE_WHITELIST, assertProxyAllOrNone };
