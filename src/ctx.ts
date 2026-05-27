/**
 * ctx.ts — per-process binding of the MCP server to a single user + DB.
 *
 * The host process spawns one MCP process per session and injects:
 *   - MCP_USER_ID   : the user_id validated by the host's auth layer (uuid string)
 *   - SUPABASE_DB_URL : the Supabase pooler Postgres connection string
 *   - SUPABASE_DB_SSL : optional ("0"/"false"/"off" disables SSL; default on)
 *
 * No tool ever accepts a user_id parameter (decision P2). The bound userId is
 * read ONCE here, at startup, and injected server-side into every query.
 *
 * Fail-fast: if either required env var is missing/empty (or MCP_USER_ID is not
 * a uuid) we throw immediately so the process never serves requests unbound.
 */

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface Ctx {
  /** Bound user_id (uuid), injected into every query server-side. */
  readonly userId: string;
  /** Postgres connection string for the Supabase pooler. */
  readonly dbUrl: string;
  /** Whether to use TLS for the pooler connection (default true). */
  readonly ssl: boolean;
}

function falsy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * Build the Ctx from process.env. Throws with a clear, actionable message if a
 * required variable is missing or malformed. Accepts an explicit env map for
 * testability (defaults to process.env).
 */
export function buildCtx(env: NodeJS.ProcessEnv = process.env): Ctx {
  const userId = (env.MCP_USER_ID ?? '').trim();
  const dbUrl = (env.SUPABASE_DB_URL ?? '').trim();

  if (!userId) {
    throw new Error(
      'MCP_USER_ID is missing or empty. The host process must inject the ' +
        'validated user_id into the MCP process env at spawn time.'
    );
  }
  if (!UUID_RE.test(userId)) {
    throw new Error(
      `MCP_USER_ID is not a valid uuid: "${userId}". Expected the auth.users.id ` +
        'of the bound user.'
    );
  }
  if (!dbUrl) {
    throw new Error(
      'SUPABASE_DB_URL is missing or empty. Provide the Supabase pooler ' +
        'Postgres connection string in the MCP process env.'
    );
  }

  return {
    userId,
    dbUrl,
    ssl: !falsy(env.SUPABASE_DB_SSL),
  };
}
