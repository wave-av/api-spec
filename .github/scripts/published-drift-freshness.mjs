#!/usr/bin/env node
/**
 * published-drift-freshness.mjs — is the COMMITTED `contract-drift.json` still a receipt for the
 * CURRENT `openapi.yaml`, or has the spec moved on underneath it?
 *
 * WHY THIS EXISTS AS A SEPARATE GATE. `contract-drift.json` is a point-in-time artifact: it says
 * so in its own `about` field. That honesty covers the PUBLISHED half of the picture — the gateway
 * can change under it at any moment, and only the scheduled networked job can see that. It does
 * NOT cover the REPO half. openapi.yaml lives in this repo and changes only by pull request, so a
 * receipt that disagrees with the spec sitting next to it is not "a dated view of a moving world",
 * it is simply wrong, and wrong in a file a reader has no reason to distrust. Nothing else in this
 * repo notices: the `unit` job never opens the committed file, and the `drift` job writes a FRESH
 * copy to /tmp and uploads it as a build artifact without ever diffing it against the committed
 * one. This script is that missing diff.
 *
 * OFFLINE, ALWAYS. It compares two files that are both in the checkout. There is no fetch here and
 * there must never be one: the whole point is that this question is answerable from the diff alone,
 * so it can run on the pull-request path without making an author depend on a network read.
 *
 * WHAT THE DIGEST COVERS — AND WHAT IT DELIBERATELY DOES NOT.
 * The digest is taken over one line per operation, `"<METHOD> <path>\t<x-schema-status>"`, sorted.
 * That is exactly the repo-side input that decides how the report CLASSIFIES an operation:
 *   - adding or removing an operation moves it in or out of every direction at once;
 *   - flipping `x-schema-status` is the promote-out-of-draft transition that turns a suppressed
 *     `unpublished-repo` entry into a finding (see published-drift-compare.mjs on why `draft`
 *     suppresses).
 * It does NOT cover edits INSIDE an operation — a changed parameter, a new response field. Those
 * can change a `shared-drift` finding, and no offline check can settle them, because the answer
 * depends on what the gateway serves. That question belongs to the networked `drift` job, which
 * runs daily. The two compose: this one catches the half that is a property of the diff, that one
 * catches the half that is a property of the world. Neither pretends to cover the other.
 *
 * EXIT CODES — the same contract as published-drift.mjs, for the same reason: a FAILED READ IS
 * NEVER REPORTED AS "FRESH".
 *   0  FRESH — the receipt's repo-side facts match openapi.yaml.
 *   1  UNKNOWN — a file is missing, unparseable, or the receipt predates the digest field. A
 *      TOOLING failure. It says nothing about freshness and must go red without filing the routine
 *      staleness issue.
 *   2  STALE — the receipt describes a different openapi.yaml than the one in this checkout.
 *
 * USAGE
 *   node .github/scripts/published-drift-freshness.mjs [openapi.yaml] [--receipt contract-drift.json]
 *
 * To clear a STALE verdict, regenerate the receipt (this DOES need the network, which is why
 * clearing it is a deliberate act and not something CI does behind your back):
 *   node .github/scripts/published-drift.mjs openapi.yaml --out contract-drift.json
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { indexOperations } from './published-drift-compare.mjs';

export const EXIT_FRESH = 0;
export const EXIT_UNKNOWN = 1;
export const EXIT_STALE = 2;

/** The one field this gate adds to the artifact. Named here so the generator and the check agree. */
export const DIGEST_FIELD = 'repoOperationsDigest';

/**
 * The repo-side facts a receipt claims, recomputed from the spec. Pure: no I/O, no clock.
 * `paths` and `operations` mirror published-drift-compare.mjs's headline exactly, so a receipt and
 * a fresh recomputation are comparing like with like.
 */
export function repoFacts(repoDoc) {
  const ops = indexOperations(repoDoc);
  const lines = [...ops.entries()]
    .map(([key, { op }]) => `${key}\t${op?.['x-schema-status'] ?? '-'}`)
    .sort();
  return {
    version: repoDoc?.info?.version ?? null,
    paths: Object.keys(repoDoc?.paths ?? {}).length,
    operations: ops.size,
    digest: createHash('sha256').update(lines.join('\n')).digest('hex'),
  };
}

/**
 * Compare recomputed facts against a parsed receipt. Returns `{ status, reasons }` where status is
 * one of 'fresh' | 'stale' | 'unknown'. Pure, so the tests can drive it without touching disk.
 */
export function checkFreshness(repoDoc, receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { status: 'unknown', reasons: ['the receipt is not a JSON object'] };
  }
  const headline = receipt.headline;
  if (!headline || typeof headline !== 'object') {
    return { status: 'unknown', reasons: ['the receipt has no "headline" object'] };
  }
  const recorded = receipt.sources?.[DIGEST_FIELD];
  if (typeof recorded !== 'string' || recorded.length === 0) {
    return {
      status: 'unknown',
      reasons: [
        `the receipt carries no sources.${DIGEST_FIELD} — it predates this check. Regenerate it ` +
          'once with published-drift.mjs and the field will be there from then on.',
      ],
    };
  }

  const facts = repoFacts(repoDoc);
  const reasons = [];
  const compare = (label, mine, theirs) => {
    if (mine !== theirs) reasons.push(`${label}: the spec says ${mine}, the receipt records ${theirs}`);
  };
  compare('info.version', facts.version, headline.repoVersion);
  compare('path count', facts.paths, headline.repoPaths);
  compare('operation count', facts.operations, headline.repoOperations);
  if (facts.digest !== recorded) {
    reasons.push(
      `operation digest: the spec hashes to ${facts.digest}, the receipt records ${recorded} ` +
        '(an operation was added, removed, or promoted out of draft)',
    );
  }
  return { status: reasons.length ? 'stale' : 'fresh', reasons };
}

export function parseArgs(argv) {
  const args = { spec: null, receipt: 'contract-drift.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--receipt') args.receipt = argv[++i];
    else if (!a.startsWith('--') && args.spec === null) args.spec = a;
  }
  args.spec ??= 'openapi.yaml';
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  let repoDoc;
  try {
    const yaml = await import('js-yaml');
    repoDoc = (yaml.default ?? yaml).load(readFileSync(args.spec, 'utf8'));
  } catch (err) {
    console.error(`published-drift-freshness: could not read/parse ${args.spec}: ${err.message}`);
    return EXIT_UNKNOWN;
  }
  if (!repoDoc?.paths || typeof repoDoc.paths !== 'object') {
    console.error(`published-drift-freshness: ${args.spec} has no usable "paths" object`);
    return EXIT_UNKNOWN;
  }

  let receipt;
  try {
    receipt = JSON.parse(readFileSync(args.receipt, 'utf8'));
  } catch (err) {
    console.error(`published-drift-freshness: could not read/parse ${args.receipt}: ${err.message}`);
    return EXIT_UNKNOWN;
  }

  const { status, reasons } = checkFreshness(repoDoc, receipt);

  if (status === 'unknown') {
    for (const r of reasons) console.error(`published-drift-freshness: UNKNOWN — ${r}`);
    return EXIT_UNKNOWN;
  }
  if (status === 'stale') {
    console.error(
      `published-drift-freshness: STALE — ${args.receipt} was generated at ` +
        `${receipt.generatedAt ?? 'an unrecorded time'} and no longer describes ${args.spec}.`,
    );
    for (const r of reasons) console.error(`published-drift-freshness:   - ${r}`);
    console.error(
      'published-drift-freshness: regenerate it with ' +
        `\`node .github/scripts/published-drift.mjs ${args.spec} --out ${args.receipt}\` (needs network).`,
    );
    return EXIT_STALE;
  }

  const facts = repoFacts(repoDoc);
  console.log(
    `published-drift-freshness: FRESH — ${args.receipt} matches ${args.spec} ` +
      `(${facts.version}, ${facts.paths} paths / ${facts.operations} ops, digest ${facts.digest.slice(0, 12)}…).`,
  );
  return EXIT_FRESH;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
