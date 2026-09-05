// live-route-drift.test.mjs — offline. No network: probe results are inputs, and the two tests that
// exercise the prober inject a fake `fetch`.
//
// Every test here is written against the specific false-green this feature closes
// (WAVE-GA-VERDICT #11): `published-contract-drift` compares repo-declared against
// gateway-published, so a route that is LIVE and absent from BOTH is invisible to it by
// construction. The suite is built so it cannot pass vacuously:
//   (a) the previously-invisible condition now FAILS,
//   (b) a POSITIVE CONTROL — a genuinely compliant state still passes, so the gate discriminates
//       rather than blanket-failing,
//   (c) the probe semantics are pinned by name, especially that 402 is PRESENCE and not absence,
//   (d) a MUTATION PROOF — `twoArtifactDriftOnly` (what the old gate could see) returns ZERO on the
//       same input where the three-way comparison returns a finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProbe, probePath, probeAll, ABSENT, MAPPED, INDETERMINATE } from './live-route-probe.mjs';
import {
  basePath,
  candidatePaths,
  compareAgainstLive,
  isProbeable,
  segmentKey,
  twoArtifactDriftOnly,
  withinSpecBase,
  validateAllowlist,
} from './live-route-compare.mjs';

const SERVERS = [{ url: 'https://api.wave.online/v1' }];

/** A spec that declares /clips and /render, exactly as the real one does (relative to the /v1 base). */
const REPO_DOC = {
  servers: SERVERS,
  paths: {
    '/clips': { get: { operationId: 'listClips' } },
    '/render': { get: { operationId: 'getRender' } },
  },
};
const PUBLISHED_DOC = {
  servers: SERVERS,
  paths: {
    '/clips': { get: { operationId: 'listClips' } },
    '/render': { get: { operationId: 'getRender' } },
  },
};

const probeMap = (entries) => new Map(entries.map((e) => [e.path, e]));

// ─── (c) Probe semantics. A paywall is not an absence. ───────────────────────────────────────────

test('402 is MAPPED — a paywall proves the route EXISTS and is priced, it is never an absence', () => {
  // This is the single most consequential rule in the feature. If 402 ever read as "absent", the
  // gate would go blind to exactly the routes that charge customers money.
  assert.equal(classifyProbe({ status: 402, body: { x402Version: 1, error: 'payment required' } }), MAPPED);
});

test('only an explicit ROUTE_NOT_MAPPED code is ABSENT; a bare 403 is MAPPED', () => {
  assert.equal(classifyProbe({ status: 403, body: { error: { code: 'ROUTE_NOT_MAPPED' } } }), ABSENT);
  // A plain authorization failure PROVES the route exists — there was something to be unauthorized
  // for. Inferring absence from the status number alone would delete real findings.
  assert.equal(classifyProbe({ status: 403, body: { error: { code: 'FORBIDDEN' } } }), MAPPED);
  assert.equal(classifyProbe({ status: 401, body: { error: { code: 'UNAUTHENTICATED' } } }), MAPPED);
});

test('200 is MAPPED and 5xx is INDETERMINATE — an origin having a bad minute is not an absence', () => {
  assert.equal(classifyProbe({ status: 200, body: { source: 'sample' } }), MAPPED);
  assert.equal(classifyProbe({ status: 503, body: null }), INDETERMINATE);
  assert.equal(classifyProbe({ status: 500, body: { error: { code: 'ROUTE_NOT_MAPPED' } } }), INDETERMINATE);
});

test('probePath sends an unauthenticated GET and never throws on a transport failure', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, method: init.method, hasAuth: Boolean(init.headers?.authorization ?? init.headers?.Authorization) });
    return { status: 402, json: async () => ({ error: 'payment required' }) };
  };
  const r = await probePath('/v1/render', fakeFetch);
  assert.equal(r.state, MAPPED);
  assert.equal(seen[0].method, 'GET', 'probes must be GET — never a POST that could do billable work');
  assert.equal(seen[0].hasAuth, false, 'probes must be unauthenticated — no tenant, meter or balance is touched');

  const boom = await probePath('/v1/render', async () => {
    throw new Error('ECONNRESET');
  });
  assert.equal(boom.state, INDETERMINATE, 'a failed probe is INDETERMINATE, never ABSENT');
});

test('probeAll probes every candidate exactly once', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { status: 402, json: async () => ({}) };
  };
  const out = await probeAll(['/v1/a', '/v1/b', '/v1/c'], fakeFetch, 'https://x.test', 2);
  assert.equal(out.size, 3);
  assert.equal(calls.length, 3);
});

// ─── (a) The previously-invisible condition now FAILS. ───────────────────────────────────────────

test('SEEDED VIOLATION — a route that is LIVE and absent from BOTH artifacts is a finding', () => {
  // This is the exact shape measured against production on 2026-09-05: GET /v1/samples/clips
  // answers 200, and it appears in neither openapi.yaml nor the published contract.
  const probes = probeMap([
    { path: '/v1/clips', state: MAPPED, status: 402 },
    { path: '/v1/render', state: MAPPED, status: 402 },
    { path: '/v1/samples/clips', state: MAPPED, status: 200 },
  ]);
  const r = compareAgainstLive({ repoDoc: REPO_DOC, publishedDoc: PUBLISHED_DOC, probes });
  assert.equal(r.headline.liveUndeclared, 1);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].path, '/v1/samples/clips');
  assert.equal(r.findings[0].direction, 'live-undeclared');
  assert.equal(r.findings[0].severity, 'security-relevant');
});

test('SEEDED VIOLATION — a 402-only route absent from both artifacts is a finding too', () => {
  // Guards the money-relevant case specifically: a route can be live, PRICED, billable, and
  // undocumented. If 402 were ever mistaken for an absence this finding would silently vanish.
  const probes = probeMap([
    { path: '/v1/clips', state: MAPPED, status: 402 },
    { path: '/v1/undocumented-paid-thing', state: MAPPED, status: 402 },
  ]);
  const r = compareAgainstLive({ repoDoc: REPO_DOC, publishedDoc: PUBLISHED_DOC, probes });
  assert.equal(r.headline.liveUndeclared, 1);
  assert.equal(r.findings[0].path, '/v1/undocumented-paid-thing');
});

test('SEEDED VIOLATION — a non-draft declaration the gateway does not serve is a finding', () => {
  // The other direction only a probe can see: both documents can agree and both be wrong.
  const probes = probeMap([
    { path: '/v1/clips', state: MAPPED, status: 402 },
    { path: '/v1/render', state: ABSENT, status: 403 },
  ]);
  const r = compareAgainstLive({ repoDoc: REPO_DOC, publishedDoc: PUBLISHED_DOC, probes });
  assert.equal(r.headline.declaredNotLive, 1);
  assert.equal(r.findings[0].path, '/v1/render');
  assert.deepEqual(r.findings[0].methods, ['GET']);
});

test('x-schema-status: draft suppresses declared-not-live, but never live-undeclared', () => {
  const draftRepo = { servers: SERVERS, paths: { '/clips': { get: { 'x-schema-status': 'draft' } } } };
  const r = compareAgainstLive({
    repoDoc: draftRepo,
    publishedDoc: { servers: SERVERS, paths: {} },
    probes: probeMap([{ path: '/v1/clips', state: ABSENT, status: 403 }]),
  });
  assert.equal(r.findings.length, 0, 'a draft that is not yet served is not a finding');

  const r2 = compareAgainstLive({
    repoDoc: draftRepo,
    publishedDoc: { servers: SERVERS, paths: {} },
    probes: probeMap([{ path: '/v1/other', state: MAPPED, status: 200 }]),
  });
  assert.equal(r2.headline.liveUndeclared, 1, 'draft never excuses an UNDECLARED LIVE route');
});

// ─── (b) POSITIVE CONTROL. A compliant state must still pass. ────────────────────────────────────

test('POSITIVE CONTROL — a fully compliant surface produces ZERO findings', () => {
  // Without this the gate could satisfy every test above by simply always failing, which is a
  // different broken gate rather than a fixed one. These are the real /v1/clips and /v1/render,
  // present in all three sources, classified by the same code path as the violations.
  const probes = probeMap([
    { path: '/v1/clips', state: MAPPED, status: 402 },
    { path: '/v1/render', state: MAPPED, status: 402 },
    { path: '/v1/not-a-route', state: ABSENT, status: 403 },
  ]);
  const r = compareAgainstLive({ repoDoc: REPO_DOC, publishedDoc: PUBLISHED_DOC, probes });
  assert.equal(r.findings.length, 0);
  assert.equal(r.headline.liveUndeclared, 0);
  assert.equal(r.headline.declaredNotLive, 0);
  assert.equal(r.headline.mapped, 2);
  assert.equal(r.headline.absent, 1);
});

test('POSITIVE CONTROL — a product-root live entry is covered by the segment its spec documents', () => {
  // The live enumerators are product-granular (`/v1/voice`) while the spec documents `/voice/voices`.
  // Reporting the product root as undeclared would bury real findings under a dozen false ones.
  const repo = { servers: SERVERS, paths: { '/voice/voices': { get: {} }, '/voice/generate': { post: {} } } };
  const r = compareAgainstLive({
    repoDoc: repo,
    publishedDoc: repo,
    probes: probeMap([{ path: '/v1/voice', state: MAPPED, status: 402 }]),
  });
  assert.equal(r.findings.length, 0);
});

test('an INDETERMINATE probe is neither a pass nor a finding — it is surfaced', () => {
  const r = compareAgainstLive({
    repoDoc: REPO_DOC,
    publishedDoc: PUBLISHED_DOC,
    probes: probeMap([{ path: '/v1/mystery', state: INDETERMINATE, error: 'timed out' }]),
  });
  assert.equal(r.findings.length, 0, 'an unreadable probe must not manufacture a finding');
  assert.equal(r.headline.indeterminate, 1, 'nor may it disappear into a clean-looking run');
});

// ─── (d) MUTATION PROOF. Remove the third source and the finding silently vanishes. ──────────────

test('MUTATION PROOF — the two-artifact comparison reports ZERO on the input the live probe catches', () => {
  // `twoArtifactDriftOnly` is what published-drift.mjs can see: repo-declared vs gateway-published.
  // On the live-undeclared input it finds NOTHING, because the route is missing from both documents
  // and it only ever compares those two to each other. That is the entire false-green, executable.
  const probes = probeMap([
    { path: '/v1/clips', state: MAPPED, status: 402 },
    { path: '/v1/render', state: MAPPED, status: 402 },
    { path: '/v1/samples/clips', state: MAPPED, status: 200 },
  ]);
  const threeWay = compareAgainstLive({ repoDoc: REPO_DOC, publishedDoc: PUBLISHED_DOC, probes });
  const twoWay = twoArtifactDriftOnly({ repoDoc: REPO_DOC, publishedDoc: PUBLISHED_DOC });

  assert.equal(twoWay.length, 0, 'the two documents agree perfectly — the old gate is green here');
  assert.equal(threeWay.findings.length, 1, 'the live surface disagrees with both of them');
  assert.equal(threeWay.findings[0].path, '/v1/samples/clips');
  // Stated as one assertion so the delta itself is the thing under test: deleting the probe from
  // this feature reduces it to `twoWay`, and this line fails.
  assert.ok(threeWay.findings.length > twoWay.length, 'the third source must find what two artifacts cannot');
});

// ─── Scoping rules. Each must exclude only what it claims to, proven with an in-scope control. ───

test('paths outside the spec server base are out of scope, but every /v1 route stays in scope', () => {
  // Measured against production: /robots.txt, /favicon.svg, /llms.txt, /health and friends are live
  // and correctly absent from an API contract. Reporting them would be 7 false findings stacked on
  // the real ones. The control below is what stops this rule from becoming a suppression.
  const probes = probeMap([
    { path: '/robots.txt', state: MAPPED, status: 200 },
    { path: '/health', state: MAPPED, status: 200 },
    { path: '/v1/samples/clips', state: MAPPED, status: 200 },
  ]);
  const r = compareAgainstLive({ repoDoc: REPO_DOC, publishedDoc: PUBLISHED_DOC, probes });
  assert.equal(r.headline.outOfScope, 2);
  assert.equal(r.findings.length, 1, 'CONTROL: an undeclared route UNDER /v1 is still a finding');
  assert.equal(r.findings[0].path, '/v1/samples/clips');
});

test('withinSpecBase does not exclude by prefix accident, and an absent base excludes nothing', () => {
  assert.equal(withinSpecBase('/v1/clips', '/v1'), true);
  assert.equal(withinSpecBase('/v1', '/v1'), true);
  assert.equal(withinSpecBase('/v10/clips', '/v1'), false, '/v10 is a different base, not a child of /v1');
  assert.equal(withinSpecBase('/robots.txt', '/v1'), false);
  assert.equal(withinSpecBase('/anything', ''), true, 'no server base means fail-closed: everything is in scope');
});

test('a POST-only declaration answering ROUTE_NOT_MAPPED to a GET is INDETERMINATE, not a finding', () => {
  // MEASURED: /v1/agent/auth/device and /v1/agent/auth/token are POST-only OAuth device-grant
  // routes. A GET to each returns 403 ROUTE_NOT_MAPPED because the gateway's scope map is keyed by
  // route AND method — which says nothing about whether their POST is served. An earlier draft of
  // this gate reported both as findings; that was the gate asserting a fact its evidence did not
  // support. Unknown is not a pass either: it is surfaced.
  const repo = {
    servers: SERVERS,
    paths: {
      '/agent/auth/device': { post: { operationId: 'deviceAuth' } },
      '/render': { get: { operationId: 'getRender' } },
    },
  };
  const r = compareAgainstLive({
    repoDoc: repo,
    publishedDoc: repo,
    probes: probeMap([
      { path: '/v1/agent/auth/device', state: ABSENT, status: 403 },
      { path: '/v1/render', state: ABSENT, status: 403 },
    ]),
  });
  assert.equal(r.headline.declaredNotLive, 1, 'CONTROL: the GET-declaring path IS still reported');
  assert.equal(r.findings[0].path, '/v1/render');
  assert.equal(r.headline.indeterminate, 1);
  assert.match(r.indeterminate[0].reason, /declares only POST/);
});

// ─── Enumeration and allowlist plumbing. ─────────────────────────────────────────────────────────

test('candidatePaths unions all five enumerators and drops templated paths', () => {
  const c = candidatePaths({
    repoDoc: { servers: SERVERS, paths: { '/clips': {}, '/clips/{clipId}': {} } },
    publishedDoc: { servers: SERVERS, paths: { '/render': {} } },
    scopeCatalog: { routes: [{ path: '/v1/voice' }], no_scope_required: { paths: ['/health'] } },
    capabilityIndex: { 0: { path: '/v1/gpu' } },
    seeds: [{ path: '/v1/samples/clips' }],
  });
  assert.deepEqual(c, ['/health', '/v1/clips', '/v1/gpu', '/v1/render', '/v1/samples/clips', '/v1/voice']);
  assert.ok(!c.includes('/v1/clips/{clipId}'), 'a templated path has no probe-able concrete form');
});

test('basePath / isProbeable / segmentKey', () => {
  assert.equal(basePath({ servers: SERVERS }), '/v1');
  assert.equal(basePath({}), '');
  assert.equal(isProbeable('/v1/clips'), true);
  assert.equal(isProbeable('/v1/clips/{clipId}'), false);
  assert.equal(segmentKey('/v1/render/{jobId}'), 'v1/render');
});

test('an allowlist entry suppresses its finding, and a dead entry is surfaced not honoured silently', () => {
  const probes = probeMap([{ path: '/v1/samples/clips', state: MAPPED, status: 200 }]);
  const allowlist = [
    {
      direction: 'live-undeclared',
      path: '/v1/samples/clips',
      justification: 'documented separately as a free synthetic sample surface, tracked for promotion into the spec',
    },
    {
      direction: 'live-undeclared',
      path: '/v1/gone',
      justification: 'this exemption no longer matches anything and must be reported as dead rather than left standing',
    },
  ];
  const r = compareAgainstLive({ repoDoc: REPO_DOC, publishedDoc: PUBLISHED_DOC, probes, allowlist });
  assert.equal(r.findings.length, 0);
  assert.equal(r.allowlisted.length, 1);
  assert.deepEqual(r.unmatchedAllowlist, ['live-undeclared /v1/gone']);
});

test('validateAllowlist rejects a missing justification, an unknown direction and a duplicate', () => {
  assert.equal(validateAllowlist([]), null);
  assert.match(validateAllowlist([{ direction: 'live-undeclared', path: '/v1/x', justification: 'too short' }]), /justification/);
  assert.match(validateAllowlist([{ direction: 'made-up', path: '/v1/x', justification: 'a perfectly long justification string here' }]), /unknown direction/);
  const dup = { direction: 'live-undeclared', path: '/v1/x', justification: 'a perfectly long justification string here' };
  assert.match(validateAllowlist([dup, { ...dup }]), /duplicate/);
  assert.match(validateAllowlist({}), /not an array/);
});
