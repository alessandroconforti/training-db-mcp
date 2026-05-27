/**
 * registry.ts — the tool-module contract every phase plugs into.
 *
 * A tool is a self-contained module: a name, a description, a zod input schema,
 * and a handler that receives the *parsed* input + a ToolCtx (bound userId + db).
 * The registry:
 *   - exposes tools via tools/list (zod → JSON Schema for inputSchema),
 *   - validates input with zod on tools/call (parse failure → ValidationError),
 *   - wraps success as { content: [{type:'text', text: JSON.stringify(result)}] },
 *   - wraps any throw via toToolError (loud, structured — never a silent no-op).
 *
 * HOW PHASES 1-5 ADD TOOLS:
 *   Each phase exports an array of ToolModule (e.g. `export const readTools = [...]`).
 *   In index.ts those arrays are spread into the central `allTools` list, e.g.
 *     const allTools: ToolModule[] = [echoUserTool, ...readTools, ...writeTools];
 *   No change to the registry is needed — just append to the list in index.ts.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Ctx } from './ctx.js';
import type { Db } from './db.js';
import { toToolError, ValidationError } from './errors.js';

/** Runtime context handed to every tool handler. */
export interface ToolCtx {
  readonly userId: string;
  readonly db: Db;
}

/** The contract all tool modules implement. */
export interface ToolModule<I = unknown, O = unknown> {
  /** Unique tool name (snake_case, e.g. `get_scheda`). */
  name: string;
  /** Human description shown to the agent in tools/list. */
  description: string;
  /** zod schema describing & validating the tool input. */
  inputSchema: z.ZodType<I>;
  /** Handler: receives validated input + bound ctx, returns a JSON-serializable result. */
  handler: (input: I, ctx: ToolCtx) => Promise<O>;
}

/** Convenience identity helper for declaring a strongly-typed tool. */
export function defineTool<I, O>(mod: ToolModule<I, O>): ToolModule<I, O> {
  return mod;
}

/**
 * Heterogeneous tool list element. Tools are individually strongly typed via
 * `defineTool`, but the central registry list mixes different I/O shapes, so the
 * aggregator uses `AnyToolModule` (invariant-safe).
 */
export type AnyToolModule = ToolModule<any, any>;

/**
 * Wire a list of tool modules into the MCP server: registers tools/list and
 * tools/call handlers. The bound ctx (userId + db) is closed over so no tool
 * ever receives user_id as a parameter.
 */
export function registerTools(
  server: Server,
  tools: AnyToolModule[],
  ctx: Ctx,
  db: Db
): void {
  const byName = new Map<string, AnyToolModule>();
  for (const t of tools) {
    if (byName.has(t.name)) {
      throw new Error(`Duplicate tool name registered: ${t.name}`);
    }
    byName.set(t.name, t);
  }

  const toolCtx: ToolCtx = { userId: ctx.userId, db };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema, {
        target: 'jsonSchema7',
        $refStrategy: 'none',
      }) as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (req): Promise<CallToolResult> => {
      const tool = byName.get(req.params.name);
      if (!tool) {
        return toToolError(
          new ValidationError(`Unknown tool: ${req.params.name}`)
        ) as CallToolResult;
      }

      try {
        const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
        if (!parsed.success) {
          throw new ValidationError(
            `Invalid input for ${tool.name}`,
            parsed.error.issues
          );
        }
        const result = await tool.handler(parsed.data, toolCtx);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch (err) {
        return toToolError(err) as CallToolResult;
      }
    }
  );
}
