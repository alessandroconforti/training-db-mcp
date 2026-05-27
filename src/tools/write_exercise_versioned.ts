/**
 * write_exercise_versioned.ts — Phase 3 (T009) bitemporal structural writes.
 *
 * These tools change the SHAPE of an exercise prescription (sets/reps/target/
 * exercise swap/add/remove). Unlike the Phase-2 patches (order_num/notes/load/
 * alternative — done in place), every op here is VERSIONED:
 *
 *   - close the current row (set valid_to = the new row's valid_from), and
 *   - INSERT a new current row (valid_to IS NULL) carrying the overrides plus
 *     the inherited (unchanged) fields, and
 *   - write a scheda_changes audit row linking before/after via the versioning
 *     ids and recording a jsonb diff of the changed fields.
 *
 * Half-open interval [valid_from, valid_to): closing a row sets valid_to to the
 * valid_from of its successor. `remove_exercise` only closes (no successor).
 *
 * Every mutation runs in db.tx and is preceded by requireOwned. A cross-tenant
 * id resolves to NotFound and performs ZERO writes. FK targets (the composite
 * (program_id, day_type) -> program_days and exercise_id -> exercises) are
 * validated loudly before the INSERT; any failure rolls the whole tx back.
 *
 * program_id for the scheda_changes row is DERIVED from the pe row, never a param.
 *
 * Tables: program_exercises (versioned), scheda_changes (audit), and read-only
 * existence checks on program_days / exercises.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { requireOwned } from '../ownership.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { Queryable } from '../db.js';

// ── shared zod fragments ──────────────────────────────────────────────────────

const peId = z.number().int().positive();
const programId = z.number().int().positive();
const exerciseId = z.number().int().positive();
const orderNum = z.number().int().min(0);
const dayType = z.string().min(1);
/** ISO date (YYYY-MM-DD). The bitemporal columns are `date`. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

const weightArray = z
  .array(z.number().min(0).max(1000))
  .min(1, 'current_weight_array must contain at least one value');

const setsField = z.number().int().min(0).max(100);
const repsField = z.number().int().min(0).max(1000);
const targetWeight = z.number().min(0).max(1000);
const restSec = z.number().int().min(0).max(36000);

// ── the persisted row shape (program_exercises columns we manage) ─────────────

interface PeRow {
  id: number;
  user_id: string;
  program_id: number;
  day_type: string;
  order_num: number;
  exercise_id: number;
  sets: number | null;
  reps_min: number | null;
  reps_max: number | null;
  current_weight_array: number[] | null;
  target_weight_kg: number | null;
  rest_sec: number | null;
  metadata: unknown;
  ai_notes_text: string | null;
  alternative_exercise_text: string | null;
  valid_from: string;
  valid_to: string | null;
}

/** Load the CURRENT (valid_to IS NULL) row of a pe id, scoped to the user. */
async function loadCurrentRow(
  tx: Queryable,
  userId: string,
  peIdValue: number
): Promise<PeRow> {
  const row = await tx.queryOne<PeRow>(
    `SELECT id, user_id, program_id, day_type, order_num, exercise_id,
            sets, reps_min, reps_max, current_weight_array, target_weight_kg,
            rest_sec, metadata, ai_notes_text, alternative_exercise_text,
            valid_from, valid_to
       FROM program_exercises
      WHERE id = $1 AND user_id = $2 AND valid_to IS NULL`,
    [peIdValue, userId]
  );
  if (row === null) {
    throw new NotFoundError(
      `program_exercise ${peIdValue} has no current row (valid_to IS NULL) for the current user.`,
      { id: peIdValue }
    );
  }
  return row;
}

/** Loudly assert (program_id, day_type) resolves to a program_days row of the user. */
async function assertDayExists(
  tx: Queryable,
  userId: string,
  programIdValue: number,
  dayTypeValue: string
): Promise<void> {
  const row = await tx.queryOne(
    `SELECT 1 FROM program_days
      WHERE program_id = $1 AND day_type = $2 AND user_id = $3 LIMIT 1`,
    [programIdValue, dayTypeValue, userId]
  );
  if (row === null) {
    throw new ValidationError(
      `No program_days row for (program_id=${programIdValue}, day_type=${dayTypeValue}); ` +
        `create the day first (create_day).`,
      { program_id: programIdValue, day_type: dayTypeValue }
    );
  }
}

/** Loudly assert exercise_id exists in the catalog (seed or own). */
async function assertExerciseExists(
  tx: Queryable,
  userId: string,
  exerciseIdValue: number
): Promise<void> {
  const row = await tx.queryOne(
    `SELECT 1 FROM exercises
      WHERE id = $1 AND (created_by IS NULL OR created_by = $2) LIMIT 1`,
    [exerciseIdValue, userId]
  );
  if (row === null) {
    throw new ValidationError(
      `exercise_id ${exerciseIdValue} does not exist in the catalog (resolve via search_exercises / create_exercise).`,
      { exercise_id: exerciseIdValue }
    );
  }
}

/** Insert a new CURRENT program_exercises row; returns its id. */
async function insertExerciseRow(
  tx: Queryable,
  userId: string,
  fields: {
    program_id: number;
    day_type: string;
    order_num: number;
    exercise_id: number;
    sets: number | null;
    reps_min: number | null;
    reps_max: number | null;
    current_weight_array: number[] | null;
    target_weight_kg: number | null;
    rest_sec: number | null;
    metadata: unknown;
    ai_notes_text: string | null;
    alternative_exercise_text: string | null;
    valid_from: string;
  }
): Promise<number> {
  const rows = await tx.query<{ id: number }>(
    `INSERT INTO program_exercises
        (user_id, program_id, day_type, order_num, exercise_id,
         sets, reps_min, reps_max, current_weight_array, target_weight_kg,
         rest_sec, metadata, ai_notes_text, alternative_exercise_text,
         valid_from, valid_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, NULL)
     RETURNING id`,
    [
      userId,
      fields.program_id,
      fields.day_type,
      fields.order_num,
      fields.exercise_id,
      fields.sets,
      fields.reps_min,
      fields.reps_max,
      fields.current_weight_array,
      fields.target_weight_kg,
      fields.rest_sec,
      fields.metadata === undefined || fields.metadata === null
        ? null
        : JSON.stringify(fields.metadata),
      fields.ai_notes_text,
      fields.alternative_exercise_text,
      fields.valid_from,
    ]
  );
  return rows[0].id;
}

/** Close a current row (valid_to = the successor's valid_from). */
async function closeRow(
  tx: Queryable,
  userId: string,
  peIdValue: number,
  validTo: string
): Promise<void> {
  const rows = await tx.query<{ id: number }>(
    `UPDATE program_exercises
        SET valid_to = $1
      WHERE id = $2 AND user_id = $3 AND valid_to IS NULL
      RETURNING id`,
    [validTo, peIdValue, userId]
  );
  if (rows.length === 0) {
    throw new NotFoundError(
      `program_exercise ${peIdValue} has no current row to close.`,
      { id: peIdValue }
    );
  }
}

/** Write one scheda_changes audit row. program_id derived from the pe row. */
async function writeAudit(
  tx: Queryable,
  userId: string,
  args: {
    change_type: 'add' | 'update' | 'swap' | 'remove';
    program_id: number;
    description: string;
    affected_before_id: number | null;
    affected_after_id: number | null;
    diff: Record<string, unknown> | null;
  }
): Promise<number> {
  const rows = await tx.query<{ id: number }>(
    `INSERT INTO scheda_changes
        (user_id, changed_at, change_type, program_id, description,
         affected_before_id, affected_after_id, diff)
     VALUES ($1, now(), $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      userId,
      args.change_type,
      args.program_id,
      args.description,
      args.affected_before_id,
      args.affected_after_id,
      args.diff === null ? null : JSON.stringify(args.diff),
    ]
  );
  return rows[0].id;
}

/** Build a jsonb diff of {before,after} for the fields that actually changed. */
function buildDiff(
  before: PeRow,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const [key, after] of Object.entries(overrides)) {
    if (after === undefined) continue;
    const prev = (before as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(prev) !== JSON.stringify(after)) {
      diff[key] = { before: prev ?? null, after };
    }
  }
  return diff;
}

// ── add_exercise ──────────────────────────────────────────────────────────────

const addExerciseTool = defineTool({
  name: 'add_exercise',
  description:
    'Add a NEW exercise to a program day: INSERT a current program_exercises row ' +
    '(valid_to IS NULL) and write a scheda_changes audit row (change_type="add", ' +
    'affected_after_id=new id). Validates the composite FK (program_id, day_type) ' +
    'and exercise_id before inserting; any failure rolls the whole transaction ' +
    'back. exercise_id comes from search_exercises / create_exercise.',
  inputSchema: z
    .object({
      program_id: programId,
      day_type: dayType,
      order_num: orderNum,
      exercise_id: exerciseId,
      sets: setsField.nullable().optional(),
      reps_min: repsField.nullable().optional(),
      reps_max: repsField.nullable().optional(),
      current_weight_array: weightArray.nullable().optional(),
      target_weight_kg: targetWeight.nullable().optional(),
      rest_sec: restSec.nullable().optional(),
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
      ai_notes_text: z.string().nullable().optional(),
      alternative_exercise_text: z.string().nullable().optional(),
      valid_from: isoDate,
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    return ctx.db.tx(async (tx) => {
      // Validate FKs loudly (own program day + catalog exercise) before insert.
      await assertDayExists(tx, ctx.userId, input.program_id, input.day_type);
      await assertExerciseExists(tx, ctx.userId, input.exercise_id);

      const newId = await insertExerciseRow(tx, ctx.userId, {
        program_id: input.program_id,
        day_type: input.day_type,
        order_num: input.order_num,
        exercise_id: input.exercise_id,
        sets: input.sets ?? null,
        reps_min: input.reps_min ?? null,
        reps_max: input.reps_max ?? null,
        current_weight_array: input.current_weight_array ?? null,
        target_weight_kg: input.target_weight_kg ?? null,
        rest_sec: input.rest_sec ?? null,
        metadata: input.metadata ?? null,
        ai_notes_text: input.ai_notes_text ?? null,
        alternative_exercise_text: input.alternative_exercise_text ?? null,
        valid_from: input.valid_from,
      });

      const changeId = await writeAudit(tx, ctx.userId, {
        change_type: 'add',
        program_id: input.program_id,
        description: `Added exercise ${input.exercise_id} to ${input.day_type}`,
        affected_before_id: null,
        affected_after_id: newId,
        diff: null,
      });

      return {
        pe_id: newId,
        change_id: changeId,
        change_type: 'add' as const,
      };
    });
  },
});

// ── revise_exercise ─────────────────────────────────────────────────────────

const reviseFields = z
  .object({
    sets: setsField.optional(),
    reps_min: repsField.optional(),
    reps_max: repsField.optional(),
    target_weight_kg: targetWeight.nullable().optional(),
    rest_sec: restSec.nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    order_num: orderNum.optional(),
  })
  .strict();

const reviseExerciseTool = defineTool({
  name: 'revise_exercise',
  description:
    'Revise the prescription of an exercise (sets/reps_min/reps_max/' +
    'target_weight_kg/rest_sec/metadata/order_num) as a NEW bitemporal version: ' +
    'closes the current row (valid_to = valid_from of the new row), inserts a new ' +
    'current row with the overridden fields and ALL other fields inherited ' +
    '(order_num if not overridden, current_weight_array, ai_notes_text, ' +
    'alternative_exercise_text, exercise_id), and writes a scheda_changes row ' +
    '(change_type="update", before/after ids, jsonb diff of changed fields). ' +
    'Cross-tenant pe_id => NotFound, zero writes.',
  inputSchema: z
    .object({
      pe_id: peId,
      fields: reviseFields,
      valid_from: isoDate,
      change_description: z.string().min(1),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.pe_id,
      table: 'program_exercises',
      idColumn: 'id',
      label: 'program_exercise',
    });

    return ctx.db.tx(async (tx) => {
      const before = await loadCurrentRow(tx, ctx.userId, input.pe_id);
      const f = input.fields;

      const next = {
        program_id: before.program_id,
        day_type: before.day_type,
        order_num: f.order_num ?? before.order_num,
        exercise_id: before.exercise_id,
        sets: f.sets ?? before.sets,
        reps_min: f.reps_min ?? before.reps_min,
        reps_max: f.reps_max ?? before.reps_max,
        current_weight_array: before.current_weight_array,
        target_weight_kg:
          f.target_weight_kg !== undefined
            ? f.target_weight_kg
            : before.target_weight_kg,
        rest_sec: f.rest_sec !== undefined ? f.rest_sec : before.rest_sec,
        metadata: f.metadata !== undefined ? f.metadata : before.metadata,
        ai_notes_text: before.ai_notes_text,
        alternative_exercise_text: before.alternative_exercise_text,
        valid_from: input.valid_from,
      };

      await closeRow(tx, ctx.userId, input.pe_id, input.valid_from);
      const newId = await insertExerciseRow(tx, ctx.userId, next);

      const diff = buildDiff(before, {
        sets: next.sets,
        reps_min: next.reps_min,
        reps_max: next.reps_max,
        target_weight_kg: next.target_weight_kg,
        rest_sec: next.rest_sec,
        metadata: next.metadata,
        order_num: next.order_num,
      });

      const changeId = await writeAudit(tx, ctx.userId, {
        change_type: 'update',
        program_id: before.program_id,
        description: input.change_description,
        affected_before_id: input.pe_id,
        affected_after_id: newId,
        diff,
      });

      return {
        pe_id: newId,
        previous_pe_id: input.pe_id,
        change_id: changeId,
        change_type: 'update' as const,
        diff,
      };
    });
  },
});

// ── swap_exercise ─────────────────────────────────────────────────────────────

const swapExerciseTool = defineTool({
  name: 'swap_exercise',
  description:
    'Swap the movement of an exercise slot for a different exercise_id, as a NEW ' +
    'bitemporal version (like revise_exercise but exercise_id changes). Closes the ' +
    'current row, inserts a new current row with the new exercise_id plus any ' +
    'overridden prescription fields and the rest inherited, and writes a ' +
    'scheda_changes row (change_type="swap"). Validates the new exercise_id exists. ' +
    'Cross-tenant pe_id => NotFound, zero writes.',
  inputSchema: z
    .object({
      pe_id_out: peId,
      exercise_id_in: exerciseId,
      fields: reviseFields,
      valid_from: isoDate,
      change_description: z.string().min(1),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.pe_id_out,
      table: 'program_exercises',
      idColumn: 'id',
      label: 'program_exercise',
    });

    return ctx.db.tx(async (tx) => {
      const before = await loadCurrentRow(tx, ctx.userId, input.pe_id_out);
      await assertExerciseExists(tx, ctx.userId, input.exercise_id_in);
      const f = input.fields;

      const next = {
        program_id: before.program_id,
        day_type: before.day_type,
        order_num: f.order_num ?? before.order_num,
        exercise_id: input.exercise_id_in,
        sets: f.sets ?? before.sets,
        reps_min: f.reps_min ?? before.reps_min,
        reps_max: f.reps_max ?? before.reps_max,
        current_weight_array: before.current_weight_array,
        target_weight_kg:
          f.target_weight_kg !== undefined
            ? f.target_weight_kg
            : before.target_weight_kg,
        rest_sec: f.rest_sec !== undefined ? f.rest_sec : before.rest_sec,
        metadata: f.metadata !== undefined ? f.metadata : before.metadata,
        ai_notes_text: before.ai_notes_text,
        alternative_exercise_text: before.alternative_exercise_text,
        valid_from: input.valid_from,
      };

      await closeRow(tx, ctx.userId, input.pe_id_out, input.valid_from);
      const newId = await insertExerciseRow(tx, ctx.userId, next);

      const diff = buildDiff(before, {
        exercise_id: next.exercise_id,
        sets: next.sets,
        reps_min: next.reps_min,
        reps_max: next.reps_max,
        target_weight_kg: next.target_weight_kg,
        rest_sec: next.rest_sec,
        metadata: next.metadata,
        order_num: next.order_num,
      });

      const changeId = await writeAudit(tx, ctx.userId, {
        change_type: 'swap',
        program_id: before.program_id,
        description: input.change_description,
        affected_before_id: input.pe_id_out,
        affected_after_id: newId,
        diff,
      });

      return {
        pe_id: newId,
        previous_pe_id: input.pe_id_out,
        change_id: changeId,
        change_type: 'swap' as const,
        diff,
      };
    });
  },
});

// ── remove_exercise ───────────────────────────────────────────────────────────

const removeExerciseTool = defineTool({
  name: 'remove_exercise',
  description:
    'Remove an exercise from the current scheda: close its current row ' +
    '(set valid_to) WITHOUT inserting a successor, and write a scheda_changes row ' +
    '(change_type="remove", affected_before_id=pe_id). Cross-tenant pe_id => ' +
    'NotFound, zero writes.',
  inputSchema: z
    .object({
      pe_id: peId,
      valid_to: isoDate,
      change_description: z.string().min(1),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.pe_id,
      table: 'program_exercises',
      idColumn: 'id',
      label: 'program_exercise',
    });

    return ctx.db.tx(async (tx) => {
      const before = await loadCurrentRow(tx, ctx.userId, input.pe_id);
      await closeRow(tx, ctx.userId, input.pe_id, input.valid_to);

      const changeId = await writeAudit(tx, ctx.userId, {
        change_type: 'remove',
        program_id: before.program_id,
        description: input.change_description,
        affected_before_id: input.pe_id,
        affected_after_id: null,
        diff: null,
      });

      return {
        pe_id: input.pe_id,
        change_id: changeId,
        change_type: 'remove' as const,
        valid_to: input.valid_to,
      };
    });
  },
});

export const writeExerciseVersionedTools: AnyToolModule[] = [
  addExerciseTool,
  reviseExerciseTool,
  swapExerciseTool,
  removeExerciseTool,
];

// Internal helpers reused by write_program.ts (replace_program payload).
export {
  insertExerciseRow,
  assertDayExists,
  assertExerciseExists,
  writeAudit,
  weightArray,
  setsField,
  repsField,
  targetWeight,
  restSec,
  orderNum,
  dayType,
  exerciseId,
  isoDate,
};
