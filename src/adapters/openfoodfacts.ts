/**
 * openfoodfacts.ts — Open Food Facts HTTP adapter (Phase 6 / T007).
 *
 * Two modes:
 *   - 'barcode' → /api/v2/product/<barcode>.json (single product)
 *   - 'name'    → /cgi/search.pl?search_terms=... (up to 5 results, IT locale)
 *
 * Discards incomplete entries (no kcal or no protein per-100g). No API key.
 * Stateless (no MCP_USER_ID needed). Used by `nutrition.lookup_food`.
 */
import { request as undiciRequest } from 'undici';
import type { NormalizedFood } from './usda.js';

const OFF_BASE = 'https://world.openfoodfacts.org';

type HttpRequest = (url: string, init?: { method?: string }) => Promise<{
  statusCode: number;
  body: { json: () => Promise<unknown> };
}>;
let httpRequest: HttpRequest = undiciRequest as unknown as HttpRequest;
export function __setHttp(fn: HttpRequest | null): void {
  httpRequest = fn ?? (undiciRequest as unknown as HttpRequest);
}

interface OffNutriments {
  'energy-kcal_100g'?: number;
  proteins_100g?: number;
  carbohydrates_100g?: number;
  fat_100g?: number;
}

interface OffProduct {
  code?: string;
  product_name?: string;
  product_name_it?: string;
  nutriments?: OffNutriments;
}

interface OffProductResponse {
  status?: number;
  code?: string;
  product?: OffProduct;
}

interface OffSearchResponse {
  products?: OffProduct[];
}

function normalize(product: OffProduct, fallbackCode?: string): NormalizedFood | null {
  const n = product.nutriments ?? {};
  const kcal = n['energy-kcal_100g'];
  const protein = n.proteins_100g;
  if (typeof kcal !== 'number' || typeof protein !== 'number') return null;
  const code = product.code ?? fallbackCode ?? '';
  const name = (product.product_name_it ?? product.product_name ?? '').trim();
  if (!name) return null;
  return {
    source: `off:${code}`,
    name,
    kcal_per_100g: kcal,
    protein_g_per_100g: protein,
    carbs_g_per_100g: typeof n.carbohydrates_100g === 'number' ? n.carbohydrates_100g : 0,
    fat_g_per_100g: typeof n.fat_100g === 'number' ? n.fat_100g : 0,
    confidence: 0.8, // OFF doesn't expose a search score; flat default
  };
}

export async function searchOff(
  query: string,
  kind: 'barcode' | 'name'
): Promise<NormalizedFood[]> {
  if (!query || !query.trim()) return [];

  if (kind === 'barcode') {
    const url = `${OFF_BASE}/api/v2/product/${encodeURIComponent(query.trim())}.json`;
    const res = await httpRequest(url, { method: 'GET' });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`OFF HTTP ${res.statusCode}`);
    }
    const body = (await res.body.json()) as OffProductResponse;
    if (body.status !== 1 || !body.product) return [];
    const normed = normalize(body.product, body.code);
    return normed ? [normed] : [];
  }

  // name search
  const url = new URL(`${OFF_BASE}/cgi/search.pl`);
  url.searchParams.set('search_terms', query.trim());
  url.searchParams.set('search_simple', '1');
  url.searchParams.set('json', '1');
  url.searchParams.set('page_size', '5');
  url.searchParams.set('lc', 'it');
  const res = await httpRequest(url.toString(), { method: 'GET' });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`OFF HTTP ${res.statusCode}`);
  }
  const body = (await res.body.json()) as OffSearchResponse;
  const products = body.products ?? [];
  return products
    .map((p) => normalize(p))
    .filter((x): x is NormalizedFood => x !== null);
}
