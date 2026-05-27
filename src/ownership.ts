/**
 * ownership.ts — the cornerstone of multi-user isolation (P2 / decision 1).
 *
 * Every mutation (and any read targeting a specific id) MUST resolve that id
 * with `AND user_id = $userId`. An id belonging to another user resolves to 0
 * rows → NotFoundError → never a mutation. There is no code path that touches a
 * row without proving ownership first.
 *
 * For child tables that have no direct user_id (e.g. session_exercises), pass a
 * `joinPredicate` that constrains ownership via the parent (e.g. a join to
 * sessions). The query is always parameterized: $1 = id value, $2 = userId.
 */
import type { Queryable } from './db.js';
import { NotFoundError } from './errors.js';

export interface RequireOwnedOpts {
  /** Queryable to run on — pass a tx client to check inside a transaction. */
  db: Queryable;
  /** The bound user id (from Ctx). */
  userId: string;
  /** The id value to verify (bound as $1). */
  idValue: number | string;
  /**
   * Simple case: a table with its own user_id column.
   * Builds: SELECT 1 FROM <table> WHERE <idColumn> = $1 AND user_id = $2 LIMIT 1
   */
  table?: string;
  idColumn?: string;
  /**
   * Custom case (child tables): a full predicate after WHERE, using $1 (idValue)
   * and $2 (userId). The caller supplies the FROM/join. Example for
   * session_exercises:
   *   fromAndWhere:
   *     'FROM session_exercises se JOIN sessions s ON s.id = se.session_id ' +
   *     'WHERE se.id = $1 AND s.user_id = $2'
   * Mutually exclusive with table/idColumn.
   */
  fromAndWhere?: string;
  /** Human label for the NotFound message (defaults to table or "resource"). */
  label?: string;
}

/**
 * Throw NotFoundError unless exactly the bound user owns the referenced row.
 * Returns void on success. Never mutates.
 */
export async function requireOwned(opts: RequireOwnedOpts): Promise<void> {
  const { db, userId, idValue } = opts;

  let sql: string;
  if (opts.fromAndWhere) {
    sql = `SELECT 1 ${opts.fromAndWhere} LIMIT 1`;
  } else {
    if (!opts.table || !opts.idColumn) {
      throw new Error(
        'requireOwned: provide either { table, idColumn } or { fromAndWhere }'
      );
    }
    sql =
      `SELECT 1 FROM ${opts.table} ` +
      `WHERE ${opts.idColumn} = $1 AND user_id = $2 LIMIT 1`;
  }

  const row = await db.queryOne<{ '?column?': number }>(sql, [idValue, userId]);
  if (row === null) {
    const label = opts.label ?? opts.table ?? 'resource';
    throw new NotFoundError(
      `${label} ${idValue} not found for the current user.`,
      { id: idValue }
    );
  }
}
