/**
 * write_observations.ts — Observation store (Flusso 3).
 *
 * Tools:
 *   - add_observation: INSERT a user_observations row. confidence default 'low',
 *     status default 'pending', evidence_count = 1. text non-empty. Returns
 *     { observation_id }.
 *   - reinforce_observation: requireOwned, then evidence_count = evidence_count + 1
 *     (UNLESS bump_evidence:false), last_seen = now(); confidence updated ONLY if
 *     passed (never auto-lowered). Returns { observation_id, evidence_count }.
 *   - set_observation_status: requireOwned, then set status. Returns
 *     { observation_id, status }.
 *
 * Hard rules: no user_id param (bound from ctx); requireOwned before every
 * mutation; cross-tenant id => NotFound. Enums match the DB CHECK lists exactly.
 *
 * Tables: user_observations.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { requireOwned } from '../ownership.js';

const observationId = z.number().int().positive();

const kindEnum = z.enum([
  'identity_anthro',
  'lifestyle',
  'training_behavior',
  'nutrition_behavior',
  'goal_hypothesis',
  'problem_signal',
  'preference_taste',
  'personality_communication',
  'life_context',
]);

const confidenceEnum = z.enum(['low', 'medium', 'high']);

const statusEnum = z.enum(['pending', 'promoted', 'superseded', 'discarded']);

// ── add_observation ────────────────────────────────────────────────────────────

const addObservationTool = defineTool({
  name: 'add_observation',
  description:
    'Add a user_observations row (intake/coaching signal). kind + text required; ' +
    'confidence (low/medium/high, default low), source_conversation_id, metadata ' +
    'optional. status defaults to pending, evidence_count to 1. Returns ' +
    '{ observation_id }.',
  inputSchema: z
    .object({
      kind: kindEnum,
      text: z.string().min(1),
      confidence: confidenceEnum.optional(),
      source_conversation_id: z.string().uuid().nullable().optional(),
      metadata: z.record(z.unknown()).nullable().optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const rows = await ctx.db.query<{ id: number }>(
      `INSERT INTO user_observations
          (user_id, kind, text, confidence, evidence_count, status,
           source_conversation_id, metadata)
       VALUES ($1, $2, $3, $4, 1, 'pending', $5, $6)
       RETURNING id`,
      [
        ctx.userId,
        input.kind,
        input.text,
        input.confidence ?? 'low',
        input.source_conversation_id ?? null,
        input.metadata ?? null,
      ]
    );
    return { observation_id: rows[0].id };
  },
});

// ── reinforce_observation ───────────────────────────────────────────────────────

const reinforceObservationTool = defineTool({
  name: 'reinforce_observation',
  description:
    'Reinforce a user_observations row by id: bump evidence_count by 1 (unless ' +
    'bump_evidence:false) and set last_seen = now(). confidence is updated ONLY ' +
    'when passed (never auto-lowered). requireOwned. Cross-tenant id => NotFound. ' +
    'Returns { observation_id, evidence_count }.',
  inputSchema: z
    .object({
      id: observationId,
      confidence: confidenceEnum.optional(),
      bump_evidence: z.boolean().optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.id,
      table: 'user_observations',
      idColumn: 'id',
      label: 'observation',
    });

    const bump = input.bump_evidence !== false;
    const sets: string[] = ['last_seen = now()', 'updated_at = now()'];
    if (bump) sets.push('evidence_count = evidence_count + 1');
    const vals: unknown[] = [];
    let i = 1;
    if (input.confidence !== undefined) {
      sets.push(`confidence = $${i}`);
      vals.push(input.confidence);
      i += 1;
    }
    vals.push(input.id, ctx.userId);
    const rows = await ctx.db.query<{ evidence_count: number }>(
      `UPDATE user_observations SET ${sets.join(', ')}
        WHERE id = $${i} AND user_id = $${i + 1}
        RETURNING evidence_count`,
      vals
    );
    return { observation_id: input.id, evidence_count: rows[0].evidence_count };
  },
});

// ── set_observation_status ──────────────────────────────────────────────────────

const setObservationStatusTool = defineTool({
  name: 'set_observation_status',
  description:
    'Set the lifecycle status of a user_observations row by id ' +
    '(pending/promoted/superseded/discarded). Maintains updated_at = now(). ' +
    'requireOwned. Cross-tenant id => NotFound. Returns { observation_id, status }.',
  inputSchema: z
    .object({ id: observationId, status: statusEnum })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.id,
      table: 'user_observations',
      idColumn: 'id',
      label: 'observation',
    });
    await ctx.db.query(
      `UPDATE user_observations
          SET status = $1, updated_at = now()
        WHERE id = $2 AND user_id = $3`,
      [input.status, input.id, ctx.userId]
    );
    return { observation_id: input.id, status: input.status };
  },
});

export const writeObservationsTools: AnyToolModule[] = [
  addObservationTool,
  reinforceObservationTool,
  setObservationStatusTool,
];
