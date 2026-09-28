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

function writeFixture(name, repoYaml, liveDoc, allowlist) {
  const dir = mkdtempSync(join(tmpdir(), `ga-contract-test-${name}-`));
  mkdirSync(dir, { recursive: true });
  const repoSpecPath = join(dir, 'openapi.yaml');
  const liveFile = join(dir, 'live.json');
  writeFileSync(repoSpecPath, repoYaml);
  writeFileSync(liveFile, JSON.stringify(liveDoc, null, 2));
  let allowlistPath;
  if (allowlist) {
    allowlistPath = join(dir, 'allowlist.json');
    writeFileSync(allowlistPath, JSON.stringify(allowlist, null, 2));
  }
  return { dir, repoSpecPath, liveFile, allowlistPath };
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

// ── content-digest honours the same `shared-drift` allowlist operation-parity does ──────────────
//
// BOTH DIRECTIONS ARE PINNED HERE ON PURPOSE. Subtracting an exemption from a digest is exactly the
// shape of change that can quietly become a way to switch a criterion off, so it is not enough to
// show that an allowlisted difference stops failing: the tests below also hold that a NON-allowlisted
// difference, a difference sitting alongside an allowlisted one, and an allowlist entry whose lapsing
// predicate no longer matches the live document all still fail. An exemption may only ever remove an
// operation from the comparison; it may never turn a real mismatch into a pass.

const TWO_OP_REPO_YAML = `
openapi: 3.1.0
info: {title: t, version: 1.0.0}
paths:
  /alpha:
    get:
      operationId: getAlpha
      summary: Alpha as this repo documents it
      responses:
        '200':
          description: OK
  /beta:
    get:
      operationId: getBeta
      summary: Beta
      responses:
        '200':
          description: OK
`;

/** /alpha diverges (a different summary); /beta is byte-identical to the repo's declaration. */
function twoOpLiveDoc(extraPaths = {}) {
  return {
    openapi: '3.1.0',
    info: { title: 't', version: '1.0.0' },
    paths: {
      '/alpha': { get: { operationId: 'getAlpha', summary: 'Alpha as the gateway generates it', responses: { 200: { description: 'OK' } } } },
      '/beta': { get: { operationId: 'getBeta', summary: 'Beta', responses: { 200: { description: 'OK' } } } },
      ...extraPaths,
    },
  };
}

const ALPHA_EXEMPTION = {
  path: '/alpha',
  method: 'GET',
  direction: 'shared-drift',
  justification: 'Editorial-only summary divergence between the hand-written declaration and the generated one; keyed on the published operationId so the exemption lapses if this operation is ever renamed or regenerated.',
  expect: { operationId: 'getAlpha' },
};

test('content-digest: WITHOUT the exemption, the allowlistable difference fails the digest (fail-before)', async () => {
  const { dir, repoSpecPath, liveFile, allowlistPath } = writeFixture('al-before', TWO_OP_REPO_YAML, twoOpLiveDoc(), []);
  try {
    const result = await run({ repoSpecPath, liveFile, allowlistPath });
    assert.equal(result.couldNotRun, false);
    assert.equal(checkByName(result, 'content-digest').ok, false, 'an empty allowlist must leave /alpha in the digest');
    assert.equal(result.exemptedCount, 0);
    assert.equal(result.digestedCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content-digest: WITH the exemption honoured, the same difference does not trip the digest (pass-after)', async () => {
  const { dir, repoSpecPath, liveFile, allowlistPath } = writeFixture('al-after', TWO_OP_REPO_YAML, twoOpLiveDoc(), [ALPHA_EXEMPTION]);
  try {
    const result = await run({ repoSpecPath, liveFile, allowlistPath });
    assert.equal(result.couldNotRun, false);
    assert.equal(checkByName(result, 'operation-parity').ok, true);
    assert.equal(checkByName(result, 'content-digest').ok, true, 'a still-live shared-drift exemption must be subtracted from the digest, as operation-parity already subtracts it');
    assert.equal(result.exemptedCount, 1, 'exactly the one exempted operation is excluded');
    assert.equal(result.digestedCount, 1, '/beta is still compared');
    assert.equal(result.sharedCount, 2, 'the shared count still reports the true total');
    assert.match(checkByName(result, 'content-digest').detail, /1 allowlisted shared-drift exemption\(s\) excluded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content-digest: an exemption does NOT silence a different, non-allowlisted operation', async () => {
  // /gamma is served with a summary the repo never declared and carries no exemption. Its presence
  // alongside an honoured /alpha exemption must still fail the digest — this is the half of the
  // behaviour that stops the allowlist becoming a way to switch the criterion off.
  const repoYaml = `${TWO_OP_REPO_YAML}  /gamma:
    get:
      operationId: getGamma
      summary: Gamma as this repo documents it
      responses:
        '200':
          description: OK
`;
  const live = twoOpLiveDoc({
    '/gamma': { get: { operationId: 'getGamma', summary: 'Gamma as the gateway serves it', responses: { 200: { description: 'OK' } } } },
  });
  const { dir, repoSpecPath, liveFile, allowlistPath } = writeFixture('al-nonexempt', repoYaml, live, [ALPHA_EXEMPTION]);
  try {
    const result = await run({ repoSpecPath, liveFile, allowlistPath });
    assert.equal(result.couldNotRun, false);
    assert.equal(checkByName(result, 'content-digest').ok, false, 'a non-allowlisted content difference must still fail even when a sibling operation is exempted');
    assert.equal(result.exemptedCount, 1, 'the exemption applies to /alpha only — it never widens to cover /gamma');
    assert.equal(result.digestedCount, 2, '/beta and /gamma are both still compared');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content-digest: a non-allowlisted $ref-only change still fails while a sibling exemption stands', async () => {
  // The reachable-$ref fold must survive the subtraction: /delta's own operation object is
  // byte-identical on both sides and only its referenced component schema moved.
  const repoYaml = `${TWO_OP_REPO_YAML}  /delta:
    get:
      operationId: getDelta
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/DeltaBody'
components:
  schemas:
    DeltaBody:
      type: object
      properties:
        id:
          type: string
`;
  const deltaOp = {
    operationId: 'getDelta',
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/DeltaBody' } } } } },
  };
  const live = twoOpLiveDoc({ '/delta': { get: deltaOp } });
  live.components = { schemas: { DeltaBody: { type: 'object', properties: { id: { type: 'string' }, extra: { type: 'integer' } } } } };
  const { dir, repoSpecPath, liveFile, allowlistPath } = writeFixture('al-refs', repoYaml, live, [ALPHA_EXEMPTION]);
  try {
    const result = await run({ repoSpecPath, liveFile, allowlistPath });
    assert.equal(result.couldNotRun, false);
    assert.equal(checkByName(result, 'content-digest').ok, false, 'a referenced-schema change on a non-exempt operation must still flip the digest');
    assert.equal(result.exemptedCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content-digest: an exemption whose lapsing predicate no longer matches is NOT subtracted', async () => {
  // The published operationId moved, so the entry's `expect` no longer holds. compare() reports it
  // as lapsed rather than honoured, and the operation must fall straight back into the digest —
  // otherwise an exemption would outlive the justification it was granted under.
  const lapsed = { ...ALPHA_EXEMPTION, expect: { operationId: 'getAlphaRenamedSinceThisEntryWasWritten' } };
  const { dir, repoSpecPath, liveFile, allowlistPath } = writeFixture('al-lapsed', TWO_OP_REPO_YAML, twoOpLiveDoc(), [lapsed]);
  try {
    const result = await run({ repoSpecPath, liveFile, allowlistPath });
    assert.equal(result.couldNotRun, false);
    assert.equal(checkByName(result, 'content-digest').ok, false, 'a lapsed exemption must not be subtracted from the digest');
    assert.equal(result.exemptedCount, 0);
    assert.equal(result.digestedCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content-digest: an exemption for a DIFFERENT direction never subtracts a shared operation', async () => {
  // Only `shared-drift` describes an accepted difference between two operations that both exist.
  // An entry in any other direction must not remove an operation from the digest.
  const wrongDirection = {
    path: '/alpha',
    method: 'GET',
    direction: 'undocumented-live',
    justification: 'A deliberately mis-directed entry used to prove the subtraction is keyed on the shared-drift direction and not on path+method alone.',
    expect: { operationId: 'getAlpha' },
  };
  const { dir, repoSpecPath, liveFile, allowlistPath } = writeFixture('al-direction', TWO_OP_REPO_YAML, twoOpLiveDoc(), [wrongDirection]);
  try {
    const result = await run({ repoSpecPath, liveFile, allowlistPath });
    assert.equal(result.couldNotRun, false);
    assert.equal(result.exemptedCount, 0, 'an undocumented-live entry must not exempt a shared operation from the content digest');
    assert.equal(checkByName(result, 'content-digest').ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
