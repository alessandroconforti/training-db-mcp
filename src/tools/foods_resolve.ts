/**
 * foods_resolve.ts — T015 unified resolver: user recipes + atomic + global + external.
 *
 * Entry point for the centrale Claude. Parallel queries (Promise.all):
 *   A: user_recipes (kind='user_recipe', owner=user)
 *   B: foods (created_by=user, match) — direct SELECT here (carries reference_qty
 *      so we can normalize macros to per-100g per the resolver contract)
 *   C: foods (created_by IS NULL, match) — same SELECT, global scope
 *   D: nutrition.lookup_food (USDA + OFF), skipped if include_external=false
 *
 * Dedupe rules:
 *   - D candidate whose `source` matches existing external_source in A/B/C => drop.
 *   - Fallback dedupe: same normalized (lowercase trim) canonical_name across all.
 *
 * Ranking precedence:
 *   1 user_recipe, 2 user_atomic, 3 global_atomic_imported (external_source != NULL),
 *   4 global_composite (kind in composite/user_recipe but created_by IS NULL),
 *   5 global_atomic_seed (created_by IS NULL, external_source IS NULL),
 *   6 external_off, 7 external_usda
 *
 * D-fetch failure OR empty external => returns DB-only candidates with
 * `warning: 'external_lookup_failed'` (helpful UX: centrale knows external
 * didn't contribute, regardless of whether the cause was network or no match).
 *
 * Macro contract (plan line 337): every candidate exposes per-100g values.
 *   - user_recipe: factor = 100 / reference_qty (recipe ref_qty = total grams)
 *   - atomic/global: factor = 100 / reference_qty (food may be stored per 50g, etc.)
 *   - external: already per-100g from adapter normalization
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { listUserRecipesInternal, type UserRecipeRow } from './foods_list_user_recipes.js';
import { lookupFoodInternal } from './nutrition_lookup_food.js';
import type { NormalizedFood } from '../adapters/usda.js';
import {
  tokenizeQuery,
  escapeLike,
  buildTokenAndWhere,
  TRIGRAM_THRESHOLD,
} from '../lib/query_tokens.js';

// Re-export for callers/tests that imported it from foods_resolve historically.
export { TRIGRAM_THRESHOLD };

type SourceType =
  | 'user_recipe'
  | 'user_atomic'
  | 'global_atomic_imported'
  | 'global_composite'
  | 'global_atomic_seed'
  | 'external_off'
  | 'external_usda';

const RANK: Record<SourceType, number> = {
  user_recipe: 1,
  user_atomic: 2,
  global_atomic_imported: 3,
  global_composite: 4,
  global_atomic_seed: 5,
  external_off: 6,
  external_usda: 7,
};

export interface UserHistoryEntry {
  times_logged_60d: number;
  last_logged_at: string;
  last_quantity: number;
  last_entry_unit: 'g' | 'ml' | 'pz';
}

export interface ResolveCandidate {
  source_type: SourceType;
  food_id?: number;
  external_payload?: NormalizedFood;
  name: string;
  kcal_per_100g: number;
  protein_g_per_100g: number;
  carbs_g_per_100g: number;
  fat_g_per_100g: number;
  kind?: 'atomic' | 'composite' | 'user_recipe';
  confidence: number;
  user_history: UserHistoryEntry | null;
}

interface UserHistoryRow {
  food_id: number;
  times_logged_60d: number | string;
  last_logged_at: string;
  last_quantity: number | string;
  last_entry_unit: string;
}

/**
 * Selects per-food usage history for the bound user across a recent window.
 * Returns one entry per distinct food_id logged in `food_entries` within
 * `windowDays` days, carrying the count and the most-recent entry's qty/unit.
 *
 * Single round-trip via WINDOW functions (ROW_NUMBER + COUNT OVER PARTITION).
 * Consumed in memory by the merge step in foods_resolve to enrich candidates.
 */
export async function selectUserHistory(
  ctx: ToolCtx,
  windowDays: number
): Promise<Map<number, UserHistoryEntry>> {
  const windowStartDate = new Date(Date.now() - windowDays * 86400000)
    .toISOString()
    .slice(0, 10);

  const rows = await ctx.db.query<UserHistoryRow>(
    `SELECT food_id, times_logged_60d, last_logged_at, last_quantity, last_entry_unit
     FROM (
       SELECT food_id,
              COUNT(*) OVER (PARTITION BY food_id) AS times_logged_60d,
              date AS last_logged_at,
              quantity AS last_quantity,
              entry_unit AS last_entry_unit,
              ROW_NUMBER() OVER (PARTITION BY food_id ORDER BY date DESC, id DESC) AS rn
       FROM food_entries
       WHERE user_id = $1
         AND food_id IS NOT NULL
         AND date >= $2
     ) t
     WHERE rn = 1`,
    [ctx.userId, windowStartDate]
  );

  const map = new Map<number, UserHistoryEntry>();
  for (const row of rows) {
    map.set(row.food_id, {
      times_logged_60d: Number(row.times_logged_60d),
      last_logged_at: row.last_logged_at,
      last_quantity: Number(row.last_quantity),
      // DB CHECK constraint guarantees this union
      last_entry_unit: row.last_entry_unit as 'g' | 'ml' | 'pz',
    });
  }
  return map;
}

interface FoodRowForResolve {
  id: number;
  canonical_name: string;
  kind: string;
  kcal: number | string;
  protein_g: number | string;
  carbs_g: number | string;
  fat_g: number | string;
  reference_qty: number | string;
  external_source: string | null;
}

/**
 * Direct SELECT for resolve (vs searchFoodsInternal): includes reference_qty so
 * macros can be normalized to per-100g. Kept private to foods_resolve so the
 * public foods_search return shape stays stable.
 */
async function selectFoodsForResolve(
  ctx: ToolCtx,
  query: string,
  scope: 'user' | 'global',
  limit: number
): Promise<FoodRowForResolve[]> {
  const selectCols = `id, canonical_name, kind,
            kcal, protein_g, carbs_g, fat_g,
            reference_qty, external_source`;

  // Build scope clause + base params so $N placeholders only exist when their
  // value is actually consumed by the SQL. Critical for scope='global', where
  // we MUST NOT pass ctx.userId as $1 (the SQL contains `created_by IS NULL`
  // with no $1 reference, and Postgres would raise "could not determine data
  // type of parameter $1"). The previous shape silently failed inside the
  // parallel Promise.all `.catch(() => [])` and made global lookups return 0.
  const baseParams: unknown[] = [];
  let nextIdx = 1;
  let scopeSql: string;
  if (scope === 'user') {
    baseParams.push(ctx.userId);
    scopeSql = `created_by = $${nextIdx++}`;
  } else {
    scopeSql = 'created_by IS NULL';
  }

  // ── Strategy A — Token AND on unaccented canonical_name + aliases ─────────
  const tokens = tokenizeQuery(query);
  if (tokens.length >= 1) {
    const { sql: tokWhere, params: tokParams } = buildTokenAndWhere(
      tokens,
      nextIdx
    );
    const limitIdx = nextIdx + tokParams.length;
    const rowsA = await ctx.db.query<FoodRowForResolve>(
      `SELECT ${selectCols}
         FROM foods
        WHERE ${tokWhere}
          AND ${scopeSql}
        ORDER BY canonical_name ASC
        LIMIT $${limitIdx}`,
      [...baseParams, ...tokParams, limit]
    );
    if (rowsA.length > 0) return rowsA;
  } else {
    // Token list degenerate (only stopwords/numbers). Back-compat: ILIKE on
    // whole escaped query against canonical_name (no alias match — exact
    // ANY check was never useful for free-text). Keeps zero-result avoidance
    // when caller passes e.g. "uno" or "100g".
    const like = `%${escapeLike(query)}%`;
    const likeIdx = nextIdx;
    const limitIdx = nextIdx + 1;
    const rowsFallback = await ctx.db.query<FoodRowForResolve>(
      `SELECT ${selectCols}
         FROM foods
        WHERE immutable_unaccent(lower(canonical_name)) ILIKE $${likeIdx}
          AND ${scopeSql}
        ORDER BY canonical_name ASC
        LIMIT $${limitIdx}`,
      [...baseParams, like, limit]
    );
    if (rowsFallback.length > 0) return rowsFallback;
  }

  // ── Strategy B — Trigram fuzzy fallback (threshold in WHERE) ──────────────
  const queryIdx = nextIdx;
  const limitIdxB = nextIdx + 1;
  return ctx.db.query<FoodRowForResolve>(
    `SELECT ${selectCols}
       FROM foods
      WHERE similarity(
              immutable_unaccent(lower(canonical_name)),
              immutable_unaccent(lower($${queryIdx}))
            ) >= ${TRIGRAM_THRESHOLD}
        AND ${scopeSql}
      ORDER BY similarity(
                 immutable_unaccent(lower(canonical_name)),
                 immutable_unaccent(lower($${queryIdx}))
               ) DESC
      LIMIT $${limitIdxB}`,
    [...baseParams, query, limit]
  );
}

function per100(row: FoodRowForResolve): {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
} {
  const refQty = Number(row.reference_qty);
  const factor = refQty > 0 ? 100 / refQty : 1;
  return {
    kcal: Number(row.kcal) * factor,
    protein: Number(row.protein_g) * factor,
    carbs: Number(row.carbs_g) * factor,
    fat: Number(row.fat_g) * factor,
  };
}

function normName(s: string): string {
  return s.toLowerCase().trim();
}

const resolveTool = defineTool({
  name: 'foods_resolve',
  description:
    'Unified resolver. Parallel: user_recipes (A) + user atomic foods (B) + global ' +
    'foods (C) + external USDA/OFF lookup (D, optional). Dedupe D candidates whose ' +
    'source matches existing external_source in DB, then by normalized canonical_name. ' +
    'Returns ranked list (user_recipe > user_atomic > global_atomic_imported > ' +
    'global_composite > global_atomic_seed > external_off > external_usda) + counts. ' +
    'All macros normalized to per-100g (factor = 100 / reference_qty). External ' +
    'fetch failure OR empty external => warning:"external_lookup_failed", never throws.',
  inputSchema: z
    .object({
      query: z.string().min(1),
      include_external: z.boolean().optional(),
      limit: z.number().int().positive().max(50).optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const limit = input.limit ?? 10;
    const includeExternal = input.include_external ?? true;

    // Structured entry log (observability, T006). One JSON line per call.
    const entryTokens = tokenizeQuery(input.query);
    console.log(
      JSON.stringify({
        tool: 'foods_resolve',
        user_id: ctx.userId,
        query: input.query,
        tokens: entryTokens,
        ts: new Date().toISOString(),
      })
    );

    // Run DB queries in parallel.
    const [recipes, userFoods, globalFoods, externalResult, historyMap] =
      await Promise.all([
        // A
        listUserRecipesInternal(ctx, { name_query: input.query, limit: 20 }).catch(
          () => [] as UserRecipeRow[]
        ),
        // B: user-owned foods (atomic + recipes carry created_by=user; we keep atomic only,
        // recipes already in A).
        selectFoodsForResolve(ctx, input.query, 'user', 20).catch(
          () => [] as FoodRowForResolve[]
        ),
        // C: global foods (created_by IS NULL).
        selectFoodsForResolve(ctx, input.query, 'global', 20).catch(
          () => [] as FoodRowForResolve[]
        ),
        // D
        includeExternal
          ? lookupFoodInternal(input.query, 'auto', 10).catch(() => null)
          : Promise.resolve(null),
        // E: per-user food usage history (last 60 days). Independent of A/B/C/D,
        // consulted in-memory after slice to enrich candidates with user_history.
        selectUserHistory(ctx, 60).catch(() => new Map<number, UserHistoryEntry>()),
      ]);

    const externalFoods = externalResult?.results ?? [];
    // Warn whenever external was requested but contributed nothing (throw OR empty).
    // Helpful UX so the centrale knows external didn't run / didn't match.
    const externalFailed = includeExternal && externalFoods.length === 0;

    // Collect external_source + normalized names already in DB for dedupe.
    const dbExternalSources = new Set<string>();
    const dbNames = new Set<string>();
    for (const r of recipes) dbNames.add(normName(r.canonical_name));
    for (const f of userFoods) {
      if (f.external_source) dbExternalSources.add(f.external_source);
      dbNames.add(normName(f.canonical_name));
    }
    for (const f of globalFoods) {
      if (f.external_source) dbExternalSources.add(f.external_source);
      dbNames.add(normName(f.canonical_name));
    }
    // Filter atomic user/global to atomic-only for ranking (recipes already in A).
    const userAtomicOnly = userFoods.filter((f) => f.kind === 'atomic');
    const globalAtomic = globalFoods.filter((f) => f.kind === 'atomic');
    const globalComposite = globalFoods.filter(
      (f) => f.kind === 'composite' || f.kind === 'user_recipe'
    );

    // Build candidates.
    const candidates: ResolveCandidate[] = [];

    for (const r of recipes) {
      // recipe.reference_qty = total grams of the recipe (set at upsert_composite time).
      const refQty = r.reference_qty;
      const factor = refQty > 0 ? 100 / refQty : 1;
      candidates.push({
        source_type: 'user_recipe',
        food_id: r.food_id,
        name: r.canonical_name,
        kcal_per_100g: r.kcal * factor,
        protein_g_per_100g: r.protein_g * factor,
        carbs_g_per_100g: r.carbs_g * factor,
        fat_g_per_100g: r.fat_g * factor,
        kind: 'user_recipe',
        confidence: 1.0,
        user_history: null,
      });
    }

    for (const f of userAtomicOnly) {
      const m = per100(f);
      candidates.push({
        source_type: 'user_atomic',
        food_id: f.id,
        name: f.canonical_name,
        kcal_per_100g: m.kcal,
        protein_g_per_100g: m.protein,
        carbs_g_per_100g: m.carbs,
        fat_g_per_100g: m.fat,
        kind: 'atomic',
        confidence: 0.95,
        user_history: null,
      });
    }

    for (const f of globalAtomic) {
      const sourceType: SourceType =
        f.external_source !== null
          ? 'global_atomic_imported'
          : 'global_atomic_seed';
      const m = per100(f);
      candidates.push({
        source_type: sourceType,
        food_id: f.id,
        name: f.canonical_name,
        kcal_per_100g: m.kcal,
        protein_g_per_100g: m.protein,
        carbs_g_per_100g: m.carbs,
        fat_g_per_100g: m.fat,
        kind: 'atomic',
        confidence: sourceType === 'global_atomic_imported' ? 0.9 : 0.85,
        user_history: null,
      });
    }

    for (const f of globalComposite) {
      const m = per100(f);
      candidates.push({
        source_type: 'global_composite',
        food_id: f.id,
        name: f.canonical_name,
        kcal_per_100g: m.kcal,
        protein_g_per_100g: m.protein,
        carbs_g_per_100g: m.carbs,
        fat_g_per_100g: m.fat,
        kind: f.kind === 'user_recipe' ? 'user_recipe' : 'composite',
        confidence: 0.85,
        user_history: null,
      });
    }

    // D candidates with dedupe by source AND by name.
    for (const ext of externalFoods) {
      if (dbExternalSources.has(ext.source)) continue;
      if (dbNames.has(normName(ext.name))) continue;
      const sourceType: SourceType = ext.source.startsWith('usda:')
        ? 'external_usda'
        : 'external_off';
      candidates.push({
        source_type: sourceType,
        external_payload: ext,
        name: ext.name,
        kcal_per_100g: ext.kcal_per_100g,
        protein_g_per_100g: ext.protein_g_per_100g,
        carbs_g_per_100g: ext.carbs_g_per_100g,
        fat_g_per_100g: ext.fat_g_per_100g,
        confidence: ext.confidence,
        user_history: null,
      });
    }

    // Stable sort by rank, then by confidence desc.
    candidates.sort((a, b) => {
      const r = RANK[a.source_type] - RANK[b.source_type];
      if (r !== 0) return r;
      return b.confidence - a.confidence;
    });

    const top = candidates.slice(0, limit);

    // Enrich top candidates with user_history (pure additive — no ranking impact).
    for (const candidate of top) {
      candidate.user_history =
        candidate.food_id != null
          ? (historyMap.get(candidate.food_id) ?? null)
          : null;
    }

    const counts = {
      user_recipe: top.filter((c) => c.source_type === 'user_recipe').length,
      user_atomic: top.filter((c) => c.source_type === 'user_atomic').length,
      global: top.filter(
        (c) =>
          c.source_type === 'global_atomic_imported' ||
          c.source_type === 'global_atomic_seed' ||
          c.source_type === 'global_composite'
      ).length,
      external: top.filter(
        (c) => c.source_type === 'external_usda' || c.source_type === 'external_off'
      ).length,
    };

    const warning = externalFailed ? 'external_lookup_failed' : undefined;

    // Structured exit log (observability, T006).
    console.log(
      JSON.stringify({
        tool: 'foods_resolve',
        user_id: ctx.userId,
        query: input.query,
        counts,
        top_source_types: top.slice(0, 3).map((c) => c.source_type),
        warning,
        ts: new Date().toISOString(),
      })
    );

    const result: {
      candidates: ResolveCandidate[];
      counts: typeof counts;
      warning?: string;
    } = { candidates: top, counts };
    if (warning) result.warning = warning;
    return result;
  },
});

export const foodsResolveTools: AnyToolModule[] = [resolveTool];
