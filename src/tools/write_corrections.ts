/**
 * write_corrections.ts — Phase 4 (T016) corrections / hard deletes.
 *
 * Hard delete everywhere (no soft-delete). requireOwned
 * before every mutation; cross-tenant id => NotFound.
 *
 * Tools:
 *   - delete_weight(date)                — DELETE weight_log by (user, date).
 *   - delete_food_entry(id)              — DELETE food_entries by id.
 *   - update_food_entry(id, fields)      — patch quantity/meal/notes. Does NOT
 *                                          recompute snapshots (by design — the
 *                                          7 snapshot columns stay frozen).
 *   - update_session(session_id, fields) — patch sessions fields.
 *   - delete_session(session_id)         — TX: DELETE child session_exercises
 *                                          first, THEN the session (no documented
 *                                          cascade FK, so we do it explicitly to
 *                                          avoid orphan rows).
 *   - update_session_exercise(se_id, fields) — patch; recompute total_reps if
 *                                          reps_array changes. Owned via join to
 *                                          sessions (session_exercises has no own
 *                                          user_id).
 *   - delete_session_exercise(se_id)     — DELETE one session_exercises row.
 *
 * Tables: weight_log, food_entries, sessions, session_exercises.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { requireOwned } from '../ownership.js';
import { NotFoundError } from '../errors.js';
import {
  isoDate,
  weightArray,
  orderNum,
  assertExerciseExists,
} from './write_exercise_versioned.js';
import { ENTRY_UNITS, resolveGppSnapshot } from './write_nutrition.js';

const idPos = z.number().int().positive();
const MEALS = [
  'colazione',
  'pre_workout',
  'pranzo',
  'snack',
  'cena',
  'sera',
] as const;
const repsArray = z.array(z.number().int().min(0).max(1000)).min(1);

/** session_exercises ownership via parent sessions (no own user_id). */
const SE_FROM_AND_WHERE =
  'FROM session_exercises se JOIN sessions s ON s.id = se.session_id ' +
  'WHERE se.id = $1 AND s.user_id = $2';

// ── delete_weight ─────────────────────────────────────────────────────────────

const deleteWeightTool = defineTool({
  name: 'delete_weight',
  description:
    'Hard-delete the weight_log entry for a date (PK (user,date)). requireOwned ' +
    'by (user,date). Unknown date => NotFound. Use to clear a wrong weight before ' +
    're-logging (log_daily_metrics is loud on PK conflict).',
  inputSchema: z.object({ date: isoDate }).strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.date,
      table: 'weight_log',
      idColumn: 'date',
      label: 'weight_log entry',
    });
    await ctx.db.query(
      `DELETE FROM weight_log WHERE date = $1 AND user_id = $2`,
      [input.date, ctx.userId]
    );
    return { date: input.date, deleted: true };
  },
});

// ── delete_food_entry ─────────────────────────────────────────────────────────

const deleteFoodEntryTool = defineTool({
  name: 'delete_food_entry',
  description:
    'Hard-delete a food_entries row by id. requireOwned. Cross-tenant id => NotFound.',
  inputSchema: z.object({ id: idPos }).strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.id,
      table: 'food_entries',
      idColumn: 'id',
      label: 'food_entry',
    });
    await ctx.db.query(
      `DELETE FROM food_entries WHERE id = $1 AND user_id = $2`,
      [input.id, ctx.userId]
    );
    return { food_entry_id: input.id, deleted: true };
  },
});

// ── update_food_entry ─────────────────────────────────────────────────────────

const updateFoodEntryTool = defineTool({
  name: 'update_food_entry',
  description:
    'Patch a food_entries row (quantity / meal / notes / entry_unit). Does NOT ' +
    'recompute the 7 snapshot macro columns by design (they stay frozen at log ' +
    'time). If entry_unit (g/ml/pz) is passed, the linked food is JOIN-read and ' +
    'grams_per_piece_snapshot is recomputed via the same Case A/B/C rules as ' +
    'log_food_entry (switching to g/ml clears it; switching to pz on a food with ' +
    'no per-piece definition => Conflict). If entry_unit is omitted, both columns ' +
    'stay untouched (backward compat). At least one field required. requireOwned. ' +
    'Cross-tenant id => NotFound.',
  inputSchema: z
    .object({
      id: idPos,
      fields: z
        .object({
          quantity: z.number().positive().optional(),
          meal: z.enum(MEALS).optional(),
          notes: z.string().nullable().optional(),
          entry_unit: z.enum(ENTRY_UNITS).optional(),
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
      table: 'food_entries',
      idColumn: 'id',
      label: 'food_entry',
    });

    const f = input.fields as Record<string, unknown>;

    // When entry_unit is part of the patch, JOIN-read the linked food to
    // recompute grams_per_piece_snapshot (same Case A/B/C table as
    // log_food_entry). We mutate a working copy of `fields` so the generic SET
    // builder below also writes grams_per_piece_snapshot in the SAME UPDATE.
    const patch: Record<string, unknown> = { ...f };
    if (input.fields.entry_unit !== undefined) {
      const entryUnit = input.fields.entry_unit;
      const food = await ctx.db.queryOne<{
        unit: string;
        grams_per_piece: number | null;
      }>(
        `SELECT fo.unit, fo.grams_per_piece
           FROM food_entries fe
           JOIN foods fo ON fo.id = fe.food_id
          WHERE fe.id = $1 AND fe.user_id = $2`,
        [input.id, ctx.userId]
      );
      if (food === null) {
        // Owned (requireOwned passed) but no linked food row — defensive.
        throw new NotFoundError(
          `food_entry ${input.id} has no resolvable linked food; cannot switch entry_unit.`,
          { id: input.id }
        );
      }
      // Throws ConflictError on Case C (pz with no per-piece definition).
      patch.grams_per_piece_snapshot = resolveGppSnapshot(entryUnit, food);
    }

    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(`${key} = $${i}`);
      vals.push(value ?? null);
      i += 1;
    }
    vals.push(input.id, ctx.userId);
    await ctx.db.query(
      `UPDATE food_entries SET ${sets.join(', ')}
        WHERE id = $${i} AND user_id = $${i + 1}`,
      vals
    );
    return { food_entry_id: input.id, updated: true };
  },
});

// ── update_session ────────────────────────────────────────────────────────────

const updateSessionTool = defineTool({
  name: 'update_session',
  description:
    'Patch a sessions row by id (day_type / start_time / end_time / duration_min / ' +
    'sleep_h / body_weight_kg / condition / notes_text / program_id). At least one ' +
    'field required. requireOwned. Cross-tenant id => NotFound.',
  inputSchema: z
    .object({
      session_id: idPos,
      fields: z
        .object({
          day_type: z.string().nullable().optional(),
          start_time: z.string().nullable().optional(),
          end_time: z.string().nullable().optional(),
          duration_min: z.number().int().min(0).nullable().optional(),
          sleep_h: z.number().min(0).max(24).nullable().optional(),
          body_weight_kg: z.number().min(0).max(400).nullable().optional(),
          condition: z.string().nullable().optional(),
          notes_text: z.string().nullable().optional(),
          program_id: z.number().int().positive().nullable().optional(),
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
      idValue: input.session_id,
      table: 'sessions',
      idColumn: 'id',
      label: 'session',
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
    vals.push(input.session_id, ctx.userId);
    await ctx.db.query(
      `UPDATE sessions SET ${sets.join(', ')}
        WHERE id = $${i} AND user_id = $${i + 1}`,
      vals
    );
    return { session_id: input.session_id, updated: true };
  },
});

// ── delete_session ────────────────────────────────────────────────────────────

const deleteSessionTool = defineTool({
  name: 'delete_session',
  description:
    'Hard-delete a session and its executed exercises in ONE transaction: DELETE ' +
    'session_exercises WHERE session_id=… FIRST, then DELETE the session (no ' +
    'documented cascade FK, so child rows are removed explicitly — no orphans). ' +
    'requireOwned. Cross-tenant id => NotFound, zero writes.',
  inputSchema: z.object({ session_id: idPos }).strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.session_id,
      table: 'sessions',
      idColumn: 'id',
      label: 'session',
    });

    return ctx.db.tx(async (tx) => {
      // Child first (no cascade FK documented), then the parent — both in-tx.
      // FIX 3 (defense-in-depth, OBS-1): tenant-scope the child DELETE via a
      // parent EXISTS guard so it can never touch another tenant's rows even if
      // the preceding requireOwned were ever refactored away — aligning with the
      // twin update_session_exercise / delete_session_exercise writes.
      await tx.query(
        `DELETE FROM session_exercises
          WHERE session_id = $1
            AND EXISTS (
              SELECT 1 FROM sessions s
               WHERE s.id = session_id AND s.user_id = $2
            )`,
        [input.session_id, ctx.userId]
      );
      await tx.query(
        `DELETE FROM sessions WHERE id = $1 AND user_id = $2`,
        [input.session_id, ctx.userId]
      );
      return { session_id: input.session_id, deleted: true };
    });
  },
});

// ── update_session_exercise ───────────────────────────────────────────────────

const updateSessionExerciseTool = defineTool({
  name: 'update_session_exercise',
  description:
    'Patch a session_exercises row by id (exercise_id / order_num / weight_array / ' +
    'reps_array / rpe / notes_text / linked_program_exercise_id). If reps_array ' +
    'changes, total_reps is recomputed = sum(reps_array) (or NULL if reps_array set ' +
    'to null). At least one field required. requireOwned via join to sessions. ' +
    'Cross-tenant id => NotFound.',
  inputSchema: z
    .object({
      se_id: idPos,
      fields: z
        .object({
          exercise_id: z.number().int().positive().optional(),
          order_num: orderNum.optional(),
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
      idValue: input.se_id,
      fromAndWhere: SE_FROM_AND_WHERE,
      label: 'session_exercise',
    });

    // FIX 2: if the patch changes exercise_id, validate it against the catalog
    // accessibility predicate (created_by IS NULL OR created_by = $userId), the
    // same check add_exercise / swap_exercise apply. Non-existent / cross-tenant
    // exercise_id => ValidationError, zero writes.
    if (input.fields.exercise_id !== undefined) {
      await assertExerciseExists(ctx.db, ctx.userId, input.fields.exercise_id);
    }

    // FIX 1: if the patch (re)links a planned program_exercises version, verify
    // that linked row belongs to the bound user. Cross-tenant id => NotFound,
    // zero writes. (null clears the link and needs no ownership check.)
    if (
      input.fields.linked_program_exercise_id !== null &&
      input.fields.linked_program_exercise_id !== undefined
    ) {
      await requireOwned({
        db: ctx.db,
        userId: ctx.userId,
        idValue: input.fields.linked_program_exercise_id,
        table: 'program_exercises',
        idColumn: 'id',
        label: 'program_exercise',
      });
    }

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

    // Recompute total_reps when reps_array is part of the patch.
    if ('reps_array' in f && f.reps_array !== undefined) {
      const reps = input.fields.reps_array ?? null;
      const totalReps =
        reps === null ? null : reps.reduce((acc, n) => acc + n, 0);
      sets.push(`total_reps = $${i}`);
      vals.push(totalReps);
      i += 1;
    }

    // Self-guard the write: even though requireOwned already proved ownership,
    // the mutation itself is tenant-scoped via a join to sessions so it can
    // never touch another tenant's row (defense-in-depth, OBS-1).
    vals.push(input.se_id, ctx.userId);
    await ctx.db.query(
      `UPDATE session_exercises SET ${sets.join(', ')}
        WHERE id = $${i}
          AND EXISTS (
            SELECT 1 FROM sessions s
             WHERE s.id = session_exercises.session_id
               AND s.user_id = $${i + 1}
          )`,
      vals
    );
    return { session_exercise_id: input.se_id, updated: true };
  },
});

// ── delete_session_exercise ───────────────────────────────────────────────────

const deleteSessionExerciseTool = defineTool({
  name: 'delete_session_exercise',
  description:
    'Hard-delete a single session_exercises row by id. requireOwned via join to ' +
    'sessions. Cross-tenant id => NotFound.',
  inputSchema: z.object({ se_id: idPos }).strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.se_id,
      fromAndWhere: SE_FROM_AND_WHERE,
      label: 'session_exercise',
    });
    // Self-guard the write (defense-in-depth, OBS-1): tenant-scope the DELETE
    // via a join to sessions so it cannot remove another tenant's row even if
    // the preceding requireOwned were ever refactored away.
    await ctx.db.query(
      `DELETE FROM session_exercises
        WHERE id = $1
          AND EXISTS (
            SELECT 1 FROM sessions s
             WHERE s.id = session_exercises.session_id
               AND s.user_id = $2
          )`,
      [input.se_id, ctx.userId]
    );
    return { session_exercise_id: input.se_id, deleted: true };
  },
});

export const writeCorrectionsTools: AnyToolModule[] = [
  deleteWeightTool,
  deleteFoodEntryTool,
  updateFoodEntryTool,
  updateSessionTool,
  deleteSessionTool,
  updateSessionExerciseTool,
  deleteSessionExerciseTool,
];
