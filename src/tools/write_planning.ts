/**
 * write_planning.ts — Phase 5 (T018) long-term plan + roadmap (both bitemporal).
 *
 * Two versioned (bitemporal) citizenships, half-open [valid_from, valid_to):
 *
 *   - long_term_plans: one CURRENT (valid_to IS NULL) plan per user. create_plan
 *     closes the current plan (valid_to = the new valid_from) and inserts the new
 *     current row in ONE db.tx, so the "one current per user" UNIQUE invariant
 *     always holds.
 *
 *   - roadmap: one CURRENT row per (user, domain). create_roadmap closes the
 *     current roadmap for that domain and inserts a new one in one tx; FK targets
 *     goal_id / long_term_plan_id are ownership-checked when provided (cross-
 *     tenant => ValidationError, NOT a silent NULL). update_roadmap_timeline
 *     patches the timeline of the CURRENT row in place (no new version) —
 *     timeline corrections aren't a periodization change.
 *
 * timeline (jsonb) is validated LOUDLY against the lib/roadmapModel shape
 * (phases / scheduled_events / checkpoints) — a malformed timeline raises a
 * ValidationError BEFORE any write. The read-model parser stays defensive (drops
 * malformed entries); the write side is the loud gate so bad data never lands.
 *
 * Tables: long_term_plans (versioned), roadmap (versioned), read-only ownership
 * checks on goals / long_term_plans (FK targets).
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { requireOwned } from '../ownership.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { Queryable } from '../db.js';
import { isoDate } from './write_profile_goals.js';

const ROADMAP_DOMAINS = ['nutrition', 'training'] as const;
const EVENT_TYPES = ['refeed', 'diet_break', 'deload'] as const;
const SOURCE_TYPES = ['body_weight', 'exercise', 'manual'] as const;
const EXERCISE_FIELDS = ['weight', 'top_set_reps', 'total_reps'] as const;

// ── timeline validation (LOUD; mirrors lib/roadmapModel.ts snake_case shape) ────

/**
 * The timeline jsonb contract (snake_case, exactly as lib/roadmapModel.ts
 * parses it). Strict zod: an unknown key, a wrong type, or a malformed source
 * raises a ValidationError on parse. The optional `source` defaults (when
 * absent) to body_weight in the read-model — here we accept absence and only
 * reject a PRESENT-but-malformed source.
 */
const timelineSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('body_weight') }).strict(),
  z
    .object({
      type: z.literal('exercise'),
      exercise_id: z.number().int().positive(),
      field: z.enum(EXERCISE_FIELDS),
    })
    .strict(),
  z.object({ type: z.literal('manual') }).strict(),
]);

const timelinePhaseSchema = z
  .object({
    nutrition_target_id: z.number().int(),
    label: z.string().optional(),
    started_on: isoDate,
    ended_on: isoDate.nullable().optional(),
  })
  .strict();

const timelineScheduledEventSchema = z
  .object({
    type: z.enum(EVENT_TYPES),
    date: isoDate.nullable().optional(),
    from: isoDate.nullable().optional(),
    to: isoDate.nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .strict();

const timelineCheckpointSchema = z
  .object({
    date: isoDate,
    metric: z.string().optional(),
    expected_value: z.number(),
    note: z.string().nullable().optional(),
    source: timelineSourceSchema.optional(),
  })
  .strict();

const timelineSchema = z
  .object({
    phases: z.array(timelinePhaseSchema),
    scheduled_events: z.array(timelineScheduledEventSchema),
    checkpoints: z.array(timelineCheckpointSchema),
  })
  .strict();

/**
 * Validate a raw timeline against the roadmapModel shape, LOUDLY. Returns the
 * normalized object (all three arrays guaranteed present) for storage. Throws
 * ValidationError with the zod issues on any malformation.
 */
function validateTimeline(raw: unknown): z.infer<typeof timelineSchema> {
  const parsed = timelineSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      'timeline does not match the roadmap shape ' +
        '({phases, scheduled_events, checkpoints}); see issues.',
      parsed.error.issues
    );
  }
  return parsed.data;
}

// ── create_plan (long_term_plans, versioned) ───────────────────────────────────

const createPlanTool = defineTool({
  name: 'create_plan',
  description:
    'Create a new CURRENT long_term_plans row (narrative prose). Bitemporal: in ' +
    'ONE transaction, close the current plan (valid_to = valid_from of the new ' +
    'row) and INSERT the new current row (valid_to IS NULL). The "one current per ' +
    'user" UNIQUE invariant always holds. The first ever plan simply inserts (no ' +
    'row to close).',
  inputSchema: z
    .object({
      title: z.string().min(1),
      content_md: z.string().min(1),
      valid_from: isoDate,
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    return ctx.db.tx(async (tx: Queryable) => {
      const closed = await tx.query<{ id: number }>(
        `UPDATE long_term_plans SET valid_to = $1
          WHERE user_id = $2 AND valid_to IS NULL
          RETURNING id`,
        [input.valid_from, ctx.userId]
      );
      const rows = await tx.query<{ id: number }>(
        `INSERT INTO long_term_plans
            (user_id, title, content_md, valid_from, valid_to)
         VALUES ($1, $2, $3, $4, NULL)
         RETURNING id`,
        [ctx.userId, input.title, input.content_md, input.valid_from]
      );
      return {
        plan_id: rows[0].id,
        closed_plan_ids: closed.map((r) => r.id),
        valid_from: input.valid_from,
      };
    });
  },
});

// ── FK ownership helpers ────────────────────────────────────────────────────────

async function assertGoalOwned(
  tx: Queryable,
  userId: string,
  goalIdValue: number
): Promise<void> {
  const row = await tx.queryOne(
    `SELECT 1 FROM goals WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [goalIdValue, userId]
  );
  if (row === null) {
    throw new ValidationError(
      `goal_id ${goalIdValue} does not exist for the current user.`,
      { goal_id: goalIdValue }
    );
  }
}

async function assertPlanOwned(
  tx: Queryable,
  userId: string,
  planIdValue: number
): Promise<void> {
  const row = await tx.queryOne(
    `SELECT 1 FROM long_term_plans WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [planIdValue, userId]
  );
  if (row === null) {
    throw new ValidationError(
      `long_term_plan_id ${planIdValue} does not exist for the current user.`,
      { long_term_plan_id: planIdValue }
    );
  }
}

// ── create_roadmap (roadmap, versioned per (user, domain)) ──────────────────────

const createRoadmapTool = defineTool({
  name: 'create_roadmap',
  description:
    'Create a new CURRENT roadmap for a domain (nutrition|training). Bitemporal: ' +
    'in ONE transaction, close the current roadmap for (user, domain) ' +
    '(valid_to = horizon_start) and INSERT the new current row (valid_to IS NULL), ' +
    'so the "one current per (user, domain)" UNIQUE invariant holds. domain is ' +
    'enum-validated; timeline is validated LOUDLY against the roadmap shape ' +
    '({phases, scheduled_events, checkpoints}); goal_id / long_term_plan_id are ' +
    'ownership-checked when provided (cross-tenant => ValidationError, not a silent ' +
    'NULL). valid_from = horizon_start.',
  inputSchema: z
    .object({
      domain: z.enum(ROADMAP_DOMAINS),
      goal_id: z.number().int().positive().nullable().optional(),
      long_term_plan_id: z.number().int().positive().nullable().optional(),
      horizon_start: isoDate,
      horizon_target_date: isoDate.nullable().optional(),
      timeline: z.unknown(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const timeline = validateTimeline(input.timeline);

    return ctx.db.tx(async (tx: Queryable) => {
      if (input.goal_id !== undefined && input.goal_id !== null) {
        await assertGoalOwned(tx, ctx.userId, input.goal_id);
      }
      if (
        input.long_term_plan_id !== undefined &&
        input.long_term_plan_id !== null
      ) {
        await assertPlanOwned(tx, ctx.userId, input.long_term_plan_id);
      }

      const closed = await tx.query<{ id: number }>(
        `UPDATE roadmap SET valid_to = $1
          WHERE user_id = $2 AND domain = $3 AND valid_to IS NULL
          RETURNING id`,
        [input.horizon_start, ctx.userId, input.domain]
      );

      const rows = await tx.query<{ id: number }>(
        `INSERT INTO roadmap
            (user_id, domain, goal_id, long_term_plan_id,
             horizon_start, horizon_target_date, timeline, valid_from, valid_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
         RETURNING id`,
        [
          ctx.userId,
          input.domain,
          input.goal_id ?? null,
          input.long_term_plan_id ?? null,
          input.horizon_start,
          input.horizon_target_date ?? null,
          JSON.stringify(timeline),
          input.horizon_start,
        ]
      );

      return {
        roadmap_id: rows[0].id,
        domain: input.domain,
        closed_roadmap_ids: closed.map((r) => r.id),
        valid_from: input.horizon_start,
      };
    });
  },
});

// ── update_roadmap_timeline (in-place patch of the current row) ─────────────────

const updateRoadmapTimelineTool = defineTool({
  name: 'update_roadmap_timeline',
  description:
    'Patch the timeline of an EXISTING roadmap row IN PLACE (no new version — a ' +
    'timeline correction is not a periodization change). The targeted row must be ' +
    'the CURRENT one (valid_to IS NULL). timeline is validated LOUDLY against the ' +
    'roadmap shape. requireOwned first; cross-tenant roadmap_id => NotFound, zero ' +
    'writes.',
  inputSchema: z
    .object({
      roadmap_id: z.number().int().positive(),
      timeline: z.unknown(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const timeline = validateTimeline(input.timeline);

    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.roadmap_id,
      table: 'roadmap',
      idColumn: 'id',
      label: 'roadmap',
    });

    const rows = await ctx.db.query<{ id: number }>(
      `UPDATE roadmap SET timeline = $1
        WHERE id = $2 AND user_id = $3 AND valid_to IS NULL
        RETURNING id`,
      [JSON.stringify(timeline), input.roadmap_id, ctx.userId]
    );
    if (rows.length === 0) {
      throw new NotFoundError(
        `roadmap ${input.roadmap_id} has no current row (valid_to IS NULL) to patch.`,
        { id: input.roadmap_id }
      );
    }
    return { roadmap_id: input.roadmap_id, updated: true };
  },
});

export const writePlanningTools: AnyToolModule[] = [
  createPlanTool,
  createRoadmapTool,
  updateRoadmapTimelineTool,
];

// Reused by tests.
export { validateTimeline };
