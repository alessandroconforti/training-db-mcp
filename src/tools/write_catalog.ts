/**
 * write_catalog.ts — Phase 3 (T011) catalog minting (exercises / foods).
 *
 * The catalog tables are shared reference data: seed rows have created_by IS
 * NULL, user-minted rows carry created_by = the bound user. These tools INSERT a
 * new row with created_by ALWAYS = ctx.userId (never a param). There is no
 * requireOwned (you are creating, not editing an owned row), but a user can only
 * ever stamp rows with their own id.
 *
 * Use ONLY after the corresponding search_* tool returned no usable match:
 *   search_exercises -> create_exercise -> use the returned id as exercise_id
 *   search_foods     -> create_food     -> use the returned id as food_id
 *
 * Tables: exercises, foods. Returns the new id for immediate downstream use.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';

const nonEmpty = z.string().min(1);
const tags = z.array(z.string().min(1)).optional();

// ── create_exercise ───────────────────────────────────────────────────────────

const createExerciseTool = defineTool({
  name: 'create_exercise',
  description:
    'Mint a NEW catalog exercise (exercises row) with created_by = the bound ' +
    'user. Use ONLY when search_exercises returned no usable match. Returns the ' +
    'new exercise id, ready to pass as exercise_id to add_exercise / swap_exercise.',
  inputSchema: z
    .object({
      canonical_name: nonEmpty,
      muscle_groups: tags,
      equipment: tags,
      is_bodyweight: z.boolean().optional(),
      aliases: tags,
      notes: z.string().nullable().optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const rows = await ctx.db.query<{ id: number }>(
      `INSERT INTO exercises
          (canonical_name, muscle_groups, equipment, is_bodyweight,
           aliases, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.canonical_name,
        input.muscle_groups ?? null,
        input.equipment ?? null,
        input.is_bodyweight ?? null,
        input.aliases ?? null,
        input.notes ?? null,
        ctx.userId,
      ]
    );
    return { exercise_id: rows[0].id, created: true };
  },
});

// ── create_food ───────────────────────────────────────────────────────────────

const createFoodTool = defineTool({
  name: 'create_food',
  description:
    'Mint a NEW catalog food (foods row) with created_by = the bound user. Use ' +
    'ONLY when search_foods returned no usable match. Macros are per reference_qty ' +
    'of unit. Optional grams_per_piece (>0) enables the dual-unit model: a g/ml ' +
    "food can then be logged in 'pz', with the view converting pieces -> base via " +
    'this factor. Returns the new food id, ready to pass as food_id downstream.',
  inputSchema: z
    .object({
      canonical_name: nonEmpty,
      unit: nonEmpty,
      reference_qty: z.number().positive(),
      kcal: z.number().min(0),
      protein_g: z.number().min(0),
      carbs_g: z.number().min(0),
      fat_g: z.number().min(0),
      grams_per_piece: z.number().positive().optional(),
      aliases: tags,
      notes: z.string().nullable().optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const rows = await ctx.db.query<{ id: number }>(
      `INSERT INTO foods
          (canonical_name, unit, reference_qty, kcal, protein_g, carbs_g, fat_g,
           grams_per_piece, aliases, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        input.canonical_name,
        input.unit,
        input.reference_qty,
        input.kcal,
        input.protein_g,
        input.carbs_g,
        input.fat_g,
        input.grams_per_piece ?? null,
        input.aliases ?? null,
        input.notes ?? null,
        ctx.userId,
      ]
    );
    return { food_id: rows[0].id, created: true };
  },
});

export const writeCatalogTools: AnyToolModule[] = [
  createExerciseTool,
  createFoodTool,
];
