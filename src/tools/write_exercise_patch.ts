/**
 * write_exercise_patch.ts — Phase 2 (T006) per-exercise patch tools.
 *
 * All four tools patch the CURRENT row of program_exercises in place
 * (`valid_to IS NULL AND user_id = $U`). They do NOT create new bitemporal
 * versions (versioning is Phase 3). `requireOwned` runs BEFORE every mutation;
 * an id of another user resolves to NotFound and is never touched.
 *
 * Semantics (decision T3/P6):
 *   - set_exercise_weight(current_weight_array): the array is patched only when
 *     the tool is invoked (the agent chose to touch it). `null` clears it
 *     (bodyweight). The "don't zero by omission" rule lives at the orchestration
 *     layer: the load family is never auto-zeroed because nobody calls this tool
 *     with null unless they mean to clear.
 *   - set_exercise_note / set_exercise_alternative: explicit set; `null` clears.
 *
 * Columns touched (program_exercises): current_weight_array, ai_notes_text,
 * alternative_exercise_text, order_num. Ownership table: program_exercises(id,user_id).
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { requireOwned } from '../ownership.js';
import { NotFoundError } from '../errors.js';

const peId = z.number().int().positive();

/** number[] len>=1, each value in [0,1000]. */
const weightArray = z
  .array(z.number().min(0).max(1000))
  .min(1, 'current_weight_array must contain at least one value');

/** Patch one column on the current program_exercises row; assert exactly 1 row touched. */
async function patchCurrentExercise(
  ctx: ToolCtx,
  peIdValue: number,
  column: 'current_weight_array' | 'ai_notes_text' | 'alternative_exercise_text',
  value: number[] | string | null
): Promise<{ pe_id: number; updated: true }> {
  await requireOwned({
    db: ctx.db,
    userId: ctx.userId,
    idValue: peIdValue,
    table: 'program_exercises',
    idColumn: 'id',
    label: 'program_exercise',
  });

  const rows = await ctx.db.query<{ id: number }>(
    `UPDATE program_exercises
        SET ${column} = $1
      WHERE id = $2 AND user_id = $3 AND valid_to IS NULL
      RETURNING id`,
    [value, peIdValue, ctx.userId]
  );
  if (rows.length === 0) {
    // Owned but no current row (already versioned out) — surface, never silent.
    throw new NotFoundError(
      `program_exercise ${peIdValue} has no current row (valid_to IS NULL) to patch.`,
      { id: peIdValue }
    );
  }
  return { pe_id: peIdValue, updated: true };
}

// ── set_exercise_weight ────────────────────────────────────────────────────────

const setExerciseWeightTool = defineTool({
  name: 'set_exercise_weight',
  description:
    'PATCH the prescribed per-serie load (current_weight_array) on the CURRENT ' +
    'program_exercises row. Pass a number[] (len>=1, each 0..1000) to set; null ' +
    'to clear (bodyweight). In place — does not create a new version. The array ' +
    'is only ever touched when this tool is called (never zeroed by omission).',
  inputSchema: z
    .object({
      pe_id: peId,
      current_weight_array: weightArray.nullable(),
    })
    .strict(),
  handler: (input, ctx) =>
    patchCurrentExercise(
      ctx,
      input.pe_id,
      'current_weight_array',
      input.current_weight_array
    ),
});

// ── set_exercise_note ──────────────────────────────────────────────────────────

const setExerciseNoteTool = defineTool({
  name: 'set_exercise_note',
  description:
    'Explicit-set the ephemeral tactical gloss (ai_notes_text) on the CURRENT ' +
    'program_exercises row. null clears it. In place — no new version.',
  inputSchema: z
    .object({
      pe_id: peId,
      ai_notes_text: z.string().nullable(),
    })
    .strict(),
  handler: (input, ctx) =>
    patchCurrentExercise(ctx, input.pe_id, 'ai_notes_text', input.ai_notes_text),
});

// ── set_exercise_alternative ─────────────────────────────────────────────────

const setExerciseAlternativeTool = defineTool({
  name: 'set_exercise_alternative',
  description:
    'Explicit-set the persistent alternative-exercise reference ' +
    '(alternative_exercise_text) on the CURRENT program_exercises row. null ' +
    'clears it. Stable across sessions (unlike ai_notes_text). In place.',
  inputSchema: z
    .object({
      pe_id: peId,
      alternative_exercise_text: z.string().nullable(),
    })
    .strict(),
  handler: (input, ctx) =>
    patchCurrentExercise(
      ctx,
      input.pe_id,
      'alternative_exercise_text',
      input.alternative_exercise_text
    ),
});

// ── reorder_day ────────────────────────────────────────────────────────────────

const reorderDayTool = defineTool({
  name: 'reorder_day',
  description:
    'Reorder the exercises of a program day: set order_num on each listed ' +
    'CURRENT program_exercises row, atomically (one transaction). Each pe_id is ' +
    'ownership-checked and constrained to the given program_id/day_type inside ' +
    'the transaction; an unknown/cross-tenant id rolls the whole batch back.',
  inputSchema: z
    .object({
      program_id: z.number().int().positive(),
      day_type: z.string().min(1),
      items: z
        .array(
          z
            .object({
              pe_id: peId,
              order_num: z.number().int().min(0),
            })
            .strict()
        )
        .min(1, 'items must contain at least one entry'),
    })
    .strict(),
  handler: async (input, ctx) => {
    const { program_id, day_type, items } = input;

    return ctx.db.tx(async (tx) => {
      for (const item of items) {
        // requireOwned BEFORE the mutation, inside the tx client.
        await requireOwned({
          db: tx,
          userId: ctx.userId,
          idValue: item.pe_id,
          table: 'program_exercises',
          idColumn: 'id',
          label: 'program_exercise',
        });

        const rows = await tx.query<{ id: number }>(
          `UPDATE program_exercises
              SET order_num = $1
            WHERE id = $2 AND user_id = $3
              AND program_id = $4 AND day_type = $5
              AND valid_to IS NULL
            RETURNING id`,
          [item.order_num, item.pe_id, ctx.userId, program_id, day_type]
        );
        if (rows.length === 0) {
          // Owned, but not a current row of this program_id/day_type.
          throw new NotFoundError(
            `program_exercise ${item.pe_id} is not a current row of ` +
              `program ${program_id} / day_type ${day_type}.`,
            { id: item.pe_id, program_id, day_type }
          );
        }
      }
      return { program_id, day_type, reordered: items.length };
    });
  },
});

export const writeExercisePatchTools: AnyToolModule[] = [
  setExerciseWeightTool,
  setExerciseNoteTool,
  setExerciseAlternativeTool,
  reorderDayTool,
];
