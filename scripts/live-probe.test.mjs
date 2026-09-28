#!/usr/bin/env node
/**
 * live-probe.test.mjs — hermetic, offline, zero network. Covers the pure decision logic
 * live-probe.mjs's CLI wraps: argument parsing, preview detection, the --only/--strict-preview
 * selection filter, path-template placeholder filling, and the pass/fail verdict itself (the
 * exact behavior the liveProof step depends on: a non-preview route that answers ROUTE_NOT_FOUND
 * / ROUTE_NOT_MAPPED must fail; a preview route answering the same must pass unless
 * --strict-preview is set).
 *
 * Run: node --test scripts/live-probe.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, fillPathTemplate, isPreview, shouldProbe, isFailure } from './live-probe.mjs';

// ── parseArgs ────────────────────────────────────────────────────────────────────────────────

test('parseArgs: defaults with no flags', () => {
  assert.deepEqual(parseArgs([]), { only: null, strictPreview: false, json: false });
});

test('parseArgs: --only splits and trims a comma-separated list', () => {
  const args = parseArgs(['--only', 'srt, moq ,whip']);
  assert.deepEqual(args.only, ['srt', 'moq', 'whip']);
});

test('parseArgs: --strict-preview and --json are independent boolean flags', () => {
  const args = parseArgs(['--strict-preview', '--json']);
  assert.equal(args.strictPreview, true);
  assert.equal(args.json, true);
  assert.equal(args.only, null);
});

// ── fillPathTemplate ─────────────────────────────────────────────────────────────────────────

test('fillPathTemplate: leaves a template with no params untouched', () => {
  assert.equal(fillPathTemplate('/srt'), '/srt');
});

test('fillPathTemplate: fills a single path param', () => {
  assert.equal(fillPathTemplate('/streams/{streamId}'), '/streams/live-probe-smoke');
});

test('fillPathTemplate: fills every param when there is more than one', () => {
  assert.equal(
    fillPathTemplate('/moq/publish/{ns}/{track}'),
    '/moq/publish/live-probe-smoke/live-probe-smoke',
  );
});

// ── isPreview ────────────────────────────────────────────────────────────────────────────────

test('isPreview: operation-level x-wave-availability: preview wins', () => {
  assert.equal(isPreview({ 'x-wave-availability': 'preview' }, {}), true);
});

test('isPreview: operation-level x-schema-status: preview also counts', () => {
  assert.equal(isPreview({ 'x-schema-status': 'preview' }, {}), true);
});

test('isPreview: falls back to the path-item level when the operation does not say', () => {
  assert.equal(isPreview({}, { 'x-wave-availability': 'preview' }), true);
});

test('isPreview: a GA operation (x-wave-availability: ga) is not preview', () => {
  assert.equal(isPreview({ 'x-wave-availability': 'ga', 'x-schema-status': 'draft' }, {}), false);
});

test('isPreview: an operation with neither field is not preview', () => {
  assert.equal(isPreview({}, {}), false);
});

// ── shouldProbe ──────────────────────────────────────────────────────────────────────────────

test('shouldProbe: a non-preview op is probed with no --only filter', () => {
  assert.equal(shouldProbe('/srt', {}, {}, { only: null, strictPreview: false }), true);
});

test('shouldProbe: --only excludes a path with a non-matching prefix', () => {
  assert.equal(shouldProbe('/dante', {}, {}, { only: ['srt', 'moq'], strictPreview: false }), false);
});

test('shouldProbe: --only matches an exact single-segment path', () => {
  assert.equal(shouldProbe('/srt', {}, {}, { only: ['srt'], strictPreview: false }), true);
});

test('shouldProbe: --only matches a deeper path by prefix', () => {
  assert.equal(
    shouldProbe('/moq/publish/{ns}/{track}', {}, {}, { only: ['moq'], strictPreview: false }),
    true,
  );
});

test('shouldProbe: a preview op is skipped by default (not --strict-preview)', () => {
  const op = { 'x-wave-availability': 'preview' };
  assert.equal(shouldProbe('/aes67', op, {}, { only: null, strictPreview: false }), false);
});

test('shouldProbe: --strict-preview re-includes a preview op', () => {
  const op = { 'x-wave-availability': 'preview' };
  assert.equal(shouldProbe('/aes67', op, {}, { only: null, strictPreview: true }), true);
});

// ── isFailure — the exact verdict the liveProof gate depends on ────────────────────────────────

test('isFailure: a non-preview route answering ROUTE_NOT_FOUND fails (the stale-doc case)', () => {
  assert.equal(isFailure({ ok: true, preview: false, status: 404, code: 'ROUTE_NOT_FOUND' }), true);
});

test('isFailure: a non-preview route answering ROUTE_NOT_MAPPED fails', () => {
  assert.equal(isFailure({ ok: true, preview: false, status: 403, code: 'ROUTE_NOT_MAPPED' }), true);
});

test('isFailure: a non-preview route answering 402 (x402 challenge) passes — proven live', () => {
  assert.equal(isFailure({ ok: true, preview: false, status: 402, code: 'PAYMENT_REQUIRED' }), false);
});

test('isFailure: a non-preview route answering 401 AUTH_REQUIRED passes', () => {
  assert.equal(isFailure({ ok: true, preview: false, status: 401, code: 'AUTH_REQUIRED' }), false);
});

test('isFailure: a non-preview route answering a route-specific 503 passes (e.g. NDI egress-host-unconfigured)', () => {
  assert.equal(
    isFailure({ ok: true, preview: false, status: 503, code: 'EGRESS_HOST_NOT_CONFIGURED' }),
    false,
  );
});

test('isFailure: a preview route answering 404 passes by default (honest preview behavior)', () => {
  assert.equal(isFailure({ ok: true, preview: true, status: 404, code: 'ROUTE_NOT_FOUND' }), false);
});

test('isFailure: a preview route answering 503 passes by default', () => {
  assert.equal(isFailure({ ok: true, preview: true, status: 503, code: null }), false);
});

test('isFailure: under strict-preview semantics a preview route answering 200 fails (secretly-live)', () => {
  // isFailure itself does not read args; the row's `preview` flag already encodes strict-preview's
  // inclusion decision (shouldProbe gates whether the row exists at all). Given a preview row that
  // WAS probed (i.e. --strict-preview was set), a 2xx must fail.
  assert.equal(isFailure({ ok: true, preview: true, status: 200, code: null }), true);
});

test('isFailure: a network/timeout failure is never a pass, preview or not', () => {
  assert.equal(isFailure({ ok: false, preview: false, error: 'timed out after 15000ms' }), true);
  assert.equal(isFailure({ ok: false, preview: true, error: 'timed out after 15000ms' }), true);
});
