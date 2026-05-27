/**
 * nutrition_lookup_food.ts — T009 external lookup (USDA + OFF), stateless.
 *
 * NO MCP_USER_ID needed. Cached on disk for 30d. Routing:
 *   - 8-13 digits => barcode OFF only
 *   - generic IT/EN term in hardcoded list => USDA first
 *   - else => OFF first (branded IT), USDA fallback
 *
 * Returns deduped (by canonical name lower-trim) top-N (default 5).
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule } from '../registry.js';
import { searchUsda, type NormalizedFood } from '../adapters/usda.js';
import { searchOff } from '../adapters/openfoodfacts.js';
import * as cache from '../adapters/cache.js';

const GENERIC_TERMS = new Set([
  // Italian
  'pasta', 'riso', 'olio', 'pollo', 'vongole', 'latte', 'uova', 'uovo',
  'formaggio', 'pane', 'burro', 'zucchero', 'sale', 'farina', 'tonno',
  'manzo', 'maiale', 'mela', 'banana', 'pomodoro', 'patata', 'patate',
  'cipolla', 'aglio', 'limone', 'arancia', 'yogurt', 'mozzarella', 'parmigiano',
  // English
  'chicken', 'beef', 'pork', 'rice', 'bread', 'milk', 'eggs', 'egg',
  'cheese', 'butter', 'sugar', 'salt', 'flour', 'tuna', 'apple', 'banana',
  'tomato', 'potato', 'onion', 'garlic', 'lemon', 'orange', 'yogurt',
]);

const BARCODE_RE = /^\d{8,13}$/;

function isGeneric(query: string): boolean {
  const tokens = query.toLowerCase().trim().split(/\s+/);
  return tokens.some((t) => GENERIC_TERMS.has(t));
}

function dedupeByName(list: NormalizedFood[]): NormalizedFood[] {
  const seen = new Set<string>();
  const out: NormalizedFood[] = [];
  for (const f of list) {
    const k = f.name.toLowerCase().trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(f);
    }
  }
  return out;
}

export interface LookupResult {
  results: NormalizedFood[];
  cached: boolean;
}

/** Stateless internal entry — also used by foods.resolve. */
export async function lookupFoodInternal(
  query: string,
  prefer: 'usda' | 'off' | 'auto',
  limit: number
): Promise<LookupResult> {
  const q = query.trim();
  if (!q) return { results: [], cached: false };

  const cacheKey = `lookup:${prefer}:${q.toLowerCase()}`;
  const cached = await cache.get<NormalizedFood[]>(cacheKey);
  if (cached) {
    return { results: cached.slice(0, limit), cached: true };
  }

  let primary: NormalizedFood[] = [];
  let secondary: NormalizedFood[] = [];

  const isBarcode = BARCODE_RE.test(q);
  let route: 'usda' | 'off' | 'barcode';
  if (prefer === 'usda') route = 'usda';
  else if (prefer === 'off') route = 'off';
  else if (isBarcode) route = 'barcode';
  else if (isGeneric(q)) route = 'usda';
  else route = 'off';

  try {
    if (route === 'barcode') {
      primary = await searchOff(q, 'barcode');
    } else if (route === 'usda') {
      primary = await searchUsda(q);
      if (primary.length === 0) secondary = await searchOff(q, 'name').catch(() => []);
    } else {
      // route === 'off'
      primary = await searchOff(q, 'name');
      if (primary.length === 0) secondary = await searchUsda(q).catch(() => []);
    }
  } catch {
    // network failure on primary => still try secondary
    if (route === 'usda') secondary = await searchOff(q, 'name').catch(() => []);
    else if (route === 'off') secondary = await searchUsda(q).catch(() => []);
  }

  const merged = dedupeByName([...primary, ...secondary]).slice(0, limit);
  // best-effort cache; ignore write errors
  await cache.set(cacheKey, merged).catch(() => undefined);
  return { results: merged, cached: false };
}

const lookupFoodTool = defineTool({
  name: 'nutrition_lookup_food',
  description:
    'Stateless external lookup against USDA + Open Food Facts. Routes by query shape ' +
    '(barcode 8-13 digits => OFF; generic term => USDA first; else OFF first). Disk ' +
    'cached 30d. Returns per-100g macros + source ("usda:<fdcId>" | "off:<code>") for ' +
    'each candidate. NO user_id involved (stateless). Errors from adapters do not throw ' +
    'when a fallback path is available.',
  inputSchema: z
    .object({
      query: z.string().min(1),
      prefer: z.enum(['usda', 'off', 'auto']).optional(),
      limit: z.number().int().positive().max(20).optional(),
    })
    .strict(),
  handler: async (input) => {
    return lookupFoodInternal(input.query, input.prefer ?? 'auto', input.limit ?? 5);
  },
});

export const nutritionLookupFoodTools: AnyToolModule[] = [lookupFoodTool];
