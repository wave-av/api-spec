// published-drift-live.test.mjs — the behavioural tier. Offline: every "network" call is a stub.
// Runs on every pull request in the `unit` job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  classifyLiveObservation, describeObservation, extractBodyCode, probePath, probeOperations,
} from './published-drift-live.mjs';
import { compare } from './published-drift-compare.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A fake fetch driven by a path -> {status, body} table. Anything not in the table is unmapped. */
const fakeFetch = (table) => async (url) => {
  const path = new URL(url).pathname.replace(/^\/v1/, '');
  const hit = table[path];
  if (!hit) return { status: 403, text: async () => JSON.stringify({ error: { code: 'ROUTE_NOT_MAPPED' } }) };
  if (hit.throw) throw Object.assign(new Error('boom'), { name: hit.throw });
  return { status: hit.status, text: async () => hit.body ?? '' };
};

const doc = (paths) => ({ openapi: '3.1.0', info: { version: '1.0.0' }, servers: [{ url: 'https://api.wave.online/v1' }], paths });
const draftOp = { 'x-schema-status': 'draft', 'x-price': { model: 'x402' }, responses: {} };

// ── The classifier ───────────────────────────────────────────────────────────────────────────────
test('A 402 CLASSIFIES AS PUBLISHED — a paywall is not an absence', () => {
  // This is the whole finding. On this gateway a 402 proves the route exists AND is priced; an
  // unmapped path returns 403 ROUTE_NOT_MAPPED instead. Reading a paywall as "not yet published"
  // is how 155 live, billable operations were reported as zero.
  assert.equal(classifyLiveObservation({ status: 402, bodyCode: 'X402_CHALLENGE' }), 'published');
  assert.equal(classifyLiveObservation({ status: 402, bodyCode: null }), 'published');
});

test('only an explicit route-level refusal counts as UNPUBLISHED', () => {
  assert.equal(classifyLiveObservation({ status: 403, bodyCode: 'ROUTE_NOT_MAPPED' }), 'unpublished');
  assert.equal(classifyLiveObservation({ status: 404, bodyCode: 'ROUTE_NOT_MAPPED' }), 'unpublished');
});

test('a BARE 404 is UNKNOWN, never UNPUBLISHED — a mapped resource route also 404s for a missing or unsubstituted id', () => {
  // A resource route the gateway routed to a real handler (e.g. GET /clips/{clipId} with a
  // nonexistent or unsubstituted id) answers 404 with no route-level refusal code. Reading every
  // bare 404 as "unpublished" would suppress exactly the routes this tier exists to stop
  // suppressing, the same failure the bare-5xx rule already guards against.
  assert.equal(classifyLiveObservation({ status: 404, bodyCode: null }), 'unknown');
  assert.equal(classifyLiveObservation({ status: 404 }), 'unknown');
});

test('every other answer is PUBLISHED — something recognised the path enough to answer', () => {
  // Measured live 2026-09-05 across the 157 suppressed operations: 152x402, 1x200, 1x401, 1x5xx.
  for (const o of [
    { status: 200, bodyCode: null }, { status: 204, bodyCode: null },
    { status: 401, bodyCode: 'AUTH_REQUIRED' }, { status: 403, bodyCode: 'FORBIDDEN' },
    { status: 405, bodyCode: null }, { status: 429, bodyCode: 'RATE_LIMITED' },
  ]) assert.equal(classifyLiveObservation(o), 'published', JSON.stringify(o));
});

test('a 5xx with a route-level code is published; a bare 5xx is UNKNOWN, never unpublished', () => {
  // One of the 157 returned a 5xx from its own handler — it had been ROUTED. But a bare 5xx is a
  // gateway wobble, and calling that "unpublished" would let an outage silently empty this gate.
  assert.equal(classifyLiveObservation({ status: 503, bodyCode: 'SOME_HANDLER_CODE' }), 'published');
  assert.equal(classifyLiveObservation({ status: 502, bodyCode: null }), 'unknown');
});

test('a failed probe is UNKNOWN and is never folded into either verdict', () => {
  for (const o of [{ status: 0, bodyCode: 'TIMEOUT' }, {}, undefined, { status: null }]) {
    assert.equal(classifyLiveObservation(o), 'unknown', JSON.stringify(o));
  }
});

test('extractBodyCode reads the code from JSON, from an x402 challenge, and from a TRUNCATED body', () => {
  assert.equal(extractBodyCode('{"error":{"code":"ROUTE_NOT_MAPPED"}}'), 'ROUTE_NOT_MAPPED');
  assert.equal(extractBodyCode('{"x402Version":1,"accepts":[]}'), 'X402_CHALLENGE');
  assert.equal(extractBodyCode('{"error":{"code":"AUTH_REQUIRED","message":"aut'), 'AUTH_REQUIRED');
  assert.equal(extractBodyCode(''), null);
  assert.equal(extractBodyCode(null), null);
});

test('describeObservation names the evidence so a finding explains itself', () => {
  assert.match(describeObservation({ status: 402, bodyCode: 'X402_CHALLENGE' }), /prices and serves/);
  assert.match(describeObservation({ status: 401, bodyCode: 'AUTH_REQUIRED' }), /requires a credential/);
});

// ── The prober ───────────────────────────────────────────────────────────────────────────────────
test('probePath uses GET with no body and no credentials — side-effect-free by construction', async () => {
  let seen = null;
  await probePath('https://api.wave.online/v1', '/x', async (url, init) => {
    seen = { url, init };
    return { status: 402, text: async () => '{}' };
  });
  assert.equal(seen.init.method, 'GET');
  assert.equal(seen.init.body, undefined);
  assert.equal(seen.init.redirect, 'manual', 'a redirect must not choose this job’s next destination');
  assert.ok(!('authorization' in Object.fromEntries(Object.entries(seen.init.headers).map(([k, v]) => [k.toLowerCase(), v]))));
});

test('probeOperations REFUSES the whole batch when a control answers as live', async () => {
  // A probe with no control is not a measurement. If a path that cannot exist answers, the gateway
  // is answering for everything and no observation in the batch means anything.
  const r = await probeOperations('https://api.wave.online/v1', ['/a'], {
    doFetch: async () => ({ status: 402, text: async () => '{"x402Version":1}' }),
  });
  assert.equal(r.usable, false);
  assert.match(r.reason, /control failed/);
});

test('POSITIVE CONTROL: probeOperations returns observations when the controls behave', async () => {
  const r = await probeOperations('https://api.wave.online/v1', ['/live', '/gone'], {
    doFetch: fakeFetch({ '/live': { status: 402, body: '{"x402Version":1}' } }),
  });
  assert.equal(r.usable, true);
  assert.equal(classifyLiveObservation(r.observations.get('/live')), 'published');
  assert.equal(classifyLiveObservation(r.observations.get('/gone')), 'unpublished');
});

// ── (a) the previously-invisible condition now FAILS ─────────────────────────────────────────────
test('a draft operation the gateway SERVES is a finding, not a suppression', () => {
  const repo = doc({ '/served': { post: draftOp } });
  const r = compare({
    repoDoc: repo, liveDoc: doc({}),
    liveObservations: new Map([['/served', { status: 402, bodyCode: 'X402_CHALLENGE' }]]),
  });
  assert.equal(r.headline.draftNotYetPublished, 0, 'it must NOT be suppressed');
  assert.equal(r.headline.draftButLive, 1);
  const f = r.findings.find((x) => x.direction === 'draft-but-live');
  assert.equal(f.severity, 'claim-contradicted-by-behaviour');
  assert.match(f.liveEvidence, /402/, 'the finding carries its own evidence');
});

test('an UNPROBEABLE draft operation is a finding too — UNKNOWN IS NOT A PASS', () => {
  // Falling back to the suppressed bucket during an outage would restore the false-green quietly,
  // and only when nobody could see it happen.
  const r = compare({
    repoDoc: doc({ '/x': { post: draftOp } }), liveDoc: doc({}),
    liveObservations: new Map([['/x', { status: 0, bodyCode: 'TIMEOUT' }]]),
  });
  assert.equal(r.headline.draftNotYetPublished, 0);
  assert.equal(r.findings.find((x) => x.direction === 'draft-but-live').severity, 'unverifiable');
});

// ── (b) POSITIVE CONTROL: a genuinely unpublished draft still passes ─────────────────────────────
test('POSITIVE CONTROL: a draft operation the gateway does NOT serve is still suppressed', () => {
  // The gate must discriminate. `draft` remains a real lane to publication for a real placeholder;
  // this is not a blanket "every draft is a finding" rule.
  const r = compare({
    repoDoc: doc({ '/stub': { post: draftOp } }), liveDoc: doc({}),
    liveObservations: new Map([['/stub', { status: 403, bodyCode: 'ROUTE_NOT_MAPPED' }]]),
  });
  assert.equal(r.headline.draftNotYetPublished, 1);
  assert.equal(r.headline.draftButLive, 0);
  assert.equal(r.findings.length, 0);
});

test('POSITIVE CONTROL: with no observations at all, behaviour is unchanged from before this tier', () => {
  // The offline unit tier must keep working exactly as it did, so this change cannot be blamed for
  // a failure it did not cause.
  const r = compare({ repoDoc: doc({ '/stub': { post: draftOp } }), liveDoc: doc({}) });
  assert.equal(r.headline.draftNotYetPublished, 1);
  assert.equal(r.headline.draftButLive, 0);
  assert.equal(r.headline.liveProbed, null);
});

// ── (c) MUTATION PROOFS ──────────────────────────────────────────────────────────────────────────
test('MUTATION PROOF: editing the ANNOTATION cannot re-suppress a route the gateway serves', () => {
  // This is the requirement in one test. Re-labelling was explicitly not the fix, because a
  // relabel leaves the mechanism intact. Suppression needs BOTH `draft` AND silence from the
  // gateway, and no edit to openapi.yaml can produce the second one.
  const live = new Map([['/served', { status: 402, bodyCode: 'X402_CHALLENGE' }]]);
  const asDraft = compare({ repoDoc: doc({ '/served': { post: draftOp } }), liveDoc: doc({}), liveObservations: live });
  const { 'x-schema-status': _, ...notDraft } = draftOp;
  const asNormal = compare({ repoDoc: doc({ '/served': { post: notDraft } }), liveDoc: doc({}), liveObservations: live });

  assert.equal(asDraft.headline.draftNotYetPublished, 0);
  assert.equal(asNormal.headline.draftNotYetPublished, 0);
  // Both spellings produce exactly one finding. The annotation changes the LABEL, never the verdict.
  assert.equal(asDraft.findings.length, 1);
  assert.equal(asNormal.findings.length, 1);
  assert.equal(asDraft.findings[0].direction, 'draft-but-live');
  assert.equal(asNormal.findings[0].direction, 'unpublished-repo');
});

test('MUTATION PROOF: removing the live observations restores the old false-green', () => {
  // Reverting this change = passing no observations. Assert that the OLD behaviour is exactly the
  // reported defect, so nobody can revert it believing nothing is lost.
  const repoDoc = doc({ '/served': { post: draftOp } });
  const before = compare({ repoDoc, liveDoc: doc({}) });
  assert.equal(before.headline.draftNotYetPublished, 1, 'the old code suppressed it');
  assert.equal(before.headline.unpublishedRepo, 0, 'and reported zero — zero by redefinition');
  assert.equal(before.findings.length, 0);
});

// ── The workflow actually runs it, on PRs, without an escape hatch ───────────────────────────────
const WORKFLOW = readFileSync(join(REPO_ROOT, '.github/workflows/published-contract-drift.yml'), 'utf8');

// The `drift:` job's own YAML block, bounded at the NEXT top-level job key so a check scoped to
// "the drift job" cannot pass or fail because of text that belongs to a job declared after it.
const DRIFT_JOB_START = WORKFLOW.indexOf('\n  drift:');
const driftJobRest = WORKFLOW.slice(DRIFT_JOB_START + 1);
const nextTopLevelJob = driftJobRest.slice(1).search(/^\s{2}\S[^\n]*:\s*$/m);
const DRIFT_JOB = nextTopLevelJob > 0 ? driftJobRest.slice(0, nextTopLevelJob + 1) : driftJobRest;

test('MUTATION PROOF: the drift job runs on pull_request, not on the schedule alone', () => {
  // Defect 1 of false-green #4: the drift job was `if: schedule || workflow_dispatch`, so it was
  // SKIPPED on every pull request and could never grade the diff that introduced a drift.
  assert.ok(!/if:\s*github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\s*$/m.test(DRIFT_JOB),
    'the schedule-only guard must be gone');
  assert.match(WORKFLOW, /^\s{2}pull_request:/m);
  assert.match(DRIFT_JOB, /pull_request/, 'the drift job must acknowledge the pull_request path');
});

test('MUTATION PROOF: the workflow never disables the live probe', () => {
  assert.ok(!WORKFLOW.includes('--no-live-probe'), 'the behavioural tier may not be switched off in CI');
  // A word boundary, not a literal trailing space, so `--live` at end-of-line or `--live=file` are
  // caught too — a space-only match would let either form quietly feed the gate an offline snapshot.
  assert.ok(!/published-drift\.mjs[^\n]*--live\b/.test(WORKFLOW), 'CI must not feed the gate an offline snapshot');
  assert.ok(!WORKFLOW.includes('continue-on-error'), 'no step may be softened');
});
