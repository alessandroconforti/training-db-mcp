/**
 * write_daily_metrics.ts — Phase 4 (T013) daily metrics logging.
 *
 * log_daily_metrics writes the per-day body weight to `weight_log` (composite PK
 * (user_id, date)) and, if sleep_h / body_weight_kg are passed, enriches the
 * day's `sessions` row via the shared sleep-only logic (enrichOrCreateSession,
 * from write_session_log).
 *
 * Loud conflicts (locked rule): weight_log has PK (user_id, date) — a second
 * log_daily_metrics for the same day with weight_kg raises Postgres 23505, which
 * we map to a clear ConflictError naming the date (no silent overwrite). To
 * surface the existing value, we read it (best-effort) before composing the
 * message.
 *
 * Branching:
 *   - weight_kg only          -> weight_log INSERT (no sessions touch).
 *   - sleep_h/body_weight_kg  -> sessions enrich (sleep-only create/update).
 *   - both                    -> weight_log INSERT THEN sessions enrich.
 *
 * Not a transaction by design (matches the app): the two tables are independent;
 * a PK conflict on weight_log fails before any sessions write.
 *
 * Tables: weight_log, sessions.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { ConflictError } from '../errors.js';
import { isoDate } from './write_exercise_versioned.js';
import { enrichOrCreateSession } from './write_session_log.js';

/** True if an error (or its wrapped message) is a Postgres unique violation. */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === '23505') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /duplicate key|already exists|unique constraint|23505/i.test(msg);
}

const logDailyMetricsTool = defineTool({
  name: 'log_daily_metrics',
  description:
    'Log per-day body weight (weight_log, PK (user,date)) and/or sleep. ' +
    'weight_kg writes weight_log loud on PK conflict (a second same-day weight => ' +
    'ConflictError naming the date, never a silent overwrite). sleep_h / ' +
    'body_weight_kg enrich the day sessions row (sleep-only create/update, no ' +
    'weight_log touch). Dates are UTC ISO.',
  inputSchema: z
    .object({
      date: isoDate,
      weight_kg: z.number().min(20).max(400).optional(),
      sleep_h: z.number().min(0).max(24).optional(),
      body_weight_kg: z.number().min(0).max(400).optional(),
      notes: z.string().nullable().optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const result: {
      date: string;
      weight_logged: boolean;
      session_id?: number;
      session_created?: boolean;
    } = { date: input.date, weight_logged: false };

    // 1. weight_log — plain INSERT, loud on PK conflict.
    if (input.weight_kg !== undefined) {
      try {
        await ctx.db.query(
          `INSERT INTO weight_log (user_id, date, weight_kg, notes)
           VALUES ($1, $2, $3, $4)`,
          [ctx.userId, input.date, input.weight_kg, input.notes ?? null]
        );
        result.weight_logged = true;
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Best-effort: fetch the existing value to name it in the message.
          let existingLabel = 'a value';
          try {
            const row = await ctx.db.queryOne<{ weight_kg: number }>(
              `SELECT weight_kg FROM weight_log
                WHERE user_id = $1 AND date = $2`,
              [ctx.userId, input.date]
            );
            if (row && typeof row.weight_kg === 'number') {
              existingLabel = `${row.weight_kg} kg`;
            }
          } catch {
            // ignore — fall back to the generic label
          }
          throw new ConflictError(
            `weight_log already has an entry for ${input.date}: ${existingLabel}. ` +
              `Delete the existing row first if you want to overwrite (no silent overwrite).`,
            { date: input.date }
          );
        }
        throw err;
      }
    }

    // 2. sessions enrich — only if sleep/body-weight provided.
    if (input.sleep_h !== undefined || input.body_weight_kg !== undefined) {
      const enrich = await enrichOrCreateSession(
        ctx.db,
        ctx.userId,
        input.date,
        {
          sleep_h: input.sleep_h,
          body_weight_kg: input.body_weight_kg,
        }
      );
      result.session_id = enrich.session_id;
      result.session_created = enrich.created;
    }

    return result;
  },
});

export const writeDailyMetricsTools: AnyToolModule[] = [logDailyMetricsTool];
