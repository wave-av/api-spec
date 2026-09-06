#!/usr/bin/env node
/**
 * ga-evidence.mjs — GA-evidence PRODUCER for wave-av/api-spec, on the wave-av/sdks pattern (see
 * that repo's scripts/ga/registry-cleanroom.mjs and .github/workflows/registry-cleanroom.yml).
 *
 * Runs this repo's two GA-gate criteria — CONTRACT-001 (contract-001-check.mjs) and COMPAT-001
 * (compat-001-check.mjs) — and writes:
 *   ga-out/ga-report.json                          full detail: every sub-check, both raw runs
 *   ga-out/wave-av__api-spec.ga-evidence.json       the schema-shaped document, ready to drop into
 *                                                   governance/ga-gate/evidence/incoming/ in
 *                                                   claude-workstation (a separate, credential-
 *                                                   gated cross-repo step — not done by this repo)
 *
 * STATUS RULES — computed, never hardcoded (see each check module for what it actually verifies):
 *   CONTRACT-001  pass    both operation-parity and content-digest checks passed
 *                 fail    either check found a genuine difference
 *                 unknown the gate could not run (fetch/parse/allowlist failure) — a could-not-run
 *                         is never reported as a pass
 *   COMPAT-001    fail    oasdiff found at least one ERR-level (breaking) change
 *                 unknown the breaking-change check ran clean OR the gate could not run — EITHER
 *                         way this criterion's `deprecation notice / migration path / support
 *                         window` half is never machine-verified by this repo, so a clean breaking-
 *                         change run can still never be reported as a full `pass`. failing_checks
 *                         always names exactly what stays unverified.
 *
 * EXIT CODE: mirrors the two checks' own contract — 0 if every emitted result is `pass`, 1 if any
 * result is `fail`, 2 if any result is `unknown` because its gate could not run at all (as
 * distinct from "ran, and one half is honestly unverifiable", which is a normal `unknown` and does
 * not itself force a non-zero producer exit — see COULD_NOT_RUN below).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { run as runContract001 } from './contract-001-check.mjs';
import { run as runCompat001 } from './compat-001-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const REPOSITORY = 'wave-av/api-spec';
const SPEC_VERSION = '1.0.0';
const EVIDENCE_URI = 'ci://wave-av/api-spec/.github/workflows/ga-evidence.yml#ga-report.json';

function parseArgs(argv) {
  const out = { outDir: join(REPO_ROOT, 'ga-out') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out-dir') out.outDir = resolve(argv[++i]);
  }
  return out;
}

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => {
      o[k] = sortKeysDeep(v[k]);
      return o;
    }, {});
  }
  return v;
}

function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function gitRevParseHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

/** ISO 8601 UTC, truncated to whole seconds — no milliseconds, per the evidence schema's utcTimestamp. */
function nowIsoSeconds() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build the CONTRACT-001 result row from contract-001-check.mjs's raw output.
 * `couldNotRun` -> status 'unknown' (a failed read says nothing about the criterion and must
 * never be graded as a pass); otherwise 'pass' only when every sub-check passed, else 'fail'.
 */
export function buildContractRow(raw) {
  const command = 'scripts/ga/check-CONTRACT-001.sh';
  if (raw.couldNotRun) {
    const detail = raw.checks[0]?.detail ?? 'unknown failure';
    return {
      criterion_id: 'CONTRACT-001',
      status: 'unknown',
      command,
      failing_checks: [`gate could not run — ${raw.checks[0]?.name}: ${detail}`.slice(0, 500)],
      targets_observed: [],
      fingerprintPayload: { criterion_id: 'CONTRACT-001', couldNotRun: true, checks: raw.checks.map((c) => [c.name, c.ok, c.detail]) },
    };
  }
  const allPass = raw.checks.every((c) => c.ok === true);
  const failing = raw.checks.filter((c) => c.ok !== true).map((c) => `${c.name}: ${c.detail}`.slice(0, 500));
  const targets = [
    `openapi.yaml@${raw.localDigest.slice(0, 12)}`,
    `live-openapi.json@${raw.liveDigest.slice(0, 12)}`,
  ];
  return {
    criterion_id: 'CONTRACT-001',
    status: allPass ? 'pass' : 'fail',
    command,
    failing_checks: allPass ? undefined : failing,
    targets_observed: targets,
    // `detail` is included (not just `ok`) so evidence-relevant content changes that don't flip a
    // boolean — e.g. which operations are undocumented-live — still change the fingerprint instead
    // of being deduplicated against stale evidence (cubic P2).
    fingerprintPayload: {
      criterion_id: 'CONTRACT-001',
      checks: raw.checks.map((c) => [c.name, c.ok, c.detail]).sort(),
      targets: [...targets].sort(),
    },
  };
}

/**
 * Build the COMPAT-001 result row. This criterion's status is NEVER 'pass' from this producer —
 * see the module header. A clean breaking-change run still reports 'unknown' because the
 * deprecation-notice half is unverified; a dirty run reports 'fail'; a gate that could not run
 * also reports 'unknown', distinguished in failing_checks.
 */
export function buildCompatRow(raw) {
  const command = 'scripts/ga/check-COMPAT-001.sh';
  if (raw.couldNotRun) {
    const detail = raw.checks[0]?.detail ?? 'unknown failure';
    return {
      criterion_id: 'COMPAT-001',
      status: 'unknown',
      command,
      failing_checks: [`gate could not run — ${raw.checks[0]?.name}: ${detail}`.slice(0, 500)],
      targets_observed: [],
      fingerprintPayload: { criterion_id: 'COMPAT-001', couldNotRun: true, checks: raw.checks.map((c) => [c.name, c.ok, c.detail]) },
    };
  }
  const breakingCheck = raw.checks.find((c) => c.name === 'breaking-changes');
  const targets = [`openapi.yaml@${raw.tag}`, `openapi.yaml@${raw.head.slice(0, 12)}`];
  const failing = [];
  let status;
  if (breakingCheck.ok === false) {
    status = 'fail';
    failing.push(`breaking-changes: ${breakingCheck.detail}`.slice(0, 500));
  } else {
    status = 'unknown';
  }
  // Always named, honestly, per the HONESTY RULES in this producer's brief: never claim the
  // deprecation-notice half of COMPAT-001's pass_condition.
  failing.push('deprecation notice/migration path not machine-verified');
  return {
    criterion_id: 'COMPAT-001',
    status,
    command,
    failing_checks: failing,
    targets_observed: targets,
    fingerprintPayload: {
      criterion_id: 'COMPAT-001',
      checks: raw.checks.map((c) => [c.name, c.ok, c.detail]).sort(),
      targets: [...targets].sort(),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const revision = gitRevParseHead();
  const verifiedAt = nowIsoSeconds();

  process.stdout.write(`ga-evidence — wave-av/api-spec @ ${revision.slice(0, 12)}\n\n`);

  const [contractRaw, compatRaw] = await Promise.all([runContract001(), runCompat001()]);

  process.stdout.write('-- CONTRACT-001 --\n');
  for (const c of contractRaw.checks) {
    const label = c.ok === null ? 'UNKNOWN' : c.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`${label} ${c.name}: ${c.detail}\n`);
  }
  process.stdout.write('\n-- COMPAT-001 --\n');
  for (const c of compatRaw.checks) {
    const label = c.ok === null || c.ok === 'unknown' ? 'UNKNOWN' : c.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`${label} ${c.name}: ${c.detail}\n`);
  }
  process.stdout.write('\n');

  const contractRow = buildContractRow(contractRaw);
  const compatRow = buildCompatRow(compatRaw);

  // ONE fingerprint over BOTH rows, sorted by criterion id before hashing — same idempotency
  // rule the gate spec states and the sdks producer follows (registry-cleanroom.mjs buildEvidence
  // computes one `fingerprint` shared by every row). Deliberately excludes timestamps, temp paths
  // and durations: two runs observing the same artifacts must produce the same digest.
  const fingerprintPayload = [contractRow.fingerprintPayload, compatRow.fingerprintPayload]
    .sort((a, b) => a.criterion_id.localeCompare(b.criterion_id));
  const fingerprint = sha256Hex(canonicalJson(fingerprintPayload));

  const results = [contractRow, compatRow]
    .sort((a, b) => a.criterion_id.localeCompare(b.criterion_id))
    .map((r) => {
      const { fingerprintPayload: _drop, failing_checks, ...rest } = r;
      const result = {
        ...rest,
        evidence_sha256: fingerprint,
        evidence_uri: EVIDENCE_URI,
        verified_at: verifiedAt,
      };
      if (failing_checks && failing_checks.length > 0) result.failing_checks = failing_checks;
      if (result.targets_observed && result.targets_observed.length === 0) delete result.targets_observed;
      return result;
    });

  const evidence = {
    spec_version: SPEC_VERSION,
    repository: REPOSITORY,
    revision,
    generated_at: verifiedAt,
    results,
  };

  const report = {
    schema: 'wave-api-spec-ga-evidence/1',
    spec_version: SPEC_VERSION,
    repository: REPOSITORY,
    revision,
    generated_at: verifiedAt,
    evidence_sha256: fingerprint,
    runner: { node: process.version, platform: process.platform },
    checks: {
      'CONTRACT-001': contractRaw,
      'COMPAT-001': compatRaw,
    },
    evidence,
  };

  mkdirSync(args.outDir, { recursive: true });
  writeFileSync(join(args.outDir, 'ga-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  // additionalProperties:false at every level of the evidence schema — evidence.json carries
  // ONLY the schema's own shape, never the raw check detail (that lives in ga-report.json).
  const evidenceOnly = { spec_version: SPEC_VERSION, repository: REPOSITORY, revision, generated_at: verifiedAt, results };
  writeFileSync(join(args.outDir, 'wave-av__api-spec.ga-evidence.json'), `${JSON.stringify(evidenceOnly, null, 2)}\n`);

  process.stdout.write(`${'-'.repeat(78)}\n`);
  for (const r of results) process.stdout.write(`${r.criterion_id}: ${r.status.toUpperCase()}\n`);
  process.stdout.write(`\nevidence fingerprint: ${fingerprint}\n`);
  process.stdout.write(`wrote ${join(args.outDir, 'ga-report.json')} and ${join(args.outDir, 'wave-av__api-spec.ga-evidence.json')}\n`);

  const anyCouldNotRun = contractRaw.couldNotRun || compatRaw.couldNotRun;
  const anyFail = results.some((r) => r.status === 'fail');
  if (anyCouldNotRun) {
    process.stdout.write('\nGA-EVIDENCE COULD NOT FULLY RUN\n');
    process.exitCode = 2;
    return;
  }
  if (anyFail) {
    process.stdout.write('\nGA-EVIDENCE FOUND FAILING CRITERIA\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\nga-evidence: ran cleanly (see per-criterion status above — unknown is not a failure but is not a pass either)\n');
}

// Guarded so importing this module for its exports (buildContractRow/buildCompatRow, tested in
// ga-evidence.test.mjs) does not run the full producer — contract-001-check.mjs and
// compat-001-check.mjs already follow this pattern; this file was missing it, which made `node
// --test` actually execute the live producer (network fetch, git tag read, oasdiff invocation) as
// an import side effect every time the test file loaded it.
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`ga-evidence could not run: ${e?.stack || e}\n`);
    process.exit(2);
  });
}
