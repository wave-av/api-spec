#!/usr/bin/env node
/**
 * published-drift.test.mjs — offline, deterministic, zero network.
 *
 * Every fixture here is hand-built rather than a checked-in copy of the two real documents: the
 * live contract is 242 KB and openapi.yaml is 447 KB, and a snapshot of either would be stale the
 * day it landed while telling us nothing a small fixture cannot. What the fixtures DO encode is the
 * exact enrichment observed in the published document, so the normalizer is tested against the
 * shape it actually has to undo.
 *
 * Run: node --test .github/scripts/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ERROR_SCHEMA,
  INJECTED_ERROR_CODES,
  VERSIONING,
  normalizePair,
  synthesizeOperationId,
} from './published-drift-normalize.mjs';
import { allowlistStillApplies, compare, diffOperation, indexOperations, validateAllowlist } from './published-drift-compare.mjs';
import { EXIT_DRIFT, EXIT_OK, EXIT_UNKNOWN, fetchPublished, main } from './published-drift.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/** Apply the serve-time enrichment to an operation exactly as the published document shows it. */
function enrich(op, path, method) {
  const out = structuredClone(op);
  if (!out.operationId) out.operationId = synthesizeOperationId(path, method);
  out.responses ??= {};
  if (out.responses['200'] && !out.responses['200'].content) {
    out.responses['200'] = {
      description: out.responses['200'].description || 'Success',
      content: { 'application/json': { schema: { type: 'object' } } },
    };
  }
  for (const code of INJECTED_ERROR_CODES) {
    out.responses[code] ??= { description: `${code} error`, content: { 'application/json': { schema: ERROR_SCHEMA } } };
  }
  Object.assign(out, VERSIONING);
  return out;
}

const doc = (paths, version = '1.0.0') => ({ openapi: '3.1.0', info: { title: 't', version }, paths });

// ── The load-bearing test: the normalizer has to earn its place. ────────────────────────────────
test('an enriched-but-otherwise-identical operation is drift WITHOUT normalization and clean WITH it', () => {
  const repoOp = {
    summary: 'Render a brief',
    description: 'POST a typed Brief. Unpaid requests answer 402 with an x402 challenge.',
    responses: { 200: { description: 'Accepted' } },
  };
  const repoDoc = doc({ '/render': { post: repoOp } });
  const liveDoc = doc({ '/render': { post: enrich(repoOp, '/render', 'post') } });

  const naive = compare({ repoDoc, liveDoc, normalize: false });
  assert.equal(naive.headline.sharedDrift, 1, 'without normalization the gateway enrichment reads as drift');
  assert.deepEqual(
    naive.findings[0].differences.map((d) => d.field).sort(),
    ['description', 'operationId', 'responses', 'x-deprecation-policy', 'x-version'],
    'all five enrichments read as differences when nothing is normalized',
  );

  const normalized = compare({ repoDoc, liveDoc });
  assert.equal(normalized.headline.sharedDrift, 0, 'with normalization the same pair is clean');
  assert.equal(normalized.enrichmentObservations.errorResponsesInjected, INJECTED_ERROR_CODES.length);
  assert.equal(normalized.enrichmentObservations.operationIdsSynthesized, 1);
  assert.deepEqual(normalized.enrichmentObservations.descriptionsOverwritten, ['POST /render']);
});

test('normalization scales: every enriched operation is stripped, none reported', () => {
  const paths = {};
  for (let i = 0; i < 40; i++) paths[`/p${i}`] = { post: { summary: `op ${i}`, responses: { 200: { description: 'ok' } } } };
  const repoDoc = doc(paths);
  const liveDoc = doc(Object.fromEntries(Object.entries(paths).map(([p, item]) => [p, { post: enrich(item.post, p, 'post') }])));
  assert.equal(compare({ repoDoc, liveDoc, normalize: false }).headline.sharedDrift, 40);
  assert.equal(compare({ repoDoc, liveDoc }).headline.sharedDrift, 0);
});

// ── Exact-shape stripping: the normalizer must not go blind in the fields it touches. ───────────
test('a 404 that is NOT the injected envelope survives normalization and surfaces as drift', () => {
  const repoOp = { summary: 's' };
  const liveOp = enrich(repoOp, '/x', 'get');
  liveOp.responses['404'] = { description: 'Video not found', content: { 'application/json': { schema: { type: 'string' } } } };
  const { repo, live } = normalizePair(repoOp, liveOp, '/x', 'get');
  const fields = diffOperation(repo, live).map((d) => d.field);
  assert.deepEqual(fields, ['responses'], 'a hand-written 404 is real content, not enrichment');
});

test('a hand-set operationId that differs from the synthesis is never stripped', () => {
  const repoOp = { summary: 's', responses: {} };
  const liveOp = enrich(repoOp, '/x', 'get');
  liveOp.operationId = 'aDeliberatelyDifferentId';
  const { repo, live } = normalizePair(repoOp, liveOp, '/x', 'get');
  assert.deepEqual(diffOperation(repo, live).map((d) => d.field), ['operationId']);
});

test('operationId synthesis is a faithful port of the gateway formula', () => {
  assert.equal(synthesizeOperationId('/videos/{videoId}/chapters', 'get'), 'getVideosVideoIdChapters');
  assert.equal(synthesizeOperationId('/render', 'post'), 'postRender');
});

test('a real description overwritten by the versioning boilerplate is COUNTED, not silently dropped', () => {
  const repoOp = { description: 'The real, hand-written description.', responses: {} };
  const liveDoc = doc({ '/x': { get: enrich(repoOp, '/x', 'get') } });
  const r = compare({ repoDoc: doc({ '/x': { get: repoOp } }), liveDoc });
  assert.equal(r.headline.sharedDrift, 0, 'not counted as drift — it is a defect in the publishing service');
  assert.deepEqual(r.enrichmentObservations.descriptionsOverwritten, ['GET /x'], 'but it is reported');
});

// ── Direction: unpublished-repo, and the draft rule that gates it. ──────────────────────────────
test('a draft repo-only operation is suppressed; promoting it out of draft makes it a finding', () => {
  const draft = { 'x-schema-status': 'draft', 'x-price': { model: 'x402' }, responses: {} };
  const liveDoc = doc({ '/known': { get: { responses: {} } } });

  const withDraft = compare({ repoDoc: doc({ '/known': { get: { responses: {} } }, '/new': { post: draft } }), liveDoc });
  assert.equal(withDraft.headline.unpublishedRepo, 0);
  assert.equal(withDraft.headline.draftNotYetPublished, 1);
  assert.equal(withDraft.draftNotYetPublished[0].xPriceModel, 'x402');

  const { 'x-schema-status': _dropped, ...promoted } = draft;
  const afterPromotion = compare({ repoDoc: doc({ '/known': { get: { responses: {} } }, '/new': { post: promoted } }), liveDoc });
  assert.equal(afterPromotion.headline.unpublishedRepo, 1, 'promotion without publication is exactly the drift this gate exists for');
  assert.equal(afterPromotion.findings[0].severity, 'contract-ahead');
});

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
  const ok = { path: '/a', method: 'GET', direction: 'undocumented-live', justification: 'A justification long enough.' };
  assert.equal(validateAllowlist([ok]), null);
  assert.match(validateAllowlist({}), /not an array/);
  assert.match(validateAllowlist([{ ...ok, justification: 'too short' }]), /needs a real justification/);
  assert.match(validateAllowlist([{ ...ok, direction: 'whatever' }]), /unknown direction/);
  assert.match(validateAllowlist([ok, ok]), /duplicate allowlist entry/);
});

test('the COMMITTED allowlist is well-formed and every entry is a live-direction exemption with a predicate', () => {
  const committed = JSON.parse(readFileSync(join(__dirname, 'published-drift-allowlist.json'), 'utf8'));
  assert.equal(validateAllowlist(committed), null);
  for (const e of committed) {
    assert.equal(e.direction, 'undocumented-live', `${e.method} ${e.path}: only live surface should ever need an exemption`);
    assert.ok(Object.keys(e.expect ?? {}).length > 0, `${e.method} ${e.path}: an exemption without a predicate cannot lapse`);
    assert.ok(e.expectAbsent?.includes('security'), `${e.method} ${e.path}: must lapse when the route gains auth`);
  }
});

// ── Index and path-item handling. ───────────────────────────────────────────────────────────────
test('indexOperations skips path-item metadata and counts only real operations', () => {
  const ops = indexOperations(doc({ '/a': { get: {}, post: {}, parameters: [{ name: 'x' }], summary: 'shared', $ref: '#/x' } }));
  assert.deepEqual([...ops.keys()].sort(), ['GET /a', 'POST /a']);
});

// ── Exit contract: a broken read is NEVER "no drift". ───────────────────────────────────────────
test('fetchPublished reports a failure rather than throwing or defaulting', async () => {
  const boom = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.deepEqual(await fetchPublished('https://example.invalid/x', boom), {
    ok: false,
    error: 'https://example.invalid/x: ECONNREFUSED',
  });
  const notOk = async () => ({ ok: false, status: 503 });
  assert.match((await fetchPublished('https://example.invalid/x', notOk)).error, /HTTP 503/);
});

test('an unreadable snapshot exits UNKNOWN, never OK', async () => {
  assert.equal(await main([join(REPO_ROOT, 'openapi.yaml'), '--live', '/nonexistent/live.json']), EXIT_UNKNOWN);
});

test('an unreadable spec exits UNKNOWN, never OK', async () => {
  assert.equal(await main(['/nonexistent/openapi.yaml', '--live', '/nonexistent/live.json']), EXIT_UNKNOWN);
});

test('a published contract with zero operations exits UNKNOWN, never OK', async () => {
  // The dangerous failure is a gateway that answers 200 with an empty or truncated document:
  // every repo operation would look "unpublished" and, with all of them draft-suppressed, the run
  // would report a clean contract. Refusing to grade an empty document is what stops that.
  const { writeFileSync, rmSync } = await import('node:fs');
  const snapshot = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-empty-${process.pid}.json`);
  writeFileSync(snapshot, JSON.stringify(doc({})));
  try {
    assert.equal(await main([join(REPO_ROOT, 'openapi.yaml'), '--live', snapshot]), EXIT_UNKNOWN);
  } finally {
    rmSync(snapshot, { force: true });
  }
});

// ── End to end against the real openapi.yaml, using a fabricated published document. ────────────
test('main() exits DRIFT on a real spec vs a published document that omits a promoted operation', async () => {
  const yaml = (await import('js-yaml')).default;
  const spec = yaml.load(readFileSync(join(REPO_ROOT, 'openapi.yaml'), 'utf8'));
  // Serve the spec's own non-draft operations, then delete one — a published contract that has
  // dropped a promoted operation is unambiguous drift.
  const served = {};
  for (const [p, item] of Object.entries(spec.paths)) {
    const kept = Object.fromEntries(Object.entries(item).filter(([, op]) => op?.['x-schema-status'] !== 'draft'));
    if (Object.keys(kept).length) served[p] = kept;
  }
  const victim = Object.keys(served)[0];
  delete served[victim];

  const snapshot = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-fixture-${process.pid}.json`);
  const { writeFileSync, rmSync } = await import('node:fs');
  writeFileSync(snapshot, JSON.stringify(doc(served)));
  try {
    assert.equal(await main([join(REPO_ROOT, 'openapi.yaml'), '--live', snapshot]), EXIT_DRIFT);
  } finally {
    rmSync(snapshot, { force: true });
  }
});

test('main() exits OK when the published document carries every non-draft operation verbatim', async () => {
  const yaml = (await import('js-yaml')).default;
  const spec = yaml.load(readFileSync(join(REPO_ROOT, 'openapi.yaml'), 'utf8'));
  const served = {};
  for (const [p, item] of Object.entries(spec.paths)) {
    const kept = Object.fromEntries(Object.entries(item).filter(([, op]) => op?.['x-schema-status'] !== 'draft'));
    if (Object.keys(kept).length) served[p] = kept;
  }
  const snapshot = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-clean-${process.pid}.json`);
  const { writeFileSync, rmSync } = await import('node:fs');
  writeFileSync(snapshot, JSON.stringify(doc(served)));
  try {
    assert.equal(await main([join(REPO_ROOT, 'openapi.yaml'), '--live', snapshot]), EXIT_OK);
  } finally {
    rmSync(snapshot, { force: true });
  }
});
