/**
 * read_week_bundle.ts — Phase 1 (T004) get_week_bundle.
 *
 * Implements the weekly-review bundle contract in TS/SQL. We emit the documented
 * top-level key set; like the post-workout bundle, we emit FACTS only — no
 * adherence verdicts or interpretive labels.
 *
 * Top-level keys (T026 parity):
 *   meta, program, program_days, sessions, exercise_diff, weight_log,
 *   nutrition_target, nutrition_days, problems, prev_reviews, derived,
 *   goals, roadmap, roadmap_projections
 *
 * `roadmap_projections` is fetched from an optional internal projection endpoint
 * (needs env ROADMAP_PROJECTION_SECRET); any failure → null (never breaks the
 * bundle).
 *
 * `derived.weeks[]` aggregates per week inside [range_start, range_end]. Week
 * boundaries are derived from `week_start_dow` (0=Sunday..6=Saturday; default 6 =
 * Saturday, matching the Sat→Fri weekly-review convention). Date arithmetic is
 * UTC (never CURRENT_DATE server-side).
 *
 * NOTE: the live nutrition_targets schema uses per-day mon_target..sun_target
 * jsonb columns (not weekday/weekend aggregate columns). We use the live
 * columns.
 *
 * All SELECTs filter user_id via a bound param. READ-ONLY.
 */
import { z } from 'zod';
import { defineTool, type AnyToolModule, type ToolCtx } from '../registry.js';
import { ValidationError } from '../errors.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be ISO YYYY-MM-DD');

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
  if (!Array.isArray(v)) return null;
  return v.map((x) => num(x)).filter((x): x is number => x !== null);
}

function maxOrNull(arr: number[] | null): number | null {
  if (arr === null || arr.length === 0) return null;
  return Math.max(...arr);
}

/** Parse an ISO YYYY-MM-DD into a UTC Date at midnight. */
function parseUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}
function fmtUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
function dowUtc(d: Date): number {
  return d.getUTCDay(); // 0=Sunday..6=Saturday
}

/**
 * Fetch roadmap_projections from an optional internal projection endpoint.
 * Reads ROADMAP_PROJECTION_SECRET and ROADMAP_PROJECTION_BASE_URL from the
 * environment and GETs <base>/api/internal/roadmap-projection?user_id=<uid> with
 * a bearer header, parsing `.projections` (which MUST be an array). Returns:
 *   - the projections array (possibly []) on success;
 *   - null on ANY failure: missing secret/base url, non-200, non-JSON,
 *     fetch/timeout error, or `.projections` absent / not an array.
 * NEVER throws — a projection failure must not break the whole bundle.
 */
async function fetchRoadmapProjections(
  userId: string
): Promise<unknown[] | null> {
  const secret = process.env.ROADMAP_PROJECTION_SECRET;
  const baseUrl = (process.env.ROADMAP_PROJECTION_BASE_URL ?? '').trim();
  if (!secret || !baseUrl) return null;
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/api/internal/roadmap-projection?user_id=${encodeURIComponent(
      userId
    )}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${secret}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const projections =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>).projections
        : undefined;
    return Array.isArray(projections) ? projections : null;
  } catch {
    return null;
  }
}

/**
 * Build the list of week windows covering [rangeStart, rangeEnd]. Each window
 * starts on the configured week_start_dow. The first window starts at the most
 * recent week_start_dow boundary <= rangeStart; windows advance by 7 days until
 * the window start passes rangeEnd. Windows are clamped to the range for the
 * effective day-count facts but report their full canonical start/end too.
 */
function buildWeeks(
  rangeStart: string,
  rangeEnd: string,
  weekStartDow: number
): Array<{ week_start: string; week_end: string }> {
  const start = parseUtc(rangeStart);
  const end = parseUtc(rangeEnd);
  // Step back to the boundary <= start.
  let cursor = new Date(start.getTime());
  while (dowUtc(cursor) !== weekStartDow) {
    cursor = addDays(cursor, -1);
  }
  const weeks: Array<{ week_start: string; week_end: string }> = [];
  while (cursor.getTime() <= end.getTime()) {
    const weekEnd = addDays(cursor, 6);
    weeks.push({ week_start: fmtUtc(cursor), week_end: fmtUtc(weekEnd) });
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

// ── row types ─────────────────────────────────────────────────────────────────

interface SessionRow {
  id: number;
  date: string;
  day_type: string | null;
  duration_min: number | null;
  sleep_h: number | null;
  body_weight_kg: number | null;
  condition: string | null;
  notes_text: string | null;
}
interface DiffRow {
  date: string;
  day_type: string | null;
  exercise: string;
  exercise_id: number;
  planned_sets: number | null;
  reps_min: number | null;
  reps_max: number | null;
  planned_weight: unknown;
  done_weight: unknown;
  done_reps: number[] | null;
  done_total_reps: number | null;
  rpe: unknown;
  notes_text: string | null;
  linked_program_exercise_id: number | null;
}
interface WeightRow {
  date: string;
  weight_kg: unknown;
  notes: string | null;
}

// ── tool ──────────────────────────────────────────────────────────────────────

const getWeekBundleTool = defineTool({
  name: 'get_week_bundle',
  description:
    'Weekly review bundle for a date range: program + days, sessions, plan-vs-done ' +
    'exercise diff (with per-set facts), weight log, active nutrition target, ' +
    'nutrition_days aggregates, problems, previous reviews, and per-week derived ' +
    'aggregates. Emits FACTS only (no adherence verdicts).',
  inputSchema: z
    .object({
      range_start: dateStr,
      range_end: dateStr,
      week_start_dow: z.number().int().min(0).max(6).optional(),
    })
    .strict(),
  handler: async (input, ctx: ToolCtx) => {
    const db = ctx.db;
    const userId = ctx.userId;
    const { range_start: rangeStart, range_end: rangeEnd } = input;
    if (parseUtc(rangeStart).getTime() > parseUtc(rangeEnd).getTime()) {
      throw new ValidationError('range_start must be <= range_end', {
        range_start: rangeStart,
        range_end: rangeEnd,
      });
    }
    const weekStartDow = input.week_start_dow ?? 6; // Saturday by default
    const generatedAt = new Date().toISOString();
    // meta.today_utc = current UTC date as YYYY-MM-DD (not SQL CURRENT_DATE;
    // computed in JS to keep all date arithmetic UTC-consistent).
    const todayUtc = fmtUtc(new Date());

    // ── program (active) + days ─────────────────────────────────────────────────
    const program = await db.queryOne<{ id: number }>(
      `SELECT id, user_id, name, description, started_on, ended_on,
              philosophy_md_path, created_at
         FROM programs
         WHERE user_id = $1 AND ended_on IS NULL
         ORDER BY started_on DESC, id DESC
         LIMIT 1`,
      [userId]
    );
    const programId = program?.id ?? null;

    const programDays =
      programId !== null
        ? await db.query(
            `SELECT id, user_id, program_id, day_type, display_name, weekday, created_at
               FROM program_days
               WHERE user_id = $1 AND program_id = $2
               ORDER BY COALESCE(weekday, 99), day_type`,
            [userId, programId]
          )
        : [];

    // ── sessions in range ───────────────────────────────────────────────────────
    const sessions = await db.query<SessionRow>(
      `SELECT id, date, day_type, duration_min, sleep_h, body_weight_kg,
              condition, notes_text
         FROM sessions
         WHERE user_id = $1 AND date BETWEEN $2::date AND $3::date
         ORDER BY date, COALESCE(start_time, '00:00')`,
      [userId, rangeStart, rangeEnd]
    );

    // ── exercise_diff: plan vs done for each exercise in range ──────────────────
    const diffRows = await db.query<DiffRow>(
      `SELECT s.date, s.day_type,
              e.canonical_name AS exercise, se.exercise_id,
              pe.sets AS planned_sets, pe.reps_min, pe.reps_max,
              pe.current_weight_array AS planned_weight,
              se.weight_array AS done_weight,
              se.reps_array AS done_reps,
              se.total_reps AS done_total_reps,
              se.rpe, se.notes_text, se.linked_program_exercise_id
         FROM session_exercises se
         JOIN sessions s ON s.id = se.session_id AND s.user_id = se.user_id
         JOIN exercises e ON e.id = se.exercise_id
         LEFT JOIN program_exercises pe
           ON pe.id = se.linked_program_exercise_id AND pe.user_id = se.user_id
         WHERE se.user_id = $1 AND s.date BETWEEN $2::date AND $3::date
         ORDER BY s.date, se.order_num`,
      [userId, rangeStart, rangeEnd]
    );

    // Compute per-exercise facts (max-representative of arrays; no verdicts).
    const exerciseDiff = diffRows.map((r) => {
      const doneW = maxOrNull(numArr(r.done_weight));
      const plannedW = maxOrNull(numArr(r.planned_weight));
      const onPlan = r.linked_program_exercise_id !== null;
      const floor =
        onPlan && r.planned_sets !== null && r.reps_min !== null
          ? r.planned_sets * r.reps_min
          : null;
      const rpe = num(r.rpe);
      return {
        date: r.date,
        day_type: r.day_type,
        exercise: r.exercise,
        exercise_id: r.exercise_id,
        planned: {
          sets: r.planned_sets,
          reps_min: r.reps_min,
          reps_max: r.reps_max,
          planned_weight: numArr(r.planned_weight),
        },
        done: {
          done_weight: numArr(r.done_weight),
          done_reps: r.done_reps,
          done_total_reps: r.done_total_reps,
          rpe,
          notes_text: r.notes_text,
        },
        computed: {
          done_w: doneW,
          planned_w: plannedW,
          weight_delta_vs_plan_kg:
            onPlan && doneW !== null && plannedW !== null
              ? doneW - plannedW
              : null,
          reps_target_floor: floor,
        },
        facts: {
          off_plan: !onPlan,
          rpe_high: rpe !== null ? rpe >= 9 : false,
          weight_below_plan:
            onPlan && doneW !== null && plannedW !== null
              ? doneW < plannedW
              : false,
          weight_above_plan:
            onPlan && doneW !== null && plannedW !== null
              ? doneW > plannedW
              : false,
          miss_reps_significant:
            floor !== null && floor > 0 && r.done_total_reps !== null
              ? r.done_total_reps < floor
              : false,
        },
      };
    });

    // ── weight_log ──────────────────────────────────────────────────────────────
    // We fetch range + 7 days before so the per-week aggregates below can compute
    // each week's prev-week delta (weightByDate). The emitted `weight_log`,
    // however, emits ONLY the in-range rows
    // (date BETWEEN range_start AND range_end). After the oid-1082 parser fix
    // `r.date` is the raw `YYYY-MM-DD` string, so this string comparison is now
    // correct (previously `Date >= string` → NaN → every row dropped).
    const weightStart = fmtUtc(addDays(parseUtc(rangeStart), -7));
    const weightRows = await db.query<WeightRow>(
      `SELECT date, weight_kg, notes
         FROM weight_log
         WHERE user_id = $1 AND date BETWEEN $2::date AND $3::date
         ORDER BY date`,
      [userId, weightStart, rangeEnd]
    );
    const weightLog = weightRows
      .filter((r) => r.date >= rangeStart && r.date <= rangeEnd)
      .map((r) => ({ date: r.date, weight_kg: num(r.weight_kg), notes: r.notes }));

    // ── nutrition_target: phase active overlapping the range ────────────────────
    const nutritionTarget = await db.queryOne(
      `SELECT id, user_id, phase_name, started_on, ended_on,
              mon_target, tue_target, wed_target, thu_target,
              fri_target, sat_target, sun_target, notes, created_at
         FROM nutrition_targets
         WHERE user_id = $1
           AND started_on <= $3::date
           AND (ended_on IS NULL OR ended_on >= $2::date)
         ORDER BY started_on DESC LIMIT 1`,
      [userId, rangeStart, rangeEnd]
    );

    // ── nutrition_days: aggregate view across range ─────────────────────────────
    const nutritionDaysRows = await db.query<{
      date: string;
      kcal: unknown;
      protein_g: unknown;
      carbs_g: unknown;
      fat_g: unknown;
      entries_count: number | null;
    }>(
      `SELECT date, kcal, protein_g, carbs_g, fat_g, entries_count
         FROM nutrition_days
         WHERE user_id = $1 AND date BETWEEN $2::date AND $3::date
         ORDER BY date`,
      [userId, rangeStart, rangeEnd]
    );
    const nutritionDays = nutritionDaysRows.map((r) => ({
      date: r.date,
      kcal: num(r.kcal),
      protein_g: num(r.protein_g),
      carbs_g: num(r.carbs_g),
      fat_g: num(r.fat_g),
      entries_count: r.entries_count,
    }));

    // ── problems (open) ─────────────────────────────────────────────────────────
    const problems = await db.query(
      `SELECT id, title, status, severity, started_on, resolved_on,
              description, management, related_exercises
         FROM problems
         WHERE user_id = $1 AND status IN ('active','monitoring','chronic')
         ORDER BY severity DESC NULLS LAST, id`,
      [userId]
    );

    // ── prev_reviews (latest 3) ─────────────────────────────────────────────────
    const prevReviews = await db.query(
      `SELECT review_number, week_start, week_end, adherence_pct,
              sessions_done, sessions_planned, weight_avg_kg, weight_delta_kg,
              decisions_summary
         FROM weekly_reviews
         WHERE user_id = $1
         ORDER BY review_number DESC NULLS LAST, id DESC
         LIMIT 3`,
      [userId]
    );

    // ── goals (active) ───────────────────────────────────────────────────────────
    // user_id-scoped; status='active'.
    const goals = await db.query(
      `SELECT id, user_id, user_words, triage_class, mechanism_hypothesis,
              status, proxy_metric, proxy_target_value, proxy_target_date,
              created_at, updated_at
         FROM goals
         WHERE user_id = $1 AND status = 'active'
         ORDER BY created_at DESC, id DESC`,
      [userId]
    );

    // ── roadmap (current nutrition) ──────────────────────────────────────────────
    // Single row or null (domain='nutrition', valid_to IS NULL). user_id-scoped.
    const roadmap = await db.queryOne(
      `SELECT id, user_id, domain, goal_id, long_term_plan_id,
              horizon_start, horizon_target_date, timeline,
              valid_from, valid_to, created_at
         FROM roadmap
         WHERE user_id = $1 AND valid_to IS NULL AND domain = 'nutrition'
         LIMIT 1`,
      [userId]
    );

    // ── roadmap_projections via optional internal endpoint ───────────────────────
    // Calls the optional internal projection endpoint with a
    // bearer secret and parses `.projections` (must be an array). Graceful
    // fallback to null on ANY failure (missing secret / non-200 / non-JSON /
    // `.projections` absent or not an array). NEVER throws — must not fail the
    // whole bundle. `.projections=[]` stays `[]`.
    const roadmapProjections = await fetchRoadmapProjections(userId);

    // ── derived.weeks[]: per-week aggregates ────────────────────────────────────
    const weeks = buildWeeks(rangeStart, rangeEnd, weekStartDow);

    // sessions_planned = program_days rows with weekday assigned; else total rows.
    const daysWithWeekday = (programDays as Array<{ weekday: number | null }>).filter(
      (d) => d.weekday !== null
    ).length;
    const sessionsPlanned =
      daysWithWeekday > 0 ? daysWithWeekday : programDays.length;

    // weight averages by week (incl. prev-week from the extended window).
    const weightByDate = new Map<string, number>();
    for (const r of weightRows) {
      const w = num(r.weight_kg);
      if (w !== null) weightByDate.set(r.date, w);
    }
    function avgWeight(start: string, end: string): number | null {
      const vals: number[] = [];
      for (const [d, w] of weightByDate) {
        if (d >= start && d <= end) vals.push(w);
      }
      return vals.length === 0
        ? null
        : Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    }

    function avgKcal(rows: Array<{ kcal: number | null }>): number | null {
      const vals = rows
        .map((n) => n.kcal)
        .filter((x): x is number => x !== null);
      if (vals.length === 0) return null;
      return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }

    const derivedWeeks = weeks.map((wk) => {
      const inWk = (d: string) => d >= wk.week_start && d <= wk.week_end;
      const wkSessions = sessions.filter((s) => inWk(s.date));
      const wkSleeps = wkSessions
        .map((s) => num(s.sleep_h))
        .filter((x): x is number => x !== null);
      const wkNutrition = nutritionDays.filter((n) => inWk(n.date));
      const loggedDays = wkNutrition.filter(
        (n) => (n.entries_count ?? 0) > 0
      ).length;
      const wkWeightDays = [...weightByDate.keys()].filter(inWk).length;
      const avgCurr = avgWeight(wk.week_start, wk.week_end);
      const prevStart = fmtUtc(addDays(parseUtc(wk.week_start), -7));
      const prevEnd = fmtUtc(addDays(parseUtc(wk.week_end), -7));
      const avgPrev = avgWeight(prevStart, prevEnd);

      return {
        week_start: wk.week_start,
        week_end: wk.week_end,
        sessions_done: wkSessions.length,
        sessions_planned: sessionsPlanned,
        session_day_types: wkSessions.map((s) => s.day_type),
        avg_duration_min:
          wkSessions.length === 0
            ? null
            : Math.round(
                wkSessions
                  .map((s) => num(s.duration_min) ?? 0)
                  .reduce((a, b) => a + b, 0) / wkSessions.length
              ),
        sleep_avg_h:
          wkSleeps.length === 0
            ? null
            : Math.round(
                (wkSleeps.reduce((a, b) => a + b, 0) / wkSleeps.length) * 10
              ) / 10,
        weight_measurements: wkWeightDays,
        weight_avg_kg: avgCurr,
        weight_delta_kg:
          avgCurr !== null && avgPrev !== null
            ? Math.round((avgCurr - avgPrev) * 10) / 10
            : null,
        nutrition_days_logged: loggedDays,
        avg_kcal: avgKcal(wkNutrition),
      };
    });

    const meta = {
      user_id: userId,
      range_start: rangeStart,
      range_end: rangeEnd,
      week_start_dow: weekStartDow,
      program_id: programId,
      today_utc: todayUtc,
      generated_at: generatedAt,
    };

    return {
      meta,
      program,
      program_days: programDays,
      sessions,
      exercise_diff: exerciseDiff,
      weight_log: weightLog,
      nutrition_target: nutritionTarget,
      nutrition_days: nutritionDays,
      problems,
      prev_reviews: prevReviews,
      derived: { weeks: derivedWeeks },
      goals,
      roadmap,
      roadmap_projections: roadmapProjections,
    };
  },
});

/** Phase 1 week bundle tool (T004). */
export const readWeekBundleTools: AnyToolModule[] = [getWeekBundleTool];
