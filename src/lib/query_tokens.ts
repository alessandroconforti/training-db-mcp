/**
 * query_tokens.ts — shared tokenization helpers for fuzzy food lookup pipelines.
 *
 * Used by foods_resolve / foods_search / foods_list_user_recipes to normalize
 * user queries into a stable token bag suitable for trigram / ILIKE matching.
 *
 * No external dependencies — Node stdlib only.
 */

/**
 * Trigram similarity threshold for Strategy B fuzzy fallback. Applied inside
 * the WHERE clause (not via `set_limit()`) so it does not leak into other
 * queries sharing the same pg session.
 */
export const TRIGRAM_THRESHOLD = 0.25;

// Italian stopwords (lowercase, unaccented). Kept minimal: common articles,
// prepositions and conjunctions that add no discriminative power for food
// search. Extend conservatively — every word added here is invisible to search.
const STOPWORDS = new Set<string>([
  'con',
  'di',
  'e',
  'da',
  'del',
  'della',
  'al',
  'alla',
  'su',
  'in',
  'per',
  'un',
  'uno',
  'una',
  'il',
  'la',
  'lo',
  'gli',
  'le',
  'i',
  'dei',
  'delle',
]);

// Matches purely numeric tokens, optionally followed by a common unit.
// Examples that match: "100", "150g", "2.5kg", "5%", "200ml", "3x", "12oz".
const NUMBER_UNIT_RE = /^\d+(\.\d+)?(g|ml|kg|l|kcal|x|%|cl|oz|lb)?$/;

// Combining diacritical marks range used to strip accents after NFD
// normalization. Hard-coded as a unicode range so we don't depend on a regex
// flag that may not be enabled in older toolchains.
const DIACRITICS_RE = /[̀-ͯ]/g;

/**
 * Tokenize and normalize a free-text query into a stable token list.
 *
 * Pipeline: lowercase → unaccent → split on whitespace → drop stopwords,
 * pure number+unit tokens, and anything shorter than 2 chars.
 */
export function tokenizeQuery(query: string): string[] {
  if (!query) return [];

  const normalized = query
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS_RE, '');

  const raw = normalized.split(/\s+/);

  const out: string[] = [];
  for (const tok of raw) {
    if (!tok) continue;
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    if (NUMBER_UNIT_RE.test(tok)) continue;
    out.push(tok);
  }
  return out;
}

/**
 * Escape a string for safe use inside an ILIKE / LIKE pattern.
 *
 * Escapes backslash, percent and underscore so the caller can splice user
 * input into a pattern such as `%${escapeLike(input)}%` without leaking
 * wildcards. The caller is responsible for adding the surrounding `%`.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

/**
 * Build a parametrized SQL WHERE fragment that matches every token against
 * `canonical_name` AND `aliases` (both unaccented + lowercased). Tokens are
 * AND-ed together; for each token, canonical_name OR aliases (EXISTS unnest)
 * must contain the token substring.
 *
 * Returns the SQL fragment plus the matching `$N` parameter values, with
 * placeholder indices starting at `startIdx`. Caller is responsible for
 * appending the param values to its own params array in order.
 *
 * Example with startIdx=2, tokens=["shaker","proteico"]:
 *   sql = "((immutable_unaccent(lower(canonical_name)) ILIKE $2 OR EXISTS (...))
 *           AND (immutable_unaccent(lower(canonical_name)) ILIKE $3 OR EXISTS (...)))"
 *   params = ["%shaker%", "%proteico%"]
 */
export function buildTokenAndWhere(
  tokens: string[],
  startIdx: number
): { sql: string; params: string[] } {
  if (tokens.length === 0) return { sql: '', params: [] };
  const params: string[] = [];
  const clauses: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const idx = startIdx + i;
    clauses.push(
      `(immutable_unaccent(lower(canonical_name)) ILIKE $${idx}` +
        ` OR EXISTS (SELECT 1 FROM unnest(COALESCE(aliases, ARRAY[]::text[])) a` +
        ` WHERE immutable_unaccent(lower(a)) ILIKE $${idx}))`
    );
    params.push(`%${escapeLike(tokens[i])}%`);
  }
  return { sql: `(${clauses.join(' AND ')})`, params };
}
