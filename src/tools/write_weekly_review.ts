/**
 * write_weekly_review.ts — Phase 5 (T019) weekly review seal.
 *
 * create_weekly_review inserts a durable weekly_reviews row. Two locked rules:
 *
 *   - review_number is USER-SCOPED and computed INSIDE the transaction as
 *     COALESCE(MAX(review_number), 0) + 1 (so the first review of a user => 1).
 *     Computing it in-tx (SELECT ... then INSERT under the same client) avoids a
 *     read-then-write race between concurrent seals.
 *
 *   - review_md_path is ALWAYS NULL (NC2): persistence is DB-only, no file on
 *     disk. The column survives only for legacy reference and is never written.
 *
 * The optional metrics (adherence_pct / sessions_done / sessions_planned /
 * sleep_avg_h / weight_avg_kg / weight_delta_kg) and decisions_summary /
 * content_md / source_conversation_id are stored verbatim when provided.
 *
 * Table: weekly_reviews.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import type { Queryable } from '../db.js';
import { isoDate } from './write_profile_goals.js';

const createWeeklyReviewTool = defineTool({
  name: 'create_weekly_review',
  description:
    'Seal a weekly review (durable weekly_reviews row). review_number is ' +
    'user-scoped and computed IN-TRANSACTION as MAX(review_number)+1 (first ' +
    'review => 1) to avoid races. review_md_path is ALWAYS NULL (DB-only ' +
    'persistence). week_start/week_end describe the accumulating range covered. ' +
    'The optional metrics and decisions_summary/content_md/source_conversation_id ' +
    'are stored verbatim when provided.',
  inputSchema: z
    .object({
      week_start: isoDate,
      week_end: isoDate,
      content_md: z.string().min(1),
      decisions_summary: z.string().nullable().optional(),
      source_conversation_id: z.number().int().positive().nullable().optional(),
      adherence_pct: z.number().nullable().optional(),
      sessions_done: z.number().int().min(0).nullable().optional(),
      sessions_planned: z.number().int().min(0).nullable().optional(),
      sleep_avg_h: z.number().min(0).max(24).nullable().optional(),
      weight_avg_kg: z.number().min(0).max(400).nullable().optional(),
      weight_delta_kg: z.number().nullable().optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    return ctx.db.tx(async (tx: Queryable) => {
      // review_number = user-scoped MAX+1, computed in-tx (first review => 1).
      const maxRow = await tx.queryOne<{ next_number: number }>(
        `SELECT COALESCE(MAX(review_number), 0) + 1 AS next_number
           FROM weekly_reviews
          WHERE user_id = $1`,
        [ctx.userId]
      );
      const reviewNumber = maxRow?.next_number ?? 1;

      const rows = await tx.query<{ id: number }>(
        `INSERT INTO weekly_reviews
            (user_id, review_number, week_start, week_end,
             source_conversation_id, adherence_pct, sessions_done,
             sessions_planned, sleep_avg_h, weight_avg_kg, weight_delta_kg,
             review_md_path, decisions_summary, content_md)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, $13)
         RETURNING id`,
        [
          ctx.userId,
          reviewNumber,
          input.week_start,
          input.week_end,
          input.source_conversation_id ?? null,
          input.adherence_pct ?? null,
          input.sessions_done ?? null,
          input.sessions_planned ?? null,
          input.sleep_avg_h ?? null,
          input.weight_avg_kg ?? null,
          input.weight_delta_kg ?? null,
          input.decisions_summary ?? null,
          input.content_md,
        ]
      );

      return {
        review_id: rows[0].id,
        review_number: reviewNumber,
        week_start: input.week_start,
        week_end: input.week_end,
        review_md_path: null as null,
      };
    });
  },
});

export const writeWeeklyReviewTools: AnyToolModule[] = [createWeeklyReviewTool];
