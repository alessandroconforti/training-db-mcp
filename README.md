# training-db MCP server

A standalone **stdio MCP server** that exposes a fitness-tracking Postgres/Supabase
domain as **typed, user-scoped tools** for an LLM agent.

The point of interest is the **isolation model**: one server process per session,
bound to a single `user_id` at spawn time. Multi-tenant isolation is enforced
**server-side, in code — never by the prompt**. No tool ever accepts a `user_id`
parameter, so a model cannot read or write another user's data even if it tries.

This is a real-world example extracted from a production AI coaching app, not a
generic framework. The domain tools are fitness-specific (workouts, nutrition,
weekly reviews); the reusable idea is the *structure*: typed tools + a contract
that binds identity at the boundary + ownership checks on every row.

## Why server-side identity

A common MCP pattern hands the agent a broad database tool and tells it, in the
prompt, to "always filter by the current user." That delegates a security
invariant to a non-deterministic model. Here the invariant lives in code:

- `MCP_USER_ID` is read **once**, at process startup (`src/ctx.ts`), and fails
  fast if missing or not a uuid. The agent never sees it and cannot change it.
- Every mutation (and every read targeting a specific id) calls
  `requireOwned(...)` (`src/ownership.ts`): an id owned by another user resolves
  to 0 rows → `NotFoundError`, never a mutation.
- There is no code path that touches a row without proving ownership first.

The model gets a clean, typed tool surface; the safety guarantee does not depend
on the model behaving.

## Environment variables

| Var | Required | Meaning |
|-----|----------|---------|
| `MCP_USER_ID` | yes | The `auth.users.id` (uuid) the instance is bound to. Injected per-session by the host process from the authenticated request's validated `user_id`. The process **fails fast** at startup if missing or not a uuid. |
| `SUPABASE_DB_URL` | yes | Postgres connection string for the Supabase pooler. Used by the `pg` pool. **Fails fast** if missing. Never hardcoded. |
| `SUPABASE_DB_SSL` | no | TLS toggle. Default **on** with `{ rejectUnauthorized: false }` (the Supabase pooler typically requires SSL). Set to `0`/`false`/`off`/`no` to disable (e.g. local plain Postgres). |
| `NUTRITION_USDA_API_KEY` | yes (nutrition) | API key for USDA FoodData Central, used by the nutrition lookup pipeline. Validated at startup. |
| `ROADMAP_PROJECTION_BASE_URL` | no | Base URL for an optional internal projection endpoint. If absent, roadmap projections resolve to `null` (the bundle never breaks). |
| `ROADMAP_PROJECTION_SECRET` | no | Bearer token for the optional projection endpoint above. |
| `NUTRITION_CACHE_DIR` | no | Directory for the on-disk nutrition lookup cache. |

No secrets live in the code; all credentials arrive via env at spawn time. See
`.env.example` for a template and `mcp.example.json` for a sample client config.

## Build & run

```bash
npm install
npm run build        # tsc → dist/
npm start            # node dist/index.js  (stdio; requires env above)
npm test             # node --test, runs without a live DB
```

The `tools/list` request responds even with only the minimal `echo_user` tool,
which returns `{ user_id }` to confirm the bound identity.

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

### Adding tools

1. In a tool module file, export an array of `ToolModule`, e.g.
   `export const readTools = [getSchedaTool, getSessionTool, ...]`.
2. In `src/index.ts`, import and spread it into `allTools`:
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

A direct `pg` connection (rather than a higher-level HTTP query wrapper) is used
so handlers get real transactions for bitemporal versioning + audit and
`replace_program`.

## License

[MIT](./LICENSE) © 2026 Alessandro Conforti.
