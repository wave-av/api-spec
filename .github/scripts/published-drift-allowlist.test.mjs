#!/usr/bin/env node
/**
 * published-drift-allowlist.test.mjs — the EXEMPTION LIFECYCLE, split out of published-drift.test.mjs.
 *
 * One responsibility: how an allowlist entry is granted, honored, and — the part that matters —
 * how it LAPSES. An exemption is the only way a finding in this gate can be silenced, so the rules
 * that keep one honest are worth testing as their own surface rather than as a section of the
 * comparison tests. published-drift.test.mjs keeps normalization, indexing and the CLI exit
 * contract; nothing is dropped in the move.
 *
 * Offline, deterministic, zero network. Run: node --test .github/scripts/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { allowlistStillApplies, compare, validateAllowlist } from './published-drift-compare.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The same minimal document helper the comparison tests use. */
const doc = (paths, version = '1.0.0') => ({ openapi: '3.1.0', info: { title: 't', version }, paths });

// ── Direction: undocumented-live, the security-relevant one. ────────────────────────────────────
const injectedPublicOp = {
  summary: 'LIVE inference funnel usage (registry-grounded, GROUP BY model, spend to 8 decimals)',
  tags: ['public'],
  responses: { 200: { description: 'ok' } },
};

test('an operation served live but absent from the spec is a security-relevant finding', () => {
  const r = compare({ repoDoc: doc({}), liveDoc: doc({ '/usage': { get: injectedPublicOp } }) });
  assert.equal(r.headline.undocumentedLive, 1);
  assert.equal(r.findings[0].severity, 'security-relevant');
  assert.equal(r.findings[0].method, 'GET');
  assert.equal(r.findings[0].path, '/usage');
});

test('an allowlist entry suppresses it — and LAPSES the moment the operation gains auth', () => {
  const allowlist = [
    {
      path: '/usage',
      method: 'GET',
      direction: 'undocumented-live',
      justification: 'Gateway-native public root surface, exempt only while it stays unauthenticated.',
      expect: { 'tags.0': 'public' },
      expectAbsent: ['security'],
    },
  ];
  const clean = compare({ repoDoc: doc({}), liveDoc: doc({ '/usage': { get: injectedPublicOp } }), allowlist });
  assert.equal(clean.headline.undocumentedLive, 0);
  assert.equal(clean.headline.allowlisted, 1);

  const behindAuth = { ...injectedPublicOp, security: [{ bearerWithScopes: ['usage:read'] }] };
  const lapsed = compare({ repoDoc: doc({}), liveDoc: doc({ '/usage': { get: behindAuth } }), allowlist });
  assert.equal(lapsed.headline.undocumentedLive, 1, 'the exemption was granted for the unauthenticated shape only');
  assert.equal(lapsed.headline.lapsedAllowlistEntries, 1);
});

test('an allowlist entry does not leak across directions', () => {
  const allowlist = [
    { path: '/x', method: 'POST', direction: 'unpublished-repo', justification: 'A justification long enough to pass.', expect: {} },
  ];
  const r = compare({ repoDoc: doc({}), liveDoc: doc({ '/x': { post: { responses: {} } } }), allowlist });
  assert.equal(r.headline.undocumentedLive, 1, 'an unpublished-repo exemption must not silence an undocumented-live finding');
});

test('a null expectation matches an absent key as well as a literal null', () => {
  assert.equal(allowlistStillApplies({ expect: { security: null } }, { tags: ['public'] }), true);
  assert.equal(allowlistStillApplies({ expect: { security: null } }, { security: null }), true);
  assert.equal(allowlistStillApplies({ expect: { security: null } }, { security: [] }), false);
});

// ── Allowlist hygiene. ──────────────────────────────────────────────────────────────────────────
test('validateAllowlist rejects the ways an exemption goes bad', () => {
  const ok = {
    path: '/a',
    method: 'GET',
    direction: 'undocumented-live',
    justification: 'A justification long enough.',
    expectAbsent: ['security'],
  };
  assert.equal(validateAllowlist([ok]), null);
  assert.match(validateAllowlist({}), /not an array/);
  assert.match(validateAllowlist([{ ...ok, justification: 'too short' }]), /needs a real justification/);
  assert.match(validateAllowlist([{ ...ok, direction: 'whatever' }]), /unknown direction/);
  assert.match(validateAllowlist([ok, ok]), /duplicate allowlist entry/);
});

test('a live-direction exemption without a predicate is rejected — it could never lapse', () => {
  // The file header promises "a justification AND a live predicate". Before this, only the
  // justification was enforced: a predicate-free entry validated, then allowlistStillApplies
  // returned true on a path+method match alone, and the exemption outlived its own reasoning.
  const bare = { path: '/a', method: 'GET', direction: 'undocumented-live', justification: 'A justification long enough.' };
  assert.match(validateAllowlist([bare]), /needs an expect or expectAbsent predicate/);
  assert.match(validateAllowlist([{ ...bare, expect: {}, expectAbsent: [] }]), /needs an expect or expectAbsent predicate/);
  assert.equal(validateAllowlist([{ ...bare, expect: { 'tags.0': 'public' } }]), null);
  assert.equal(validateAllowlist([{ ...bare, expectAbsent: ['security'] }]), null);
  // shared-drift also has a live operation, so the same requirement applies.
  assert.match(validateAllowlist([{ ...bare, direction: 'shared-drift' }]), /needs an expect or expectAbsent predicate/);
});

test('an unpublished-repo exemption is rejected for CARRYING a predicate — there is nothing to evaluate it against', () => {
  // The mirror image of the rule above. unpublished-repo means "declared here, not served", so
  // there is no live operation; a predicate there can never be true and the entry, though it
  // validates, would silently never apply.
  const entry = { path: '/a', method: 'GET', direction: 'unpublished-repo', justification: 'A justification long enough.' };
  assert.equal(validateAllowlist([entry]), null);
  assert.match(validateAllowlist([{ ...entry, expect: { 'tags.0': 'public' } }]), /cannot carry a predicate/);
  assert.match(validateAllowlist([{ ...entry, expectAbsent: ['security'] }]), /cannot carry a predicate/);
});

test('an unpublished-repo exemption is HONORED, and is not reported with a live-operation reason', () => {
  // `record` passes null as liveOp for this direction, so allowlistStillApplies used to return
  // false for every entry: the direction was configurable but inert, and the entry landed in both
  // lapsedAllowlist and findings with a reason that named a live operation that never existed.
  const allowlist = [
    { path: '/legacy', method: 'POST', direction: 'unpublished-repo', justification: 'A justification long enough to pass.' },
  ];
  const repoDoc = doc({ '/legacy': { post: { responses: {} } } });
  const r = compare({ repoDoc, liveDoc: doc({ '/other': { get: { responses: {} } } }), allowlist });
  assert.equal(r.headline.unpublishedRepo, 0, 'a predicate-free unpublished-repo exemption must be honored');
  assert.equal(r.headline.allowlisted, 1);
  assert.equal(r.headline.lapsedAllowlistEntries, 0);

  // An entry that DOES state a predicate cannot be graded, so it lapses — with an accurate reason.
  const withPredicate = [{ ...allowlist[0], expectAbsent: ['security'] }];
  const lapsed = compare({ repoDoc, liveDoc: doc({ '/other': { get: { responses: {} } } }), allowlist: withPredicate });
  assert.equal(lapsed.headline.unpublishedRepo, 1);
  assert.match(lapsed.lapsedAllowlist[0].reason, /no live operation/);
  assert.doesNotMatch(lapsed.lapsedAllowlist[0].reason, /no longer matches/);
});

test('document-level security counts as the operation gaining auth', () => {
  // THE LIVE CASE, measured against https://api.wave.online/openapi.json on 2026-09-04: the
  // published document carries a root `security`, and GET /leaderboard has no `security` key of
  // its own. Reading only the operation object called it unauthenticated and kept the exemption
  // alive; OpenAPI says a document-level `security` is the default for exactly such an operation,
  // so it is authenticated and the exemption — granted for the unauthenticated shape — must lapse.
  const entry = {
    path: '/leaderboard',
    method: 'GET',
    direction: 'undocumented-live',
    justification: 'Public unauthenticated root surface; exempt only while it stays unauthenticated.',
    expectAbsent: ['security'],
  };
  const op = { tags: ['public'], responses: {} };
  const openDoc = doc({ '/leaderboard': { get: op } });
  assert.equal(allowlistStillApplies(entry, op, openDoc), true, 'no auth anywhere: the exemption holds');

  const rootAuth = { ...openDoc, security: [{ BearerAuth: [] }] };
  assert.equal(allowlistStillApplies(entry, op, rootAuth), false, 'document-level auth must lapse it');

  // And end to end, which is what the gate actually runs.
  const r = compare({ repoDoc: doc({}), liveDoc: rootAuth, allowlist: [entry] });
  assert.equal(r.headline.undocumentedLive, 1, 'the operation is authenticated now, so it is a finding');
  assert.equal(r.headline.lapsedAllowlistEntries, 1);

  // An operation with its OWN security still wins over the document default, in both directions.
  const ownAuth = doc({ '/leaderboard': { get: { ...op, security: [{ bearerWithScopes: [] }] } } });
  assert.equal(allowlistStillApplies(entry, ownAuth.paths['/leaderboard'].get, ownAuth), false);
  const explicitlyOpen = { ...rootAuth, paths: { '/leaderboard': { get: { ...op, security: [] } } } };
  assert.equal(
    allowlistStillApplies({ ...entry, expectAbsent: [], expect: { security: [] } }, explicitlyOpen.paths['/leaderboard'].get, explicitlyOpen),
    true,
    'an operation that opts out with an empty security array is not inheriting the document default',
  );
});

test('an allowlist entry that matches no operation is surfaced, not silently ignored', () => {
  // allowByKey is only ever consulted from `record`, so an entry whose operation is no longer
  // served — or which openapi.yaml now documents — was never looked up and never counted. It
  // appeared in neither `allowlisted` nor `lapsedAllowlistEntries`, so it read as "no allowlist
  // problem" forever.
  const allowlist = [
    {
      path: '/gone',
      method: 'GET',
      direction: 'undocumented-live',
      justification: 'A justification long enough to pass validation.',
      expectAbsent: ['security'],
    },
  ];
  const r = compare({ repoDoc: doc({}), liveDoc: doc({ '/still-here': { get: { responses: {} } } }), allowlist });
  assert.equal(r.headline.unmatchedAllowlistEntries, 1);
  assert.deepEqual(
    r.unmatchedAllowlist.map((e) => e.key),
    ['undocumented-live GET /gone'],
  );
  // It is stale bookkeeping, not drift: surfacing it must not manufacture a finding.
  assert.equal(r.findings.some((f) => f.path === '/gone'), false);

  // A matched entry is not reported as unmatched.
  const matched = compare({
    repoDoc: doc({}),
    liveDoc: doc({ '/gone': { get: { responses: {} } } }),
    allowlist,
  });
  assert.equal(matched.headline.unmatchedAllowlistEntries, 0);
  assert.equal(matched.headline.allowlisted, 1);
});

test('the COMMITTED allowlist is well-formed and every entry has a predicate that can actually lapse', () => {
  const committed = JSON.parse(readFileSync(join(__dirname, 'published-drift-allowlist.json'), 'utf8'));
  assert.equal(validateAllowlist(committed), null);
  for (const e of committed) {
    const hasPredicate = Object.keys(e.expect ?? {}).length > 0 || (e.expectAbsent ?? []).length > 0;
    if (e.direction === 'unpublished-repo') {
      // No live operation ever exists for this direction, so a predicate could never be graded —
      // validateAllowlist itself rejects one here. The entry lapses instead when the key stops
      // matching at all (surfaced as an unmatchedAllowlistEntries warning, not silently).
      assert.ok(!hasPredicate, `${e.method} ${e.path}: unpublished-repo cannot carry a predicate`);
    } else {
      assert.ok(
        ['undocumented-live', 'shared-drift'].includes(e.direction),
        `${e.method} ${e.path}: only a direction with a live operation to grade a predicate against belongs here`,
      );
      assert.ok(hasPredicate, `${e.method} ${e.path}: an exemption without a predicate cannot lapse`);
    }
    assert.ok(
      typeof e.justification === 'string' && e.justification.length >= 40,
      `${e.method} ${e.path}: justification must actually explain the exemption, not just satisfy the length floor`,
    );
  }
});

