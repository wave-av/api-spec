#!/usr/bin/env node
/**
 * published-drift-freshness.test.mjs — offline, deterministic, zero network.
 *
 * Its own file rather than more tests in published-drift.test.mjs, because it has its own subject:
 * that file tests the COMPARISON against the published contract, this one tests whether the
 * COMMITTED receipt still describes the spec beside it. Different module, different question.
 *
 * The load-bearing test here is the operation SWAP: two specs with identical version, identical
 * path count and identical operation count, differing only in WHICH operations they declare. A
 * freshness check built on the headline numbers alone would call that fresh. It is the one case
 * that proves the digest is doing real work.
 *
 * Run: node --test .github/scripts/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { compare } from './published-drift-compare.mjs';
import { DIGEST_FIELD, EXIT_UNKNOWN, checkFreshness, main, parseArgs, repoFacts } from './published-drift-freshness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const doc = (paths, version = '1.0.0') => ({ openapi: '3.1.0', info: { title: 't', version }, paths });

/** A receipt carrying exactly the repo-side facts the given spec actually has. */
const receiptFor = (spec, over = {}) => {
  const f = repoFacts(spec);
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    sources: { repoSpec: 'openapi.yaml', [DIGEST_FIELD]: f.digest },
    headline: { repoVersion: f.version, repoPaths: f.paths, repoOperations: f.operations },
    ...over,
  };
};

// ── The facts this check recomputes must be the same facts the report publishes. ────────────────
test('repoFacts counts agree with the headline compare() publishes, so the two cannot diverge', () => {
  const spec = doc({ '/a': { get: {}, post: {} }, '/b': { get: { 'x-schema-status': 'draft' } } }, '9.9.9');
  const facts = repoFacts(spec);
  const { headline } = compare({ repoDoc: spec, liveDoc: doc({}), allowlist: [] });
  assert.equal(facts.version, headline.repoVersion);
  assert.equal(facts.paths, headline.repoPaths);
  assert.equal(facts.operations, headline.repoOperations);
});

test('a receipt generated from the same spec reads FRESH', () => {
  const spec = doc({ '/a': { get: {} } });
  assert.deepEqual(checkFreshness(spec, receiptFor(spec)), { status: 'fresh', reasons: [] });
});

// ── The load-bearing case. ──────────────────────────────────────────────────────────────────────
test('swapping one operation for another keeps every count identical and is STILL caught', () => {
  const before = doc({ '/a': { get: {} }, '/b': { get: {} } });
  const after = doc({ '/a': { get: {} }, '/c': { get: {} } });

  const bf = repoFacts(before);
  const af = repoFacts(after);
  assert.equal(bf.version, af.version);
  assert.equal(bf.paths, af.paths, 'the fixture must keep path counts equal or it proves nothing');
  assert.equal(bf.operations, af.operations, 'the fixture must keep operation counts equal or it proves nothing');
  assert.notEqual(bf.digest, af.digest);

  const verdict = checkFreshness(after, receiptFor(before));
  assert.equal(verdict.status, 'stale');
  assert.equal(verdict.reasons.length, 1, 'every count agrees, so the digest must be the SOLE reason');
  assert.match(verdict.reasons[0], /operation digest/);
});

test('promoting an operation out of draft is caught, because draft status decides its classification', () => {
  // published-drift-compare.mjs suppresses an unpublished-repo operation ONLY while it is draft.
  // Flipping that bit changes the report's verdict without changing any count, so the digest has
  // to cover it or a promoted operation would be misreported by a receipt that still looks current.
  const draft = doc({ '/a': { get: { 'x-schema-status': 'draft' } } });
  const promoted = doc({ '/a': { get: {} } });
  assert.notEqual(repoFacts(draft).digest, repoFacts(promoted).digest);
  assert.equal(checkFreshness(promoted, receiptFor(draft)).status, 'stale');
});

test('an added operation, a removed one, and a bumped version each read STALE', () => {
  const spec = doc({ '/a': { get: {} }, '/b': { get: {} } });
  const receipt = receiptFor(spec);
  assert.equal(checkFreshness(doc({ '/a': { get: {} }, '/b': { get: {} }, '/c': { get: {} } }), receipt).status, 'stale');
  assert.equal(checkFreshness(doc({ '/a': { get: {} } }), receipt).status, 'stale');
  assert.equal(checkFreshness(doc({ '/a': { get: {} }, '/b': { get: {} } }, '2.0.0'), receipt).status, 'stale');
});

// ── Exit contract: a receipt that cannot be graded is NEVER a pass. ─────────────────────────────
test('an ungradable receipt is UNKNOWN, never FRESH', () => {
  const spec = doc({ '/a': { get: {} } });
  const noDigest = receiptFor(spec);
  delete noDigest.sources[DIGEST_FIELD];
  // The bootstrap case: a receipt written before this check existed. UNKNOWN, not FRESH — claiming
  // freshness for a receipt with nothing to compare against is the exact false pass this avoids.
  assert.equal(checkFreshness(spec, noDigest).status, 'unknown');
  assert.equal(checkFreshness(spec, { ...receiptFor(spec), headline: undefined }).status, 'unknown');
  assert.equal(checkFreshness(spec, null).status, 'unknown');
  assert.equal(checkFreshness(spec, []).status, 'unknown');
});

test('a digest that is not a digest is UNKNOWN, not STALE', () => {
  // STALE and UNKNOWN are different claims that drive different CI behaviour: STALE (exit 2) files
  // the routine staleness issue and tells the reader the spec moved; UNKNOWN (exit 1) goes red and
  // files nothing. A malformed digest is the second — the receipt cannot be graded, which says
  // nothing about whether the spec moved. Any non-empty string used to sail through the check and
  // fail the equality test below it, so a merge marker or a truncated paste was reported as STALE.
  const spec = doc({ '/a': { get: {} } });
  for (const bad of ['invalid', '', '   ', 'TODO', 'a'.repeat(63), 'a'.repeat(65), `${'A'.repeat(64)}`, '<<<<<<< HEAD']) {
    const receipt = receiptFor(spec);
    receipt.sources[DIGEST_FIELD] = bad;
    assert.equal(checkFreshness(spec, receipt).status, 'unknown', `${JSON.stringify(bad)} is not a gradable digest`);
  }
  // A well-formed digest that simply disagrees is still STALE — this narrows the gate, it does not
  // blunt it.
  const wrongButWellFormed = receiptFor(spec);
  wrongButWellFormed.sources[DIGEST_FIELD] = 'b'.repeat(64);
  assert.equal(checkFreshness(spec, wrongButWellFormed).status, 'stale');
  assert.equal(checkFreshness(spec, receiptFor(spec)).status, 'fresh');
});

test('--receipt with no value is a usage error, not a misleading read error', () => {
  // It used to set args.receipt = undefined, reach readFileSync, and surface as
  // "could not read/parse undefined" — sending the reader after a missing file, not a missing arg.
  assert.match(parseArgs(['--receipt']).error, /--receipt needs a value \(got nothing\)/);
  assert.match(parseArgs(['openapi.yaml', '--receipt']).error, /--receipt needs a value/);
  const ok = parseArgs(['openapi.yaml', '--receipt', 'contract-drift.json']);
  assert.equal(ok.error, null);
  assert.deepEqual({ spec: ok.spec, receipt: ok.receipt }, { spec: 'openapi.yaml', receipt: 'contract-drift.json' });
  assert.equal(parseArgs([]).receipt, 'contract-drift.json', 'the default receipt still applies');
});

test('main() exits UNKNOWN on an unreadable spec or receipt, never FRESH', async () => {
  assert.equal(await main(['/nonexistent/openapi.yaml', '--receipt', '/nonexistent/r.json']), EXIT_UNKNOWN);
  assert.equal(await main([join(REPO_ROOT, 'openapi.yaml'), '--receipt', '/nonexistent/r.json']), EXIT_UNKNOWN);
  assert.equal(await main(['--receipt']), EXIT_UNKNOWN, 'a usage error is UNKNOWN, never a verdict');
});

// ── The shipped artifact itself is the subject. ─────────────────────────────────────────────────
test('the COMMITTED contract-drift.json is a gradable receipt for the COMMITTED openapi.yaml', async () => {
  // Asserts the receipt is well-formed and carries a digest — deliberately NOT that it is current.
  // Clearing a stale verdict needs a networked regeneration, and requiring that on the
  // pull-request path is exactly the coupling published-contract-drift.yml refuses to reintroduce.
  // Currency is the freshness job's call: advisory on a PR, red on the schedule.
  const yaml = await import('js-yaml');
  const spec = (yaml.default ?? yaml).load(readFileSync(join(REPO_ROOT, 'openapi.yaml'), 'utf8'));
  const receipt = JSON.parse(readFileSync(join(REPO_ROOT, 'contract-drift.json'), 'utf8'));
  assert.match(receipt.sources?.[DIGEST_FIELD] ?? '', /^[0-9a-f]{64}$/, 'the digest must be a sha256 hex string');
  assert.notEqual(checkFreshness(spec, receipt).status, 'unknown', 'the committed receipt must at least be gradable');
});
