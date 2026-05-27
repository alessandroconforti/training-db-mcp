/**
 * log_food_entry_with_components.ts — T013 main write tool for nutrition logging
 * with optional ingredient-level decomposition snapshot.
 *
 * Semantics (decisione bloccata):
 *   - Case A (components absent/empty): log by reference. food_entries snapshot copied
 *     from the foods row. ZERO food_entry_components rows. Used for atomic standalone
 *     AND recipe reused identically.
 *   - Case B (components present + parent kind in composite/user_recipe): log by
 *     decomposition. N food_entry_components rows. Aggregated food_entries snapshot
 *     computed FROM the components (not from foods).
 *   - Reject: components passed + parent kind='atomic' => ValidationError.
 *
 * Per-component snapshot semantics: kcal_snapshot etc. are the child's per-100g
 * values at log time (immutable). Caller contribution: (grams/100)*kcal_snapshot.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { resolveGppSnapshot, ENTRY_UNITS, type EntryUnit } from './write_nutrition.js';

const MEALS = [
  'colazione',
  'pre_workout',
  'pranzo',
  'snack',
  'cena',
  'sera',
] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

const componentInput = z
  .object({
    food_id: z.number().int().positive(),
    grams: z.number().positive(),
    position: z.number().int().min(0),
  })
  .strict();

const logTool = defineTool({
  name: 'log_food_entry_with_components',
  description:
    'Log a food_entries row, optionally with per-ingredient snapshot rows ' +
    '(food_entry_components). Case A (no components): snapshot copied from foods row, ' +
    'no component rows. Case B (components present + composite/user_recipe parent): N ' +
    'component rows with per-100g snapshots of each child; aggregated food_entries ' +
    'snapshot is the sum of (grams/100)*kcal_snapshot etc. Rejects components on an ' +
    'atomic parent. Single transaction.',
  inputSchema: z
    .object({
      date: isoDate,
      meal: z.enum(MEALS),
      food_id: z.number().int().positive(),
      quantity: z.number().positive(),
      entry_unit: z.enum(ENTRY_UNITS),
      notes: z.string().nullable().optional(),
      components: z.array(componentInput).optional(),
    })
    .strict()
    .superRefine((val, ctx) => {
      if (val.components && val.components.length > 0) {
        const positions = val.components.map((c) => c.position);
        if (new Set(positions).size !== positions.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'components.position values must be unique',
          });
        }
      }
    }),
  handler: async (input, ctx: ToolCtx) => {
    const components = input.components ?? [];
    const hasComponents = components.length > 0;

    return ctx.db.tx(async (client) => {
      // Resolve parent food.
      const parent = await client.queryOne<{
        id: number;
        canonical_name: string;
        unit: string;
        reference_qty: number;
        kcal: number;
        protein_g: number;
        carbs_g: number;
        fat_g: number;
        grams_per_piece: number | null;
        kind: string;
      }>(
        `SELECT id, canonical_name, unit, reference_qty,
                kcal, protein_g, carbs_g, fat_g,
                grams_per_piece, kind
           FROM foods
          WHERE id = $1 AND (created_by IS NULL OR created_by = $2)`,
        [input.food_id, ctx.userId]
      );
      if (!parent) {
        throw new NotFoundError(
          `food_id ${input.food_id} does not exist in the catalog.`,
          { food_id: input.food_id }
        );
      }

      // Reject Case-B with atomic parent.
      if (hasComponents && parent.kind === 'atomic') {
        throw new ValidationError(
          `Components passed but food_id ${input.food_id} has kind='atomic' — atomic foods cannot have components.`,
          { food_id: input.food_id, kind: parent.kind }
        );
      }

      const entryUnit: EntryUnit = input.entry_unit;
      const gppSnapshot = resolveGppSnapshot(entryUnit, parent);

      // Compute aggregated snapshot.
      let kcalAgg: number;
      let proteinAgg: number;
      let carbsAgg: number;
      let fatAgg: number;

      // Pre-resolve component children for Case B (also drives component INSERTs).
      type Resolved = {
        comp: { food_id: number; grams: number; position: number };
        child: {
          canonical_name: string;
          reference_qty: number;
          kcal: number;
          protein_g: number;
          carbs_g: number;
          fat_g: number;
        };
        per100: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
      };
      const resolved: Resolved[] = [];

      if (hasComponents) {
        kcalAgg = 0;
        proteinAgg = 0;
        carbsAgg = 0;
        fatAgg = 0;
        for (const comp of components) {
          const child = await client.queryOne<{
            id: number;
            canonical_name: string;
            kind: string;
            reference_qty: number;
            kcal: number;
            protein_g: number;
            carbs_g: number;
            fat_g: number;
          }>(
            `SELECT id, canonical_name, kind, reference_qty,
                    kcal, protein_g, carbs_g, fat_g
               FROM foods
              WHERE id = $1 AND (created_by IS NULL OR created_by = $2)`,
            [comp.food_id, ctx.userId]
          );
          if (!child) {
            throw new NotFoundError(
              `Component food_id ${comp.food_id} not found or not accessible.`,
              { food_id: comp.food_id }
            );
          }
          if (child.kind !== 'atomic') {
            throw new ValidationError(
              `Component food_id ${comp.food_id} has kind='${child.kind}'; only atomic foods may be components.`,
              { food_id: comp.food_id, kind: child.kind }
            );
          }
          const refQty = Number(child.reference_qty);
          // Per-100g snapshot of the child (immutable from this point).
          const per100 = {
            kcal: (Number(child.kcal) * 100) / refQty,
            protein_g: (Number(child.protein_g) * 100) / refQty,
            carbs_g: (Number(child.carbs_g) * 100) / refQty,
            fat_g: (Number(child.fat_g) * 100) / refQty,
          };
          kcalAgg += (comp.grams / 100) * per100.kcal;
          proteinAgg += (comp.grams / 100) * per100.protein_g;
          carbsAgg += (comp.grams / 100) * per100.carbs_g;
          fatAgg += (comp.grams / 100) * per100.fat_g;
          resolved.push({
            comp,
            child: {
              canonical_name: child.canonical_name,
              reference_qty: refQty,
              kcal: Number(child.kcal),
              protein_g: Number(child.protein_g),
              carbs_g: Number(child.carbs_g),
              fat_g: Number(child.fat_g),
            },
            per100,
          });
        }
      } else {
        // Case A: snapshot from foods row (pattern identical to log_food_entry).
        kcalAgg = Number(parent.kcal);
        proteinAgg = Number(parent.protein_g);
        carbsAgg = Number(parent.carbs_g);
        fatAgg = Number(parent.fat_g);
      }

      const rows = await client.query<{ id: number }>(
        `INSERT INTO food_entries
            (user_id, date, meal, food_id, quantity,
             food_name_snapshot, unit_snapshot, reference_qty_snapshot,
             kcal_snapshot, protein_g_snapshot, carbs_g_snapshot, fat_g_snapshot,
             entry_unit, grams_per_piece_snapshot, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          ctx.userId,
          input.date,
          input.meal,
          input.food_id,
          input.quantity,
          parent.canonical_name,
          parent.unit,
          parent.reference_qty,
          kcalAgg,
          proteinAgg,
          carbsAgg,
          fatAgg,
          entryUnit,
          gppSnapshot,
          input.notes ?? null,
        ]
      );
      const foodEntryId = rows[0].id;

      // Case B: insert N component rows.
      for (const r of resolved) {
        await client.query(
          `INSERT INTO food_entry_components
              (food_entry_id, user_id, food_id, grams, position,
               food_name_snapshot,
               kcal_snapshot, protein_g_snapshot, carbs_g_snapshot, fat_g_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            foodEntryId,
            ctx.userId,
            r.comp.food_id,
            r.comp.grams,
            r.comp.position,
            r.child.canonical_name,
            r.per100.kcal,
            r.per100.protein_g,
            r.per100.carbs_g,
            r.per100.fat_g,
          ]
        );
      }

      return {
        food_entry_id: foodEntryId,
        total_macros: {
          kcal: kcalAgg,
          protein_g: proteinAgg,
          carbs_g: carbsAgg,
          fat_g: fatAgg,
        },
        components_logged: resolved.length,
      };
    });
  },
});

export const logFoodEntryWithComponentsTools: AnyToolModule[] = [logTool];
