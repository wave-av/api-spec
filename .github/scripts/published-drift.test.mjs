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
 * The EXEMPTION lifecycle — how an allowlist entry is granted, honored and lapses — lives in
 * published-drift-allowlist.test.mjs. This file keeps normalization, indexing and the CLI contract.
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
import { compare, diffOperation, indexOperations } from './published-drift-compare.mjs';
import {
  EXIT_DRIFT, EXIT_OK, EXIT_UNKNOWN, fetchPublished, indexSpecPathsByProbePath, main, parseArgs,
  reindexObservationsBySpecPath, templateToProbePath,
} from './published-drift.mjs';

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

test('a redirect is refused rather than followed', async () => {
  // redirect: 'follow' let whatever answers the published URL choose this CI job's next
  // destination. The URL is a hardcoded HTTPS constant; a bounce is not a contract to grade, it is
  // a read that did not happen — so it must come back as a failure, which main() turns into
  // EXIT_UNKNOWN (red, no issue filed) rather than a verdict about drift.
  const withHeaders = async () => ({ ok: false, status: 302, headers: new Headers({ location: 'https://elsewhere.invalid/x' }) });
  const r = await fetchPublished('https://example.invalid/openapi.json', withHeaders);
  assert.equal(r.ok, false);
  assert.match(r.error, /redirected \(HTTP 302\) to https:\/\/elsewhere\.invalid\/x — refusing to follow/);

  // Every 3xx, and a 3xx with no Location at all, is still a refusal rather than a read.
  for (const status of [301, 302, 307, 308]) {
    const bounce = async () => ({ ok: false, status, headers: new Headers({ location: 'https://elsewhere.invalid/x' }) });
    assert.equal((await fetchPublished('https://example.invalid/openapi.json', bounce)).ok, false, `HTTP ${status}`);
  }
  const noLocation = async () => ({ ok: false, status: 302, headers: new Headers() });
  assert.match((await fetchPublished('https://example.invalid/openapi.json', noLocation)).error, /an undisclosed location/);

  // A 200 still reads normally — this refuses redirects, not the endpoint.
  const fine = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ paths: {} }) });
  assert.deepEqual(await fetchPublished('https://example.invalid/openapi.json', fine), { ok: true, doc: { paths: {} } });
});

test('a value-taking option with no value is a usage error, not a silent opposite', () => {
  // `--live` with nothing after it used to mean "no snapshot", which takes the NETWORK branch —
  // the exact branch the caller typed --live to avoid.
  assert.match(parseArgs(['--live']).error, /--live needs a value \(got nothing\)/);
  assert.match(parseArgs(['--live', '--json']).error, /--live needs a value \(got "--json"\)/);
  assert.match(parseArgs(['--out']).error, /--out needs a value/);
  assert.match(parseArgs(['--out', '--no-normalize']).error, /--out needs a value/);
  // The valid forms are unchanged.
  const ok = parseArgs(['openapi.yaml', '--live', 'live.json', '--out', 'drift.json', '--json', '--no-normalize']);
  assert.equal(ok.error, null);
  assert.deepEqual(
    { spec: ok.spec, live: ok.live, out: ok.out, json: ok.json, normalize: ok.normalize },
    { spec: 'openapi.yaml', live: 'live.json', out: 'drift.json', json: true, normalize: false },
  );
  assert.equal(parseArgs([]).spec, 'openapi.yaml', 'the default spec still applies');
});

test('templateToProbePath substitutes every {param} segment with a real placeholder', () => {
  // Probed literally, an OpenAPI path template does not match the gateway's router (it matches a
  // real segment, never the literal string `{clipId}`), so a draft route behind a path parameter
  // would 404 and be misclassified as unpublished — the false-green this tier exists to remove.
  assert.equal(templateToProbePath('/clips/{clipId}'), '/clips/wave-drift-probe-placeholder');
  assert.equal(
    templateToProbePath('/videos/{videoId}/chapters/{chapterId}'),
    '/videos/wave-drift-probe-placeholder/chapters/wave-drift-probe-placeholder',
  );
  assert.equal(templateToProbePath('/clips'), '/clips', 'a path with no template is unchanged');
});

test('indexSpecPathsByProbePath / reindexObservationsBySpecPath: a probe result finds its way back to the SPEC path', () => {
  // The regression this guards: `compare()` looks observations up by the ORIGINAL spec path, never
  // the placeholder-substituted probe path. Before this pair of functions existed, `repoOnly` was
  // built directly from `templateToProbePath(path)` and the probe's Map stayed keyed by that
  // substituted string — every templated draft operation's observation was then unreachable by
  // `compare()`, which classified it `unknown` and reported it as an unverifiable finding on every
  // run, regardless of what the gateway actually served.
  const draftOp = { 'x-schema-status': 'draft', responses: {} };
  const repoDoc = {
    openapi: '3.1.0',
    paths: {
      '/clips/{clipId}': { get: draftOp },
      '/published/{id}': { get: { responses: {} } }, // already live — must be excluded
    },
  };
  const livePublished = new Map([['GET /published/{id}', {}]]);

  const index = indexSpecPathsByProbePath(repoDoc, livePublished);
  assert.deepEqual([...index.entries()], [['/clips/wave-drift-probe-placeholder', ['/clips/{clipId}']]]);

  const observations = new Map([['/clips/wave-drift-probe-placeholder', { status: 402, bodyCode: 'X402_CHALLENGE' }]]);
  const reindexed = reindexObservationsBySpecPath(observations, index);
  assert.deepEqual([...reindexed.keys()], ['/clips/{clipId}'], 'the observation must be reachable by the SPEC path');
  assert.equal(reindexed.get('/clips/{clipId}').status, 402);
});

test('indexSpecPathsByProbePath: two templated spec paths that collapse to the same probe path both receive the observation', () => {
  const draftOp = { 'x-schema-status': 'draft', responses: {} };
  const repoDoc = {
    openapi: '3.1.0',
    paths: {
      '/x/{a}': { get: draftOp },
      '/x/{b}': { post: draftOp },
    },
  };
  const index = indexSpecPathsByProbePath(repoDoc, new Map());
  const probePath = templateToProbePath('/x/{a}');
  assert.deepEqual(new Set(index.get(probePath)), new Set(['/x/{a}', '/x/{b}']));

  const reindexed = reindexObservationsBySpecPath(new Map([[probePath, { status: 402 }]]), index);
  assert.equal(reindexed.get('/x/{a}').status, 402);
  assert.equal(reindexed.get('/x/{b}').status, 402);
});

test('a usage error exits UNKNOWN and never reaches the network', async () => {
  assert.equal(await main(['--live']), EXIT_UNKNOWN);
  assert.equal(await main(['--out']), EXIT_UNKNOWN);
});

test('--json keeps stdout parseable: the artifact and nothing else', async () => {
  // The human report and the OK line used to be written to stdout alongside the JSON, so a
  // consumer piping this into a parser got a stream it could not read.
  const { writeFileSync, rmSync } = await import('node:fs');
  const yaml = (await import('js-yaml')).default;
  const spec = yaml.load(readFileSync(join(REPO_ROOT, 'openapi.yaml'), 'utf8'));
  const served = {};
  for (const [p, item] of Object.entries(spec.paths)) {
    const kept = Object.fromEntries(Object.entries(item).filter(([, op]) => op?.['x-schema-status'] !== 'draft'));
    if (Object.keys(kept).length) served[p] = kept;
  }
  const snapshot = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-json-${process.pid}.json`);
  writeFileSync(snapshot, JSON.stringify(doc(served)));

  const chunks = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const realLog = console.log;
  const realError = console.error;
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return true;
  };
  console.log = (...a) => chunks.push(`${a.join(' ')}\n`);
  console.error = () => {};
  try {
    const code = await main([join(REPO_ROOT, 'openapi.yaml'), '--live', snapshot, '--json']);
    assert.equal(code, EXIT_OK);
  } finally {
    process.stdout.write = realWrite;
    console.log = realLog;
    console.error = realError;
    rmSync(snapshot, { force: true });
  }

  const stdout = chunks.join('');
  assert.doesNotThrow(() => JSON.parse(stdout), 'everything written to stdout under --json must be the artifact');
  assert.equal(JSON.parse(stdout).headline.sharedDrift, 0);
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
