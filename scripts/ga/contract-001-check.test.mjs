#!/usr/bin/env node
/**
 * contract-001-check.test.mjs — hermetic, offline, zero network (uses opts.repoSpecPath and
 * opts.liveFile, never fetch). Covers:
 *   - resolveJsonPointer / collectReachableRefs (pure, cubic P1's reachable-ref digest fix)
 *   - operation-parity vs content-digest independence (cubic P2: shared-drift must not also fail
 *     operation-parity)
 *   - a content-digest catch that only the reachable-ref fold makes possible: an operation whose
 *     own object is byte-identical on both sides, but whose $ref-referenced component schema
 *     changed, must be reported as a content-digest mismatch (the exact gap cubic P1 named)
 *
 * Run: node --test scripts/ga/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectReachableRefs, resolveJsonPointer, run } from './contract-001-check.mjs';

// ── resolveJsonPointer / collectReachableRefs ──────────────────────────────────────────────────

test('resolveJsonPointer: resolves a simple internal pointer', () => {
  const doc = { components: { schemas: { Widget: { type: 'object' } } } };
  assert.deepEqual(resolveJsonPointer(doc, '#/components/schemas/Widget'), { type: 'object' });
});

test('resolveJsonPointer: unescapes ~0 and ~1', () => {
  const doc = { components: { schemas: { 'a/b~c': { type: 'string' } } } };
  assert.deepEqual(resolveJsonPointer(doc, '#/components/schemas/a~1b~0c'), { type: 'string' });
});

test('resolveJsonPointer: a dangling pointer resolves to undefined, never throws', () => {
  const doc = { components: { schemas: {} } };
  assert.equal(resolveJsonPointer(doc, '#/components/schemas/Missing'), undefined);
});

test('resolveJsonPointer: a non-internal ($ref does not start with #/) pointer is ignored', () => {
  assert.equal(resolveJsonPointer({}, 'https://example.com/schema.json'), undefined);
});

test('collectReachableRefs: resolves a $ref reachable from a nested node', () => {
  const doc = {
    components: { schemas: { Widget: { type: 'object', properties: { id: { type: 'string' } } } } },
  };
  const op = { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } } } } };
  const refs = collectReachableRefs(op, doc);
  assert.equal(refs.size, 1);
  assert.deepEqual(refs.get('#/components/schemas/Widget'), doc.components.schemas.Widget);
});

test('collectReachableRefs: chases a ref through another ref (transitive)', () => {
  const doc = {
    components: {
      schemas: {
        Widget: { properties: { owner: { $ref: '#/components/schemas/Owner' } } },
        Owner: { type: 'string' },
      },
    },
  };
  const op = { schema: { $ref: '#/components/schemas/Widget' } };
  const refs = collectReachableRefs(op, doc);
  assert.equal(refs.size, 2);
  assert.ok(refs.has('#/components/schemas/Widget'));
  assert.ok(refs.has('#/components/schemas/Owner'));
});

test('collectReachableRefs: an external (non "#/") $ref is left unresolved, not thrown on', () => {
  const op = { schema: { $ref: 'external.json#/Thing' } };
  const refs = collectReachableRefs(op, {});
  assert.equal(refs.size, 0);
});

test('collectReachableRefs: a self-referential (cyclic) ref does not infinite-loop', () => {
  const doc = { components: { schemas: { Node: { properties: { next: { $ref: '#/components/schemas/Node' } } } } } };
  const op = { schema: { $ref: '#/components/schemas/Node' } };
  const refs = collectReachableRefs(op, doc);
  assert.equal(refs.size, 1);
});

// ── run() end-to-end against hermetic fixtures ─────────────────────────────────────────────────

function writeFixture(name, repoYaml, liveDoc) {
  const dir = mkdtempSync(join(tmpdir(), `ga-contract-test-${name}-`));
  mkdirSync(dir, { recursive: true });
  const repoSpecPath = join(dir, 'openapi.yaml');
  const liveFile = join(dir, 'live.json');
  writeFileSync(repoSpecPath, repoYaml);
  writeFileSync(liveFile, JSON.stringify(liveDoc, null, 2));
  return { dir, repoSpecPath, liveFile };
}

function checkByName(result, name) {
  return result.checks.find((c) => c.name === name);
}

test('run(): a content change reachable only via $ref is caught by content-digest, with byte-identical operations and zero shared-drift', async () => {
  const repoYaml = `
openapi: 3.1.0
info: {title: t, version: 1.0.0}
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/WidgetList'
components:
  schemas:
    WidgetList:
      type: object
      properties:
        items:
          type: array
`;
  const sharedOp = {
    operationId: 'listWidgets',
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/WidgetList' } } },
      },
    },
  };
  const liveDoc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1.0.0' },
    paths: { '/widgets': { get: sharedOp } },
    // The live component schema changed (an extra "total" property) while the operation still
    // points at the identical $ref — the exact gap cubic P1 named.
    components: { schemas: { WidgetList: { type: 'object', properties: { items: { type: 'array' }, total: { type: 'integer' } } } } },
  };
  const { dir, repoSpecPath, liveFile } = writeFixture('refs', repoYaml, liveDoc);
  try {
    const result = await run({ repoSpecPath, liveFile });
    assert.equal(result.couldNotRun, false);
    assert.equal(checkByName(result, 'operation-parity').ok, true, 'the operation itself is declared and served on both sides');
    assert.equal(checkByName(result, 'content-digest').ok, false, 'a referenced-schema change must flip the content digest even though the operation object is unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run(): operation-parity does not fail on a shared-drift-only difference (that is content-digest\'s job)', async () => {
  const repoYaml = `
openapi: 3.1.0
info: {title: t, version: 1.0.0}
paths:
  /alpha:
    get:
      operationId: getAlpha
      summary: Alpha v1
      responses:
        '200':
          description: OK
`;
  const liveDoc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1.0.0' },
    paths: {
      '/alpha': {
        get: { operationId: 'getAlpha', summary: 'Alpha v2', responses: { 200: { description: 'OK' } } },
      },
    },
  };
  const { dir, repoSpecPath, liveFile } = writeFixture('shared-drift', repoYaml, liveDoc);
  try {
    const result = await run({ repoSpecPath, liveFile });
    assert.equal(result.couldNotRun, false);
    assert.equal(checkByName(result, 'operation-parity').ok, true, 'a shared, differently-worded operation is not a parity problem');
    assert.equal(checkByName(result, 'content-digest').ok, false, 'the summary difference must still be caught, just by content-digest, not operation-parity');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run(): an undocumented-live operation fails operation-parity, independent of content-digest', async () => {
  const repoYaml = `
openapi: 3.1.0
info: {title: t, version: 1.0.0}
paths:
  /alpha:
    get:
      operationId: getAlpha
      responses:
        '200':
          description: OK
`;
  const sharedOp = { operationId: 'getAlpha', responses: { 200: { description: 'OK' } } };
  const liveDoc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1.0.0' },
    paths: {
      '/alpha': { get: sharedOp },
      // Served live, never declared in the repo spec.
      '/beta': { get: { operationId: 'getBeta', responses: { 200: { description: 'OK' } } } },
    },
  };
  const { dir, repoSpecPath, liveFile } = writeFixture('undocumented-live', repoYaml, liveDoc);
  try {
    const result = await run({ repoSpecPath, liveFile });
    assert.equal(result.couldNotRun, false);
    assert.equal(checkByName(result, 'operation-parity').ok, false);
    assert.match(checkByName(result, 'operation-parity').detail, /undocumented-live/);
    assert.equal(checkByName(result, 'content-digest').ok, true, '/beta is unmatched, so it never enters the shared-operation digest loop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
