/**
 * query_tokens.test.ts — unit tests for shared fuzzy-search tokenizer.
 *
 * Run: npm test  (node --test --import tsx)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenizeQuery, escapeLike } from '../lib/query_tokens.js';

test('tokenizeQuery strips stopwords, number+unit tokens, keeps content words', () => {
  assert.deepEqual(
    tokenizeQuery('uno shaker con 150ml di latte e 40g di proteine'),
    ['shaker', 'latte', 'proteine']
  );
});

test('tokenizeQuery unaccents lowercase Italian characters', () => {
  assert.deepEqual(tokenizeQuery('Caffè ristretto'), ['caffe', 'ristretto']);
});

test('tokenizeQuery drops number+percent tokens like "0%"', () => {
  assert.deepEqual(tokenizeQuery('yogurt 0%'), ['yogurt']);
});

test('tokenizeQuery discards tokens shorter than 2 chars', () => {
  assert.deepEqual(tokenizeQuery('a'), []);
});

test('tokenizeQuery returns [] for empty string', () => {
  assert.deepEqual(tokenizeQuery(''), []);
});

test('tokenizeQuery returns [] when input is only stopwords', () => {
  assert.deepEqual(tokenizeQuery('di con e per la'), []);
});

test('tokenizeQuery returns [] when input is only numeric+unit tokens', () => {
  assert.deepEqual(tokenizeQuery('100g 200ml 5kcal'), []);
});

test('escapeLike escapes %, _ and backslash for ILIKE patterns', () => {
  assert.equal(escapeLike('50%_off'), '50\\%\\_off');
  assert.equal(escapeLike('a\\b'), 'a\\\\b');
  assert.equal(escapeLike('plain'), 'plain');
});
