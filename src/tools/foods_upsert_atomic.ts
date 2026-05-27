/**
 * foods_upsert_atomic.ts — T011 idempotent insert/update of atomic foods.
 *
 * Sequence (P3 transactional inside `tx`):
 *   1. Find by external_source => return existing id (idempotent).
 *   2. Find by canonical_name:
 *        - owner (created_by = userId) => UPDATE.
 *        - not owner => reject (already exists globally / for another user).
 *        - not found => INSERT.
 *   3. INSERT with kind='atomic'. created_by = userId iff external_source is null
 *      (user-created), else created_by = NULL (globale via bridge esterno).
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { ConflictError } from '../errors.js';

const upsertAtomicTool = defineTool({
  name: 'foods_upsert_atomic',
  description:
    'Idempotent upsert of an atomic food (kind="atomic"). Resolution order: ' +
    '(1) external_source hit returns existing id; (2) canonical_name hit: own row => ' +
    'UPDATE, foreign row => Conflict; (3) miss => INSERT. created_by = bound user iff ' +
    'no external_source (user-created), else NULL (globale, importato da USDA/OFF). ' +
    'Returns { food_id, was_created }.',
  inputSchema: z
    .object({
      canonical_name: z.string().min(1),
      aliases: z.array(z.string().min(1)).optional(),
      unit: z.enum(['g', 'ml', 'pz']),
      reference_qty: z.number().positive(),
      kcal: z.number().min(0),
      protein_g: z.number().min(0),
      carbs_g: z.number().min(0),
      fat_g: z.number().min(0),
      grams_per_piece: z.number().positive().optional(),
      category: z.string().min(1).optional(),
      external_source: z.string().min(1).optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    return ctx.db.tx(async (client) => {
      // 1. external_source idempotency.
      if (input.external_source) {
        const ext = await client.queryOne<{ id: number }>(
          `SELECT id FROM foods WHERE external_source = $1 LIMIT 1`,
          [input.external_source]
        );
        if (ext) return { food_id: ext.id, was_created: false };
      }

      // 2. canonical_name resolution.
      const existing = await client.queryOne<{ id: number; created_by: string | null }>(
        `SELECT id, created_by FROM foods
          WHERE canonical_name = $1
            AND (created_by IS NULL OR created_by = $2)
          LIMIT 1`,
        [input.canonical_name, ctx.userId]
      );
      if (existing) {
        const isOwn = existing.created_by === ctx.userId;
        if (!isOwn) {
          throw new ConflictError(
            `Food "${input.canonical_name}" already exists globally — use foods_search to retrieve the id.`,
            { canonical_name: input.canonical_name }
          );
        }
        await client.query(
          `UPDATE foods
              SET aliases = $1, unit = $2, reference_qty = $3,
                  kcal = $4, protein_g = $5, carbs_g = $6, fat_g = $7,
                  grams_per_piece = $8, category = $9, external_source = $10,
                  kind = 'atomic'
            WHERE id = $11`,
          [
            input.aliases ?? null,
            input.unit,
            input.reference_qty,
            input.kcal,
            input.protein_g,
            input.carbs_g,
            input.fat_g,
            input.grams_per_piece ?? null,
            input.category ?? null,
            input.external_source ?? null,
            existing.id,
          ]
        );
        return { food_id: existing.id, was_created: false };
      }

      // 3. INSERT.
      const createdBy = input.external_source ? null : ctx.userId;
      const rows = await client.query<{ id: number }>(
        `INSERT INTO foods
            (canonical_name, aliases, unit, reference_qty,
             kcal, protein_g, carbs_g, fat_g,
             grams_per_piece, category, external_source,
             kind, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'atomic',$12)
         RETURNING id`,
        [
          input.canonical_name,
          input.aliases ?? null,
          input.unit,
          input.reference_qty,
          input.kcal,
          input.protein_g,
          input.carbs_g,
          input.fat_g,
          input.grams_per_piece ?? null,
          input.category ?? null,
          input.external_source ?? null,
          createdBy,
        ]
      );
      return { food_id: rows[0].id, was_created: true };
    });
  },
});

export const foodsUpsertAtomicTools: AnyToolModule[] = [upsertAtomicTool];
