/**
 * write_nutrition.ts — Phase 4 (T014) nutrition logging + phases + notes.
 *
 * Tools:
 *   - log_food_entry: SELECT the foods catalog row by id (loud NotFound if
 *     missing / cross-tenant), copy the 7 snapshot columns into a fresh
 *     food_entries INSERT. meal is a soft-enum validated server-side. No
 *     uniqueness — duplicates are allowed (two yogurts in a meal = two rows).
 *   - create/update/end_nutrition_phase: nutrition_targets lifecycle. Per-day
 *     targets are jsonb {kcal,protein_g,carbs_g,fat_g} on mon..sun_target.
 *   - set_nutrition_day_ai_comment: UPSERT nutrition_day_notes.ai_comment on
 *     (user,date). The CHECK requires ai_comment OR user_comment non-null:
 *     clearing ai_comment (null) is allowed ONLY if a user_comment already
 *     exists on the row, else a clear Conflict/Validation error.
 *   - set_nutrition_general_advice: UPSERT nutrition_general_notes (PK user_id)
 *     ai_advice.
 *
 * Hard rules: no user_id param (bound from ctx); requireOwned on phase ids before
 * mutation; cross-tenant id => NotFound. UTC ISO dates.
 *
 * Tables: foods (read), food_entries, nutrition_targets, nutrition_day_notes,
 * nutrition_general_notes.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { requireOwned } from '../ownership.js';
import { NotFoundError, ValidationError, ConflictError } from '../errors.js';
import { isoDate } from './write_exercise_versioned.js';

const MEALS = [
  'colazione',
  'pre_workout',
  'pranzo',
  'snack',
  'cena',
  'sera',
] as const;

const phaseId = z.number().int().positive();

/** A per-day target payload (jsonb): {kcal, protein_g, carbs_g, fat_g}. */
const dayTarget = z
  .object({
    kcal: z.number().min(0),
    protein_g: z.number().min(0),
    carbs_g: z.number().min(0),
    fat_g: z.number().min(0),
  })
  .strict();

const DAY_TARGET_COLS = [
  'mon_target',
  'tue_target',
  'wed_target',
  'thu_target',
  'fri_target',
  'sat_target',
  'sun_target',
] as const;

// ── log_food_entry ────────────────────────────────────────────────────────────

export const ENTRY_UNITS = ['g', 'ml', 'pz'] as const;
export type EntryUnit = (typeof ENTRY_UNITS)[number];

/**
 * Dual-unit Case A/B/C resolution — mirrors logFoodEntryAction (actions.ts:240-259).
 * Decides whether the chosen entry_unit is valid for this food and which
 * grams_per_piece value to snapshot on the row. `quantity` is ALWAYS stored RAW
 * in the chosen unit; the nutrition_days view converts pz -> base via the snapshot
 * (COALESCE to foods.grams_per_piece, then 1 for legacy pz rows).
 */
export function resolveGppSnapshot(
  entryUnit: EntryUnit,
  food: { unit: string; grams_per_piece: number | null }
): number | null {
  if (entryUnit !== 'pz') {
    // g / ml — no per-piece conversion, snapshot stays null.
    return null;
  }
  if (food.grams_per_piece != null && food.grams_per_piece > 0) {
    // Case A — new dual-unit model: snapshot the food's grams_per_piece.
    return food.grams_per_piece;
  }
  if (food.unit === 'pz') {
    // Case B — legacy unit='pz', macros already per-piece. View uses COALESCE(...,1).
    return null;
  }
  // Case C — food is g/ml with no per-piece definition. Cannot convert pieces.
  throw new ConflictError(
    `food has no per-piece definition (unit='${food.unit}', grams_per_piece is null); ` +
      `cannot log it in 'pz'. Edit the food to set grams_per_piece, or log in '${food.unit}'.`,
    { unit: food.unit }
  );
}

const logFoodEntryTool = defineTool({
  name: 'log_food_entry',
  description:
    'Log a food entry (food_entries row) for a date+meal. Resolves food_id in the ' +
    'catalog (foods) and copies the snapshot columns (name/unit/reference_qty + ' +
    '4 macros + entry_unit + grams_per_piece_snapshot) into the row so historical ' +
    'entries stay fixed if the foods row is later edited. quantity is stored RAW in ' +
    'entry_unit (the nutrition_days view converts pz -> base via grams_per_piece). ' +
    "entry_unit (g/ml/pz) defaults to the food's base unit when omitted. Logging in " +
    "'pz' a food without a per-piece definition => Conflict. meal is a soft-enum " +
    '(colazione/pre_workout/pranzo/snack/cena/sera). Duplicates allowed (no ' +
    'uniqueness). Missing/cross-tenant food => NotFound.',
  inputSchema: z
    .object({
      date: isoDate,
      meal: z.enum(MEALS),
      food_id: z.number().int().positive(),
      quantity: z.number().positive(),
      entry_unit: z.enum(ENTRY_UNITS).optional(),
      notes: z.string().nullable().optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    // Resolve the catalog food (seed or own). created_by IS NULL OR = userId.
    // unit + grams_per_piece bridge the dual-unit model (Case A/B/C).
    const food = await ctx.db.queryOne<{
      canonical_name: string;
      unit: string;
      reference_qty: number;
      kcal: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
      grams_per_piece: number | null;
    }>(
      `SELECT canonical_name, unit, reference_qty, kcal,
              protein_g, carbs_g, fat_g, grams_per_piece
         FROM foods
        WHERE id = $1 AND (created_by IS NULL OR created_by = $2)`,
      [input.food_id, ctx.userId]
    );
    if (food === null) {
      throw new NotFoundError(
        `food_id ${input.food_id} does not exist in the catalog (resolve via search_foods / create_food).`,
        { food_id: input.food_id }
      );
    }

    // Default entry_unit to the food's base unit; if that isn't a valid entry
    // unit (g/ml/pz), fall back to 'g'.
    const entryUnit: EntryUnit =
      input.entry_unit ??
      (ENTRY_UNITS.includes(food.unit as EntryUnit) ? (food.unit as EntryUnit) : 'g');

    // Case A/B/C — validate + compute the per-piece snapshot. Throws on Case C.
    const gppSnapshot = resolveGppSnapshot(entryUnit, food);

    const rows = await ctx.db.query<{ id: number }>(
      `INSERT INTO food_entries
          (user_id, date, meal, food_id, quantity,
           food_name_snapshot, unit_snapshot, reference_qty_snapshot,
           kcal_snapshot, protein_g_snapshot, carbs_g_snapshot, fat_g_snapshot,
           entry_unit, grams_per_piece_snapshot,
           notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        ctx.userId,
        input.date,
        input.meal,
        input.food_id,
        input.quantity,
        food.canonical_name,
        food.unit,
        food.reference_qty,
        food.kcal,
        food.protein_g,
        food.carbs_g,
        food.fat_g,
        entryUnit,
        gppSnapshot,
        input.notes ?? null,
      ]
    );
    return { food_entry_id: rows[0].id };
  },
});

// ── create_nutrition_phase ────────────────────────────────────────────────────

const dayTargetFields = {
  mon_target: dayTarget.nullable().optional(),
  tue_target: dayTarget.nullable().optional(),
  wed_target: dayTarget.nullable().optional(),
  thu_target: dayTarget.nullable().optional(),
  fri_target: dayTarget.nullable().optional(),
  sat_target: dayTarget.nullable().optional(),
  sun_target: dayTarget.nullable().optional(),
};

const createNutritionPhaseTool = defineTool({
  name: 'create_nutrition_phase',
  description:
    'Create a nutrition phase (nutrition_targets row) — phase_name + started_on ' +
    '(forecast anchor) and optional per-day targets (mon..sun_target jsonb ' +
    '{kcal,protein_g,carbs_g,fat_g}). ended_on stays NULL (active). Does NOT end ' +
    'other phases. Returns { nutrition_target_id }.',
  inputSchema: z
    .object({
      phase_name: z.string().min(1),
      started_on: isoDate,
      notes: z.string().nullable().optional(),
      ...dayTargetFields,
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const cols = ['user_id', 'phase_name', 'started_on', 'notes'];
    const vals: unknown[] = [
      ctx.userId,
      input.phase_name,
      input.started_on,
      input.notes ?? null,
    ];
    for (const col of DAY_TARGET_COLS) {
      const v = input[col];
      if (v !== undefined) {
        cols.push(col);
        vals.push(v === null ? null : JSON.stringify(v));
      }
    }
    const placeholders = cols.map((c, i) =>
      DAY_TARGET_COLS.includes(c as (typeof DAY_TARGET_COLS)[number])
        ? `$${i + 1}::jsonb`
        : `$${i + 1}`
    );
    const rows = await ctx.db.query<{ id: number }>(
      `INSERT INTO nutrition_targets (${cols.join(', ')})
       VALUES (${placeholders.join(', ')}) RETURNING id`,
      vals
    );
    return { nutrition_target_id: rows[0].id };
  },
});

// ── update_nutrition_phase ────────────────────────────────────────────────────

const updateNutritionPhaseTool = defineTool({
  name: 'update_nutrition_phase',
  description:
    'Update a nutrition phase (nutrition_targets) by id: phase_name / started_on / ' +
    'notes / any per-day target (jsonb; null clears that day). At least one field ' +
    'required. requireOwned. Does NOT touch ended_on (use end_nutrition_phase). ' +
    'Cross-tenant id => NotFound.',
  inputSchema: z
    .object({
      id: phaseId,
      fields: z
        .object({
          phase_name: z.string().min(1).optional(),
          started_on: isoDate.optional(),
          notes: z.string().nullable().optional(),
          ...dayTargetFields,
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
      table: 'nutrition_targets',
      idColumn: 'id',
      label: 'nutrition_target',
    });

    const f = input.fields as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const [key, value] of Object.entries(f)) {
      if (value === undefined) continue;
      const isJsonb = DAY_TARGET_COLS.includes(
        key as (typeof DAY_TARGET_COLS)[number]
      );
      sets.push(isJsonb ? `${key} = $${i}::jsonb` : `${key} = $${i}`);
      vals.push(
        isJsonb && value !== null ? JSON.stringify(value) : (value ?? null)
      );
      i += 1;
    }
    vals.push(input.id, ctx.userId);
    await ctx.db.query(
      `UPDATE nutrition_targets SET ${sets.join(', ')}
        WHERE id = $${i} AND user_id = $${i + 1}`,
      vals
    );
    return { nutrition_target_id: input.id, updated: true };
  },
});

// ── end_nutrition_phase ───────────────────────────────────────────────────────

const endNutritionPhaseTool = defineTool({
  name: 'end_nutrition_phase',
  description:
    'End a nutrition phase: set ended_on (nutrition_targets) by id. requireOwned. ' +
    'Cross-tenant id => NotFound.',
  inputSchema: z
    .object({ id: phaseId, ended_on: isoDate })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.id,
      table: 'nutrition_targets',
      idColumn: 'id',
      label: 'nutrition_target',
    });
    await ctx.db.query(
      `UPDATE nutrition_targets SET ended_on = $1
        WHERE id = $2 AND user_id = $3`,
      [input.ended_on, input.id, ctx.userId]
    );
    return { nutrition_target_id: input.id, ended_on: input.ended_on };
  },
});

// ── set_nutrition_day_ai_comment ──────────────────────────────────────────────

const setNutritionDayAiCommentTool = defineTool({
  name: 'set_nutrition_day_ai_comment',
  description:
    'UPSERT the AI comment for a nutrition day (nutrition_day_notes.ai_comment) on ' +
    '(user,date). text=null clears it, but the CHECK (ai_comment OR user_comment ' +
    'non-null) means clearing is allowed ONLY if a user_comment already exists on ' +
    'that row; otherwise a clear Conflict error (it would create/leave an empty row).',
  inputSchema: z
    .object({ date: isoDate, text: z.string().nullable() })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    if (input.text === null) {
      // Clearing: only valid if a user_comment exists on the row.
      const row = await ctx.db.queryOne<{ user_comment: string | null }>(
        `SELECT user_comment FROM nutrition_day_notes
          WHERE user_id = $1 AND date = $2`,
        [ctx.userId, input.date]
      );
      if (row === null) {
        throw new ConflictError(
          `Cannot clear ai_comment for ${input.date}: no nutrition_day_notes row exists ` +
            `(clearing would leave nothing; the CHECK requires ai_comment OR user_comment).`,
          { date: input.date }
        );
      }
      if (row.user_comment === null) {
        throw new ConflictError(
          `Cannot clear ai_comment for ${input.date}: no user_comment present, so the ` +
            `row would violate the CHECK (ai_comment OR user_comment must be non-null).`,
          { date: input.date }
        );
      }
      await ctx.db.query(
        `UPDATE nutrition_day_notes SET ai_comment = NULL
          WHERE user_id = $1 AND date = $2`,
        [ctx.userId, input.date]
      );
      return { date: input.date, ai_comment: null };
    }

    if (input.text.trim().length === 0) {
      throw new ValidationError(
        'ai_comment text must be non-empty (use null to clear).',
        { date: input.date }
      );
    }

    await ctx.db.query(
      `INSERT INTO nutrition_day_notes (user_id, date, ai_comment)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, date)
       DO UPDATE SET ai_comment = EXCLUDED.ai_comment`,
      [ctx.userId, input.date, input.text]
    );
    return { date: input.date, ai_comment: input.text };
  },
});

// ── set_nutrition_general_advice ──────────────────────────────────────────────

const setNutritionGeneralAdviceTool = defineTool({
  name: 'set_nutrition_general_advice',
  description:
    'UPSERT the current-strategy AI advice (nutrition_general_notes.ai_advice), PK ' +
    'user_id — one row per user. Overwrite-in-place. Shown as the accordion above ' +
    'the /nutrizione week summary.',
  inputSchema: z.object({ text: z.string().min(1) }).strict(),
  handler: async (input, ctx: ToolCtx) => {
    await ctx.db.query(
      `INSERT INTO nutrition_general_notes (user_id, ai_advice)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET ai_advice = EXCLUDED.ai_advice`,
      [ctx.userId, input.text]
    );
    return { updated: true };
  },
});

export const writeNutritionTools: AnyToolModule[] = [
  logFoodEntryTool,
  createNutritionPhaseTool,
  updateNutritionPhaseTool,
  endNutritionPhaseTool,
  setNutritionDayAiCommentTool,
  setNutritionGeneralAdviceTool,
];
