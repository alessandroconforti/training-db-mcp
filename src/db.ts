/**
 * db.ts — node-postgres connection pool + query helpers + real transactions.
 *
 * A direct `pg` connection (rather than a higher-level HTTP query wrapper) is
 * mandated because later phases need real BEGIN/COMMIT transactions for
 * bitemporal versioning + audit and replace_program.
 *
 * The pool is built lazily from Ctx.dbUrl. SSL defaults on (Supabase pooler
 * typically requires it) with rejectUnauthorized:false, toggled via Ctx.ssl
 * (env SUPABASE_DB_SSL). See README for env documentation.
 */
import pg from 'pg';
import type { Ctx } from './ctx.js';
import { DbError } from './errors.js';

const { Pool } = pg;
export type PoolClient = pg.PoolClient;

// Return `date` columns as plain `YYYY-MM-DD` strings: the node-postgres driver
// otherwise parses `date` (oid 1082) into a JS Date that
// serializes to an ISO timestamp (`2026-05-22T00:00:00.000Z`). Returning the
// raw string keeps session.date, started_on, week_start, weight_log[].date,
// history dates, etc. as plain `YYYY-MM-DD`. This ALSO fixes the get_week_bundle
// weight_log filter, where `Date >= string` evaluated to NaN → false and
// silently dropped every row. We intentionally do NOT touch timestamp /
// timestamptz parsing (oid 1114 / 1184): columns like created_at / changed_at /
// updated_at aren't compared in the parity diff and stay as-is.
pg.types.setTypeParser(1082, (v) => v);

/**
 * Minimal query surface shared by the pool-level helpers and the transactional
 * client passed into `tx`. Tool handlers receive a `Queryable` so the same code
 * runs inside or outside a transaction.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T | null>;
}

export interface Db extends Queryable {
  /**
   * Run `cb` inside a transaction: BEGIN → cb → COMMIT. On any throw: ROLLBACK
   * then rethrow. The client is always released. `cb` receives a Queryable
   * bound to the transaction's client.
   */
  tx<T>(cb: (client: Queryable) => Promise<T>): Promise<T>;
  /** Close the pool (shutdown). */
  end(): Promise<void>;
}

function wrapClient(client: PoolClient): Queryable {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const res = await client.query(sql, params as unknown[] | undefined);
      return res.rows as T[];
    },
    async queryOne<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[]
    ) {
      const res = await client.query(sql, params as unknown[] | undefined);
      return (res.rows[0] as T) ?? null;
    },
  };
}

/** Build a Db backed by a pg.Pool from the bound Ctx. */
export function createDb(ctx: Ctx): Db {
  const pool = new Pool({
    connectionString: ctx.dbUrl,
    ssl: ctx.ssl ? { rejectUnauthorized: false } : undefined,
  });

  // Surface pool-level errors loudly instead of crashing the process silently.
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[training-db] pg pool error:', err.message);
  });

  async function query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]> {
    try {
      const res = await pool.query(sql, params as unknown[] | undefined);
      return res.rows as T[];
    } catch (err) {
      throw new DbError(
        err instanceof Error ? err.message : 'Query failed'
      );
    }
  }

  async function queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T | null> {
    const rows = await query<T>(sql, params);
    return rows[0] ?? null;
  }

  async function tx<T>(cb: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await cb(wrapClient(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure — original error is what matters
      }
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    query,
    queryOne,
    tx,
    end: () => pool.end(),
  };
}
