/**
 * foods_list_user_recipes.ts — T014 list user_recipes owned by the bound user.
 *
 * Optional substring filter on canonical_name. Returns components_count via
 * subquery on food_components.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import {
  tokenizeQuery,
  escapeLike,
  buildTokenAndWhere,
  TRIGRAM_THRESHOLD,
} from '../lib/query_tokens.js';

export interface UserRecipeRow {
  food_id: number;
  canonical_name: string;
  aliases: string[] | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  reference_qty: number;
  components_count: number;
}

interface RawUserRecipeRow {
  id: number;
  canonical_name: string;
  aliases: string[] | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  reference_qty: number;
  components_count: string | number;
}

const USER_RECIPE_SELECT = `id, canonical_name, aliases, kcal, protein_g, carbs_g, fat_g, reference_qty,
            (SELECT COUNT(*) FROM food_components WHERE parent_food_id = foods.id) AS components_count`;

const BASE_WHERE = `created_by = $1 AND kind = 'user_recipe'`;

function mapRow(r: RawUserRecipeRow): UserRecipeRow {
  return {
    food_id: r.id,
    canonical_name: r.canonical_name,
    aliases: r.aliases,
    kcal: Number(r.kcal),
    protein_g: Number(r.protein_g),
    carbs_g: Number(r.carbs_g),
    fat_g: Number(r.fat_g),
    reference_qty: Number(r.reference_qty),
    components_count: Number(r.components_count),
  };
}

export async function listUserRecipesInternal(
  ctx: ToolCtx,
  opts: { name_query?: string; limit: number }
): Promise<UserRecipeRow[]> {
  // No name_query: plain list ordered by canonical_name.
  if (!opts.name_query) {
    const rows = await ctx.db.query<RawUserRecipeRow>(
      `SELECT ${USER_RECIPE_SELECT}
         FROM foods
        WHERE ${BASE_WHERE}
        ORDER BY canonical_name ASC
        LIMIT $2`,
      [ctx.userId, opts.limit]
    );
    return rows.map(mapRow);
  }

  // ── Strategy A — Token AND on unaccented canonical_name + aliases ─────────
  // (Aliases are now part of the matching surface, previously ignored here.)
  const tokens = tokenizeQuery(opts.name_query);
  if (tokens.length >= 1) {
    const { sql: tokWhere, params: tokParams } = buildTokenAndWhere(tokens, 2);
    const limitIdx = 2 + tokParams.length;
    const rowsA = await ctx.db.query<RawUserRecipeRow>(
      `SELECT ${USER_RECIPE_SELECT}
         FROM foods
        WHERE ${BASE_WHERE}
          AND ${tokWhere}
        ORDER BY canonical_name ASC
        LIMIT $${limitIdx}`,
      [ctx.userId, ...tokParams, opts.limit]
    );
    if (rowsA.length > 0) return rowsA.map(mapRow);
  } else {
    // Degenerate tokens: fall back to escaped ILIKE on the whole query.
    const like = `%${escapeLike(opts.name_query)}%`;
    const rowsFallback = await ctx.db.query<RawUserRecipeRow>(
      `SELECT ${USER_RECIPE_SELECT}
         FROM foods
        WHERE ${BASE_WHERE}
          AND canonical_name ILIKE $2
        ORDER BY canonical_name ASC
        LIMIT $3`,
      [ctx.userId, like, opts.limit]
    );
    if (rowsFallback.length > 0) return rowsFallback.map(mapRow);
  }

  // ── Strategy B — Trigram fuzzy fallback (threshold in WHERE) ──────────────
  const rowsB = await ctx.db.query<RawUserRecipeRow>(
    `SELECT ${USER_RECIPE_SELECT}
       FROM foods
      WHERE ${BASE_WHERE}
        AND similarity(
              immutable_unaccent(lower(canonical_name)),
              immutable_unaccent(lower($2))
            ) >= ${TRIGRAM_THRESHOLD}
      ORDER BY similarity(
                 immutable_unaccent(lower(canonical_name)),
                 immutable_unaccent(lower($2))
               ) DESC
      LIMIT $3`,
    [ctx.userId, opts.name_query, opts.limit]
  );
  return rowsB.map(mapRow);
}

const listUserRecipesTool = defineTool({
  name: 'foods_list_user_recipes',
  description:
    "List user_recipes owned by the bound user (created_by = userId AND kind = 'user_recipe'). " +
    'Optional substring filter on canonical_name. Returns macros + reference_qty + ' +
    'components_count (subquery on food_components).',
  inputSchema: z
    .object({
      name_query: z.string().min(1).optional(),
      limit: z.number().int().positive().max(100).optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    return listUserRecipesInternal(ctx, {
      name_query: input.name_query,
      limit: input.limit ?? 20,
    });
  },
});

export const foodsListUserRecipesTools: AnyToolModule[] = [listUserRecipesTool];
