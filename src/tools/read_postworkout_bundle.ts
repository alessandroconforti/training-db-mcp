/**
 * read_postworkout_bundle.ts — Phase 1 (T003) get_postworkout_bundle.
 *
 * TS/SQL implementation of the post-workout review bundle. Emits a stable
 * top-level key set and per-exercise computed/facts.
 *
 * CORE PRINCIPLE (design P3): bundles emit FACTS, never interpretations. There
 * are NO regression/good/bad labels anywhere — only booleans/numbers the model
 * interprets (e.g. weight_below_recent_history, miss_significant on a reps_min
 * floor).
 *
 * Top-level keys (T026 parity):
 *   meta, session, prev_sessions_same_daytype, nutrition_phase,
 *   prev_weekly_review, scheda_changes_recent, weight_log_recent,
 *   problems_active, decided_rules_raw, exercises, skipped_planned_exercises,
 *   evaluated_rules, derived
 *
 * Notable details: `meta.today` is computed in Europe/Rome; `meta.generated_at`
 * is set; numeric[] columns arrive already typed by node-postgres (no string→num
 * coercion needed).
 *
 * All SELECTs filter user_id via a bound param. READ-ONLY.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { NotFoundError } from '../errors.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/** node-postgres returns numeric[] as number[] but lone numeric as string. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function numArr(v: unknown): number[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return null;
  return v.map((x) => num(x)).filter((x): x is number => x !== null);
}

/** Today in Europe/Rome as YYYY-MM-DD (equivalent to `now() AT TIME ZONE`). */
function todayRome(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date()); // en-CA → YYYY-MM-DD
}

// ── row types ─────────────────────────────────────────────────────────────────

interface SessionRow {
  session_id: number;
  date: string;
  day_type: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_min: number | null;
  sleep_h: number | null;
  body_weight_kg: number | null;
  condition: string | null;
  notes_text: string | null;
  program_id: number | null;
  day_label: string | null;
}

interface ExerciseRawRow {
  se_id: number;
  order_num: number;
  exercise_id: number;
  exercise_name: string;
  pe_id: number | null;
  planned_sets: number | null;
  reps_min: number | null;
  reps_max: number | null;
  planned_weight: unknown;
  target_weight_kg: unknown;
  planned_brief: string | null;
  done_weight: unknown;
  reps_array: number[] | null;
  total_reps: number | null;
  rpe: unknown;
  notes_text: string | null;
  done_w: unknown;
  planned_w: unknown;
  done_sets_count: number | null;
}

interface HistoryRow {
  exercise_id: number;
  date: string;
  weight_array: unknown;
  reps_array: number[] | null;
  total_reps: number | null;
  rpe: unknown;
}

interface DecidedRule {
  id?: string;
  type?: string;
  target_exercise_id?: number | null;
  expected?: { value?: unknown; array?: unknown[]; total_min?: unknown } | null;
  text?: string;
  verifiable?: boolean;
  [k: string]: unknown;
}

// ── tool ──────────────────────────────────────────────────────────────────────

const getPostworkoutBundleTool = defineTool({
  name: 'get_postworkout_bundle',
  description:
    'Single-session post-workout review bundle: measured facts + deterministic ' +
    'computed values (NO interpretive labels). Defaults to the latest CLOSED ' +
    'session (end_time NOT NULL).',
  inputSchema: z
    .object({ session_id: z.number().int().positive().optional() })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const db = ctx.db;
    const userId = ctx.userId;
    const generatedAt = new Date().toISOString();

    // ── session resolution ────────────────────────────────────────────────────
    // open_session_warning: is the latest session (by date/time) still open?
    const lastAny = await db.queryOne<{ end_time: string | null }>(
      `SELECT end_time FROM sessions
         WHERE user_id = $1
         ORDER BY date DESC, COALESCE(end_time, start_time, '00:00') DESC
         LIMIT 1`,
      [userId]
    );
    const openWarning = lastAny ? lastAny.end_time === null : false;

    let mode: 'explicit' | 'auto_last_closed';
    let resolvedSid: number;
    if (input.session_id !== undefined) {
      mode = 'explicit';
      resolvedSid = input.session_id;
    } else {
      mode = 'auto_last_closed';
      const lastClosed = await db.queryOne<{ id: number }>(
        `SELECT id FROM sessions
           WHERE user_id = $1 AND end_time IS NOT NULL
           ORDER BY date DESC, COALESCE(end_time, start_time, '00:00') DESC
           LIMIT 1`,
        [userId]
      );
      if (!lastClosed) {
        throw new NotFoundError('No closed session found for the current user.');
      }
      resolvedSid = lastClosed.id;
    }

    // ── session base row + day_label ────────────────────────────────────────────
    const session = await db.queryOne<SessionRow>(
      `SELECT s.id AS session_id, s.date, s.day_type,
              s.start_time, s.end_time, s.duration_min, s.sleep_h,
              s.body_weight_kg, s.condition, s.notes_text, s.program_id,
              pd.display_name AS day_label
         FROM sessions s
         LEFT JOIN program_days pd
           ON pd.user_id = s.user_id
          AND pd.program_id = s.program_id
          AND pd.day_type = s.day_type
         WHERE s.user_id = $1 AND s.id = $2`,
      [userId, resolvedSid]
    );
    if (session === null) {
      throw new NotFoundError(
        `Session ${resolvedSid} not found for the current user.`,
        { session_id: resolvedSid }
      );
    }

    const sessionDate = session.date;
    const dayType = session.day_type;
    const programId = session.program_id;

    // ── same_day_candidates ─────────────────────────────────────────────────────
    const sameDay = await db.query(
      `SELECT id, day_type, end_time
         FROM sessions
         WHERE user_id = $1 AND date = $2::date
         ORDER BY COALESCE(end_time, start_time, '00:00')`,
      [userId, sessionDate]
    );

    // ── meta ────────────────────────────────────────────────────────────────────
    const today = todayRome();
    const resolution = {
      mode,
      resolved_session_id: resolvedSid,
      open_session_warning: openWarning,
      same_day_candidates: sameDay,
    };
    const meta = {
      user_id: userId,
      session_id: resolvedSid,
      today,
      day_type: dayType ?? null,
      day_label: session.day_label ?? null,
      program_id: programId ?? null,
      generated_at: generatedAt,
      resolution,
    };

    // ── prev_sessions_same_daytype: last 2 same day_type excl. current ──────────
    const prevSessions =
      dayType !== null
        ? await db.query(
            `SELECT s.date, s.duration_min, s.sleep_h, s.condition, s.ai_notes_text
               FROM sessions s
               WHERE s.user_id = $1 AND s.day_type = $2 AND s.id <> $3
               ORDER BY s.date DESC
               LIMIT 2`,
            [userId, dayType, resolvedSid]
          )
        : [];

    // ── nutrition_phase: target active at session.date ──────────────────────────
    const nutritionPhase = await db.queryOne(
      `SELECT phase_name, started_on, ended_on
         FROM nutrition_targets
         WHERE user_id = $1
           AND started_on <= $2::date
           AND (ended_on IS NULL OR ended_on >= $2::date)
         ORDER BY started_on DESC
         LIMIT 1`,
      [userId, sessionDate]
    );

    // ── prev_weekly_review ──────────────────────────────────────────────────────
    const prevWeeklyReview = await db.queryOne(
      `SELECT review_number, week_start, week_end, decisions_summary, content_md
         FROM weekly_reviews
         WHERE user_id = $1
         ORDER BY review_number DESC
         LIMIT 1`,
      [userId]
    );

    // ── scheda_changes_recent: last 21 days of current program ──────────────────
    const schedaChanges =
      programId !== null
        ? await db.query(
            `SELECT change_type, description, diff,
                    affected_before_id, affected_after_id,
                    (diff->>'triggered_by_session') AS triggered_by_session
               FROM scheda_changes
               WHERE user_id = $1
                 AND program_id = $2
                 AND changed_at >= ($3::date - 21)
               ORDER BY changed_at DESC`,
            [userId, programId, sessionDate]
          )
        : [];

    // ── weight_log_recent: last 7 days up to session.date ───────────────────────
    const weightLog = await db.query(
      `SELECT date, weight_kg, notes
         FROM weight_log
         WHERE user_id = $1
           AND date BETWEEN ($2::date - 6) AND $2::date
         ORDER BY date`,
      [userId, sessionDate]
    );

    // ── problems_active ─────────────────────────────────────────────────────────
    const problems = await db.query<{
      id: number;
      title: string;
      status: string;
      severity: string | null;
      related_exercises: number[] | null;
      management: string | null;
    }>(
      `SELECT id, title, status, severity, related_exercises, management
         FROM problems
         WHERE user_id = $1
           AND status IN ('active','monitoring','chronic')
         ORDER BY severity DESC NULLS LAST, id`,
      [userId]
    );

    // ── decided_rules_raw: rules in effect for this program/day_type ────────────
    let decidedRules: DecidedRule[] = [];
    if (programId !== null && dayType !== null) {
      const dr = await db.queryOne<{ decided_rules: unknown }>(
        `SELECT decided_rules
           FROM program_day_notes
           WHERE user_id = $1 AND program_id = $2 AND day_type = $3
           LIMIT 1`,
        [userId, programId, dayType]
      );
      decidedRules = Array.isArray(dr?.decided_rules)
        ? (dr!.decided_rules as DecidedRule[])
        : [];
    }

    // ── exercises[] raw ─────────────────────────────────────────────────────────
    const exRows = await db.query<ExerciseRawRow>(
      `SELECT
          se.id AS se_id,
          se.order_num,
          se.exercise_id,
          e.canonical_name AS exercise_name,
          pe.id AS pe_id,
          pe.sets AS planned_sets,
          pe.reps_min, pe.reps_max,
          pe.current_weight_array AS planned_weight,
          pe.target_weight_kg,
          pe.ai_notes_text AS planned_brief,
          se.weight_array AS done_weight,
          se.reps_array,
          se.total_reps,
          se.rpe,
          se.notes_text,
          (SELECT max(v) FROM unnest(se.weight_array) AS v) AS done_w,
          (SELECT max(v) FROM unnest(pe.current_weight_array) AS v) AS planned_w,
          array_length(se.reps_array, 1) AS done_sets_count
        FROM session_exercises se
        JOIN exercises e ON e.id = se.exercise_id
        LEFT JOIN program_exercises pe
          ON pe.id = se.linked_program_exercise_id AND pe.user_id = se.user_id
        WHERE se.user_id = $1 AND se.session_id = $2
        ORDER BY se.order_num`,
      [userId, resolvedSid]
    );

    // ── history: last 3 sessions per exercise_id (excl. current) ────────────────
    const exIds = Array.from(new Set(exRows.map((r) => r.exercise_id)));
    let historyRows: HistoryRow[] = [];
    if (exIds.length > 0) {
      historyRows = await db.query<HistoryRow>(
        `SELECT * FROM (
            SELECT se.exercise_id, s.date, se.weight_array, se.reps_array,
                   se.total_reps, se.rpe,
                   row_number() OVER (PARTITION BY se.exercise_id ORDER BY s.date DESC) AS rn
              FROM session_exercises se
              JOIN sessions s ON s.id = se.session_id AND s.user_id = se.user_id
              WHERE se.user_id = $1
                AND se.exercise_id = ANY($2::int[])
                AND se.session_id <> $3
          ) t
          WHERE t.rn <= 3
          ORDER BY t.exercise_id, t.date DESC`,
        [userId, exIds, resolvedSid]
      );
    }

    // Group history per exercise_id.
    const histMap = new Map<number, Array<Record<string, unknown>>>();
    for (const h of historyRows) {
      const list = histMap.get(h.exercise_id) ?? [];
      list.push({
        date: h.date,
        weight_array: numArr(h.weight_array),
        reps_array: h.reps_array,
        total_reps: h.total_reps,
        rpe: num(h.rpe),
      });
      histMap.set(h.exercise_id, list);
    }

    // related_exercises across active problems (for problem_correlated).
    const problemEx = new Set<number>();
    for (const p of problems) {
      for (const id of p.related_exercises ?? []) problemEx.add(id);
    }

    // Assemble exercises[] with computed + facts (deterministic, no labels).
    const exercises = exRows.map((r) => {
      const doneW = num(r.done_w);
      const plannedW = num(r.planned_w);
      const onPlan = r.pe_id !== null;
      const wdelta =
        onPlan && doneW !== null && plannedW !== null ? doneW - plannedW : null;
      const floor =
        onPlan && r.planned_sets !== null && r.reps_min !== null
          ? r.planned_sets * r.reps_min
          : null;
      let missPct: number | null = null;
      if (floor !== null && floor > 0 && r.total_reps !== null) {
        const raw = (100 * (floor - r.total_reps)) / floor;
        missPct = raw < 0 ? 0 : raw;
      }
      const rpe = num(r.rpe);
      const history = histMap.get(r.exercise_id) ?? [];
      const histWeights: number[] = [];
      for (const h of history) {
        const wa = h.weight_array as number[] | null;
        if (wa) for (const w of wa) if (w !== null) histWeights.push(w);
      }
      const histMaxW = histWeights.length === 0 ? null : Math.max(...histWeights);

      return {
        se_id: r.se_id,
        order_num: r.order_num,
        exercise_id: r.exercise_id,
        exercise_name: r.exercise_name,
        pe_id: r.pe_id,
        planned: {
          sets: r.planned_sets,
          reps_min: r.reps_min,
          reps_max: r.reps_max,
          planned_weight: numArr(r.planned_weight),
          target_weight_kg: num(r.target_weight_kg),
          planned_brief: r.planned_brief,
        },
        done: {
          done_weight: numArr(r.done_weight),
          reps_array: r.reps_array,
          total_reps: r.total_reps,
          rpe,
          notes_text: r.notes_text,
        },
        computed: {
          done_w: doneW,
          planned_w: plannedW,
          weight_delta_vs_plan_kg: wdelta,
          reps_target_floor: floor,
          miss_pct: missPct,
        },
        facts: {
          weight_increased_vs_plan:
            onPlan && wdelta !== null ? wdelta > 0 : false,
          weight_decreased_vs_plan:
            onPlan && wdelta !== null ? wdelta < 0 : false,
          weight_below_recent_history:
            doneW !== null && histMaxW !== null ? doneW < histMaxW : false,
          miss_significant: missPct !== null ? missPct >= 15 : false,
          rpe_high: rpe !== null ? rpe >= 9 : false,
          rpe_null: rpe === null,
          off_plan: r.pe_id === null,
          sets_fewer_than_planned:
            onPlan && r.planned_sets !== null && r.done_sets_count !== null
              ? r.done_sets_count < r.planned_sets
              : false,
          pr_candidate:
            onPlan && wdelta !== null
              ? wdelta > 0 && (missPct === null || missPct < 15)
              : false,
          problem_correlated: problemEx.has(r.exercise_id),
        },
        history,
      };
    });

    // ── skipped_planned_exercises[] ─────────────────────────────────────────────
    const skipped =
      programId !== null && dayType !== null
        ? await db.query(
            `SELECT pe.id AS pe_id, e.canonical_name AS exercise_name,
                    pe.sets AS planned_sets,
                    pe.reps_min AS planned_reps_min, pe.reps_max AS planned_reps_max,
                    pe.current_weight_array AS planned_weight
               FROM program_exercises pe
               JOIN exercises e ON e.id = pe.exercise_id
               WHERE pe.user_id = $1
                 AND pe.program_id = $2
                 AND pe.day_type = $3
                 AND pe.valid_from <= $4::date
                 AND (pe.valid_to IS NULL OR pe.valid_to > $4::date)
                 AND NOT EXISTS (
                   SELECT 1 FROM session_exercises se
                   WHERE se.session_id = $5
                     AND se.user_id = $1
                     AND (se.linked_program_exercise_id = pe.id
                          OR se.exercise_id = pe.exercise_id)
                 )
               ORDER BY pe.order_num`,
            [userId, programId, dayType, sessionDate, resolvedSid]
          )
        : [];

    // ── evaluated_rules[]: verify previous decisions applied ────────────────────
    const exById = new Map<number, (typeof exercises)[number]>();
    for (const ex of exercises) {
      if (!exById.has(ex.exercise_id)) exById.set(ex.exercise_id, ex);
    }
    const evaluatedRules = decidedRules.map((rule) => {
      const type = rule.type ?? 'note';
      const tex = rule.target_exercise_id ?? null;
      const match = tex !== null ? exById.get(tex) ?? null : null;
      let verdict: { applied: boolean | null; unverifiable: boolean };

      if (type === 'weight') {
        const arr = rule.expected?.array ?? null;
        const val = rule.expected?.value ?? null;
        let expW: number | null = null;
        if (Array.isArray(arr)) {
          const nums = arr.map((x) => num(x)).filter((x): x is number => x !== null);
          expW = nums.length === 0 ? null : Math.max(...nums);
        } else if (val !== null && val !== undefined) {
          expW = num(val);
        }
        if (expW === null) {
          verdict = { applied: null, unverifiable: true };
        } else if (match === null || match.computed.done_w === null) {
          verdict = { applied: false, unverifiable: false };
        } else {
          verdict = {
            applied: Math.abs(match.computed.done_w - expW) <= 0.01,
            unverifiable: false,
          };
        }
      } else if (type === 'reps') {
        const tmin = num(rule.expected?.total_min);
        if (tmin === null) {
          verdict = { applied: null, unverifiable: true };
        } else if (match === null || match.done.total_reps === null) {
          verdict = { applied: false, unverifiable: false };
        } else {
          verdict = {
            applied: match.done.total_reps >= tmin,
            unverifiable: false,
          };
        }
      } else {
        verdict = { applied: null, unverifiable: true };
      }
      return { ...rule, ...verdict };
    });

    // ── derived: session aggregates ─────────────────────────────────────────────
    const rpes = exercises
      .map((e) => e.done.rpe)
      .filter((r): r is number => r !== null);
    const dur = session.duration_min;
    const prevDur =
      prevSessions.length > 0
        ? (prevSessions[0] as { duration_min: number | null }).duration_min
        : null;
    const derived = {
      n_exercises: exercises.length,
      n_off_plan: exercises.filter((e) => e.facts.off_plan).length,
      n_skipped: skipped.length,
      n_pr_candidates: exercises.filter((e) => e.facts.pr_candidate).length,
      n_miss_significant: exercises.filter((e) => e.facts.miss_significant).length,
      avg_rpe:
        rpes.length === 0
          ? null
          : Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10,
      duration_drift_min: dur !== null && prevDur !== null ? dur - prevDur : null,
      n_rules: evaluatedRules.length,
      n_rules_applied: evaluatedRules.filter((r) => r.applied === true).length,
      n_rules_unverifiable: evaluatedRules.filter((r) => r.unverifiable === true)
        .length,
    };

    return {
      meta,
      session,
      prev_sessions_same_daytype: prevSessions,
      nutrition_phase: nutritionPhase,
      prev_weekly_review: prevWeeklyReview,
      scheda_changes_recent: schedaChanges,
      weight_log_recent: weightLog,
      problems_active: problems,
      decided_rules_raw: decidedRules,
      exercises,
      skipped_planned_exercises: skipped,
      evaluated_rules: evaluatedRules,
      derived,
    };
  },
});

/** Phase 1 post-workout bundle tool (T003). */
export const readPostworkoutBundleTools: AnyToolModule[] = [
  getPostworkoutBundleTool,
];
