/**
 * write_program.ts — Phase 3 (T010) program lifecycle + day CRUD + replace_program.
 *
 * Invariant "only one active program" (ended_on IS NULL) is enforced by
 * create_program and replace_program: a new active program may only be created
 * if no other is active, unless the caller asks to end the current one in the
 * same transaction.
 *
 * - create_program: error (CONFLICT) if an active program exists, unless
 *   end_current=true → close it (set ended_on) first, in the same tx.
 * - end_program / update_program: lifecycle + metadata edits, ownership-checked.
 * - create_day / update_day / delete_day: program_days CRUD. day_type is the
 *   immutable logical key; UNIQUE (program_id, day_type) → CONFLICT on clash;
 *   CHECK weekday∈[0,6]; delete blocked by FK RESTRICT if the day still has
 *   current exercises (surfaced as a loud CONFLICT, not a raw pg error).
 * - replace_program: ONE transaction = end current + create program + create
 *   days + add exercises from a declarative full payload (decision O3). Any FK
 *   miss (bad exercise_id, etc.) rolls the WHOLE thing back: no program created,
 *   the old one stays active.
 *
 * No tool accepts user_id. Every row is bound to ctx.userId and every ownership-
 * sensitive read/update re-asserts user_id. Tables: programs, program_days,
 * program_exercises (via add), scheda_changes (audit on the seeded exercises).
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { requireOwned } from '../ownership.js';
import { NotFoundError, ConflictError } from '../errors.js';
import type { Queryable } from '../db.js';
import {
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
} from './write_exercise_versioned.js';

const programId = z.number().int().positive();
const weekday = z.number().int().min(0).max(6);

// ── helpers ───────────────────────────────────────────────────────────────────

/** Throw CONFLICT if the user already has an active program. */
async function assertNoActiveProgram(
  tx: Queryable,
  userId: string
): Promise<void> {
  const row = await tx.queryOne<{ id: number }>(
    `SELECT id FROM programs WHERE user_id = $1 AND ended_on IS NULL LIMIT 1`,
    [userId]
  );
  if (row !== null) {
    throw new ConflictError(
      `An active program (id=${row.id}) already exists. End it first or pass end_current=true / ended_on_old.`,
      { active_program_id: row.id }
    );
  }
}

/** Close every currently-active program of the user (set ended_on). */
async function endActivePrograms(
  tx: Queryable,
  userId: string,
  endedOn: string
): Promise<number[]> {
  const rows = await tx.query<{ id: number }>(
    `UPDATE programs SET ended_on = $1
      WHERE user_id = $2 AND ended_on IS NULL
      RETURNING id`,
    [endedOn, userId]
  );
  return rows.map((r) => r.id);
}

/** INSERT a programs row, return its id. */
async function insertProgram(
  tx: Queryable,
  userId: string,
  p: {
    name: string;
    started_on: string;
    description: string | null;
    philosophy_md_path: string | null;
  }
): Promise<number> {
  const rows = await tx.query<{ id: number }>(
    `INSERT INTO programs (user_id, name, started_on, description, philosophy_md_path)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, p.name, p.started_on, p.description, p.philosophy_md_path]
  );
  return rows[0].id;
}

/** INSERT a program_days row; UNIQUE clash → ConflictError. */
async function insertDay(
  tx: Queryable,
  userId: string,
  d: {
    program_id: number;
    day_type: string;
    display_name: string;
    weekday: number | null;
  }
): Promise<number> {
  // Pre-check the UNIQUE (program_id, day_type) to give a clean CONFLICT.
  const existing = await tx.queryOne<{ id: number }>(
    `SELECT id FROM program_days
      WHERE program_id = $1 AND day_type = $2 AND user_id = $3 LIMIT 1`,
    [d.program_id, d.day_type, userId]
  );
  if (existing !== null) {
    throw new ConflictError(
      `program_day (program_id=${d.program_id}, day_type=${d.day_type}) already exists.`,
      { program_id: d.program_id, day_type: d.day_type }
    );
  }
  const rows = await tx.query<{ id: number }>(
    `INSERT INTO program_days (user_id, program_id, day_type, display_name, weekday)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, d.program_id, d.day_type, d.display_name, d.weekday]
  );
  return rows[0].id;
}

// ── create_program ────────────────────────────────────────────────────────────

const createProgramTool = defineTool({
  name: 'create_program',
  description:
    'Create a new active program (programs row, ended_on NULL). Errors with ' +
    'CONFLICT if an active program already exists, unless end_current=true → the ' +
    'current active program(s) are ended (ended_on=started_on) first, in the same ' +
    'transaction. Returns the new program id. Enforces the "one active program" ' +
    'invariant.',
  inputSchema: z
    .object({
      name: z.string().min(1),
      started_on: isoDate,
      description: z.string().nullable().optional(),
      philosophy_md_path: z.string().nullable().optional(),
      end_current: z.boolean().optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    return ctx.db.tx(async (tx) => {
      let ended: number[] = [];
      if (input.end_current) {
        ended = await endActivePrograms(tx, ctx.userId, input.started_on);
      } else {
        await assertNoActiveProgram(tx, ctx.userId);
      }
      const id = await insertProgram(tx, ctx.userId, {
        name: input.name,
        started_on: input.started_on,
        description: input.description ?? null,
        philosophy_md_path: input.philosophy_md_path ?? null,
      });
      return { program_id: id, ended_program_ids: ended };
    });
  },
});

// ── end_program ───────────────────────────────────────────────────────────────

const endProgramTool = defineTool({
  name: 'end_program',
  description:
    'End a program by setting its ended_on date. Ownership-checked; cross-tenant ' +
    'id => NotFound.',
  inputSchema: z
    .object({ program_id: programId, ended_on: isoDate })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.program_id,
      table: 'programs',
      idColumn: 'id',
      label: 'program',
    });
    const rows = await ctx.db.query<{ id: number }>(
      `UPDATE programs SET ended_on = $1
        WHERE id = $2 AND user_id = $3
        RETURNING id`,
      [input.ended_on, input.program_id, ctx.userId]
    );
    if (rows.length === 0) {
      throw new NotFoundError(`program ${input.program_id} not found.`, {
        id: input.program_id,
      });
    }
    return { program_id: input.program_id, ended_on: input.ended_on };
  },
});

// ── update_program ────────────────────────────────────────────────────────────

const updateProgramTool = defineTool({
  name: 'update_program',
  description:
    'Update a program metadata (name/description/philosophy_md_path). Only the ' +
    'provided fields are changed. Ownership-checked; cross-tenant id => NotFound. ' +
    'Does not touch started_on/ended_on (use create_program/end_program).',
  inputSchema: z
    .object({
      program_id: programId,
      fields: z
        .object({
          name: z.string().min(1).optional(),
          description: z.string().nullable().optional(),
          philosophy_md_path: z.string().nullable().optional(),
        })
        .strict()
        .refine((f) => Object.keys(f).length > 0, 'at least one field required'),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.program_id,
      table: 'programs',
      idColumn: 'id',
      label: 'program',
    });

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const f = input.fields;
    if (f.name !== undefined) {
      sets.push(`name = $${i++}`);
      params.push(f.name);
    }
    if (f.description !== undefined) {
      sets.push(`description = $${i++}`);
      params.push(f.description);
    }
    if (f.philosophy_md_path !== undefined) {
      sets.push(`philosophy_md_path = $${i++}`);
      params.push(f.philosophy_md_path);
    }
    params.push(input.program_id, ctx.userId);
    const rows = await ctx.db.query<{ id: number }>(
      `UPDATE programs SET ${sets.join(', ')}
        WHERE id = $${i++} AND user_id = $${i}
        RETURNING id`,
      params
    );
    if (rows.length === 0) {
      throw new NotFoundError(`program ${input.program_id} not found.`, {
        id: input.program_id,
      });
    }
    return { program_id: input.program_id, updated: true };
  },
});

// ── create_day ────────────────────────────────────────────────────────────────

const createDayTool = defineTool({
  name: 'create_day',
  description:
    'Create a program day (program_days row). day_type is the immutable logical ' +
    'key; UNIQUE (program_id, day_type) → CONFLICT on clash. weekday is optional ' +
    '(0=Sun..6=Sat, NULL=unscheduled). The owning program is ownership-checked.',
  inputSchema: z
    .object({
      program_id: programId,
      day_type: dayType,
      display_name: z.string().min(1),
      weekday: weekday.nullable().optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.program_id,
      table: 'programs',
      idColumn: 'id',
      label: 'program',
    });
    return ctx.db.tx(async (tx) => {
      const id = await insertDay(tx, ctx.userId, {
        program_id: input.program_id,
        day_type: input.day_type,
        display_name: input.display_name,
        weekday: input.weekday ?? null,
      });
      return { day_id: id, program_id: input.program_id, day_type: input.day_type };
    });
  },
});

// ── update_day ────────────────────────────────────────────────────────────────

const updateDayTool = defineTool({
  name: 'update_day',
  description:
    'Update a program day display_name and/or weekday, keyed by (program_id, ' +
    'day_type). day_type itself is immutable. Ownership-checked via user_id; ' +
    'unknown (program_id, day_type) => NotFound.',
  inputSchema: z
    .object({
      program_id: programId,
      day_type: dayType,
      fields: z
        .object({
          display_name: z.string().min(1).optional(),
          weekday: weekday.nullable().optional(),
        })
        .strict()
        .refine((f) => Object.keys(f).length > 0, 'at least one field required'),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const f = input.fields;
    if (f.display_name !== undefined) {
      sets.push(`display_name = $${i++}`);
      params.push(f.display_name);
    }
    if (f.weekday !== undefined) {
      sets.push(`weekday = $${i++}`);
      params.push(f.weekday);
    }
    params.push(input.program_id, input.day_type, ctx.userId);
    const rows = await ctx.db.query<{ id: number }>(
      `UPDATE program_days SET ${sets.join(', ')}
        WHERE program_id = $${i++} AND day_type = $${i++} AND user_id = $${i}
        RETURNING id`,
      params
    );
    if (rows.length === 0) {
      throw new NotFoundError(
        `program_day (program_id=${input.program_id}, day_type=${input.day_type}) not found.`,
        { program_id: input.program_id, day_type: input.day_type }
      );
    }
    return { program_id: input.program_id, day_type: input.day_type, updated: true };
  },
});

// ── delete_day ────────────────────────────────────────────────────────────────

const deleteDayTool = defineTool({
  name: 'delete_day',
  description:
    'Delete a program day (program_days row), keyed by (program_id, day_type). ' +
    'Blocked by FK RESTRICT if the day still has CURRENT exercises — surfaced as ' +
    'a loud CONFLICT (remove/swap them out first). Ownership-checked.',
  inputSchema: z
    .object({ program_id: programId, day_type: dayType })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    return ctx.db.tx(async (tx) => {
      // Pre-check FK RESTRICT to give a clean CONFLICT instead of a raw pg error.
      const blocker = await tx.queryOne<{ id: number }>(
        `SELECT id FROM program_exercises
          WHERE program_id = $1 AND day_type = $2 AND user_id = $3
            AND valid_to IS NULL LIMIT 1`,
        [input.program_id, input.day_type, ctx.userId]
      );
      if (blocker !== null) {
        throw new ConflictError(
          `program_day (program_id=${input.program_id}, day_type=${input.day_type}) ` +
            `still has current exercises (e.g. pe_id=${blocker.id}); remove them first.`,
          { program_id: input.program_id, day_type: input.day_type }
        );
      }
      const rows = await tx.query<{ id: number }>(
        `DELETE FROM program_days
          WHERE program_id = $1 AND day_type = $2 AND user_id = $3
          RETURNING id`,
        [input.program_id, input.day_type, ctx.userId]
      );
      if (rows.length === 0) {
        throw new NotFoundError(
          `program_day (program_id=${input.program_id}, day_type=${input.day_type}) not found.`,
          { program_id: input.program_id, day_type: input.day_type }
        );
      }
      return { program_id: input.program_id, day_type: input.day_type, deleted: true };
    });
  },
});

// ── replace_program ───────────────────────────────────────────────────────────

/** Declarative full payload (decision O3): one program, its days, its exercises. */
const replacePayload = z
  .object({
    program: z
      .object({
        name: z.string().min(1),
        started_on: isoDate,
        description: z.string().nullable().optional(),
        philosophy_md_path: z.string().nullable().optional(),
      })
      .strict(),
    days: z
      .array(
        z
          .object({
            day_type: dayType,
            display_name: z.string().min(1),
            weekday: weekday.nullable().optional(),
          })
          .strict()
      )
      .min(1, 'at least one day required'),
    exercises: z
      .array(
        z
          .object({
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
          })
          .strict()
      )
      .min(1, 'at least one exercise required'),
  })
  .strict();

const replaceProgramTool = defineTool({
  name: 'replace_program',
  description:
    'Replace the whole scheda in ONE transaction ("scheda da capo"): end the ' +
    'current active program(s), create a new program, create all its days, and ' +
    'add all its exercises from a declarative full payload. Each exercise.day_type ' +
    'must match a payload day, and each exercise_id must exist in the catalog. ' +
    'ANY failure (bad exercise_id, unknown day_type, FK violation) rolls the WHOLE ' +
    'thing back: no program created, the old one stays active. Each seeded ' +
    'exercise also writes a scheda_changes "add" audit row. valid_from of the ' +
    'exercises = the program started_on.',
  inputSchema: z
    .object({
      payload: replacePayload,
      ended_on_old: isoDate.optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const { payload } = input;
    const startedOn = payload.program.started_on;
    const endedOnOld = input.ended_on_old ?? startedOn;

    // Days declared by the payload — every exercise.day_type must be one of these.
    const declaredDays = new Set(payload.days.map((d) => d.day_type));
    for (const ex of payload.exercises) {
      if (!declaredDays.has(ex.day_type)) {
        throw new NotFoundError(
          `exercise references day_type "${ex.day_type}" not present in payload.days.`,
          { day_type: ex.day_type }
        );
      }
    }

    return ctx.db.tx(async (tx) => {
      // 1. End the current active program(s).
      const ended = await endActivePrograms(tx, ctx.userId, endedOnOld);

      // 2. Create the new program.
      const newProgramId = await insertProgram(tx, ctx.userId, {
        name: payload.program.name,
        started_on: startedOn,
        description: payload.program.description ?? null,
        philosophy_md_path: payload.program.philosophy_md_path ?? null,
      });

      // 3. Create the days.
      for (const d of payload.days) {
        await insertDay(tx, ctx.userId, {
          program_id: newProgramId,
          day_type: d.day_type,
          display_name: d.display_name,
          weekday: d.weekday ?? null,
        });
      }

      // 4. Add the exercises (validate FK loudly → full rollback on any miss).
      const peIds: number[] = [];
      const changeIds: number[] = [];
      for (const ex of payload.exercises) {
        await assertDayExists(tx, ctx.userId, newProgramId, ex.day_type);
        await assertExerciseExists(tx, ctx.userId, ex.exercise_id);
        const peId = await insertExerciseRow(tx, ctx.userId, {
          program_id: newProgramId,
          day_type: ex.day_type,
          order_num: ex.order_num,
          exercise_id: ex.exercise_id,
          sets: ex.sets ?? null,
          reps_min: ex.reps_min ?? null,
          reps_max: ex.reps_max ?? null,
          current_weight_array: ex.current_weight_array ?? null,
          target_weight_kg: ex.target_weight_kg ?? null,
          rest_sec: ex.rest_sec ?? null,
          metadata: ex.metadata ?? null,
          ai_notes_text: ex.ai_notes_text ?? null,
          alternative_exercise_text: ex.alternative_exercise_text ?? null,
          valid_from: startedOn,
        });
        peIds.push(peId);
        const changeId = await writeAudit(tx, ctx.userId, {
          change_type: 'add',
          program_id: newProgramId,
          description: `Seeded exercise ${ex.exercise_id} into ${ex.day_type} (replace_program)`,
          affected_before_id: null,
          affected_after_id: peId,
          diff: null,
        });
        changeIds.push(changeId);
      }

      return {
        program_id: newProgramId,
        ended_program_ids: ended,
        day_count: payload.days.length,
        pe_ids: peIds,
        change_ids: changeIds,
      };
    });
  },
});

export const writeProgramTools: AnyToolModule[] = [
  createProgramTool,
  endProgramTool,
  updateProgramTool,
  createDayTool,
  updateDayTool,
  deleteDayTool,
  replaceProgramTool,
];
