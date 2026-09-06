#!/usr/bin/env node
/**
 * ga-evidence.test.mjs — hermetic, offline, zero network. Covers buildContractRow/buildCompatRow
 * status derivation directly against synthetic "raw" check results (gitar/cubic's explicit ask),
 * and the fingerprint-payload fix (cubic P2): two raw results with the same booleans but different
 * `detail` text must NOT collapse to the same fingerprint.
 *
 * Run: node --test scripts/ga/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCompatRow, buildContractRow } from './ga-evidence.mjs';

// ── buildContractRow ───────────────────────────────────────────────────────────────────────────

test('buildContractRow: couldNotRun -> status unknown, empty targets, failing_checks names the failure', () => {
  const row = buildContractRow({ couldNotRun: true, checks: [{ name: 'live-fetch', ok: null, detail: 'HTTP 503' }] });
  assert.equal(row.status, 'unknown');
  assert.deepEqual(row.targets_observed, []);
  assert.match(row.failing_checks[0], /live-fetch: HTTP 503/);
});

test('buildContractRow: both sub-checks pass -> status pass, no failing_checks', () => {
  const row = buildContractRow({
    couldNotRun: false,
    checks: [
      { name: 'operation-parity', ok: true, detail: 'zero unexplained operations' },
      { name: 'content-digest', ok: true, detail: 'digests match' },
    ],
    localDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    liveDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.equal(row.status, 'pass');
  assert.equal(row.failing_checks, undefined);
});

test('buildContractRow: one sub-check fails -> status fail, failing_checks names only the failing one', () => {
  const row = buildContractRow({
    couldNotRun: false,
    checks: [
      { name: 'operation-parity', ok: true, detail: 'zero unexplained operations' },
      { name: 'content-digest', ok: false, detail: 'digests differ' },
    ],
    localDigest: 'a'.repeat(64),
    liveDigest: 'b'.repeat(64),
  });
  assert.equal(row.status, 'fail');
  assert.deepEqual(row.failing_checks, ['content-digest: digests differ']);
});

// ── buildCompatRow ─────────────────────────────────────────────────────────────────────────────

test('buildCompatRow: couldNotRun -> status unknown', () => {
  const row = buildCompatRow({ couldNotRun: true, checks: [{ name: 'baseline-tag', ok: null, detail: 'no v* tag found' }] });
  assert.equal(row.status, 'unknown');
});

test('buildCompatRow: a clean breaking-changes run is still unknown, never pass (the module\'s own honesty rule)', () => {
  const row = buildCompatRow({
    couldNotRun: false,
    tag: 'v1.0.0',
    head: 'deadbeef',
    checks: [
      { name: 'breaking-changes', ok: true, detail: 'zero breaking changes' },
      { name: 'deprecation-notice', ok: 'unknown', detail: 'not machine-verified' },
    ],
  });
  assert.equal(row.status, 'unknown');
  assert.ok(row.failing_checks.some((f) => f.includes('deprecation notice/migration path not machine-verified')));
});

test('buildCompatRow: a breaking change found -> status fail', () => {
  const row = buildCompatRow({
    couldNotRun: false,
    tag: 'v1.0.0',
    head: 'deadbeef',
    checks: [
      { name: 'breaking-changes', ok: false, detail: '1 breaking change' },
      { name: 'deprecation-notice', ok: 'unknown', detail: 'not machine-verified' },
    ],
  });
  assert.equal(row.status, 'fail');
  assert.ok(row.failing_checks.some((f) => f.startsWith('breaking-changes:')));
});

// ── fingerprint sensitivity (cubic P2) ────────────────────────────────────────────────────────

test('buildContractRow: fingerprintPayload changes when a check\'s detail changes even though ok stays the same', () => {
  const base = (detail) => ({
    couldNotRun: false,
    checks: [
      { name: 'operation-parity', ok: false, detail },
      { name: 'content-digest', ok: true, detail: 'digests match' },
    ],
    localDigest: 'a'.repeat(64),
    liveDigest: 'a'.repeat(64),
  });
  const rowA = buildContractRow(base('1 unexplained operation-level finding(s): undocumented-live GET /a'));
  const rowB = buildContractRow(base('1 unexplained operation-level finding(s): undocumented-live GET /b'));
  assert.equal(rowA.checks?.[0]?.ok, undefined, 'sanity: buildContractRow does not itself expose a top-level checks array');
  assert.notDeepEqual(
    rowA.fingerprintPayload,
    rowB.fingerprintPayload,
    'two different findings behind the same boolean must not produce the same fingerprint input, or a real evidence change gets deduplicated as stale',
  );
});
