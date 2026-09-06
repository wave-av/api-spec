// live-route-drift-regressions.test.mjs — offline. No network. Split out of
// live-route-drift.test.mjs (a real seam: that file is the feature's original test suite; this one
// is regressions for findings fixed after the fact) so neither file grows unbounded.
//
// Covers, in order:
//   1. basePath must resolve a relative OpenAPI `servers[0].url` instead of throwing.
//   2. The segment fallback must cover ONLY the product-root case, never a deeper undeclared
//      sub-route that happens to share a declared prefix.
//   3. An operation with its own `servers` override (e.g. the Realtime API at
//      realtime.wave.online) must never be probed or compared against this document's own base.
//   4. decideExit must not report EXIT_OK when the live surface could not actually be observed.
//   5. enumeratorShapeError must reject a malformed 200 rather than silently enumerating zero
//      routes from it.
//   6. parseArgs must not mistake --out's value for the spec when the caller omits the spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABSENT, MAPPED } from './live-route-probe.mjs';
import { basePath, candidatePaths, compareAgainstLive, hasOwnServerOverride } from './live-route-compare.mjs';
import { decideExit, enumeratorShapeError, parseArgs, EXIT_OK, EXIT_UNKNOWN, EXIT_DRIFT } from './live-route-drift.mjs';

const SERVERS = [{ url: 'https://api.wave.online/v1' }];
const probeMap = (entries) => new Map(entries.map((e) => [e.path, e]));

// ─── basePath / relative server urls. ─────────────────────────────────────────────────────────────

test('basePath resolves a relative server url instead of throwing and silently returning empty', () => {
  assert.equal(basePath({ servers: [{ url: '/v1' }] }), '/v1', "a relative server url is legal OpenAPI 3 and must not collapse to ''");
  assert.equal(basePath({ servers: [{ url: 'https://api.wave.online/v1' }] }), '/v1');
});

// ─── segment fallback scope. ───────────────────────────────────────────────────────────────────────

test('the segment fallback covers only the product-root case, never a deeper undeclared sub-route', () => {
  const repo = { servers: SERVERS, paths: { '/clips': { get: {} } } };
  const r = compareAgainstLive({
    repoDoc: repo,
    publishedDoc: repo,
    probes: probeMap([
      { path: '/v1/clips', state: MAPPED, status: 402 },
      { path: '/v1/clips/export-all', state: MAPPED, status: 200 },
    ]),
  });
  assert.equal(r.findings.length, 1, 'a deeper undeclared sub-route under a declared product root must still be a finding');
  assert.equal(r.findings[0].path, '/v1/clips/export-all');
  assert.equal(r.findings[0].direction, 'live-undeclared');
});

// ─── cross-host operations (per-operation `servers` override). ────────────────────────────────────

test('hasOwnServerOverride is true only when every operation on the path declares its own servers', () => {
  assert.equal(hasOwnServerOverride({ get: { operationId: 'a' } }), false);
  assert.equal(hasOwnServerOverride({ get: { servers: [{ url: 'https://realtime.wave.online' }] } }), true);
  assert.equal(
    hasOwnServerOverride({ get: { servers: [{ url: 'https://realtime.wave.online' }] }, post: { operationId: 'b' } }),
    false,
    'a mixed path item (one overridden method, one not) is still served at the document base for the other method',
  );
  assert.equal(hasOwnServerOverride({}), false);
});

test('an operation-level servers override is excluded from candidates and from the API-host comparison', () => {
  // openapi.yaml declares /realtime/connect (base /v1) but annotates it `servers: [{url:
  // https://realtime.wave.online}]` — served at a different host entirely, never at
  // api.wave.online/v1/realtime/connect. Probing or comparing it as if it used the document base
  // would file a false declared-not-live finding the moment the wrong-host probe comes back absent.
  const repo = {
    servers: SERVERS,
    paths: {
      '/clips': { get: { operationId: 'listClips' } },
      '/realtime/connect': { get: { operationId: 'realtimeConnect', servers: [{ url: 'https://realtime.wave.online' }] } },
    },
  };
  const c = candidatePaths({ repoDoc: repo, publishedDoc: { servers: SERVERS, paths: {} } });
  assert.ok(!c.includes('/v1/realtime/connect'), "a cross-host operation must never be probed against this document's base");

  const r = compareAgainstLive({
    repoDoc: repo,
    publishedDoc: { servers: SERVERS, paths: {} },
    probes: probeMap([{ path: '/v1/realtime/connect', state: ABSENT, status: 403 }]),
  });
  assert.equal(r.findings.length, 0, 'a cross-host operation must never be reported declared-not-live against the wrong origin');
});

// ─── exit-code decision. ────────────────────────────────────────────────────────────────────────────

test('decideExit: findings drift, probe-level indeterminates are UNKNOWN, method-only indeterminates are OK', () => {
  assert.equal(decideExit({ findings: [{}], indeterminate: [] }), EXIT_DRIFT);
  assert.equal(decideExit({ findings: [], indeterminate: [{ reason: 'timed out after 20000ms' }] }), EXIT_UNKNOWN);
  assert.equal(decideExit({ findings: [], indeterminate: [{ reason: 'HTTP 503' }] }), EXIT_UNKNOWN);
  assert.equal(
    decideExit({ findings: [], indeterminate: [{ reason: 'declares only POST — a GET probe cannot establish whether that method is served' }] }),
    EXIT_OK,
    'a method-based indeterminate (a POST-only route probed with GET) is expected and must not report UNKNOWN',
  );
  assert.equal(decideExit({ findings: [], indeterminate: [] }), EXIT_OK);
});

// ─── enumerator shape validation. ───────────────────────────────────────────────────────────────────

test('enumeratorShapeError rejects a malformed 200 instead of silently enumerating zero routes', () => {
  assert.equal(enumeratorShapeError('published contract', { paths: {} }), null);
  assert.match(enumeratorShapeError('published contract', { notPaths: {} }), /no usable "paths"/);
  assert.match(enumeratorShapeError('published contract', []), /no usable "paths"/, 'the published contract must be an object, unlike the capability index');
  assert.match(enumeratorShapeError('published contract', null), /not a JSON object or array/);
  assert.equal(enumeratorShapeError('scope catalog', { routes: [] }), null, 'a missing routes field is fine — candidatePaths defaults it');
  assert.match(enumeratorShapeError('scope catalog', { routes: 'not-an-array' }), /non-array "routes"/);
  assert.match(enumeratorShapeError('scope catalog', []), /must be an object/, 'the scope catalog is an object, unlike the capability index');
  // MEASURED: the real capability index (.well-known/wave-skills.json) is a bare JSON ARRAY, and
  // candidatePaths reads it with Object.values(), which is array-safe. A bare array must stay valid.
  assert.equal(enumeratorShapeError('capability index', [{ path: '/v1/gpu' }]), null);
  assert.match(enumeratorShapeError('capability index', 'not even json-object-shaped'), /not a JSON object or array/);
});

// ─── --out arg parsing. ─────────────────────────────────────────────────────────────────────────────

test('parseArgs skips the value consumed by --out when picking the spec, including the default-spec case', () => {
  assert.deepEqual(parseArgs(['openapi.yaml']), { spec: 'openapi.yaml', out: null });
  assert.deepEqual(parseArgs(['openapi.yaml', '--out', 'live-route-drift.json']), { spec: 'openapi.yaml', out: 'live-route-drift.json' });
  assert.deepEqual(
    parseArgs(['--out', 'live-route-drift.json']),
    { spec: 'openapi.yaml', out: 'live-route-drift.json' },
    "--out's value must never be mistaken for the spec when the caller uses the default spec",
  );
  assert.match(parseArgs(['--out']).error, /needs a value/);
  assert.match(parseArgs(['--out', '--out']).error, /needs a value/);
});
