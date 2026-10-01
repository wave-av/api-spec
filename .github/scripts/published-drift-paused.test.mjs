#!/usr/bin/env node
/**
 * published-drift-paused.test.mjs — the published document's own `x-wave-paused-products` declaration
 * explains why a paused product's operations are absent from it (see published-drift-paused.mjs).
 *
 * Measured 2026-10-01: build 06e4efce1050 omits /v1/render, /v1/renders, /v1/enhance and /v1/video-gen and
 * declares them paused at the document root, while CONTRACT-001 reported POST /enhance, POST /render,
 * GET /render/{jobId} and GET /render/{jobId}/events as unexplained unpublished-repo findings.
 *
 * Offline, deterministic, zero network. Run: node --test .github/scripts/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { compare } from './published-drift-compare.mjs';
import { pausedProductFor, pausedProducts } from './published-drift-paused.mjs';

const op = (summary) => ({ summary, responses: { 200: { description: 'ok' } } });
const SERVERS = [{ url: 'https://api.wave.online/v1' }];
const repoDoc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1.1.0' },
  servers: SERVERS,
  paths: {
    '/clips': { get: op('List clips') },
    '/render': { post: op('Start a render') },
    '/render/{jobId}': { get: op('Get a render job') },
    '/renders': { get: op('List renders') },
    '/enhance': { post: op('Enhance') },
  },
};
const PAUSED = {
  note: 'These products are paused and not sold; their operations are omitted from this document.',
  products: [
    { path: '/v1/render', product: 'render', paused_since: '2026-09-24' },
    { path: '/v1/enhance', product: 'enhance', paused_since: '2026-09-24' },
  ],
};
const liveDoc = (extra = {}) => ({ openapi: '3.1.0', info: { title: 't', version: '1.1.0' }, servers: SERVERS, paths: { '/clips': { get: op('List clips') } }, ...extra });
const unpublished = (r) => r.findings.filter((f) => f.direction === 'unpublished-repo').map((f) => `${f.method} ${f.path}`).sort();

test('pausedProducts reads the declaration and the server base path', () => {
  const p = pausedProducts(liveDoc({ 'x-wave-paused-products': PAUSED }));
  assert.deepEqual(p.map((x) => [x.prefix, x.product, x.pausedSince, x.base]), [
    ['/v1/render', 'render', '2026-09-24', '/v1'],
    ['/v1/enhance', 'enhance', '2026-09-24', '/v1'],
  ]);
  assert.deepEqual(pausedProducts(liveDoc()), [], 'no declaration, nothing paused');
  assert.deepEqual(pausedProducts(liveDoc({ 'x-wave-paused-products': { products: [{ path: '/' }, { path: 'render' }, null] } })), [], 'malformed rows are ignored');
});

test('a paused prefix covers its own path and sub-paths, never a sibling that merely shares letters', () => {
  const p = pausedProducts(liveDoc({ 'x-wave-paused-products': PAUSED }));
  assert.equal(pausedProductFor('/render', p)?.product, 'render');
  assert.equal(pausedProductFor('/render/{jobId}/events', p)?.product, 'render');
  assert.equal(pausedProductFor('/renders', p), null, '/v1/render must not cover /v1/renders');
  assert.equal(pausedProductFor('/clips', p), null);
});

test('declared-paused operations are listed as pausedNotPublished, not as unexplained findings', () => {
  const r = compare({ repoDoc, liveDoc: liveDoc({ 'x-wave-paused-products': PAUSED }) });
  assert.deepEqual(unpublished(r), ['GET /renders'], 'only the operation the document does NOT declare paused is a finding');
  assert.deepEqual(r.pausedNotPublished.map((e) => `${e.method} ${e.path} ${e.pausedProduct}`).sort(), [
    'GET /render/{jobId} render',
    'POST /enhance enhance',
    'POST /render render',
  ]);
  assert.equal(r.headline.pausedNotPublished, 3);
  assert.equal(r.headline.unpublishedRepo, 1);
});

test('control: without the declaration the same absences are unexplained findings, exactly as before', () => {
  const r = compare({ repoDoc, liveDoc: liveDoc() });
  assert.deepEqual(unpublished(r), ['GET /render/{jobId}', 'GET /renders', 'POST /enhance', 'POST /render']);
  assert.equal(r.headline.pausedNotPublished, 0);
});

test('a declared-paused operation that IS published is compared normally, never exempted', () => {
  const live = liveDoc({ 'x-wave-paused-products': PAUSED });
  live.paths['/render'] = { post: op('Start a render (changed)') };
  const r = compare({ repoDoc, liveDoc: live });
  assert.ok(!r.pausedNotPublished.some((e) => e.path === '/render' && e.method === 'POST'));
  assert.ok(r.findings.some((f) => f.direction === 'shared-drift' && f.path === '/render'), 'its content difference is still a finding');
});
