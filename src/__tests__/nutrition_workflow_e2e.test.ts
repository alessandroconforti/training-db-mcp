/**
 * nutrition_workflow_e2e.test.ts — Integration tests (T020/T021/T022).
 *
 * Exercises the full sequence end-to-end against a stateful in-memory fake DB:
 *   foods.resolve  → upsert_atomic (× ingredients)  → upsert_composite
 *                  → log_with_components (Case B)   → resolve again (reuse)
 *
 * Test 1 (T020): "pasta alle vongole" prima volta — full mapping, 3 atomics + 1 recipe + 1 entry + 3 components.
 * Test 2 (T021): "pasta alle vongole" seconda volta — Case A reuse, 0 new components, no external HTTP.
 * Test 3 (T022): Edge cases — atomic standalone (no duplication on composite), snapshot immutability.
 */
process.env.NUTRITION_USDA_API_KEY = 'test-key';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

import type { Db, Queryable } from '../db.js';
import type { ToolCtx, AnyToolModule } from '../registry.js';

import { __setHttp as setUsdaHttp } from '../adapters/usda.js';
import { __setHttp as setOffHttp } from '../adapters/openfoodfacts.js';
import * as cache from '../adapters/cache.js';

import { foodsUpsertAtomicTools } from '../tools/foods_upsert_atomic.js';
import { foodsUpsertCompositeTools } from '../tools/foods_upsert_composite.js';
import { logFoodEntryWithComponentsTools } from '../tools/log_food_entry_with_components.js';
import { foodsResolveTools } from '../tools/foods_resolve.js';

const USER = '11111111-2222-3333-4444-555555555555';

before(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nutri-e2e-cache-'));
  cache.__setCacheDir(tmp);
  process.env.NUTRITION_USDA_API_KEY = 'test-key';
});

// ─── Stateful in-memory DB simulator ─────────────────────────────────────────

interface FoodRow {
  id: number;
  canonical_name: string;
  aliases: string[] | null;
  unit: string;
  reference_qty: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  grams_per_piece: number | null;
  category: string | null;
  external_source: string | null;
  kind: 'atomic' | 'composite' | 'user_recipe';
  created_by: string | null;
}
interface FoodComponentRow {
  parent_food_id: number;
  child_food_id: number;
  grams: number;
  position: number;
}
interface FoodEntryRow {
  id: number;
  user_id: string;
  date: string;
  meal: string;
  food_id: number;
  quantity: number;
  food_name_snapshot: string;
  unit_snapshot: string;
  reference_qty_snapshot: number;
  kcal_snapshot: number;
  protein_g_snapshot: number;
  carbs_g_snapshot: number;
  fat_g_snapshot: number;
  entry_unit: string;
  grams_per_piece_snapshot: number | null;
  notes: string | null;
}
interface FoodEntryComponentRow {
  food_entry_id: number;
  user_id: string;
  food_id: number;
  grams: number;
  position: number;
  food_name_snapshot: string;
  kcal_snapshot: number;
  protein_g_snapshot: number;
  carbs_g_snapshot: number;
  fat_g_snapshot: number;
}

class FakeDbState {
  foods: FoodRow[] = [];
  foodComponents: FoodComponentRow[] = [];
  foodEntries: FoodEntryRow[] = [];
  foodEntryComponents: FoodEntryComponentRow[] = [];
  nextFoodId = 1;
  nextEntryId = 1;
}

function makeStatefulDb(state: FakeDbState): Db {
  const run = (sql: string, params: unknown[]): unknown[] => {
    const s = sql.replace(/\s+/g, ' ').trim();

    // INSERT INTO foods (atomic or composite)
    if (s.startsWith('INSERT INTO foods')) {
      // upsert_atomic shape (12 params + literal 'atomic' for kind):
      //   $1=name, $2=aliases, $3=unit, $4=ref_qty, $5=kcal, $6=p, $7=c, $8=f,
      //   $9=gpp, $10=cat, $11=ext_src, $12=created_by  (kind is literal 'atomic')
      // upsert_composite shape (9 params, 'g' is literal):
      //   $1=name, $2=aliases, $3=ref_qty, $4=kcal, $5=p, $6=c, $7=f, $8=kind, $9=created_by
      const id = state.nextFoodId++;
      if (params.length === 12) {
        state.foods.push({
          id,
          canonical_name: params[0] as string,
          aliases: (params[1] as string[] | null) ?? null,
          unit: params[2] as string,
          reference_qty: Number(params[3]),
          kcal: Number(params[4]),
          protein_g: Number(params[5]),
          carbs_g: Number(params[6]),
          fat_g: Number(params[7]),
          grams_per_piece: (params[8] as number | null) ?? null,
          category: (params[9] as string | null) ?? null,
          external_source: (params[10] as string | null) ?? null,
          kind: 'atomic',
          created_by: (params[11] as string | null) ?? null,
        });
      } else {
        // composite: ($1=name, $2=aliases, lit 'g', $3=ref_qty, $4=kcal, $5..$7, $8=kind, $9=created_by)
        state.foods.push({
          id,
          canonical_name: params[0] as string,
          aliases: (params[1] as string[] | null) ?? null,
          unit: 'g',
          reference_qty: Number(params[2]),
          kcal: Number(params[3]),
          protein_g: Number(params[4]),
          carbs_g: Number(params[5]),
          fat_g: Number(params[6]),
          grams_per_piece: null,
          category: null,
          external_source: null,
          kind: params[7] as 'composite' | 'user_recipe',
          created_by: (params[8] as string | null) ?? null,
        });
      }
      return [{ id }];
    }

    // UPDATE foods (upsert_atomic UPDATE branch)
    if (s.startsWith('UPDATE foods')) {
      const id = params[params.length - 1] as number;
      const row = state.foods.find((f) => f.id === id);
      if (row) {
        row.aliases = (params[0] as string[] | null) ?? null;
        row.unit = params[1] as string;
        row.reference_qty = Number(params[2]);
        row.kcal = Number(params[3]);
        row.protein_g = Number(params[4]);
        row.carbs_g = Number(params[5]);
        row.fat_g = Number(params[6]);
        row.grams_per_piece = (params[7] as number | null) ?? null;
        row.category = (params[8] as string | null) ?? null;
        row.external_source = (params[9] as string | null) ?? null;
        row.kind = 'atomic';
      }
      return [];
    }

    // INSERT INTO food_components
    if (s.startsWith('INSERT INTO food_components')) {
      state.foodComponents.push({
        parent_food_id: params[0] as number,
        child_food_id: params[1] as number,
        grams: Number(params[2]),
        position: params[3] as number,
      });
      return [];
    }

    // INSERT INTO food_entries
    if (s.startsWith('INSERT INTO food_entries')) {
      const id = state.nextEntryId++;
      state.foodEntries.push({
        id,
        user_id: params[0] as string,
        date: params[1] as string,
        meal: params[2] as string,
        food_id: params[3] as number,
        quantity: Number(params[4]),
        food_name_snapshot: params[5] as string,
        unit_snapshot: params[6] as string,
        reference_qty_snapshot: Number(params[7]),
        kcal_snapshot: Number(params[8]),
        protein_g_snapshot: Number(params[9]),
        carbs_g_snapshot: Number(params[10]),
        fat_g_snapshot: Number(params[11]),
        entry_unit: params[12] as string,
        grams_per_piece_snapshot: (params[13] as number | null) ?? null,
        notes: (params[14] as string | null) ?? null,
      });
      return [{ id }];
    }

    // INSERT INTO food_entry_components
    if (s.startsWith('INSERT INTO food_entry_components')) {
      state.foodEntryComponents.push({
        food_entry_id: params[0] as number,
        user_id: params[1] as string,
        food_id: params[2] as number,
        grams: Number(params[3]),
        position: params[4] as number,
        food_name_snapshot: params[5] as string,
        kcal_snapshot: Number(params[6]),
        protein_g_snapshot: Number(params[7]),
        carbs_g_snapshot: Number(params[8]),
        fat_g_snapshot: Number(params[9]),
      });
      return [];
    }

    // SELECT branches.
    if (s.startsWith('SELECT')) {
      // foods_upsert_atomic: SELECT id FROM foods WHERE external_source = $1
      if (s.includes('FROM foods') && s.includes('external_source = $1') && !s.includes('canonical_name')) {
        const src = params[0] as string;
        const hit = state.foods.find((f) => f.external_source === src);
        return hit ? [{ id: hit.id }] : [];
      }
      // foods_upsert_atomic: SELECT id, created_by ... WHERE canonical_name = $1 AND (created_by IS NULL OR created_by = $2)
      if (
        s.includes('FROM foods') &&
        s.includes('canonical_name = $1') &&
        s.includes('created_by IS NULL OR created_by = $2')
      ) {
        const name = params[0] as string;
        const uid = params[1] as string;
        const hit = state.foods.find(
          (f) => f.canonical_name === name && (f.created_by === null || f.created_by === uid)
        );
        return hit ? [{ id: hit.id, created_by: hit.created_by }] : [];
      }
      // foods_upsert_composite: SELECT id ... WHERE canonical_name = $1 AND created_by = $2 AND kind = 'user_recipe'
      if (s.includes("kind = 'user_recipe'") && s.includes('canonical_name = $1') && s.includes('created_by = $2')) {
        const name = params[0] as string;
        const uid = params[1] as string;
        const hit = state.foods.find(
          (f) => f.canonical_name === name && f.created_by === uid && f.kind === 'user_recipe'
        );
        return hit ? [{ id: hit.id }] : [];
      }
      // foods_upsert_composite component lookup OR log_with_components child lookup:
      // SELECT ... WHERE id = $1 AND (created_by IS NULL OR created_by = $2)
      if (s.includes('FROM foods') && s.includes('WHERE id = $1') && s.includes('created_by IS NULL OR created_by = $2')) {
        const id = params[0] as number;
        const uid = params[1] as string;
        const hit = state.foods.find(
          (f) => f.id === id && (f.created_by === null || f.created_by === uid)
        );
        if (!hit) return [];
        return [
          {
            id: hit.id,
            canonical_name: hit.canonical_name,
            unit: hit.unit,
            kind: hit.kind,
            reference_qty: hit.reference_qty,
            kcal: hit.kcal,
            protein_g: hit.protein_g,
            carbs_g: hit.carbs_g,
            fat_g: hit.fat_g,
            grams_per_piece: hit.grams_per_piece,
            created_by: hit.created_by,
          },
        ];
      }
      // listUserRecipesInternal: foods WHERE created_by = $1 AND kind = 'user_recipe' [AND name ILIKE]
      if (
        s.includes('FROM foods') &&
        s.includes("kind = 'user_recipe'") &&
        s.includes('created_by = $1') &&
        s.includes('components_count')
      ) {
        const uid = params[0] as string;
        const namePattern = params.length >= 3 ? (params[1] as string) : null;
        let rows = state.foods.filter((f) => f.created_by === uid && f.kind === 'user_recipe');
        if (namePattern) {
          const term = namePattern.replace(/%/g, '').toLowerCase();
          rows = rows.filter((f) => f.canonical_name.toLowerCase().includes(term));
        }
        return rows.map((f) => ({
          id: f.id,
          canonical_name: f.canonical_name,
          aliases: f.aliases,
          kcal: f.kcal,
          protein_g: f.protein_g,
          carbs_g: f.carbs_g,
          fat_g: f.fat_g,
          reference_qty: f.reference_qty,
          components_count: state.foodComponents.filter((c) => c.parent_food_id === f.id).length,
        }));
      }
      // selectFoodsForResolve: foods WHERE (canonical_name ILIKE $2 OR $3 = ANY(...)) AND (created_by=$1 | IS NULL)
      if (
        s.includes('FROM foods') &&
        s.includes('ILIKE $2') &&
        s.includes('ANY(COALESCE(aliases')
      ) {
        const uid = params[0] as string;
        const like = (params[1] as string).replace(/%/g, '').toLowerCase();
        const exact = params[2] as string;
        const scopeUser = s.includes('created_by = $1');
        let rows = state.foods.filter((f) =>
          scopeUser ? f.created_by === uid : f.created_by === null
        );
        rows = rows.filter(
          (f) =>
            f.canonical_name.toLowerCase().includes(like) ||
            (f.aliases ?? []).includes(exact)
        );
        return rows.map((f) => ({
          id: f.id,
          canonical_name: f.canonical_name,
          kind: f.kind,
          kcal: f.kcal,
          protein_g: f.protein_g,
          carbs_g: f.carbs_g,
          fat_g: f.fat_g,
          reference_qty: f.reference_qty,
          external_source: f.external_source,
        }));
      }
    }

    return [];
  };

  const q: Queryable = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return run(sql, params ?? []) as T[];
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return ((run(sql, params ?? [])[0] as T) ?? null) as T | null;
    },
  };
  return {
    ...q,
    async tx<T>(cb: (c: Queryable) => Promise<T>) {
      return cb(q);
    },
    async end() {},
  };
}

const ctxFor = (db: Db): ToolCtx => ({ userId: USER, db });

function byName(tools: AnyToolModule[], name: string): AnyToolModule {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} must exist`);
  return t!;
}

async function callTool(tool: AnyToolModule, input: unknown, db: Db): Promise<unknown> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error('input validation failed: ' + JSON.stringify(parsed.error.issues));
  return tool.handler(parsed.data, ctxFor(db));
}

function jsonHttp(producer: (url: string) => unknown) {
  return async (url: string) => ({
    statusCode: 200,
    body: { json: async () => producer(url) },
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Test 1 — "pasta alle vongole" prima volta (T020)
// ═════════════════════════════════════════════════════════════════════════════

test('T020 pasta alle vongole prima volta: full mapping resolve → atomic×3 → composite → log Case B', async () => {
  const state = new FakeDbState();
  const db = makeStatefulDb(state);

  const resolveTool = byName(foodsResolveTools, 'foods_resolve');
  const upsertAtomicTool = byName(foodsUpsertAtomicTools, 'foods_upsert_atomic');
  const upsertCompositeTool = byName(foodsUpsertCompositeTools, 'foods_upsert_composite');
  const logTool = byName(logFoodEntryWithComponentsTools, 'log_food_entry_with_components');

  // Step 1: resolve whole dish → DB empty + external returns nothing credible.
  setUsdaHttp(jsonHttp(() => ({ foods: [] })) as unknown as Parameters<typeof setUsdaHttp>[0]);
  setOffHttp(jsonHttp(() => ({ products: [] })) as unknown as Parameters<typeof setOffHttp>[0]);

  const dishQuery = `pasta-alle-vongole-test1-${Date.now()}`;
  const r1 = (await callTool(resolveTool, { query: dishQuery }, db)) as {
    candidates: unknown[];
    counts: { external: number };
    warning?: string;
  };
  assert.equal(r1.candidates.length, 0);
  assert.equal(r1.counts.external, 0);
  assert.equal(r1.warning, 'external_lookup_failed');

  // Step 2: per-ingredient resolve + upsert_atomic. Define USDA mocks per query.
  // Use distinct unique queries to bypass any normalized name dedupe/cache.
  const ingredients: Array<{ query: string; usda: { fdcId: number; description: string; kcal: number; protein: number; carbs: number; fat: number } }> = [
    { query: `spaghetti-t1-${Date.now()}-a`, usda: { fdcId: 1001, description: 'spaghetti raw', kcal: 359, protein: 12, carbs: 72, fat: 1.5 } },
    { query: `vongole-t1-${Date.now()}-b`, usda: { fdcId: 1002, description: 'clams raw', kcal: 86, protein: 14, carbs: 3, fat: 1 } },
    { query: `olio-evo-t1-${Date.now()}-c`, usda: { fdcId: 1003, description: 'olive oil extra virgin', kcal: 884, protein: 0, carbs: 0, fat: 100 } },
  ];

  const ingredientFoodIds: number[] = [];

  for (const ing of ingredients) {
    setUsdaHttp(
      jsonHttp(() => ({
        foods: [
          {
            fdcId: ing.usda.fdcId,
            description: ing.usda.description,
            score: 800,
            foodNutrients: [
              { nutrientId: 1008, value: ing.usda.kcal },
              { nutrientId: 1003, value: ing.usda.protein },
              { nutrientId: 1005, value: ing.usda.carbs },
              { nutrientId: 1004, value: ing.usda.fat },
            ],
          },
        ],
      })) as unknown as Parameters<typeof setUsdaHttp>[0]
    );
    setOffHttp(jsonHttp(() => ({ products: [] })) as unknown as Parameters<typeof setOffHttp>[0]);

    const r = (await callTool(resolveTool, { query: ing.query }, db)) as {
      candidates: Array<{
        source_type: string;
        external_payload?: { source: string; name: string; kcal_per_100g: number; protein_g_per_100g: number; carbs_g_per_100g: number; fat_g_per_100g: number };
      }>;
    };
    // Top candidate must be external (DB is empty).
    const top = r.candidates[0];
    assert.ok(top, `expected at least one candidate for ${ing.query}`);
    assert.equal(top.source_type, 'external_usda');
    assert.ok(top.external_payload, 'external_payload required to upsert');

    // Upsert atomic from external payload.
    const up = (await callTool(
      upsertAtomicTool,
      {
        canonical_name: top.external_payload!.name,
        unit: 'g',
        reference_qty: 100,
        kcal: top.external_payload!.kcal_per_100g,
        protein_g: top.external_payload!.protein_g_per_100g,
        carbs_g: top.external_payload!.carbs_g_per_100g,
        fat_g: top.external_payload!.fat_g_per_100g,
        external_source: top.external_payload!.source,
      },
      db
    )) as { food_id: number; was_created: boolean };
    assert.equal(up.was_created, true, `${ing.query} should be newly created`);
    ingredientFoodIds.push(up.food_id);
  }

  assert.equal(ingredientFoodIds.length, 3);
  assert.equal(state.foods.length, 3, '3 atomic foods inserted');
  // All atomic ingredients were imported via external → created_by must be NULL.
  for (const f of state.foods) {
    assert.equal(f.kind, 'atomic');
    assert.equal(f.created_by, null);
    assert.ok(f.external_source && f.external_source.startsWith('usda:'));
  }

  const [A, B, C] = ingredientFoodIds; // spaghetti / vongole / olio
  const recipeName = `pasta alle vongole t1-${Date.now()}`;

  // Step 3: composite recipe.
  const composite = (await callTool(
    upsertCompositeTool,
    {
      canonical_name: recipeName,
      components: [
        { food_id: A, grams: 80, position: 0 },
        { food_id: B, grams: 150, position: 1 },
        { food_id: C, grams: 15, position: 2 },
      ],
    },
    db
  )) as {
    food_id: number;
    total_grams: number;
    aggregated_macros: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  };

  const R = composite.food_id;
  assert.equal(composite.total_grams, 245);
  // Expected kcal: 80 * 3.59 + 150 * 0.86 + 15 * 8.84 = 287.2 + 129 + 132.6 = 548.8
  assert.ok(Math.abs(composite.aggregated_macros.kcal - 548.8) < 0.01,
    `aggregated kcal expected ~548.8, got ${composite.aggregated_macros.kcal}`);

  // Recipe row exists, kind=user_recipe, owned by user.
  const recipeRow = state.foods.find((f) => f.id === R);
  assert.ok(recipeRow);
  assert.equal(recipeRow!.kind, 'user_recipe');
  assert.equal(recipeRow!.created_by, USER);
  assert.equal(state.foods.filter((f) => f.kind === 'user_recipe').length, 1);
  assert.equal(state.foodComponents.filter((c) => c.parent_food_id === R).length, 3);

  // Step 4: log Case B.
  const logRes = (await callTool(
    logTool,
    {
      date: '2026-05-25',
      meal: 'pranzo',
      food_id: R,
      quantity: 245,
      entry_unit: 'g',
      components: [
        { food_id: A, grams: 80, position: 0 },
        { food_id: B, grams: 150, position: 1 },
        { food_id: C, grams: 15, position: 2 },
      ],
    },
    db
  )) as {
    food_entry_id: number;
    components_logged: number;
    total_macros: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  };

  assert.equal(logRes.components_logged, 3);
  // Aggregated snapshot kcal = same computation (~548.8).
  assert.ok(Math.abs(logRes.total_macros.kcal - 548.8) < 0.01);

  // Final assertions.
  assert.equal(state.foodEntries.length, 1, '1 food_entry');
  assert.equal(state.foodEntryComponents.length, 3, '3 food_entry_components');
  assert.equal(state.foods.filter((f) => f.kind === 'user_recipe').length, 1);
  assert.equal(state.foods.filter((f) => f.kind === 'atomic').length, 3);
  // Snapshot kcal on the entry matches aggregated.
  const entry = state.foodEntries[0];
  assert.ok(Math.abs(entry.kcal_snapshot - 548.8) < 0.01);

  setUsdaHttp(null);
  setOffHttp(null);
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 2 — Seconda volta: riuso (T021)
// ═════════════════════════════════════════════════════════════════════════════

test('T021 pasta alle vongole seconda volta: resolve picks user_recipe, Case A log, zero external HTTP', async () => {
  const state = new FakeDbState();
  const db = makeStatefulDb(state);

  // Seed: pre-build the same state as end of Test 1, but inline (no HTTP needed).
  const upsertAtomicTool = byName(foodsUpsertAtomicTools, 'foods_upsert_atomic');
  const upsertCompositeTool = byName(foodsUpsertCompositeTools, 'foods_upsert_composite');
  const resolveTool = byName(foodsResolveTools, 'foods_resolve');
  const logTool = byName(logFoodEntryWithComponentsTools, 'log_food_entry_with_components');

  const recipeName = 'pasta alle vongole t2';
  const atomics = [
    { name: 'spaghetti t2', kcal: 359, p: 12, c: 72, f: 1.5, ext: 'usda:2001' },
    { name: 'vongole t2', kcal: 86, p: 14, c: 3, f: 1, ext: 'usda:2002' },
    { name: 'olio evo t2', kcal: 884, p: 0, c: 0, f: 100, ext: 'usda:2003' },
  ];
  const ids: number[] = [];
  for (const a of atomics) {
    const r = (await callTool(
      upsertAtomicTool,
      {
        canonical_name: a.name,
        unit: 'g',
        reference_qty: 100,
        kcal: a.kcal,
        protein_g: a.p,
        carbs_g: a.c,
        fat_g: a.f,
        external_source: a.ext,
      },
      db
    )) as { food_id: number };
    ids.push(r.food_id);
  }
  const composite = (await callTool(
    upsertCompositeTool,
    {
      canonical_name: recipeName,
      components: [
        { food_id: ids[0], grams: 80, position: 0 },
        { food_id: ids[1], grams: 150, position: 1 },
        { food_id: ids[2], grams: 15, position: 2 },
      ],
    },
    db
  )) as { food_id: number };
  const R = composite.food_id;

  // Snapshot state counts to assert deltas.
  const entriesBefore = state.foodEntries.length;
  const componentsBefore = state.foodEntryComponents.length;

  // Now: any external HTTP call MUST throw — proves we did NOT hit the network.
  let externalCalls = 0;
  setUsdaHttp(
    (async () => {
      externalCalls++;
      throw new Error('USDA must not be called during reuse path');
    }) as unknown as Parameters<typeof setUsdaHttp>[0]
  );
  setOffHttp(
    (async () => {
      externalCalls++;
      throw new Error('OFF must not be called during reuse path');
    }) as unknown as Parameters<typeof setOffHttp>[0]
  );

  // Step 1: resolve — pass include_external:false to avoid even attempting external.
  // Centrale's behavior on reuse: DB hit dominates; we model that as include_external:false.
  const r = (await callTool(
    resolveTool,
    { query: 'pasta alle vongole t2', include_external: false },
    db
  )) as {
    candidates: Array<{ source_type: string; food_id?: number }>;
    counts: { user_recipe: number; external: number };
  };
  assert.ok(r.candidates.length >= 1);
  assert.equal(r.candidates[0].source_type, 'user_recipe');
  assert.equal(r.candidates[0].food_id, R);
  assert.equal(r.counts.external, 0);
  assert.equal(externalCalls, 0, 'no external HTTP must occur with include_external:false');

  // Step 2: log Case A (no components passed).
  const logRes = (await callTool(
    logTool,
    {
      date: '2026-05-25',
      meal: 'cena',
      food_id: R,
      quantity: 245,
      entry_unit: 'g',
    },
    db
  )) as {
    food_entry_id: number;
    components_logged: number;
    total_macros: { kcal: number };
  };
  assert.equal(logRes.components_logged, 0);

  // Delta assertions.
  assert.equal(state.foodEntries.length - entriesBefore, 1, '1 new entry');
  assert.equal(state.foodEntryComponents.length - componentsBefore, 0, 'ZERO new components');

  // Snapshot macros come from foods.R (Case A), not from components.
  const recipeRow = state.foods.find((f) => f.id === R)!;
  const entry = state.foodEntries[state.foodEntries.length - 1];
  assert.equal(entry.kcal_snapshot, recipeRow.kcal);
  assert.equal(entry.protein_g_snapshot, recipeRow.protein_g);

  assert.equal(externalCalls, 0, 'still no external HTTP after log');

  setUsdaHttp(null);
  setOffHttp(null);
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 3 — Edge cases: atomic standalone (NC2) + snapshot immutability (NC4) (T022)
// ═════════════════════════════════════════════════════════════════════════════

test('T022 edge cases: atomic standalone no duplication on composite + snapshot immutability', async () => {
  const state = new FakeDbState();
  const db = makeStatefulDb(state);
  const upsertAtomicTool = byName(foodsUpsertAtomicTools, 'foods_upsert_atomic');
  const upsertCompositeTool = byName(foodsUpsertCompositeTools, 'foods_upsert_composite');
  const logTool = byName(logFoodEntryWithComponentsTools, 'log_food_entry_with_components');

  // Scenario A: atomic standalone — Case A log, no components.
  const grana = (await callTool(
    upsertAtomicTool,
    {
      canonical_name: 'grana padano',
      unit: 'g',
      reference_qty: 100,
      kcal: 392,
      protein_g: 33,
      carbs_g: 0,
      fat_g: 28,
    },
    db
  )) as { food_id: number; was_created: boolean };
  assert.equal(grana.was_created, true);
  const G = grana.food_id;
  // User-created (no external_source) → created_by = USER.
  assert.equal(state.foods.find((f) => f.id === G)!.created_by, USER);

  // Log a Case A entry: 30g of grana.
  const granaLog = (await callTool(
    logTool,
    { date: '2026-05-25', meal: 'snack', food_id: G, quantity: 30, entry_unit: 'g' },
    db
  )) as { food_entry_id: number; components_logged: number; total_macros: { kcal: number } };
  assert.equal(granaLog.components_logged, 0);
  const granaEntry = state.foodEntries.find((e) => e.id === granaLog.food_entry_id)!;
  // Case A snapshot copies per-100g foods row values.
  assert.equal(granaEntry.kcal_snapshot, 392);
  assert.equal(granaEntry.protein_g_snapshot, 33);
  assert.equal(state.foodEntryComponents.filter((c) => c.food_entry_id === granaEntry.id).length, 0);

  // Add a second atomic to use as recipe component alongside grana.
  const tomato = (await callTool(
    upsertAtomicTool,
    {
      canonical_name: 'pomodoro',
      unit: 'g',
      reference_qty: 100,
      kcal: 20,
      protein_g: 1,
      carbs_g: 4,
      fat_g: 0,
    },
    db
  )) as { food_id: number };
  const T = tomato.food_id;

  // Composite uses grana as a component — no duplication of grana row.
  const granaRowsBefore = state.foods.filter((f) => f.canonical_name === 'grana padano').length;
  assert.equal(granaRowsBefore, 1);

  const composite = (await callTool(
    upsertCompositeTool,
    {
      canonical_name: 'pasta al pomodoro grana',
      components: [
        { food_id: G, grams: 15, position: 0 },
        { food_id: T, grams: 80, position: 1 },
      ],
    },
    db
  )) as { food_id: number };
  assert.ok(composite.food_id);

  const granaRowsAfter = state.foods.filter((f) => f.canonical_name === 'grana padano').length;
  assert.equal(granaRowsAfter, 1, 'grana atomic must NOT be duplicated when used in a composite');

  // Scenario B: snapshot immutability.
  // Update grana via upsert_atomic (same canonical_name, different macros, no external_source).
  const upd = (await callTool(
    upsertAtomicTool,
    {
      canonical_name: 'grana padano',
      unit: 'g',
      reference_qty: 100,
      kcal: 999,
      protein_g: 50,
      carbs_g: 0,
      fat_g: 60,
    },
    db
  )) as { food_id: number; was_created: boolean };
  assert.equal(upd.was_created, false, 'existing row must be updated, not created');
  assert.equal(upd.food_id, G);

  // foods.G now reflects updated macros.
  const updatedRow = state.foods.find((f) => f.id === G)!;
  assert.equal(updatedRow.kcal, 999);

  // Old food_entries row remains immutable (392 kcal snapshot).
  const oldEntry = state.foodEntries.find((e) => e.id === granaEntry.id)!;
  assert.equal(oldEntry.kcal_snapshot, 392, 'historical snapshot must remain immutable');

  // New log_with_components for grana → now uses 999.
  const newLog = (await callTool(
    logTool,
    { date: '2026-05-25', meal: 'cena', food_id: G, quantity: 30, entry_unit: 'g' },
    db
  )) as { food_entry_id: number; total_macros: { kcal: number } };
  const newEntry = state.foodEntries.find((e) => e.id === newLog.food_entry_id)!;
  assert.equal(newEntry.kcal_snapshot, 999, 'new snapshot reflects current foods row');
  // Old entry still unchanged.
  assert.equal(state.foodEntries.find((e) => e.id === granaEntry.id)!.kcal_snapshot, 392);
});
