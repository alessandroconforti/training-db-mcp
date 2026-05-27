/**
 * foods_search.ts — T010 DB read of the foods catalog with scope filters.
 *
 * Match canonical_name ILIKE or alias = ANY(aliases). Scope:
 *   - 'all' (default): global + user-owned
 *   - 'global': created_by IS NULL
 *   - 'user': created_by = MCP_USER_ID
 *   - 'composite': kind IN ('composite','user_recipe')
 *
 * Order: user-owned first, then global, then alpha.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import {
  tokenizeQuery,
  escapeLike,
  buildTokenAndWhere,
  TRIGRAM_THRESHOLD,
} from '../lib/query_tokens.js';

export interface FoodSearchRow {
  id: number;
  canonical_name: string;
  kind: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  external_source: string | null;
  owner: 'global' | 'user';
}

/** Shared internal so foods.resolve can reuse without going through the registry. */
interface RawFoodSearchRow {
  id: number;
  canonical_name: string;
  kind: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  external_source: string | null;
  is_user: boolean;
}

const FOOD_SEARCH_SELECT = `id, canonical_name, kind, kcal, protein_g, carbs_g, fat_g,
            external_source,
            (created_by = $1) AS is_user`;

function scopeClause(scope: 'all' | 'global' | 'user' | 'composite'): string {
  // $1 is always userId. Empty string when scope adds no extra filter.
  if (scope === 'global') return 'AND created_by IS NULL';
  if (scope === 'user') return 'AND created_by = $1';
  if (scope === 'composite') return "AND kind IN ('composite','user_recipe')";
  return 'AND (created_by IS NULL OR created_by = $1)';
}

function mapRow(r: RawFoodSearchRow): FoodSearchRow {
  return {
    id: r.id,
    canonical_name: r.canonical_name,
    kind: r.kind,
    kcal: Number(r.kcal),
    protein_g: Number(r.protein_g),
    carbs_g: Number(r.carbs_g),
    fat_g: Number(r.fat_g),
    external_source: r.external_source,
    owner: r.is_user ? 'user' : 'global',
  };
}

/** Shared internal so foods.resolve can reuse without going through the registry. */
export async function searchFoodsInternal(
  ctx: ToolCtx,
  opts: {
    query: string;
    scope: 'all' | 'global' | 'user' | 'composite';
    limit: number;
  }
): Promise<FoodSearchRow[]> {
  const scopeSql = scopeClause(opts.scope);

  // ── Strategy A — Token AND on unaccented canonical_name + aliases ─────────
  const tokens = tokenizeQuery(opts.query);
  if (tokens.length >= 1) {
    const { sql: tokWhere, params: tokParams } = buildTokenAndWhere(tokens, 2);
    const limitIdx = 2 + tokParams.length;
    const rowsA = await ctx.db.query<RawFoodSearchRow>(
      `SELECT ${FOOD_SEARCH_SELECT}
         FROM foods
        WHERE ${tokWhere}
          ${scopeSql}
        ORDER BY (created_by = $1) DESC NULLS LAST,
                 canonical_name ASC
        LIMIT $${limitIdx}`,
      [ctx.userId, ...tokParams, opts.limit]
    );
    if (rowsA.length > 0) return rowsA.map(mapRow);
  } else {
    // Degenerate tokens: fall back to escaped ILIKE on the whole query.
    const like = `%${escapeLike(opts.query)}%`;
    const rowsFallback = await ctx.db.query<RawFoodSearchRow>(
      `SELECT ${FOOD_SEARCH_SELECT}
         FROM foods
        WHERE immutable_unaccent(lower(canonical_name)) ILIKE $2
          ${scopeSql}
        ORDER BY (created_by = $1) DESC NULLS LAST,
                 canonical_name ASC
        LIMIT $3`,
      [ctx.userId, like, opts.limit]
    );
    if (rowsFallback.length > 0) return rowsFallback.map(mapRow);
  }

  // ── Strategy B — Trigram fuzzy fallback (threshold in WHERE) ──────────────
  const rowsB = await ctx.db.query<RawFoodSearchRow>(
    `SELECT ${FOOD_SEARCH_SELECT}
       FROM foods
      WHERE similarity(
              immutable_unaccent(lower(canonical_name)),
              immutable_unaccent(lower($2))
            ) >= ${TRIGRAM_THRESHOLD}
        ${scopeSql}
      ORDER BY (created_by = $1) DESC NULLS LAST,
               similarity(
                 immutable_unaccent(lower(canonical_name)),
                 immutable_unaccent(lower($2))
               ) DESC
      LIMIT $3`,
    [ctx.userId, opts.query, opts.limit]
  );
  return rowsB.map(mapRow);
}

const foodsSearchTool = defineTool({
  name: 'foods_search',
  description:
    'Search the foods catalog by canonical_name (ILIKE) or exact alias match. Scope ' +
    'filter: all (default) / global (created_by IS NULL) / user (owned by bound user) / ' +
    "composite (kind IN ('composite','user_recipe')). Order: user-owned first, then " +
    'global, then alpha. Returns macros + kind + external_source + owner per row.',
  inputSchema: z
    .object({
      query: z.string().min(1),
      scope: z.enum(['all', 'global', 'user', 'composite']).optional(),
      limit: z.number().int().positive().max(50).optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    return searchFoodsInternal(ctx, {
      query: input.query,
      scope: input.scope ?? 'all',
      limit: input.limit ?? 10,
    });
  },
});

export const foodsSearchTools: AnyToolModule[] = [foodsSearchTool];
