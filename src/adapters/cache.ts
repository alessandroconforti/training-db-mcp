/**
 * cache.ts — disk-backed key/value cache for external nutrition lookups (T008).
 *
 * Key: `<source>:<hash(query)>` (caller responsibility). Value: arbitrary JSON.
 * TTL: 30 days. Path: env NUTRITION_CACHE_DIR (default /tmp/nutrition-cache),
 * auto-created on init. Files keyed by sha256 hash of the cache key.
 *
 * Used by both adapters (USDA/OFF) and `nutrition.lookup_food`.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
let cacheDir = (process.env.NUTRITION_CACHE_DIR ?? '/tmp/nutrition-cache').trim();

let initPromise: Promise<void> | null = null;

async function ensureDir(): Promise<void> {
  if (initPromise === null) {
    initPromise = fs.mkdir(cacheDir, { recursive: true }).then(() => undefined);
  }
  await initPromise;
}

function keyToPath(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return path.join(cacheDir, `${h}.json`);
}

/** Test seam: redirect cache to a temp dir and reset init state. */
export function __setCacheDir(dir: string): void {
  cacheDir = dir;
  initPromise = null;
}

interface CacheEnvelope<T> {
  ts: number;
  value: T;
}

export async function get<T>(key: string): Promise<T | null> {
  await ensureDir();
  const file = keyToPath(key);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const env = JSON.parse(raw) as CacheEnvelope<T>;
    if (typeof env.ts !== 'number') return null;
    if (Date.now() - env.ts > TTL_MS) return null;
    return env.value;
  } catch (err: unknown) {
    // ENOENT (miss) or malformed JSON => treat as miss.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    return null;
  }
}

export async function set<T>(key: string, value: T): Promise<void> {
  await ensureDir();
  const file = keyToPath(key);
  const envelope: CacheEnvelope<T> = { ts: Date.now(), value };
  await fs.writeFile(file, JSON.stringify(envelope), 'utf8');
}

/** Exported for tests. */
export const __internals = { TTL_MS, keyToPath, getDir: () => cacheDir };
