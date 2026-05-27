/**
 * foods_upsert_composite.ts — T012 create a recipe (composite/user_recipe).
 *
 * Transaction:
 *   1. Validate each component food_id exists, has kind='atomic' (no nesting v1),
 *      and is accessible (global or owned by user).
 *   2. Compute aggregated macros (handles reference_qty != 100):
 *        contrib_kcal = grams * (child.kcal / child.reference_qty)
 *      recipe.reference_qty = sum(grams).
 *   3. Reject if user already has user_recipe with same canonical_name.
 *   4. INSERT foods + N food_components.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { NotFoundError, ConflictError, ValidationError } from '../errors.js';

const componentInput = z
  .object({
    food_id: z.number().int().positive(),
    grams: z.number().positive(),
    position: z.number().int().min(0),
  })
  .strict();

const upsertCompositeTool = defineTool({
  name: 'foods_upsert_composite',
  description:
    'Create a recipe (kind="user_recipe" default, or "composite"). Components must be ' +
    'atomic foods accessible to the user (global or owned). Aggregated macros computed ' +
    'as sum of grams * (child.kcal / child.reference_qty). Rejects if a user_recipe with ' +
    'the same canonical_name already exists for this user. Returns { food_id, ' +
    'aggregated_macros, total_grams }.',
  inputSchema: z
    .object({
      canonical_name: z.string().min(1),
      aliases: z.array(z.string().min(1)).optional(),
      components: z.array(componentInput).min(1),
      kind: z.enum(['composite', 'user_recipe']).optional(),
    })
    .strict()
    .superRefine((val, ctx) => {
      const positions = val.components.map((c) => c.position);
      if (new Set(positions).size !== positions.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'components.position values must be unique',
        });
      }
    }),
  handler: async (input, ctx: ToolCtx) => {
    const kind = input.kind ?? 'user_recipe';
    return ctx.db.tx(async (client) => {
      // 3. Idempotency-ish: reject same-name user_recipe for this user.
      const dup = await client.queryOne<{ id: number }>(
        `SELECT id FROM foods
          WHERE canonical_name = $1 AND created_by = $2 AND kind = 'user_recipe'
          LIMIT 1`,
        [input.canonical_name, ctx.userId]
      );
      if (dup) {
        throw new ConflictError(
          `User already has a user_recipe named "${input.canonical_name}".`,
          { canonical_name: input.canonical_name, food_id: dup.id }
        );
      }

      // 1. Resolve each component child food (validate kind=atomic + accessibility).
      let totalKcal = 0;
      let totalProtein = 0;
      let totalCarbs = 0;
      let totalFat = 0;
      let totalGrams = 0;

      for (const comp of input.components) {
        const child = await client.queryOne<{
          id: number;
          kind: string;
          reference_qty: number;
          kcal: number;
          protein_g: number;
          carbs_g: number;
          fat_g: number;
          created_by: string | null;
        }>(
          `SELECT id, kind, reference_qty, kcal, protein_g, carbs_g, fat_g, created_by
             FROM foods
            WHERE id = $1 AND (created_by IS NULL OR created_by = $2)
            LIMIT 1`,
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
            `Component food_id ${comp.food_id} has kind="${child.kind}"; only atomic foods may be components (no nesting in v1).`,
            { food_id: comp.food_id, kind: child.kind }
          );
        }
        const refQty = Number(child.reference_qty);
        if (refQty <= 0) {
          throw new ValidationError(
            `Component food_id ${comp.food_id} has invalid reference_qty=${refQty}.`,
            { food_id: comp.food_id }
          );
        }
        const factor = comp.grams / refQty;
        totalKcal += Number(child.kcal) * factor;
        totalProtein += Number(child.protein_g) * factor;
        totalCarbs += Number(child.carbs_g) * factor;
        totalFat += Number(child.fat_g) * factor;
        totalGrams += comp.grams;
      }

      // 4. INSERT foods.
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO foods
            (canonical_name, aliases, unit, reference_qty,
             kcal, protein_g, carbs_g, fat_g,
             kind, created_by)
         VALUES ($1,$2,'g',$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          input.canonical_name,
          input.aliases ?? null,
          totalGrams,
          totalKcal,
          totalProtein,
          totalCarbs,
          totalFat,
          kind,
          ctx.userId,
        ]
      );
      const parentId = inserted[0].id;

      // INSERT components rows.
      for (const comp of input.components) {
        await client.query(
          `INSERT INTO food_components (parent_food_id, child_food_id, grams, position)
           VALUES ($1, $2, $3, $4)`,
          [parentId, comp.food_id, comp.grams, comp.position]
        );
      }

      return {
        food_id: parentId,
        aggregated_macros: {
          kcal: totalKcal,
          protein_g: totalProtein,
          carbs_g: totalCarbs,
          fat_g: totalFat,
        },
        total_grams: totalGrams,
      };
    });
  },
});

export const foodsUpsertCompositeTools: AnyToolModule[] = [upsertCompositeTool];
