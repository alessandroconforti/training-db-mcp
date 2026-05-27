/**
 * write_problems.ts — Phase 4 (T015) injury / physical problem tracking.
 *
 * Tools:
 *   - create_problem: INSERT a problems row. related_exercises is int[] (logical
 *     FK to exercises.id, no DB constraint). created_at/updated_at default in DB.
 *   - update_problem: partial UPDATE (>=1 field), maintains updated_at = now().
 *     requireOwned. Cross-tenant id => NotFound.
 *   - resolve_problem: set status='resolved' + resolved_on, maintains updated_at.
 *     requireOwned.
 *
 * Hard rules: no user_id param (bound from ctx); requireOwned before every
 * mutation/correction; cross-tenant id => NotFound. UTC ISO dates.
 *
 * Tables: problems.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { requireOwned } from '../ownership.js';
import { isoDate } from './write_exercise_versioned.js';

const problemId = z.number().int().positive();
const relatedExercises = z.array(z.number().int().positive());

// ── create_problem ────────────────────────────────────────────────────────────

const createProblemTool = defineTool({
  name: 'create_problem',
  description:
    'Create a problem (problems row) — injury / physical issue tracking. ' +
    'title + status + started_on required; severity / description / management / ' +
    'related_exercises (int[] logical FK to exercises.id) optional. Returns ' +
    '{ problem_id }.',
  inputSchema: z
    .object({
      title: z.string().min(1),
      status: z.string().min(1),
      started_on: isoDate,
      severity: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      management: z.string().nullable().optional(),
      related_exercises: relatedExercises.nullable().optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const rows = await ctx.db.query<{ id: number }>(
      `INSERT INTO problems
          (user_id, title, status, started_on, severity, description,
           management, related_exercises)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        ctx.userId,
        input.title,
        input.status,
        input.started_on,
        input.severity ?? null,
        input.description ?? null,
        input.management ?? null,
        input.related_exercises ?? null,
      ]
    );
    return { problem_id: rows[0].id };
  },
});

// ── update_problem ────────────────────────────────────────────────────────────

const updateProblemTool = defineTool({
  name: 'update_problem',
  description:
    'Update a problem (problems) by id: any of title / status / severity / ' +
    'started_on / resolved_on / description / management / related_exercises. ' +
    'At least one field required. Maintains updated_at = now(). requireOwned. ' +
    'Cross-tenant id => NotFound.',
  inputSchema: z
    .object({
      id: problemId,
      fields: z
        .object({
          title: z.string().min(1).optional(),
          status: z.string().min(1).optional(),
          severity: z.string().nullable().optional(),
          started_on: isoDate.optional(),
          resolved_on: isoDate.nullable().optional(),
          description: z.string().nullable().optional(),
          management: z.string().nullable().optional(),
          related_exercises: relatedExercises.nullable().optional(),
        })
        .strict()
        .refine((f) => Object.keys(f).length > 0, {
          message: 'fields must contain at least one key',
        }),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.id,
      table: 'problems',
      idColumn: 'id',
      label: 'problem',
    });

    const f = input.fields as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const [key, value] of Object.entries(f)) {
      if (value === undefined) continue;
      sets.push(`${key} = $${i}`);
      vals.push(value ?? null);
      i += 1;
    }
    sets.push('updated_at = now()');
    vals.push(input.id, ctx.userId);
    await ctx.db.query(
      `UPDATE problems SET ${sets.join(', ')}
        WHERE id = $${i} AND user_id = $${i + 1}`,
      vals
    );
    return { problem_id: input.id, updated: true };
  },
});

// ── resolve_problem ───────────────────────────────────────────────────────────

const resolveProblemTool = defineTool({
  name: 'resolve_problem',
  description:
    "Resolve a problem: set status='resolved' + resolved_on, maintains " +
    'updated_at = now(). requireOwned. Cross-tenant id => NotFound.',
  inputSchema: z
    .object({ id: problemId, resolved_on: isoDate })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.id,
      table: 'problems',
      idColumn: 'id',
      label: 'problem',
    });
    await ctx.db.query(
      `UPDATE problems
          SET status = 'resolved', resolved_on = $1, updated_at = now()
        WHERE id = $2 AND user_id = $3`,
      [input.resolved_on, input.id, ctx.userId]
    );
    return { problem_id: input.id, status: 'resolved', resolved_on: input.resolved_on };
  },
});

export const writeProblemsTools: AnyToolModule[] = [
  createProblemTool,
  updateProblemTool,
  resolveProblemTool,
];
