#!/usr/bin/env node
/**
 * index.ts — stdio MCP server entrypoint for `training-db`.
 *
 * Startup sequence:
 *   1. buildCtx() — fail-fast if MCP_USER_ID / SUPABASE_DB_URL are missing.
 *   2. createDb() — node-postgres pool bound to the connection string.
 *   3. Assemble the tool list (Phase 0 ships only the `echo_user` debug tool).
 *   4. registerTools() wires tools/list + tools/call.
 *   5. Connect a StdioServerTransport — the SDK spawns this over stdio.
 *
 * Adding tools (Phase 1-5): import each phase's tool array and spread it into
 * `allTools` below at the marked spot. The registry needs no changes.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildCtx } from './ctx.js';
import { createDb } from './db.js';
import { defineTool, registerTools, type AnyToolModule } from './registry.js';
import { readPostworkoutBundleTools } from './tools/read_postworkout_bundle.js';
import { readWeekBundleTools } from './tools/read_week_bundle.js';
import { readContextTools } from './tools/read_context.js';
import { writeExercisePatchTools } from './tools/write_exercise_patch.js';
import { writeDayNotesTools } from './tools/write_day_notes.js';
import { writeSessionNotesTools } from './tools/write_session_notes.js';
import { writeExerciseVersionedTools } from './tools/write_exercise_versioned.js';
import { writeProgramTools } from './tools/write_program.js';
import { writeCatalogTools } from './tools/write_catalog.js';
import { writeSessionLogTools } from './tools/write_session_log.js';
import { writeDailyMetricsTools } from './tools/write_daily_metrics.js';
import { writeNutritionTools } from './tools/write_nutrition.js';
import { writeProblemsTools } from './tools/write_problems.js';
import { writeCorrectionsTools } from './tools/write_corrections.js';
import { writeProfileGoalsTools } from './tools/write_profile_goals.js';
import { writePlanningTools } from './tools/write_planning.js';
import { writeWeeklyReviewTools } from './tools/write_weekly_review.js';
import { nutritionLookupFoodTools } from './tools/nutrition_lookup_food.js';
import { foodsSearchTools } from './tools/foods_search.js';
import { foodsUpsertAtomicTools } from './tools/foods_upsert_atomic.js';
import { foodsUpsertCompositeTools } from './tools/foods_upsert_composite.js';
import { logFoodEntryWithComponentsTools } from './tools/log_food_entry_with_components.js';
import { foodsListUserRecipesTools } from './tools/foods_list_user_recipes.js';
import { foodsResolveTools } from './tools/foods_resolve.js';
import { writeObservationsTools } from './tools/write_observations.js';
import { assertUsdaApiKey } from './adapters/usda.js';

/** Debug tool (T002 acceptance): echoes the bound USER_ID. */
const echoUserTool = defineTool({
  name: 'echo_user',
  description:
    'Debug tool: returns the user_id this MCP instance is bound to. ' +
    'Confirms the host process injected MCP_USER_ID correctly for the session.',
  inputSchema: z.object({}).strict(),
  handler: async (_input, ctx) => ({ user_id: ctx.userId }),
});

async function main(): Promise<void> {
  // 1. Fail-fast binding.
  const ctx = buildCtx();
  // Phase 6: USDA API key required for nutrition.lookup_food + foods.resolve.
  assertUsdaApiKey();

  // 2. DB pool.
  const db = createDb(ctx);

  // 3. Tool list. Phase 1-5 spread their arrays here:
  const allTools: AnyToolModule[] = [
    echoUserTool,
    // --- Phase 1 (read): bundles + context (T003/T004/T005)
    ...readPostworkoutBundleTools,
    ...readWeekBundleTools,
    ...readContextTools,
    // --- Phase 2 (write: note/rules/load): T006/T007/T008
    ...writeExercisePatchTools,
    ...writeDayNotesTools,
    ...writeSessionNotesTools,
    // --- Phase 3 (write: versioned exercise + program lifecycle + catalog): T009/T010/T011
    ...writeExerciseVersionedTools,
    ...writeProgramTools,
    ...writeCatalogTools,
    // --- Phase 4 (write: daily flows): T012/T013/T014/T015/T016
    ...writeSessionLogTools,
    ...writeDailyMetricsTools,
    ...writeNutritionTools,
    ...writeProblemsTools,
    ...writeCorrectionsTools,
    // --- Phase 5 (planning & review seal): T017/T018/T019
    ...writeProfileGoalsTools,
    ...writePlanningTools,
    ...writeWeeklyReviewTools,
    // --- Phase 6 (nutrition decomposition): T006-T015
    // Adapters USDA + OFF, disk cache, lookup_food, foods_search/upsert_atomic/
    // upsert_composite/list_user_recipes/resolve, log_food_entry_with_components.
    ...nutritionLookupFoodTools,
    ...foodsSearchTools,
    ...foodsUpsertAtomicTools,
    ...foodsUpsertCompositeTools,
    ...logFoodEntryWithComponentsTools,
    ...foodsListUserRecipesTools,
    ...foodsResolveTools,
    // --- Observation store (Flusso 3): add/reinforce/set_status (read tool in readContextTools)
    ...writeObservationsTools,
  ];

  // 4. Server + registry.
  const server = new Server(
    { name: 'training-db', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );
  registerTools(server, allTools, ctx, db);

  // 5. stdio transport.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown: close the pool on signals.
  const shutdown = async () => {
    try {
      await db.end();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(
    '[training-db] fatal startup error:',
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
