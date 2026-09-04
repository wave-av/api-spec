#!/usr/bin/env node
/**
 * published-drift-live-probe.test.mjs — offline, deterministic, zero network. Every `doFetch` here
 * is a hand-built stub; nothing in this file makes a real HTTP request.
 *
 * Run: node --test .github/scripts/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROBE_LIVE,
  PROBE_NOT_LIVE,
  PROBE_UNKNOWN,
  probeDraftOperations,
  probeKey,
  probeOperation,
} from './published-drift-live-probe.mjs';

const jsonResponse = (status, body) => ({
  status,
  json: async () => body,
});

// ── The control: the gateway's own shape for "this route genuinely does not exist". ─────────────
test('403 ROUTE_NOT_MAPPED is the ONLY shape that reads as not-live', async () => {
  const notMapped = async () =>
    jsonResponse(403, { error: { code: 'ROUTE_NOT_MAPPED', message: 'no scope rule for this route (fail-closed)' } });
  const r = await probeOperation({ path: '/this-path-truly-does-not-exist-zz', method: 'POST' }, { doFetch: notMapped });
  assert.equal(r.status, PROBE_NOT_LIVE);
  assert.equal(r.httpStatus, 403);
  assert.equal(r.code, 'ROUTE_NOT_MAPPED');
});

// ── Every observed live shape from the 2026-09-04 measurement reads as live. ─────────────────────
test('402 (priced, unauthenticated) reads as live — the exact CONTRACT-001 signal', async () => {
  const priced = async () => jsonResponse(402, { x402Version: 1, error: 'payment required', accepts: [] });
  const r = await probeOperation({ path: '/accessibility-studio', method: 'POST' }, { doFetch: priced });
  assert.equal(r.status, PROBE_LIVE);
  assert.equal(r.httpStatus, 402);
});

test('401 AUTH_REQUIRED (a bearer-scoped route, not x402) reads as live, not not-live', async () => {
  const authRequired = async () => jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: 'authentication required' } });
  const r = await probeOperation({ path: '/zoom', method: 'POST' }, { doFetch: authRequired });
  assert.equal(r.status, PROBE_LIVE, '401 means the gateway routed the request — the opposite of ROUTE_NOT_MAPPED');
});

test('a 403 that is NOT ROUTE_NOT_MAPPED (a different fail-closed reason) still reads as live', async () => {
  const otherForbidden = async () => jsonResponse(403, { error: { code: 'SCOPE_DENIED', message: 'key lacks scope' } });
  const r = await probeOperation({ path: '/some-scoped-route', method: 'POST' }, { doFetch: otherForbidden });
  assert.equal(r.status, PROBE_LIVE, 'only the exact ROUTE_NOT_MAPPED code means "not live" — a bare 403 does not');
});

test('a 5xx from a misconfigured-but-real handler reads as live', async () => {
  const misconfigured = async () => jsonResponse(503, { error: { code: 'EGRESS_HOST_NOT_CONFIGURED' } });
  const r = await probeOperation({ path: '/ndi', method: 'POST' }, { doFetch: misconfigured });
  assert.equal(r.status, PROBE_LIVE);
});

test('a non-JSON body cannot spuriously read as not-live', async () => {
  const html = async () => ({ status: 402, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  const r = await probeOperation({ path: '/x', method: 'POST' }, { doFetch: html });
  assert.equal(r.status, PROBE_LIVE);
});

// ── UNKNOWN IS NEVER A PASS: a broken probe must never default to "not live". ────────────────────
test('a network error is UNKNOWN, never not-live', async () => {
  const boom = async () => {
    throw new Error('ECONNRESET');
  };
  const r = await probeOperation({ path: '/x', method: 'POST' }, { doFetch: boom });
  assert.equal(r.status, PROBE_UNKNOWN);
  assert.match(r.error, /ECONNRESET/);
});

test('a redirect is refused rather than followed, and reads as UNKNOWN', async () => {
  const bounce = async () => ({ status: 302, json: async () => ({}) });
  const r = await probeOperation({ path: '/x', method: 'POST' }, { doFetch: bounce });
  assert.equal(r.status, PROBE_UNKNOWN);
  assert.match(r.error, /redirected/);
});

test('probeKey matches the "METHOD /path" shape compare() indexes operations by', () => {
  assert.equal(probeKey({ path: '/render', method: 'post' }), 'POST /render');
  assert.equal(probeKey({ path: '/render', method: 'POST' }), 'POST /render');
});

// ── probeDraftOperations: concurrency, retries, and the map it hands back. ────────────────────────
test('probeDraftOperations probes every operation and keys the result by probeKey', async () => {
  const responses = {
    'POST /a': jsonResponse(402, {}),
    'POST /b': jsonResponse(403, { error: { code: 'ROUTE_NOT_MAPPED' } }),
  };
  const doFetch = async (url) => {
    const path = new URL(url).pathname.replace(/^\/v1/, '');
    return responses[`POST ${path}`];
  };
  const results = await probeDraftOperations(
    [
      { path: '/a', method: 'POST' },
      { path: '/b', method: 'POST' },
    ],
    { doFetch, concurrency: 2 },
  );
  assert.equal(results.get('POST /a').status, PROBE_LIVE);
  assert.equal(results.get('POST /b').status, PROBE_NOT_LIVE);
});

test('probeDraftOperations retries an UNKNOWN result and keeps the retried verdict', async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error('ETIMEDOUT');
    return jsonResponse(402, {});
  };
  const results = await probeDraftOperations([{ path: '/flaky', method: 'POST' }], {
    doFetch: flaky,
    retries: 2,
    retryDelayMs: 1,
  });
  assert.equal(calls, 2, 'the first UNKNOWN was retried');
  assert.equal(results.get('POST /flaky').status, PROBE_LIVE);
});

test('probeDraftOperations never silently converts an exhausted retry into a verdict — it stays UNKNOWN', async () => {
  const alwaysBoom = async () => {
    throw new Error('ECONNREFUSED');
  };
  const results = await probeDraftOperations([{ path: '/dead', method: 'POST' }], {
    doFetch: alwaysBoom,
    retries: 1,
    retryDelayMs: 1,
  });
  assert.equal(results.get('POST /dead').status, PROBE_UNKNOWN);
});

test('probeDraftOperations returns an empty map for an empty input without calling fetch', async () => {
  let called = false;
  const doFetch = async () => {
    called = true;
    return jsonResponse(200, {});
  };
  const results = await probeDraftOperations([], { doFetch });
  assert.equal(results.size, 0);
  assert.equal(called, false);
});
