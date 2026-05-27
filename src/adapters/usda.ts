/**
 * usda.ts — USDA FoodData Central HTTP adapter (Phase 6 / T006).
 *
 * Calls `/fdc/v1/foods/search` (dataType=Foundation,SR Legacy, pageSize=5) and
 * normalizes nutrient ids 1008/1003/1005/1004 (kcal/protein/carbs/fat) to a
 * per-100g shape. Fail-fast on missing API key at module load: USDA is a hard
 * dependency of the nutrition lookup pipeline.
 *
 * Stateless (no MCP_USER_ID needed). Used by `nutrition.lookup_food`.
 */
import { request as undiciRequest } from 'undici';

const USDA_BASE = 'https://api.nal.usda.gov/fdc/v1';

// Injection seam for tests (use __setHttp to override; default uses undici).
type HttpRequest = (url: string, init?: { method?: string }) => Promise<{
  statusCode: number;
  body: { json: () => Promise<unknown> };
}>;
let httpRequest: HttpRequest = undiciRequest as unknown as HttpRequest;
export function __setHttp(fn: HttpRequest | null): void {
  httpRequest = fn ?? (undiciRequest as unknown as HttpRequest);
}

function getApiKey(): string {
  const key = (process.env.NUTRITION_USDA_API_KEY ?? '').trim();
  if (!key) {
    throw new Error(
      'NUTRITION_USDA_API_KEY is missing. Provide it in the MCP process env.'
    );
  }
  return key;
}

/** Exported for index.ts startup fail-fast. */
export function assertUsdaApiKey(): void {
  getApiKey();
}

export interface NormalizedFood {
  source: string; // 'usda:<fdcId>' | 'off:<code>'
  name: string;
  kcal_per_100g: number;
  protein_g_per_100g: number;
  carbs_g_per_100g: number;
  fat_g_per_100g: number;
  confidence: number;
}

interface UsdaNutrient {
  nutrientId?: number;
  nutrientNumber?: string;
  value?: number;
}

interface UsdaFood {
  fdcId: number;
  description?: string;
  foodNutrients?: UsdaNutrient[];
  score?: number;
}

interface UsdaResponse {
  foods?: UsdaFood[];
}

function pickNutrient(nutrients: UsdaNutrient[] | undefined, id: number): number {
  if (!nutrients) return 0;
  const found = nutrients.find(
    (n) => n.nutrientId === id || n.nutrientNumber === String(id).padStart(4, '0')
  );
  return typeof found?.value === 'number' ? found.value : 0;
}

/**
 * Search USDA. Returns up to 5 normalized foods per-100g.
 * Throws on network/HTTP errors so the caller (lookup_food) can fall back.
 */
export async function searchUsda(query: string): Promise<NormalizedFood[]> {
  if (!query || !query.trim()) return [];
  const url = new URL(`${USDA_BASE}/foods/search`);
  url.searchParams.set('api_key', getApiKey());
  url.searchParams.set('query', query.trim());
  url.searchParams.set('dataType', 'Foundation,SR Legacy');
  url.searchParams.set('pageSize', '5');

  const res = await httpRequest(url.toString(), { method: 'GET' });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`USDA HTTP ${res.statusCode}`);
  }
  const body = (await res.body.json()) as UsdaResponse;
  const foods = body.foods ?? [];

  return foods
    .map<NormalizedFood | null>((f) => {
      const kcal = pickNutrient(f.foodNutrients, 1008);
      const protein = pickNutrient(f.foodNutrients, 1003);
      const carbs = pickNutrient(f.foodNutrients, 1005);
      const fat = pickNutrient(f.foodNutrients, 1004);
      if (kcal <= 0 && protein <= 0) return null;
      // USDA score is unbounded; map to 0..1 via a soft cap.
      const score = typeof f.score === 'number' ? Math.min(1, f.score / 1000) : 0.7;
      return {
        source: `usda:${f.fdcId}`,
        name: (f.description ?? '').trim(),
        kcal_per_100g: kcal,
        protein_g_per_100g: protein,
        carbs_g_per_100g: carbs,
        fat_g_per_100g: fat,
        confidence: score,
      };
    })
    .filter((x): x is NormalizedFood => x !== null);
}
