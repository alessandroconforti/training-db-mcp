# training-db MCP server

A standalone stdio MCP server that exposes a fitness-tracking Supabase
domain as **typed, user-scoped tools**. One process per chat session, bound to a
single `user_id`. Multi-user isolation is enforced server-side (not by the
prompt): no tool ever accepts a `user_id` parameter.

The host process spawns one MCP instance per chat session and injects the bound
`user_id` and database connection string into the process environment at spawn
time. The server is a self-contained stdio process with no knowledge of where it
is deployed.

## Environment variables

| Var | Required | Meaning |
|-----|----------|---------|
| `MCP_USER_ID` | yes | The `auth.users.id` (uuid) the instance is bound to. Injected per-session by the host process from the authenticated request's validated `user_id`. The process **fails fast** at startup if missing or not a uuid. |
| `SUPABASE_DB_URL` | yes | Postgres connection string for the Supabase pooler. Used by the `pg` pool. **Fails fast** if missing. Never hardcoded. |
| `SUPABASE_DB_SSL` | no | TLS toggle. Default **on** with `{ rejectUnauthorized: false }` (the Supabase pooler typically requires SSL). Set to `0`/`false`/`off`/`no` to disable (e.g. local plain Postgres). |
| `NUTRITION_USDA_API_KEY` | yes (nutrition) | API key for USDA FoodData Central, used by the nutrition lookup pipeline. Validated at startup. |
| `ROADMAP_PROJECTION_SECRET` | no | Bearer token for an optional internal projection endpoint. If absent, roadmap projections resolve to `null` (the bundle never breaks). |
| `NUTRITION_CACHE_DIR` | no | Directory for the on-disk nutrition lookup cache. |

No secrets live in the code; all credentials arrive via env at spawn time.

## Build & run

```bash
npm install
npm run build        # tsc → dist/
npm start            # node dist/index.js  (stdio; requires env above)
npm test             # node --test smoke tests (no live DB)
```

The `tools/list` request responds even with only the Phase 0 `echo_user` debug
tool, which returns `{ user_id }` to confirm the bound USER_ID.

## Tool-module contract

Every tool is a `ToolModule` (see `src/registry.ts`):

```ts
interface ToolModule<I, O> {
  name: string;                  // unique, snake_case (e.g. get_scheda)
  description: string;           // shown to the agent
  inputSchema: z.ZodType<I>;     // validated on tools/call
  handler: (input: I, ctx: ToolCtx) => Promise<O>;
}
// ToolCtx = { userId: string; db: Db }
```

The registry converts the zod schema to JSON Schema for `tools/list`, validates
input with zod on `tools/call` (parse failure → `ValidationError`), runs the
handler, wraps success as `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`,
and maps any thrown error via `toToolError` (structured `{ code, message }` —
never a silent no-op).

### Adding tools (Phase 1-5)

1. In a tool module file, export an array of `ToolModule`, e.g.
   `export const readTools = [getSchedaTool, getSessionTool, ...]`.
2. In `src/index.ts`, import and spread it into `allTools` at the marked spot:
   ```ts
   const allTools: AnyToolModule[] = [echoUserTool, ...readTools, ...writeTools];
   ```
   The central list uses `AnyToolModule` (= `ToolModule<any, any>`) so it can
   hold differently-typed tools; declare each tool with `defineTool` to keep its
   own input/output types checked. The registry needs no changes.

### Ownership / isolation

Use `requireOwned({ db, userId, idValue, table, idColumn })` (or `fromAndWhere`
for child tables joined to their owner, e.g. `session_exercises → sessions`)
before any mutation. An id owned by another user resolves to 0 rows →
`NotFoundError`, never a mutation. Inject `userId` into every SELECT/UPDATE/
DELETE WHERE and every INSERT; catalog tables (`exercises`/`foods`) read openly
but INSERT with `created_by = userId`.

### Errors

| Class | `code` |
|-------|--------|
| `NotFoundError` | `NOT_FOUND` |
| `ValidationError` | `VALIDATION` |
| `ConflictError` | `CONFLICT` |
| `DbError` | `DB` |

### DB helpers (`src/db.ts`)

```ts
query<T>(sql, params?): Promise<T[]>
queryOne<T>(sql, params?): Promise<T | null>
tx<T>(cb: (client: Queryable) => Promise<T>): Promise<T>  // BEGIN/COMMIT, ROLLBACK on throw
```

`tx` is mandated by `pg` (not `db.sh`) so later phases get real transactions for
bitemporal versioning + audit and `replace_program`.
