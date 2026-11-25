#!/usr/bin/env node
/**
 * foundation-gate-oasdiff-ssrf.test.mjs — mutation proof that the required
 * `breaking-change` job refuses to fetch PR-controlled OpenAPI `$ref`s.
 *
 * oasdiff follows external `$ref`s by default (`--allow-external-refs` defaults
 * to true). This repo already documents that as CI SSRF in
 * `compat-001-check.mjs` and disables it there. The required PR gate in
 * `.github/workflows/foundation-gate.yml` must do the same: a fork PR can put
 * `$ref: http://169.254.169.254/...` (or a `file://` path) in openapi.yaml, and
 * the job checks out PR HEAD and runs oasdiff over it.
 *
 * Offline: reads the workflow file. No network, no oasdiff binary.
 *
 * Run: node --test scripts/ga/foundation-gate-oasdiff-ssrf.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = readFileSync(join(REPO_ROOT, '.github/workflows/foundation-gate.yml'), 'utf8');

const JOB_START = WORKFLOW.indexOf('\n  breaking-change:');
assert.ok(JOB_START >= 0, 'foundation-gate.yml must declare a breaking-change job');
const jobRest = WORKFLOW.slice(JOB_START + 1);
const nextTopLevelJob = jobRest.slice(1).search(/^\s{2}\S[^\n]*:\s*$/m);
const JOB = nextTopLevelJob > 0 ? jobRest.slice(0, nextTopLevelJob + 1) : jobRest;

test('the breaking-change job invokes oasdiff with --allow-external-refs=false (equals form)', () => {
  // Boolean flags require `=` when setting false; `--allow-external-refs false`
  // is parsed as a positional spec path (oasdiff/docs/EXTERNAL-REFS.md).
  assert.match(
    JOB,
    /oasdiff breaking[^\n]*--allow-external-refs=false/,
    'oasdiff breaking on a PR-supplied openapi.yaml must disable external $ref fetches (CI SSRF)',
  );
  assert.doesNotMatch(
    JOB,
    /oasdiff breaking[^\n]*--allow-external-refs(?:\s+false|\s*$)/m,
    'must use --allow-external-refs=false, not a space-separated false that oasdiff ignores',
  );
});

test('an external-$ref refusal (oasdiff exit 123) is a hard fail, not a Breaking: yes pass', () => {
  // Exit 123 is oasdiff's dedicated "external $ref refused" code. Folding it
  // into the generic non-zero branch would let a PR body containing
  // "Breaking: yes" launder an unreviewed external $ref through the gate.
  // Compare inside the `run: |` script, not the comments — the comments mention
  // both strings in documentation order, which is not execution order.
  const oasdiffRun = JOB.indexOf('oasdiff breaking --allow-external-refs=false');
  assert.ok(oasdiffRun >= 0, 'the breaking-change job must invoke oasdiff breaking with external refs disabled');
  const run = JOB.slice(oasdiffRun);
  const breakingYesIdx = run.search(/Breaking: yes/);
  const exit123Idx = run.search(/\[ "\$code" = "123" \]/);
  assert.ok(exit123Idx >= 0, 'the run script must branch on oasdiff exit 123');
  assert.ok(breakingYesIdx >= 0, 'the run script must still honour Breaking: yes for real contract breaks');
  assert.ok(
    exit123Idx < breakingYesIdx,
    'exit 123 must be handled BEFORE the Breaking: yes acknowledgement, or the acknowledgement would swallow the SSRF refusal',
  );
});
