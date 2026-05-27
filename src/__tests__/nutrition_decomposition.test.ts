/**
 * nutrition_decomposition.test.ts — Phase 6 (T006-T015) unit tests.
 *
 * Covers adapters (USDA + OFF + cache) and the 7 new MCP tools. Uses an in-memory
 * SpyDb (no live DB) and a mock HTTP shim injected via the adapter __setHttp
 * seam. Cache is redirected to a per-process tmp dir via __setCacheDir.
 */
// Set env BEFORE importing modules that may read it at call time.
process.env.NUTRITION_USDA_API_KEY = 'test-key';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

import type { Db, Queryable } from '../db.js';
import type { ToolCtx, AnyToolModule } from '../registry.js';

import { searchUsda, __setHttp as setUsdaHttp } from '../adapters/usda.js';
import { searchOff, __setHttp as setOffHttp } from '../adapters/openfoodfacts.js';
import * as cache from '../adapters/cache.js';

import { nutritionLookupFoodTools, lookupFoodInternal } from '../tools/nutrition_lookup_food.js';
import { foodsSearchTools } from '../tools/foods_search.js';
import { foodsUpsertAtomicTools } from '../tools/foods_upsert_atomic.js';
import { foodsUpsertCompositeTools } from '../tools/foods_upsert_composite.js';
import { logFoodEntryWithComponentsTools } from '../tools/log_food_entry_with_components.js';
import { foodsListUserRecipesTools } from '../tools/foods_list_user_recipes.js';
import { foodsResolveTools, selectUserHistory } from '../tools/foods_resolve.js';

const USER = '11111111-2222-3333-4444-555555555555';

// ─── Test fixtures ───────────────────────────────────────────────────────────

before(async () => {
  // Redirect cache to a tmp dir per run.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nutri-cache-'));
  cache.__setCacheDir(tmp);
  // Provide a non-empty USDA key so usda.getApiKey() doesn't throw.
  process.env.NUTRITION_USDA_API_KEY = 'test-key';
});

type Responder = (sql: string, params: unknown[]) => unknown[];

function makeDb(responder: Responder): {
  db: Db;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const run = (sql: string, params: unknown[] = []): unknown[] => {
    calls.push({ sql, params });
    return responder(sql, params);
  };
  const q: Queryable = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return run(sql, params ?? []) as T[];
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return ((run(sql, params ?? [])[0] as T) ?? null) as T | null;
    },
  };
  const db: Db = {
    ...q,
    async tx<T>(cb: (c: Queryable) => Promise<T>) {
      return cb(q);
    },
    async end() {},
  };
  return { db, calls };
}

const ctxFor = (db: Db): ToolCtx => ({ userId: USER, db });

function byName(tools: AnyToolModule[], name: string): AnyToolModule {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} must exist`);
  return t!;
}

async function call(tool: AnyToolModule, input: unknown, db: Db): Promise<unknown> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error('input validation failed');
  return tool.handler(parsed.data, ctxFor(db));
}

function mockHttp(map: Record<string, unknown>) {
  return async (url: string) => {
    const matched = Object.keys(map).find((k) => url.includes(k));
    if (!matched) {
      return { statusCode: 404, body: { json: async () => ({}) } };
    }
    return { statusCode: 200, body: { json: async () => map[matched] } };
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// T006 — USDA adapter
// ═════════════════════════════════════════════════════════════════════════════

test('T006 searchUsda: normalizes nutrients per-100g', async () => {
  setUsdaHttp(
    mockHttp({
      '/foods/search': {
        foods: [
          {
            fdcId: 123,
            description: 'Chicken breast, raw',
            score: 800,
            foodNutrients: [
              { nutrientId: 1008, value: 165 },
              { nutrientId: 1003, value: 31 },
              { nutrientId: 1005, value: 0 },
              { nutrientId: 1004, value: 3.6 },
            ],
          },
        ],
      },
    }) as unknown as Parameters<typeof setUsdaHttp>[0]
  );
  const res = await searchUsda('chicken breast');
  assert.equal(res.length, 1);
  assert.equal(res[0].source, 'usda:123');
  assert.equal(res[0].kcal_per_100g, 165);
  assert.equal(res[0].protein_g_per_100g, 31);
  setUsdaHttp(null);
});

test('T006 searchUsda: HTTP non-2xx throws', async () => {
  setUsdaHttp(
    (async () => ({ statusCode: 500, body: { json: async () => ({}) } })) as unknown as Parameters<
      typeof setUsdaHttp
    >[0]
  );
  await assert.rejects(() => searchUsda('x'), /USDA HTTP 500/);
  setUsdaHttp(null);
});

// ═════════════════════════════════════════════════════════════════════════════
// T007 — Open Food Facts adapter
// ═════════════════════════════════════════════════════════════════════════════

test('T007 searchOff(barcode): normalizes single product', async () => {
  setOffHttp(
    mockHttp({
      '/api/v2/product/': {
        status: 1,
        code: '8076809513968',
        product: {
          code: '8076809513968',
          product_name: 'Spaghetti n.5',
          nutriments: {
            'energy-kcal_100g': 359,
            proteins_100g: 12,
            carbohydrates_100g: 72,
            fat_100g: 1.5,
          },
        },
      },
    }) as unknown as Parameters<typeof setOffHttp>[0]
  );
  const res = await searchOff('8076809513968', 'barcode');
  assert.equal(res.length, 1);
  assert.equal(res[0].source, 'off:8076809513968');
  assert.equal(res[0].kcal_per_100g, 359);
  setOffHttp(null);
});

test('T007 searchOff(name): discards products without kcal+protein', async () => {
  setOffHttp(
    mockHttp({
      '/cgi/search.pl': {
        products: [
          { product_name: 'good', nutriments: { 'energy-kcal_100g': 100, proteins_100g: 5 } },
          { product_name: 'bad', nutriments: { proteins_100g: 5 } }, // missing kcal
          { product_name: 'unnamed', nutriments: { 'energy-kcal_100g': 100, proteins_100g: 5 } },
        ],
      },
    }) as unknown as Parameters<typeof setOffHttp>[0]
  );
  // Need a code on the products
  setOffHttp(
    mockHttp({
      '/cgi/search.pl': {
        products: [
          {
            code: 'a',
            product_name: 'good',
            nutriments: { 'energy-kcal_100g': 100, proteins_100g: 5 },
          },
          {
            code: 'b',
            product_name: 'bad',
            nutriments: { proteins_100g: 5 },
          },
        ],
      },
    }) as unknown as Parameters<typeof setOffHttp>[0]
  );
  const res = await searchOff('pasta', 'name');
  assert.equal(res.length, 1);
  assert.equal(res[0].name, 'good');
  setOffHttp(null);
});

// ═════════════════════════════════════════════════════════════════════════════
// T008 — Cache
// ═════════════════════════════════════════════════════════════════════════════

test('T008 cache: set then get returns value (hit)', async () => {
  await cache.set('cache_test_1', { foo: 1 });
  const v = await cache.get<{ foo: number }>('cache_test_1');
  assert.deepEqual(v, { foo: 1 });
});

test('T008 cache: get on missing key returns null (miss)', async () => {
  const v = await cache.get<unknown>('cache_test_missing_key');
  assert.equal(v, null);
});

test('T008 cache: TTL expiry returns null', async () => {
  const key = 'cache_test_ttl';
  const dir = cache.__internals.getDir();
  const file = cache.__internals.keyToPath(key);
  // Manually write an expired envelope.
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ ts: Date.now() - cache.__internals.TTL_MS - 1000, value: 'old' }),
    'utf8'
  );
  const v = await cache.get<string>(key);
  assert.equal(v, null);
});

test('T008 cache: directory auto-created', async () => {
  const dir = cache.__internals.getDir();
  const stat = await fs.stat(dir);
  assert.ok(stat.isDirectory());
});

// ═════════════════════════════════════════════════════════════════════════════
// T009 — nutrition_lookup_food
// ═════════════════════════════════════════════════════════════════════════════

test('T009 lookup_food: barcode routes to OFF only', async () => {
  setOffHttp(
    mockHttp({
      '/api/v2/product/': {
        status: 1,
        code: '8076809513968',
        product: {
          code: '8076809513968',
          product_name: 'Barilla Spaghetti',
          nutriments: { 'energy-kcal_100g': 350, proteins_100g: 12 },
        },
      },
    }) as unknown as Parameters<typeof setOffHttp>[0]
  );
  setUsdaHttp(
    (async () => {
      throw new Error('USDA must not be called for barcode route');
    }) as unknown as Parameters<typeof setUsdaHttp>[0]
  );
  const tool = byName(nutritionLookupFoodTools, 'nutrition_lookup_food');
  const res = (await call(tool, { query: '8076809513968' }, makeDb(() => [])!.db)) as {
    results: unknown[];
  };
  assert.equal(res.results.length, 1);
  setOffHttp(null);
  setUsdaHttp(null);
});

test('T009 lookup_food: generic term ("chicken") routes USDA first', async () => {
  const usdaCalls: string[] = [];
  setUsdaHttp(
    (async (url: string) => {
      usdaCalls.push(url);
      return {
        statusCode: 200,
        body: {
          json: async () => ({
            foods: [
              {
                fdcId: 1,
                description: 'chicken breast',
                foodNutrients: [
                  { nutrientId: 1008, value: 165 },
                  { nutrientId: 1003, value: 31 },
                ],
              },
            ],
          }),
        },
      };
    }) as unknown as Parameters<typeof setUsdaHttp>[0]
  );
  setOffHttp(
    (async () => ({ statusCode: 200, body: { json: async () => ({ products: [] }) } })) as unknown as Parameters<
      typeof setOffHttp
    >[0]
  );
  const res = await lookupFoodInternal('chicken', 'auto', 5);
  assert.ok(res.results.length >= 1);
  assert.ok(usdaCalls.length >= 1);
  setUsdaHttp(null);
  setOffHttp(null);
});

test('T009 lookup_food: non-generic non-barcode routes OFF first', async () => {
  const offCalls: string[] = [];
  setOffHttp(
    (async (url: string) => {
      offCalls.push(url);
      return {
        statusCode: 200,
        body: {
          json: async () => ({
            products: [
              {
                code: 'x',
                product_name: 'Findus Pasta',
                nutriments: { 'energy-kcal_100g': 200, proteins_100g: 8 },
              },
            ],
          }),
        },
      };
    }) as unknown as Parameters<typeof setOffHttp>[0]
  );
  const res = await lookupFoodInternal('findus pasta vongole', 'auto', 5);
  assert.ok(res.results.length >= 1);
  assert.ok(offCalls.length >= 1);
  setOffHttp(null);
});

test('T009 lookup_food: cached on second call', async () => {
  let httpCalls = 0;
  setOffHttp(
    (async () => {
      httpCalls++;
      return {
        statusCode: 200,
        body: {
          json: async () => ({
            products: [
              {
                code: 'c',
                product_name: 'CachedItem',
                nutriments: { 'energy-kcal_100g': 100, proteins_100g: 10 },
              },
            ],
          }),
        },
      };
    }) as unknown as Parameters<typeof setOffHttp>[0]
  );
  const q = `unique-query-${Date.now()}`;
  const r1 = await lookupFoodInternal(q, 'auto', 5);
  assert.equal(r1.cached, false);
  const r2 = await lookupFoodInternal(q, 'auto', 5);
  assert.equal(r2.cached, true);
  assert.equal(httpCalls, 1, 'second call should hit cache, no HTTP');
  setOffHttp(null);
});

test('T009 lookup_food: dedupe by canonical name', async () => {
  setOffHttp(
    (async () => ({
      statusCode: 200,
      body: {
        json: async () => ({
          products: [
            {
              code: 'a',
              product_name: 'Pasta Same',
              nutriments: { 'energy-kcal_100g': 100, proteins_100g: 10 },
            },
            {
              code: 'b',
              product_name: 'Pasta Same',
              nutriments: { 'energy-kcal_100g': 120, proteins_100g: 12 },
            },
          ],
        }),
      },
    })) as unknown as Parameters<typeof setOffHttp>[0]
  );
  const res = await lookupFoodInternal(`dedupe-test-${Date.now()}`, 'auto', 5);
  assert.equal(res.results.length, 1);
  setOffHttp(null);
});

test('T009 lookup_food: empty query returns empty results', async () => {
  const res = await lookupFoodInternal('', 'auto', 5);
  assert.deepEqual(res, { results: [], cached: false });
});

// ═════════════════════════════════════════════════════════════════════════════
// T010 — foods_search
// ═════════════════════════════════════════════════════════════════════════════

test('T010 foods_search: builds query with ILIKE + alias match', async () => {
  const { db, calls } = makeDb((sql) => {
    if (sql.includes('FROM foods')) {
      return [
        {
          id: 1,
          canonical_name: 'spaghetti',
          kind: 'atomic',
          kcal: 359,
          protein_g: 12,
          carbs_g: 72,
          fat_g: 1.5,
          external_source: null,
          is_user: false,
        },
      ];
    }
    return [];
  });
  const tool = byName(foodsSearchTools, 'foods_search');
  const res = (await call(tool, { query: 'spag' }, db)) as Array<{ canonical_name: string }>;
  assert.equal(res.length, 1);
  assert.equal(res[0].canonical_name, 'spaghetti');
  const sql = calls[0].sql;
  // Strategy A pipeline: tokenized ILIKE on unaccented canonical_name + EXISTS
  // unnest(aliases) for alias matching. Replaces the old `= ANY(aliases)` exact
  // match. Verify the new shape is in place and the old pattern is gone.
  assert.ok(sql.includes('ILIKE'), 'expected ILIKE in Strategy A SQL');
  assert.ok(
    sql.includes('immutable_unaccent(lower(canonical_name))'),
    'expected unaccent+lower(canonical_name) in Strategy A SQL'
  );
  assert.ok(
    sql.includes('unnest(COALESCE(aliases'),
    'expected EXISTS unnest(aliases) in Strategy A SQL'
  );
  assert.ok(
    !sql.includes('= ANY(COALESCE(aliases'),
    'old exact-match `= ANY(aliases)` should be removed'
  );
});

test('T010 foods_search: scope=user filters created_by = userId', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(foodsSearchTools, 'foods_search');
  await call(tool, { query: 'x', scope: 'user' }, db);
  assert.ok(calls[0].sql.includes('created_by = $1'));
});

test('T010 foods_search: scope=composite filters kind IN', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(foodsSearchTools, 'foods_search');
  await call(tool, { query: 'x', scope: 'composite' }, db);
  assert.ok(calls[0].sql.includes("kind IN ('composite','user_recipe')"));
});

test('T010 foods_search: empty result is empty array', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(foodsSearchTools, 'foods_search');
  const res = (await call(tool, { query: 'nonexistent' }, db)) as unknown[];
  assert.deepEqual(res, []);
});

// ═════════════════════════════════════════════════════════════════════════════
// T011 — foods_upsert_atomic
// ═════════════════════════════════════════════════════════════════════════════

const BASE_ATOMIC = {
  canonical_name: 'spaghetti',
  unit: 'g' as const,
  reference_qty: 100,
  kcal: 359,
  protein_g: 12,
  carbs_g: 72,
  fat_g: 1.5,
};

test('T011 upsert_atomic: external_source hit returns existing id (idempotent)', async () => {
  const { db, calls } = makeDb((sql) => {
    if (sql.includes('external_source = $1')) return [{ id: 42 }];
    return [];
  });
  const tool = byName(foodsUpsertAtomicTools, 'foods_upsert_atomic');
  const res = (await call(
    tool,
    { ...BASE_ATOMIC, external_source: 'usda:123' },
    db
  )) as { food_id: number; was_created: boolean };
  assert.deepEqual(res, { food_id: 42, was_created: false });
  // Only the external_source lookup ran — no INSERT.
  assert.equal(calls.length, 1);
});

test('T011 upsert_atomic: canonical_name hit owned by user => UPDATE', async () => {
  const { db, calls } = makeDb((sql) => {
    if (sql.includes('canonical_name = $1')) {
      return [{ id: 50, created_by: USER }];
    }
    return [];
  });
  const tool = byName(foodsUpsertAtomicTools, 'foods_upsert_atomic');
  const res = (await call(tool, BASE_ATOMIC, db)) as { was_created: boolean };
  assert.equal(res.was_created, false);
  assert.ok(calls.some((c) => /UPDATE foods/.test(c.sql)));
});

test('T011 upsert_atomic: canonical_name hit not owned => Conflict', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes('canonical_name = $1')) {
      return [{ id: 50, created_by: null }];
    }
    return [];
  });
  const tool = byName(foodsUpsertAtomicTools, 'foods_upsert_atomic');
  await assert.rejects(
    () => call(tool, BASE_ATOMIC, db),
    /already exists globally/
  );
});

test('T011 upsert_atomic: no match + no external => INSERT with created_by=userId', async () => {
  const insertParams: unknown[][] = [];
  const { db } = makeDb((sql, params) => {
    if (sql.includes('canonical_name = $1')) return [];
    if (sql.includes('INSERT INTO foods')) {
      insertParams.push(params);
      return [{ id: 99 }];
    }
    return [];
  });
  const tool = byName(foodsUpsertAtomicTools, 'foods_upsert_atomic');
  const res = (await call(tool, BASE_ATOMIC, db)) as { food_id: number; was_created: boolean };
  assert.deepEqual(res, { food_id: 99, was_created: true });
  // Last parameter on the INSERT is created_by — should be USER (no external_source).
  const last = insertParams[0][insertParams[0].length - 1];
  assert.equal(last, USER);
});

test('T011 upsert_atomic: no match + external_source => INSERT with created_by=NULL', async () => {
  const insertParams: unknown[][] = [];
  const { db } = makeDb((sql, params) => {
    if (sql.includes('external_source = $1')) return [];
    if (sql.includes('canonical_name = $1')) return [];
    if (sql.includes('INSERT INTO foods')) {
      insertParams.push(params);
      return [{ id: 100 }];
    }
    return [];
  });
  const tool = byName(foodsUpsertAtomicTools, 'foods_upsert_atomic');
  await call(tool, { ...BASE_ATOMIC, external_source: 'usda:xyz' }, db);
  const last = insertParams[0][insertParams[0].length - 1];
  assert.equal(last, null);
});

// ═════════════════════════════════════════════════════════════════════════════
// T012 — foods_upsert_composite
// ═════════════════════════════════════════════════════════════════════════════

test('T012 upsert_composite: happy path computes aggregated macros (ref_qty=100)', async () => {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const { db } = makeDb((sql, params) => {
    if (sql.includes('user_recipe')) return []; // dup check empty
    if (sql.includes('FROM foods')) {
      // Component lookup — return atomic food with reference_qty=100.
      const fid = params[0] as number;
      return [
        {
          id: fid,
          kind: 'atomic',
          reference_qty: 100,
          kcal: 100,
          protein_g: 5,
          carbs_g: 10,
          fat_g: 2,
          created_by: null,
        },
      ];
    }
    if (sql.includes('INSERT INTO foods')) {
      inserts.push({ sql, params });
      return [{ id: 999 }];
    }
    if (sql.includes('INSERT INTO food_components')) {
      inserts.push({ sql, params });
      return [];
    }
    return [];
  });
  const tool = byName(foodsUpsertCompositeTools, 'foods_upsert_composite');
  const res = (await call(
    tool,
    {
      canonical_name: 'test recipe',
      components: [
        { food_id: 1, grams: 100, position: 0 },
        { food_id: 2, grams: 50, position: 1 },
      ],
    },
    db
  )) as { food_id: number; total_grams: number; aggregated_macros: { kcal: number } };
  assert.equal(res.food_id, 999);
  assert.equal(res.total_grams, 150);
  // 100g => 100kcal, 50g => 50kcal, total 150kcal
  assert.equal(res.aggregated_macros.kcal, 150);
  // Check we inserted 1 foods row + 2 component rows.
  assert.equal(inserts.filter((i) => i.sql.includes('food_components')).length, 2);
});

test('T012 upsert_composite: rejects non-atomic component (no nesting)', async () => {
  const { db } = makeDb((sql, params) => {
    if (sql.includes('user_recipe')) return [];
    if (sql.includes('FROM foods')) {
      return [
        {
          id: params[0],
          kind: 'composite',
          reference_qty: 100,
          kcal: 100,
          protein_g: 5,
          carbs_g: 10,
          fat_g: 2,
          created_by: null,
        },
      ];
    }
    return [];
  });
  const tool = byName(foodsUpsertCompositeTools, 'foods_upsert_composite');
  await assert.rejects(
    () =>
      call(
        tool,
        {
          canonical_name: 'nested',
          components: [{ food_id: 5, grams: 100, position: 0 }],
        },
        db
      ),
    /only atomic/
  );
});

test('T012 upsert_composite: rejects component not accessible (NotFound)', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes('user_recipe')) return [];
    if (sql.includes('FROM foods')) return [];
    return [];
  });
  const tool = byName(foodsUpsertCompositeTools, 'foods_upsert_composite');
  await assert.rejects(
    () =>
      call(
        tool,
        { canonical_name: 'x', components: [{ food_id: 99, grams: 10, position: 0 }] },
        db
      ),
    /not found or not accessible/
  );
});

test('T012 upsert_composite: rejects duplicate user_recipe name', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes("kind = 'user_recipe'")) return [{ id: 7 }];
    return [];
  });
  const tool = byName(foodsUpsertCompositeTools, 'foods_upsert_composite');
  await assert.rejects(
    () =>
      call(
        tool,
        { canonical_name: 'dup', components: [{ food_id: 1, grams: 1, position: 0 }] },
        db
      ),
    /already has a user_recipe/
  );
});

test('T012 upsert_composite: handles reference_qty != 100 correctly', async () => {
  let recipeKcal = 0;
  const { db } = makeDb((sql, params) => {
    if (sql.includes('user_recipe')) return [];
    if (sql.includes('FROM foods')) {
      // child with reference_qty=200, kcal=400 (= 200 kcal/100g)
      return [
        {
          id: params[0],
          kind: 'atomic',
          reference_qty: 200,
          kcal: 400,
          protein_g: 20,
          carbs_g: 40,
          fat_g: 5,
          created_by: null,
        },
      ];
    }
    if (sql.includes('INSERT INTO foods')) {
      // Param order in INSERT: ($1=name, $2=aliases, 'g', $3=ref_qty, $4=kcal, ...)
      recipeKcal = params[3] as number;
      return [{ id: 1 }];
    }
    return [];
  });
  const tool = byName(foodsUpsertCompositeTools, 'foods_upsert_composite');
  await call(
    tool,
    {
      canonical_name: 'r',
      components: [{ food_id: 1, grams: 100, position: 0 }],
    },
    db
  );
  // 100g of (400 kcal / 200 ref_qty = 2 kcal/g) => 200 kcal
  assert.equal(recipeKcal, 200);
});

test('T012 upsert_composite: rejects duplicate positions', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(foodsUpsertCompositeTools, 'foods_upsert_composite');
  // The zod superRefine surfaces as a parse failure; our `call` wrapper rethrows
  // as 'input validation failed'. That's the right behavior — assert the throw.
  await assert.rejects(
    () =>
      call(
        tool,
        {
          canonical_name: 'r',
          components: [
            { food_id: 1, grams: 10, position: 0 },
            { food_id: 2, grams: 10, position: 0 },
          ],
        },
        db
      ),
    /input validation failed/
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// T013 — log_food_entry_with_components
// ═════════════════════════════════════════════════════════════════════════════

test('T013 log_with_components: Case A (no components) snapshots from foods', async () => {
  const inserts: unknown[][] = [];
  const { db } = makeDb((sql, params) => {
    if (sql.includes('FROM foods') && sql.includes('WHERE id = $1')) {
      return [
        {
          id: 1,
          canonical_name: 'spaghetti',
          unit: 'g',
          reference_qty: 100,
          kcal: 359,
          protein_g: 12,
          carbs_g: 72,
          fat_g: 1.5,
          grams_per_piece: null,
          kind: 'atomic',
        },
      ];
    }
    if (sql.includes('INSERT INTO food_entries')) {
      inserts.push(params);
      return [{ id: 500 }];
    }
    return [];
  });
  const tool = byName(logFoodEntryWithComponentsTools, 'log_food_entry_with_components');
  const res = (await call(
    tool,
    {
      date: '2026-05-25',
      meal: 'pranzo',
      food_id: 1,
      quantity: 80,
      entry_unit: 'g',
    },
    db
  )) as { food_entry_id: number; components_logged: number; total_macros: { kcal: number } };
  assert.equal(res.food_entry_id, 500);
  assert.equal(res.components_logged, 0);
  assert.equal(res.total_macros.kcal, 359);
});

test('T013 log_with_components: Case B aggregates from components (per-100g snapshot)', async () => {
  const entryInserts: unknown[][] = [];
  const compInserts: unknown[][] = [];
  const { db } = makeDb((sql, params) => {
    if (sql.includes('FROM foods') && sql.includes('WHERE id = $1')) {
      const fid = params[0] as number;
      if (fid === 100) {
        return [
          {
            id: 100,
            canonical_name: 'pasta vongole',
            unit: 'g',
            reference_qty: 245,
            kcal: 999,
            protein_g: 999,
            carbs_g: 999,
            fat_g: 999,
            grams_per_piece: null,
            kind: 'user_recipe',
          },
        ];
      }
      // child component
      return [
        {
          id: fid,
          canonical_name: `child-${fid}`,
          kind: 'atomic',
          reference_qty: 100,
          kcal: 100,
          protein_g: 10,
          carbs_g: 20,
          fat_g: 5,
        },
      ];
    }
    if (sql.includes('INSERT INTO food_entries')) {
      entryInserts.push(params);
      return [{ id: 600 }];
    }
    if (sql.includes('INSERT INTO food_entry_components')) {
      compInserts.push(params);
      return [];
    }
    return [];
  });
  const tool = byName(logFoodEntryWithComponentsTools, 'log_food_entry_with_components');
  const res = (await call(
    tool,
    {
      date: '2026-05-25',
      meal: 'pranzo',
      food_id: 100,
      quantity: 245,
      entry_unit: 'g',
      components: [
        { food_id: 1, grams: 80, position: 0 },
        { food_id: 2, grams: 150, position: 1 },
      ],
    },
    db
  )) as { components_logged: number; total_macros: { kcal: number } };
  assert.equal(res.components_logged, 2);
  // 80g of 100kcal/100g = 80; 150g of 100kcal/100g = 150 => 230 (NOT 999 from parent).
  assert.equal(res.total_macros.kcal, 230);
  assert.equal(compInserts.length, 2);
});

test('T013 log_with_components: rejects components on atomic parent', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes('FROM foods') && sql.includes('WHERE id = $1')) {
      return [
        {
          id: 1,
          canonical_name: 'spaghetti',
          unit: 'g',
          reference_qty: 100,
          kcal: 359,
          protein_g: 12,
          carbs_g: 72,
          fat_g: 1.5,
          grams_per_piece: null,
          kind: 'atomic',
        },
      ];
    }
    return [];
  });
  const tool = byName(logFoodEntryWithComponentsTools, 'log_food_entry_with_components');
  await assert.rejects(
    () =>
      call(
        tool,
        {
          date: '2026-05-25',
          meal: 'pranzo',
          food_id: 1,
          quantity: 80,
          entry_unit: 'g',
          components: [{ food_id: 5, grams: 10, position: 0 }],
        },
        db
      ),
    /atomic foods cannot have components/
  );
});

test('T013 log_with_components: NotFound on missing parent', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(logFoodEntryWithComponentsTools, 'log_food_entry_with_components');
  await assert.rejects(
    () =>
      call(
        tool,
        { date: '2026-05-25', meal: 'pranzo', food_id: 999, quantity: 1, entry_unit: 'g' },
        db
      ),
    /does not exist/
  );
});

test('T013 log_with_components: per-component snapshot uses child reference_qty', async () => {
  const compInserts: unknown[][] = [];
  const { db } = makeDb((sql, params) => {
    if (sql.includes('FROM foods') && sql.includes('WHERE id = $1')) {
      const fid = params[0] as number;
      if (fid === 100) {
        return [
          {
            id: 100,
            canonical_name: 'r',
            unit: 'g',
            reference_qty: 100,
            kcal: 0,
            protein_g: 0,
            carbs_g: 0,
            fat_g: 0,
            grams_per_piece: null,
            kind: 'user_recipe',
          },
        ];
      }
      // child with reference_qty=200, kcal=400 → 200 kcal/100g snapshot
      return [
        {
          id: fid,
          canonical_name: `c-${fid}`,
          kind: 'atomic',
          reference_qty: 200,
          kcal: 400,
          protein_g: 20,
          carbs_g: 0,
          fat_g: 0,
        },
      ];
    }
    if (sql.includes('INSERT INTO food_entries')) return [{ id: 700 }];
    if (sql.includes('INSERT INTO food_entry_components')) {
      compInserts.push(params);
      return [];
    }
    return [];
  });
  const tool = byName(logFoodEntryWithComponentsTools, 'log_food_entry_with_components');
  await call(
    tool,
    {
      date: '2026-05-25',
      meal: 'pranzo',
      food_id: 100,
      quantity: 100,
      entry_unit: 'g',
      components: [{ food_id: 1, grams: 100, position: 0 }],
    },
    db
  );
  // kcal_snapshot is per-100g of child: 400 * 100 / 200 = 200
  const kcalSnap = compInserts[0][6]; // see INSERT order
  assert.equal(kcalSnap, 200);
});

// ═════════════════════════════════════════════════════════════════════════════
// T014 — foods_list_user_recipes
// ═════════════════════════════════════════════════════════════════════════════

test('T014 list_user_recipes: returns user-owned recipes with counts', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes("kind = 'user_recipe'")) {
      return [
        {
          id: 1,
          canonical_name: 'pasta vongole',
          aliases: null,
          kcal: 500,
          protein_g: 20,
          carbs_g: 80,
          fat_g: 10,
          reference_qty: 245,
          components_count: '3',
        },
      ];
    }
    return [];
  });
  const tool = byName(foodsListUserRecipesTools, 'foods_list_user_recipes');
  const res = (await call(tool, {}, db)) as Array<{ components_count: number; food_id: number }>;
  assert.equal(res.length, 1);
  assert.equal(res[0].food_id, 1);
  assert.equal(res[0].components_count, 3);
});

test('T014 list_user_recipes: filters by name_query', async () => {
  const { db, calls } = makeDb(() => []);
  const tool = byName(foodsListUserRecipesTools, 'foods_list_user_recipes');
  await call(tool, { name_query: 'pasta' }, db);
  assert.ok(calls[0].sql.includes('ILIKE'));
  assert.ok((calls[0].params as unknown[]).includes('%pasta%'));
});

test('T014 list_user_recipes: empty result is empty array', async () => {
  const { db } = makeDb(() => []);
  const tool = byName(foodsListUserRecipesTools, 'foods_list_user_recipes');
  const res = (await call(tool, { name_query: 'zzz' }, db)) as unknown[];
  assert.deepEqual(res, []);
});

// ═════════════════════════════════════════════════════════════════════════════
// T015 — foods_resolve
// ═════════════════════════════════════════════════════════════════════════════

test('T015 resolve: DB-only happy path (no external)', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes("kind = 'user_recipe'")) {
      return [
        {
          id: 1,
          canonical_name: 'pasta vongole',
          aliases: null,
          kcal: 500,
          protein_g: 20,
          carbs_g: 80,
          fat_g: 10,
          reference_qty: 245,
          components_count: 3,
        },
      ];
    }
    return [];
  });
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: 'pasta vongole', include_external: false },
    db
  )) as { candidates: Array<{ source_type: string }>; counts: { user_recipe: number } };
  assert.equal(res.candidates.length, 1);
  assert.equal(res.candidates[0].source_type, 'user_recipe');
  assert.equal(res.counts.user_recipe, 1);
});

test('T015 resolve: ranking precedence (user_recipe before global before external)', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes("kind = 'user_recipe'")) {
      return [
        {
          id: 10,
          canonical_name: 'food alpha',
          aliases: null,
          kcal: 100,
          protein_g: 10,
          carbs_g: 10,
          fat_g: 5,
          reference_qty: 100,
          components_count: 2,
        },
      ];
    }
    if (sql.includes('FROM foods')) {
      // user + global atomic for same name
      if (sql.includes('created_by = $1') && !sql.includes('IS NULL')) {
        return [
          {
            id: 20,
            canonical_name: 'food beta',
            kind: 'atomic',
            kcal: 200,
            protein_g: 20,
            carbs_g: 20,
            fat_g: 10,
            reference_qty: 100,
            external_source: null,
          },
        ];
      }
      if (sql.includes('created_by IS NULL')) {
        return [
          {
            id: 30,
            canonical_name: 'food gamma',
            kind: 'atomic',
            kcal: 300,
            protein_g: 30,
            carbs_g: 30,
            fat_g: 15,
            reference_qty: 100,
            external_source: 'usda:9999',
          },
        ];
      }
    }
    return [];
  });
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: 'food', include_external: false },
    db
  )) as { candidates: Array<{ source_type: string }> };
  assert.equal(res.candidates[0].source_type, 'user_recipe');
  assert.equal(res.candidates[1].source_type, 'user_atomic');
  assert.equal(res.candidates[2].source_type, 'global_atomic_imported');
});

test('T015 resolve: dedupes external whose source matches DB external_source', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes("kind = 'user_recipe'")) return [];
    if (sql.includes('created_by IS NULL')) {
      return [
        {
          id: 1,
          canonical_name: 'item',
          kind: 'atomic',
          kcal: 100,
          protein_g: 10,
          carbs_g: 0,
          fat_g: 0,
          reference_qty: 100,
          external_source: 'off:DUP',
        },
      ];
    }
    return [];
  });
  setOffHttp(
    (async () => ({
      statusCode: 200,
      body: {
        json: async () => ({
          products: [
            {
              code: 'DUP',
              product_name: 'Different Name',
              nutriments: { 'energy-kcal_100g': 100, proteins_100g: 10 },
            },
          ],
        }),
      },
    })) as unknown as Parameters<typeof setOffHttp>[0]
  );
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: `dedup-test-${Date.now()}` },
    db
  )) as { candidates: Array<{ source_type: string }>; counts: { external: number } };
  // External candidate had source 'off:DUP' which matches DB — should be dropped.
  assert.equal(res.counts.external, 0);
  assert.equal(res.candidates.filter((c) => c.source_type === 'external_off').length, 0);
  setOffHttp(null);
});

test('T015 resolve: dedupes external by normalized name fallback', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes("kind = 'user_recipe'")) return [];
    if (sql.includes('created_by IS NULL')) {
      return [
        {
          id: 1,
          canonical_name: 'Spaghetti N5',
          kind: 'atomic',
          kcal: 350,
          protein_g: 12,
          carbs_g: 70,
          fat_g: 1,
          reference_qty: 100,
          external_source: null,
        },
      ];
    }
    return [];
  });
  setOffHttp(
    (async () => ({
      statusCode: 200,
      body: {
        json: async () => ({
          products: [
            {
              code: 'X',
              product_name: 'spaghetti n5  ',
              nutriments: { 'energy-kcal_100g': 360, proteins_100g: 12 },
            },
          ],
        }),
      },
    })) as unknown as Parameters<typeof setOffHttp>[0]
  );
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: `name-dedup-${Date.now()}` },
    db
  )) as { counts: { external: number } };
  assert.equal(res.counts.external, 0);
  setOffHttp(null);
});

test('T015 resolve: external lookup failure returns warning, not throw', async () => {
  const { db } = makeDb(() => []);
  setOffHttp(
    (async () => {
      throw new Error('network down');
    }) as unknown as Parameters<typeof setOffHttp>[0]
  );
  setUsdaHttp(
    (async () => {
      throw new Error('network down');
    }) as unknown as Parameters<typeof setUsdaHttp>[0]
  );
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: `failtest-${Date.now()}` },
    db
  )) as { candidates: unknown[]; counts: { external: number }; warning?: string };
  // External contributed nothing (throw OR empty) => warning is set.
  assert.equal(res.counts.external, 0);
  assert.equal(res.warning, 'external_lookup_failed');
  setOffHttp(null);
  setUsdaHttp(null);
});

test('T015 resolve: warning also set when external returns empty (no error)', async () => {
  const { db } = makeDb(() => []);
  setOffHttp(
    (async () => ({
      statusCode: 200,
      body: { json: async () => ({ products: [] }) },
    })) as unknown as Parameters<typeof setOffHttp>[0]
  );
  setUsdaHttp(
    (async () => ({
      statusCode: 200,
      body: { json: async () => ({ foods: [] }) },
    })) as unknown as Parameters<typeof setUsdaHttp>[0]
  );
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: `empty-external-${Date.now()}` },
    db
  )) as { warning?: string; counts: { external: number } };
  assert.equal(res.counts.external, 0);
  assert.equal(res.warning, 'external_lookup_failed');
  setOffHttp(null);
  setUsdaHttp(null);
});

test('T015 resolve: respects limit clipping', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes("kind = 'user_recipe'")) return [];
    if (sql.includes('created_by IS NULL')) {
      // 5 global candidates
      return Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        canonical_name: `item ${i}`,
        kind: 'atomic',
        kcal: 100,
        protein_g: 10,
        carbs_g: 0,
        fat_g: 0,
        reference_qty: 100,
        external_source: null,
      }));
    }
    return [];
  });
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: 'item', include_external: false, limit: 2 },
    db
  )) as { candidates: unknown[] };
  assert.equal(res.candidates.length, 2);
});

test('T015 resolve: normalizes atomic macros to per-100g (reference_qty=100)', async () => {
  // Atomic food stored with reference_qty=100 (kcal already per-100g).
  const { db } = makeDb((sql) => {
    if (sql.includes("kind = 'user_recipe'")) return [];
    if (sql.includes('created_by IS NULL')) {
      return [
        {
          id: 1,
          canonical_name: 'chicken breast',
          kind: 'atomic',
          kcal: 165,
          protein_g: 31,
          carbs_g: 0,
          fat_g: 3.6,
          reference_qty: 100,
          external_source: null,
        },
      ];
    }
    return [];
  });
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: 'chicken', include_external: false },
    db
  )) as {
    candidates: Array<{
      kcal_per_100g: number;
      protein_g_per_100g: number;
      fat_g_per_100g: number;
    }>;
  };
  // factor = 100 / 100 = 1; macros unchanged.
  assert.equal(res.candidates[0].kcal_per_100g, 165);
  assert.equal(res.candidates[0].protein_g_per_100g, 31);
  assert.equal(res.candidates[0].fat_g_per_100g, 3.6);
});

test('T015 resolve: normalizes atomic macros to per-100g (reference_qty=50)', async () => {
  // Atomic food stored per 50g (e.g., "1 slice of bread = 50g, 130 kcal").
  // Expected per-100g: kcal = 130 * 100/50 = 260, protein = 4 * 2 = 8.
  const { db } = makeDb((sql) => {
    if (sql.includes("kind = 'user_recipe'")) return [];
    if (sql.includes('created_by IS NULL')) {
      return [
        {
          id: 1,
          canonical_name: 'bread slice',
          kind: 'atomic',
          kcal: 130,
          protein_g: 4,
          carbs_g: 26,
          fat_g: 1,
          reference_qty: 50,
          external_source: null,
        },
      ];
    }
    return [];
  });
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: 'bread', include_external: false },
    db
  )) as {
    candidates: Array<{
      kcal_per_100g: number;
      protein_g_per_100g: number;
      carbs_g_per_100g: number;
      fat_g_per_100g: number;
    }>;
  };
  assert.equal(res.candidates[0].kcal_per_100g, 260);
  assert.equal(res.candidates[0].protein_g_per_100g, 8);
  assert.equal(res.candidates[0].carbs_g_per_100g, 52);
  assert.equal(res.candidates[0].fat_g_per_100g, 2);
});

test('T015 resolve: normalizes user_recipe macros to per-100g (reference_qty=245)', async () => {
  // Recipe with total grams=245 and kcal=490 => kcal/100g = 200.
  const { db } = makeDb((sql) => {
    if (sql.includes("kind = 'user_recipe'")) {
      return [
        {
          id: 99,
          canonical_name: 'pasta vongole',
          aliases: null,
          kcal: 490,
          protein_g: 24.5,
          carbs_g: 49,
          fat_g: 9.8,
          reference_qty: 245,
          components_count: 3,
        },
      ];
    }
    return [];
  });
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: 'pasta', include_external: false },
    db
  )) as {
    candidates: Array<{
      kcal_per_100g: number;
      protein_g_per_100g: number;
      carbs_g_per_100g: number;
      fat_g_per_100g: number;
    }>;
  };
  assert.equal(res.candidates[0].kcal_per_100g, 200);
  assert.equal(res.candidates[0].protein_g_per_100g, 10);
  assert.equal(res.candidates[0].carbs_g_per_100g, 20);
  assert.equal(res.candidates[0].fat_g_per_100g, 4);
});

test('T015 resolve: external candidates appear when DB is empty and external returns', async () => {
  const { db } = makeDb(() => []);
  setOffHttp(
    (async () => ({
      statusCode: 200,
      body: {
        json: async () => ({
          products: [
            {
              code: 'NEW',
              product_name: 'BrandNew Item',
              nutriments: { 'energy-kcal_100g': 250, proteins_100g: 15 },
            },
          ],
        }),
      },
    })) as unknown as Parameters<typeof setOffHttp>[0]
  );
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: `external-only-${Date.now()}` },
    db
  )) as { candidates: Array<{ source_type: string }>; counts: { external: number } };
  assert.equal(res.counts.external, 1);
  assert.equal(res.candidates[0].source_type, 'external_off');
  setOffHttp(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// T008-TST — Strategy B (trigram) fallback when Strategy A returns 0 rows
// ─────────────────────────────────────────────────────────────────────────────

test('foods_resolve returns recipe via trigram fallback on NL query', async () => {
  // Scenario: user query "shaker proteine latte" — tokens = ["shaker","proteine","latte"].
  // Strategy A (token-AND ILIKE on unaccented canonical_name + aliases) misses
  // because the recipe canonical_name is "Shaker proteico" (no "latte", no
  // "proteine"). Strategy B (trigram similarity) fires and returns the recipe.
  //
  // SpyDb cannot evaluate Postgres trigram operators, so we pattern-match on
  // SQL substrings to decide which strategy the call belongs to:
  //   - Strategy A: contains "ILIKE" and "unnest(COALESCE(aliases"
  //   - Strategy B: contains "similarity(" (and the TRIGRAM_THRESHOLD value)
  // listUserRecipesInternal (recipes branch) and selectFoodsForResolve
  // (user/global branches) share the same A→B pipeline shape.
  const strategyACalls: string[] = [];
  const strategyBCalls: string[] = [];

  const { db, calls } = makeDb((sql) => {
    const isStrategyA =
      sql.includes('ILIKE') && sql.includes('unnest(COALESCE(aliases');
    const isStrategyB = sql.includes('similarity(') && sql.includes('0.25');

    if (isStrategyA) {
      strategyACalls.push(sql);
      // Force A=0 to push the resolver into Strategy B fallback.
      return [];
    }
    if (isStrategyB) {
      strategyBCalls.push(sql);
      // Only the user_recipe branch (BASE_WHERE includes "kind = 'user_recipe'")
      // should yield the synthetic shaker; other branches return empty.
      if (sql.includes("kind = 'user_recipe'")) {
        return [
          {
            id: 99,
            canonical_name: 'Shaker proteico',
            aliases: ['shaker'],
            kcal: 300,
            protein_g: 40,
            carbs_g: 15,
            fat_g: 5,
            reference_qty: 250,
            components_count: 2,
          },
        ];
      }
      return [];
    }
    return [];
  });

  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: 'shaker proteine latte', include_external: false },
    db
  )) as {
    candidates: Array<{ source_type: string; name: string; food_id?: number }>;
    counts: { user_recipe: number };
  };

  // Synthetic shaker row surfaced via Strategy B trigram fallback.
  assert.equal(res.counts.user_recipe, 1);
  assert.equal(res.candidates[0].source_type, 'user_recipe');
  assert.equal(res.candidates[0].food_id, 99);
  assert.equal(res.candidates[0].name, 'Shaker proteico');

  // Each of the 3 DB branches (recipes / user atomic / global atomic) ran A
  // first and then fell through to B → at least 2 SQL queries per branch.
  assert.ok(
    strategyACalls.length >= 3,
    `expected at least 3 Strategy A calls, got ${strategyACalls.length}`
  );
  assert.ok(
    strategyBCalls.length >= 3,
    `expected at least 3 Strategy B calls, got ${strategyBCalls.length}`
  );
  // Sanity: total SQL calls hit the spy at least twice (A then B).
  assert.ok(calls.length >= 2);
});

// ═════════════════════════════════════════════════════════════════════════════
// T004-TST — selectUserHistory unit tests (user_history enrichment helper)
// ═════════════════════════════════════════════════════════════════════════════

test('selectUserHistory: no entries returns empty map', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes('food_entries')) return [];
    return [];
  });
  const ctx: ToolCtx = { userId: USER, db };
  const map = await selectUserHistory(ctx, 60);
  assert.equal(map.size, 0);
});

test('selectUserHistory: aggregates correctly with last entry', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes('food_entries')) {
      // pg numeric/bigint columns may arrive as strings — verify coercion.
      return [
        {
          food_id: 42,
          times_logged_60d: '47',
          last_logged_at: '2026-05-24',
          last_quantity: '170',
          last_entry_unit: 'g',
        },
      ];
    }
    return [];
  });
  const ctx: ToolCtx = { userId: USER, db };
  const map = await selectUserHistory(ctx, 60);
  assert.equal(map.size, 1);
  const entry = map.get(42);
  assert.ok(entry, 'expected entry for food_id=42');
  assert.equal(entry!.times_logged_60d, 47);
  assert.equal(typeof entry!.times_logged_60d, 'number');
  assert.equal(entry!.last_logged_at, '2026-05-24');
  assert.equal(entry!.last_quantity, 170);
  assert.equal(typeof entry!.last_quantity, 'number');
  assert.equal(entry!.last_entry_unit, 'g');
});

test('selectUserHistory: multiple food_ids each get own map entry', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes('food_entries')) {
      return [
        {
          food_id: 42,
          times_logged_60d: '12',
          last_logged_at: '2026-05-20',
          last_quantity: '170',
          last_entry_unit: 'g',
        },
        {
          food_id: 88,
          times_logged_60d: '3',
          last_logged_at: '2026-05-22',
          last_quantity: '250',
          last_entry_unit: 'ml',
        },
      ];
    }
    return [];
  });
  const ctx: ToolCtx = { userId: USER, db };
  const map = await selectUserHistory(ctx, 60);
  assert.equal(map.size, 2);
  assert.equal(map.has(42), true);
  assert.equal(map.has(88), true);
  const e42 = map.get(42)!;
  const e88 = map.get(88)!;
  assert.equal(e42.times_logged_60d, 12);
  assert.equal(e42.last_entry_unit, 'g');
  assert.equal(e88.times_logged_60d, 3);
  assert.equal(e88.last_quantity, 250);
  assert.equal(e88.last_entry_unit, 'ml');
});

test('selectUserHistory: passes correct parameters to db.query', async () => {
  const { db, calls } = makeDb((sql) => {
    if (sql.includes('food_entries')) return [];
    return [];
  });
  const ctx: ToolCtx = { userId: USER, db };
  await selectUserHistory(ctx, 60);

  // Find the food_entries query call.
  const historyCall = calls.find((c) => c.sql.includes('food_entries'));
  assert.ok(historyCall, 'expected at least one food_entries query');
  assert.equal(historyCall!.params.length, 2);
  assert.equal(historyCall!.params[0], USER);
  const dateParam = historyCall!.params[1];
  assert.equal(typeof dateParam, 'string');
  assert.match(dateParam as string, /^\d{4}-\d{2}-\d{2}$/);
  // Verify date is ~60 days ago (allow some tolerance for clock drift in CI).
  const expected = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  assert.equal(dateParam, expected);
});

// ═════════════════════════════════════════════════════════════════════════════
// T005-TST — foods_resolve end-to-end user_history enrichment
// ═════════════════════════════════════════════════════════════════════════════

test('foods_resolve: enriches candidates with user_history when entries exist', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes("kind = 'user_recipe'")) return [];
    if (sql.includes('FROM foods') && sql.includes('created_by IS NULL')) {
      return [
        {
          id: 42,
          canonical_name: 'yogurt greco fage 0%',
          kind: 'atomic',
          kcal: 57,
          protein_g: 10,
          carbs_g: 4,
          fat_g: 0,
          reference_qty: 100,
          external_source: 'off:FAGE0',
        },
      ];
    }
    if (sql.includes('food_entries')) {
      return [
        {
          food_id: 42,
          times_logged_60d: '47',
          last_logged_at: '2026-05-24',
          last_quantity: '170',
          last_entry_unit: 'g',
        },
      ];
    }
    return [];
  });
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: 'yogurt greco', include_external: false },
    db
  )) as {
    candidates: Array<{
      food_id?: number;
      source_type: string;
      user_history: {
        times_logged_60d: number;
        last_quantity: number;
        last_logged_at: string;
        last_entry_unit: string;
      } | null;
    }>;
  };
  assert.equal(res.candidates.length, 1);
  assert.equal(res.candidates[0].food_id, 42);
  assert.ok(res.candidates[0].user_history, 'expected non-null user_history');
  assert.equal(res.candidates[0].user_history!.times_logged_60d, 47);
  assert.equal(res.candidates[0].user_history!.last_quantity, 170);
  assert.equal(res.candidates[0].user_history!.last_logged_at, '2026-05-24');
  assert.equal(res.candidates[0].user_history!.last_entry_unit, 'g');
});

test('foods_resolve: candidate without food_id has user_history = null', async () => {
  // Pure external candidate (no food_id). DB has no matching rows.
  const { db } = makeDb(() => []);
  setOffHttp(
    (async () => ({
      statusCode: 200,
      body: {
        json: async () => ({
          products: [
            {
              code: 'EXT-ONLY-1',
              product_name: 'external only product',
              nutriments: { 'energy-kcal_100g': 100, proteins_100g: 10 },
            },
          ],
        }),
      },
    })) as unknown as Parameters<typeof setOffHttp>[0]
  );
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: `ext-only-${Date.now()}` },
    db
  )) as {
    candidates: Array<{
      food_id?: number;
      source_type: string;
      user_history: unknown;
    }>;
  };
  setOffHttp(null);
  const external = res.candidates.find((c) => c.source_type === 'external_off');
  assert.ok(external, 'expected external_off candidate');
  assert.equal(external!.food_id, undefined);
  assert.equal(external!.user_history, null);
});

test('foods_resolve: candidate with food_id but no entries has user_history = null', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes("kind = 'user_recipe'")) return [];
    if (sql.includes('FROM foods') && sql.includes('created_by IS NULL')) {
      return [
        {
          id: 99,
          canonical_name: 'never-logged food',
          kind: 'atomic',
          kcal: 100,
          protein_g: 5,
          carbs_g: 10,
          fat_g: 2,
          reference_qty: 100,
          external_source: null,
        },
      ];
    }
    if (sql.includes('food_entries')) return [];
    return [];
  });
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: 'never-logged', include_external: false },
    db
  )) as {
    candidates: Array<{ food_id?: number; user_history: unknown }>;
  };
  assert.equal(res.candidates.length, 1);
  assert.equal(res.candidates[0].food_id, 99);
  assert.equal(res.candidates[0].user_history, null);
});

test('foods_resolve: history query failure leaves all user_history = null without breaking resolve', async () => {
  const { db } = makeDb((sql) => {
    if (sql.includes("kind = 'user_recipe'")) {
      return [
        {
          id: 7,
          canonical_name: 'my recipe',
          aliases: null,
          kcal: 500,
          protein_g: 20,
          carbs_g: 80,
          fat_g: 10,
          reference_qty: 245,
          components_count: 3,
        },
      ];
    }
    if (sql.includes('FROM foods') && sql.includes('created_by IS NULL')) {
      return [
        {
          id: 50,
          canonical_name: 'my recipe atomic',
          kind: 'atomic',
          kcal: 100,
          protein_g: 5,
          carbs_g: 10,
          fat_g: 2,
          reference_qty: 100,
          external_source: null,
        },
      ];
    }
    if (sql.includes('food_entries')) {
      throw new Error('simulated history query failure');
    }
    return [];
  });
  const tool = byName(foodsResolveTools, 'foods_resolve');
  const res = (await call(
    tool,
    { query: 'my recipe', include_external: false },
    db
  )) as {
    candidates: Array<{ source_type: string; user_history: unknown }>;
  };
  assert.equal(res.candidates.length, 2);
  for (const c of res.candidates) {
    assert.equal(c.user_history, null);
  }
});

