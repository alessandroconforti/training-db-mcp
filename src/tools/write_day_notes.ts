/**
 * write_day_notes.ts — Phase 2 (T007) program_day_notes write tools.
 *
 * program_day_notes has composite key (user_id, program_id, day_type) and holds:
 *   - ai_notes_text  (the day brief; DEFAULT '' so a rules-only upsert on a fresh
 *     row does not violate NOT NULL)
 *   - decided_rules  (jsonb list of coach rules for the NEXT session of day_type)
 *
 * Both tools UPSERT on the composite key (overwrite-in-place; no historization —
 * versioning is Phase 3). There is no row-level requireOwned: the key is bound
 * with user_id = ctx.userId, so the INSERT can only ever land on the bound user's
 * row and the ON CONFLICT target is (user_id, program_id, day_type) — cross-tenant
 * collision is structurally impossible.
 *
 * Columns touched (program_day_notes): ai_notes_text, decided_rules, generated_at.
 *
 * Rule-wrapper validation: malformed → ValidationError,
 * never silently stored. `verifiable` is DERIVED server-side (true only for
 * weight/reps), so any client-supplied value is ignored/recomputed.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule } from '../registry.js';
import { ValidationError } from '../errors.js';

const programId = z.number().int().positive();
const dayType = z.string().min(1);

// ── decided_rules wrapper (design §6.2) ───────────────────────────────────────

const RULE_TYPES = [
  'weight',
  'reps',
  'rest',
  'superset',
  'conditional_test',
  'technique',
  'volume',
  'note',
] as const;

/** type → verifiable is DERIVED: true only for weight/reps. */
const VERIFIABLE_TYPES = new Set(['weight', 'reps']);

/**
 * `expected` shapes (coherent per type):
 *   weight → { value: number } | { array: number[] }
 *   reps   → { total_min: int }
 *   others → must be null/absent (qualitative)
 */
const weightExpected = z.union([
  z.object({ value: z.number() }).strict(),
  z.object({ array: z.array(z.number()).min(1) }).strict(),
]);
const repsExpected = z.object({ total_min: z.number().int() }).strict();

/**
 * A single decided rule. `verifiable` is accepted but DERIVED server-side, so we
 * keep it optional in the schema and recompute it; `expected` coherence with
 * `type` is enforced in a superRefine (zod cannot cross-validate two fields by
 * union otherwise without losing the precise error).
 */
const ruleSchema = z
  .object({
    id: z.string().min(1, 'rule.id must be a non-empty string'),
    type: z.enum(RULE_TYPES),
    target_exercise_id: z.number().int().nullable(),
    expected: z.unknown().optional(),
    text: z.string().min(1, 'rule.text must be a non-empty string'),
    // accepted for round-tripping but ignored; we recompute it from `type`.
    verifiable: z.boolean().optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const exp = rule.expected ?? null;
    if (rule.type === 'weight') {
      const parsed = weightExpected.safeParse(exp);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expected'],
          message:
            "type 'weight' requires expected = {value:number} or {array:number[]}",
        });
      }
    } else if (rule.type === 'reps') {
      const parsed = repsExpected.safeParse(exp);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expected'],
          message: "type 'reps' requires expected = {total_min:int}",
        });
      }
    } else if (exp !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expected'],
        message: `type '${rule.type}' is qualitative; expected must be null/absent`,
      });
    }
  });

type Rule = z.infer<typeof ruleSchema>;

/** Normalize a validated rule into the stored jsonb wrapper, deriving `verifiable`. */
function toStoredRule(rule: Rule): {
  id: string;
  type: string;
  target_exercise_id: number | null;
  expected: unknown;
  text: string;
  verifiable: boolean;
} {
  return {
    id: rule.id,
    type: rule.type,
    target_exercise_id: rule.target_exercise_id,
    expected: rule.expected ?? null,
    text: rule.text,
    verifiable: VERIFIABLE_TYPES.has(rule.type),
  };
}

// ── set_day_brief ──────────────────────────────────────────────────────────────

const setDayBriefTool = defineTool({
  name: 'set_day_brief',
  description:
    'UPSERT the textual day brief (program_day_notes.ai_notes_text) on ' +
    '(program_id, day_type) for the bound user. null or empty string clears the ' +
    'brief (stored as ""). Does not touch decided_rules. Overwrite-in-place.',
  inputSchema: z
    .object({
      program_id: programId,
      day_type: dayType,
      text: z.string().nullable(),
    })
    .strict(),
  handler: async (input, ctx) => {
    const brief = input.text ?? '';
    await ctx.db.query(
      `INSERT INTO program_day_notes
          (user_id, program_id, day_type, ai_notes_text, generated_at)
        VALUES ($1, $2, $3, $4, now())
        ON CONFLICT (user_id, program_id, day_type)
        DO UPDATE SET ai_notes_text = EXCLUDED.ai_notes_text,
                      generated_at  = now()`,
      [ctx.userId, input.program_id, input.day_type, brief]
    );
    return {
      program_id: input.program_id,
      day_type: input.day_type,
      ai_notes_text: brief,
    };
  },
});

// ── set_decided_rules ──────────────────────────────────────────────────────────

const setDecidedRulesTool = defineTool({
  name: 'set_decided_rules',
  description:
    'UPSERT the decided_rules jsonb list (program_day_notes.decided_rules) on ' +
    '(program_id, day_type). Overwrites the whole set; [] clears it. Each rule ' +
    'is validated against the §6.2 wrapper (id, type enum, target_exercise_id, ' +
    'type-coherent expected, text); verifiable is derived (true only for ' +
    'weight/reps). Malformed rules are rejected with VALIDATION, never stored.',
  inputSchema: z
    .object({
      program_id: programId,
      day_type: dayType,
      rules: z.array(ruleSchema),
    })
    .strict(),
  handler: async (input, ctx) => {
    // Enforce unique rule ids within the set (loud, not silent dedupe).
    const ids = input.rules.map((r) => r.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      throw new ValidationError('decided_rules contains duplicate rule ids', {
        duplicate_ids: Array.from(new Set(dupes)),
      });
    }

    const stored = input.rules.map(toStoredRule);
    const json = JSON.stringify(stored);

    await ctx.db.query(
      `INSERT INTO program_day_notes
          (user_id, program_id, day_type, decided_rules, generated_at)
        VALUES ($1, $2, $3, $4::jsonb, now())
        ON CONFLICT (user_id, program_id, day_type)
        DO UPDATE SET decided_rules = EXCLUDED.decided_rules,
                      generated_at  = now()`,
      [ctx.userId, input.program_id, input.day_type, json]
    );
    return {
      program_id: input.program_id,
      day_type: input.day_type,
      n_rules: stored.length,
      decided_rules: stored,
    };
  },
});

export const writeDayNotesTools: AnyToolModule[] = [
  setDayBriefTool,
  setDecidedRulesTool,
];
