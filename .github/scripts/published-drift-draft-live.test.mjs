#!/usr/bin/env node
/**
 * published-drift-draft-live.test.mjs — offline, deterministic, zero network.
 *
 * The draft-live carve-out, end to end: the 2026-09-04 GA verdict found `unpublishedRepo: 0` was
 * zero by redefinition — 158 operations were shunted into `x-schema-status: draft` and excluded
 * from the count while 10 of 10 sampled answered a live 402 in production (control: an unmapped
 * path answers 403 ROUTE_NOT_MAPPED). `draft` must not be able to hide an operation the real
 * gateway actually serves. The live-probe unit itself (probeOperation / probeDraftOperations) has
 * its own file: published-drift-live-probe.test.mjs. This file tests the two integration seams that
 * consume it: compare()'s `draftLiveProbe` parameter, and main()'s `--draft-live-snapshot` /
 * refuse-on-unresolved-probe wiring — both fully offline, via hand-built fixtures.
 *
 * Run: node --test .github/scripts/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { compare } from './published-drift-compare.mjs';
import { EXIT_DRIFT, EXIT_OK, EXIT_UNKNOWN, main } from './published-drift.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const doc = (paths, version = '1.0.0') => ({ openapi: '3.1.0', info: { title: 't', version }, paths });

// ── compare(): the pure carve-out. ────────────────────────────────────────────────────────────────
test('a draft operation with NO probe result stays suppressed — unchanged default behavior', () => {
  const draft = { 'x-schema-status': 'draft', 'x-price': { model: 'x402' }, responses: {} };
  const repoDoc = doc({ '/known': { get: { responses: {} } }, '/shipped-but-draft': { post: draft } });
  const liveDoc = doc({ '/known': { get: { responses: {} } } });

  const unprobed = compare({ repoDoc, liveDoc });
  assert.equal(unprobed.headline.unpublishedRepo, 0);
  assert.equal(unprobed.headline.draftButLive, 0);
  assert.equal(unprobed.headline.draftNotYetPublished, 1);
});

test('a draft operation PROBED not-live (403 ROUTE_NOT_MAPPED) stays suppressed — draft is a true statement', () => {
  const draft = { 'x-schema-status': 'draft', 'x-price': { model: 'x402' }, responses: {} };
  const repoDoc = doc({ '/known': { get: { responses: {} } }, '/shipped-but-draft': { post: draft } });
  const liveDoc = doc({ '/known': { get: { responses: {} } } });

  const probedNotLive = compare({
    repoDoc,
    liveDoc,
    draftLiveProbe: new Map([['POST /shipped-but-draft', { status: 'not-live', httpStatus: 403, code: 'ROUTE_NOT_MAPPED' }]]),
  });
  assert.equal(probedNotLive.headline.unpublishedRepo, 0);
  assert.equal(probedNotLive.headline.draftButLive, 0);
  assert.equal(probedNotLive.headline.draftNotYetPublished, 1);
});

test('a draft operation PROBED live (402, the exact CONTRACT-001 signal) is a finding, not a suppression', () => {
  const draft = { 'x-schema-status': 'draft', 'x-price': { model: 'x402' }, responses: {} };
  const repoDoc = doc({ '/known': { get: { responses: {} } }, '/shipped-but-draft': { post: draft } });
  const liveDoc = doc({ '/known': { get: { responses: {} } } });

  const probedLive = compare({
    repoDoc,
    liveDoc,
    draftLiveProbe: new Map([['POST /shipped-but-draft', { status: 'live', httpStatus: 402, code: null }]]),
  });
  assert.equal(probedLive.headline.draftNotYetPublished, 0, 'a live draft is no longer in the suppressed bucket');
  assert.equal(probedLive.headline.unpublishedRepo, 1, 'the headline metric this program exists to un-zero');
  assert.equal(probedLive.headline.draftButLive, 1);
  const finding = probedLive.findings.find((f) => f.path === '/shipped-but-draft');
  assert.equal(finding.severity, 'draft-but-live');
  assert.equal(finding.direction, 'unpublished-repo');
  assert.match(finding.note, /402/);
  assert.match(finding.note, /ROUTE_NOT_MAPPED/);
});

test('a draft-but-live finding is still exemptable through the normal allowlist mechanism', () => {
  const draft = { 'x-schema-status': 'draft', 'x-price': { model: 'x402' }, responses: {} };
  const repoDoc = doc({ '/known': { get: { responses: {} } }, '/shipped-but-draft': { post: draft } });
  const liveDoc = doc({ '/known': { get: { responses: {} } } });
  const allowlist = [
    {
      path: '/shipped-but-draft',
      method: 'POST',
      direction: 'unpublished-repo',
      justification: 'Tracked in WAVE-1234, gateway team is promoting this operation out of draft this sprint.',
    },
  ];
  const allowlisted = compare({
    repoDoc,
    liveDoc,
    allowlist,
    draftLiveProbe: new Map([['POST /shipped-but-draft', { status: 'live', httpStatus: 402, code: null }]]),
  });
  assert.equal(allowlisted.headline.unpublishedRepo, 0, 'the fix is that draft no longer hides it BY DEFAULT, not that it is unexemptable');
  assert.equal(allowlisted.headline.allowlisted, 1);
});

// ── main(): the CLI wiring, still fully offline via --draft-live-snapshot. ────────────────────────
function servedWithoutDrafts(spec, { keepFirstDraft = false } = {}) {
  const served = {};
  let victimKey = null;
  for (const [p, item] of Object.entries(spec.paths)) {
    const kept = {};
    for (const [m, op] of Object.entries(item)) {
      if (op?.['x-schema-status'] === 'draft') {
        if (keepFirstDraft) victimKey ??= `${m.toUpperCase()} ${p}`;
        continue;
      }
      kept[m] = op;
    }
    if (Object.keys(kept).length) served[p] = kept;
  }
  return { served, victimKey };
}

/** Every `x-schema-status: draft` key in the real spec, `METHOD path` — the completeness check now
 * requires a --draft-live-snapshot to cover every one of these, not just the operation under test. */
function allDraftKeys(spec) {
  const keys = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(item)) {
      if (op?.['x-schema-status'] === 'draft') keys.push(`${m.toUpperCase()} ${p}`);
    }
  }
  return keys;
}

test('main(): a draft-live-snapshot naming a real draft operation as live turns EXIT_OK into EXIT_DRIFT', async () => {
  const yaml = (await import('js-yaml')).default;
  const spec = yaml.load(readFileSync(join(REPO_ROOT, 'openapi.yaml'), 'utf8'));
  const { served, victimKey } = servedWithoutDrafts(spec, { keepFirstDraft: true });
  assert.ok(victimKey, 'the real spec must have at least one draft operation for this test to mean anything');

  const { writeFileSync, rmSync } = await import('node:fs');
  const liveSnapshot = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-draftlive-clean-${process.pid}.json`);
  const draftLiveSnapshot = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-draftlive-fixture-${process.pid}.json`);
  writeFileSync(liveSnapshot, JSON.stringify(doc(served)));
  // A complete snapshot: every other draft key resolves 'not-live' (the honest default —
  // unprobed-in-this-fixture is not the point of this test), only the victim is 'live'.
  const completeSnapshot = Object.fromEntries(
    allDraftKeys(spec).map((key) => [
      key,
      key === victimKey ? { status: 'live', httpStatus: 402, code: null } : { status: 'not-live', httpStatus: 403, code: 'ROUTE_NOT_MAPPED' },
    ]),
  );
  writeFileSync(draftLiveSnapshot, JSON.stringify(completeSnapshot));
  try {
    // Baseline: with no draft-live-snapshot, the draft stays suppressed and the run is clean.
    assert.equal(await main([join(REPO_ROOT, 'openapi.yaml'), '--live', liveSnapshot]), EXIT_OK);
    // Tell the CLI the same draft answers live — the suppression must lift and the run must go red.
    assert.equal(
      await main([join(REPO_ROOT, 'openapi.yaml'), '--live', liveSnapshot, '--draft-live-snapshot', draftLiveSnapshot]),
      EXIT_DRIFT,
    );
  } finally {
    rmSync(liveSnapshot, { force: true });
    rmSync(draftLiveSnapshot, { force: true });
  }
});

test('main(): an unparseable draft-live-snapshot exits UNKNOWN, never OK', async () => {
  const { writeFileSync, rmSync } = await import('node:fs');
  const bad = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-draftlive-badsnapshot-${process.pid}.json`);
  writeFileSync(bad, 'not json');
  try {
    assert.equal(
      await main([join(REPO_ROOT, 'openapi.yaml'), '--live', join(REPO_ROOT, 'openapi.yaml'), '--draft-live-snapshot', bad]),
      EXIT_UNKNOWN,
    );
  } finally {
    rmSync(bad, { force: true });
  }
});

test('main(): a null entry in a draft-live-snapshot exits UNKNOWN rather than crashing', async () => {
  // Before validation, `r.status` on a null probe result threw inside main()'s unresolved-probe
  // check — an untrusted fixture file could crash the process instead of failing loud with EXIT_UNKNOWN.
  const yaml = (await import('js-yaml')).default;
  const spec = yaml.load(readFileSync(join(REPO_ROOT, 'openapi.yaml'), 'utf8'));
  const { served } = servedWithoutDrafts(spec);
  const { writeFileSync, rmSync } = await import('node:fs');
  const liveSnapshot = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-draftlive-nullentry-live-${process.pid}.json`);
  const snapshot = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-draftlive-nullentry-${process.pid}.json`);
  writeFileSync(liveSnapshot, JSON.stringify(doc(served)));
  writeFileSync(snapshot, JSON.stringify({ 'POST /does-not-matter': null }));
  try {
    assert.equal(
      await main([join(REPO_ROOT, 'openapi.yaml'), '--live', liveSnapshot, '--draft-live-snapshot', snapshot]),
      EXIT_UNKNOWN,
    );
  } finally {
    rmSync(liveSnapshot, { force: true });
    rmSync(snapshot, { force: true });
  }
});

test('main(): a draft-live-snapshot entry with no status, or an unsupported status, exits UNKNOWN', async () => {
  // `{}` (missing status) or a typo'd status used to pass through as a Map entry and be graded
  // downstream as silently "not live" — this must be caught as invalid input instead.
  const yaml = (await import('js-yaml')).default;
  const spec = yaml.load(readFileSync(join(REPO_ROOT, 'openapi.yaml'), 'utf8'));
  const { served } = servedWithoutDrafts(spec);
  const { writeFileSync, rmSync } = await import('node:fs');
  const liveSnapshot = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-draftlive-badentry-live-${process.pid}.json`);
  const bareEntry = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-draftlive-bare-${process.pid}.json`);
  const badStatus = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-draftlive-badstatus-${process.pid}.json`);
  writeFileSync(liveSnapshot, JSON.stringify(doc(served)));
  writeFileSync(bareEntry, JSON.stringify({ 'POST /does-not-matter': {} }));
  writeFileSync(badStatus, JSON.stringify({ 'POST /does-not-matter': { status: 'sort-of-live' } }));
  try {
    assert.equal(
      await main([join(REPO_ROOT, 'openapi.yaml'), '--live', liveSnapshot, '--draft-live-snapshot', bareEntry]),
      EXIT_UNKNOWN,
    );
    assert.equal(
      await main([join(REPO_ROOT, 'openapi.yaml'), '--live', liveSnapshot, '--draft-live-snapshot', badStatus]),
      EXIT_UNKNOWN,
    );
  } finally {
    rmSync(liveSnapshot, { force: true });
    rmSync(bareEntry, { force: true });
    rmSync(badStatus, { force: true });
  }
});

// ── The refuse path: an unresolved probe result must never be graded, only refused. ──────────────
// main()'s real network path calls probeDraftOperations() (retries exhausted -> PROBE_UNKNOWN;
// drilled directly in published-drift-live-probe.test.mjs) and then checks every entry for
// `status === 'unknown'` before ever calling compare() — see published-drift.mjs. That guard reads
// identically whether the Map came from a real probe or from --draft-live-snapshot, so feeding it
// an 'unknown' entry here exercises the exact same branch a truly-unresolved network probe would
// hit, without a real network call.
test('main(): refuses (EXIT_UNKNOWN) rather than grade when a draft-liveness probe result is unresolved', async () => {
  const yaml = (await import('js-yaml')).default;
  const spec = yaml.load(readFileSync(join(REPO_ROOT, 'openapi.yaml'), 'utf8'));
  const { served } = servedWithoutDrafts(spec);
  const draftKeys = allDraftKeys(spec);
  assert.ok(draftKeys.length, 'the real spec must have at least one draft operation for this test to mean anything');

  const { writeFileSync, rmSync } = await import('node:fs');
  const snapshot = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-draftlive-unknown-${process.pid}.json`);
  const draftLiveSnapshot = join(process.env.RUNNER_TEMP ?? '/tmp', `published-drift-draftlive-unknown-fixture-${process.pid}.json`);
  writeFileSync(snapshot, JSON.stringify(doc(served)));
  // A complete snapshot except for its VERDICT: the first key resolves 'unknown' (a genuinely
  // unresolved probe), every other key resolves 'not-live' so completeness alone cannot be why
  // this refuses — only the unresolved entry can be.
  const completeSnapshot = Object.fromEntries(
    draftKeys.map((key, i) => [
      key,
      i === 0
        ? { status: 'unknown', error: 'timed out after 10000ms' }
        : { status: 'not-live', httpStatus: 403, code: 'ROUTE_NOT_MAPPED' },
    ]),
  );
  writeFileSync(draftLiveSnapshot, JSON.stringify(completeSnapshot));
  try {
    assert.equal(
      await main([join(REPO_ROOT, 'openapi.yaml'), '--live', snapshot, '--draft-live-snapshot', draftLiveSnapshot]),
      EXIT_UNKNOWN,
      'an unresolved probe result must refuse — it says nothing about whether the route is live',
    );
  } finally {
    rmSync(snapshot, { force: true });
    rmSync(draftLiveSnapshot, { force: true });
  }
});
