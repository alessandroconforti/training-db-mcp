/**
 * write_session_notes.ts — Phase 2 (T008) retrospective session note tools.
 *
 * These patch ai_notes_text on a closed session record or a single executed
 * session_exercise. They are POINTWISE sets (`text|null`, null clears) on a
 * historical row — NOT clean-by-omission: nothing else is touched, ever.
 *
 * requireOwned BEFORE every mutation:
 *   - sessions: own user_id column.
 *   - session_exercises: no own user_id checked here for ownership; resolved via
 *     JOIN to sessions (fromAndWhere) so a cross-tenant se_id → NotFound.
 *
 * Columns touched: sessions.ai_notes_text, session_exercises.ai_notes_text.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { requireOwned } from '../ownership.js';
import { NotFoundError } from '../errors.js';

const idSchema = z.number().int().positive();

// ── set_session_ai_note ───────────────────────────────────────────────────────

const setSessionAiNoteTool = defineTool({
  name: 'set_session_ai_note',
  description:
    'Pointwise-set the retrospective coach note (sessions.ai_notes_text) on a ' +
    'session owned by the bound user. null clears it. Touches nothing else.',
  inputSchema: z
    .object({
      session_id: idSchema,
      ai_notes_text: z.string().nullable(),
    })
    .strict(),
  handler: async (input, ctx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.session_id,
      table: 'sessions',
      idColumn: 'id',
      label: 'session',
    });
    const rows = await ctx.db.query<{ id: number }>(
      `UPDATE sessions
          SET ai_notes_text = $1
        WHERE id = $2 AND user_id = $3
        RETURNING id`,
      [input.ai_notes_text, input.session_id, ctx.userId]
    );
    if (rows.length === 0) {
      throw new NotFoundError(`session ${input.session_id} not found.`, {
        id: input.session_id,
      });
    }
    return { session_id: input.session_id, ai_notes_text: input.ai_notes_text };
  },
});

// ── set_session_exercise_ai_note ──────────────────────────────────────────────

/** Ownership predicate for session_exercises via JOIN to sessions ($1=id,$2=user). */
function seFromAndWhere(): string {
  return (
    'FROM session_exercises se JOIN sessions s ON s.id = se.session_id ' +
    'WHERE se.id = $1 AND s.user_id = $2'
  );
}

const setSessionExerciseAiNoteTool = defineTool({
  name: 'set_session_exercise_ai_note',
  description:
    'Pointwise-set the retrospective coach note (session_exercises.ai_notes_text) ' +
    'on a single executed exercise of a session owned by the bound user. ' +
    'Ownership resolved via JOIN to sessions. null clears it.',
  inputSchema: z
    .object({
      se_id: idSchema,
      ai_notes_text: z.string().nullable(),
    })
    .strict(),
  handler: async (input: { se_id: number; ai_notes_text: string | null }, ctx: ToolCtx) => {
    await requireOwned({
      db: ctx.db,
      userId: ctx.userId,
      idValue: input.se_id,
      fromAndWhere: seFromAndWhere(),
      label: 'session_exercise',
    });
    // Update is itself ownership-guarded via the same join, so a row that passed
    // requireOwned cannot escape; RETURNING confirms the touch.
    const rows = await ctx.db.query<{ id: number }>(
      `UPDATE session_exercises se
          SET ai_notes_text = $1
         FROM sessions s
        WHERE s.id = se.session_id
          AND se.id = $2 AND s.user_id = $3
        RETURNING se.id`,
      [input.ai_notes_text, input.se_id, ctx.userId]
    );
    if (rows.length === 0) {
      throw new NotFoundError(`session_exercise ${input.se_id} not found.`, {
        id: input.se_id,
      });
    }
    return { se_id: input.se_id, ai_notes_text: input.ai_notes_text };
  },
});

export const writeSessionNotesTools: AnyToolModule[] = [
  setSessionAiNoteTool,
  setSessionExerciseAiNoteTool,
];
