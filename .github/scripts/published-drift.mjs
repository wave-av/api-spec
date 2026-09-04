#!/usr/bin/env node
/**
 * published-drift.mjs — CLI. Does the contract the gateway PUBLISHES at
 * https://api.wave.online/openapi.json match the contract THIS REPO declares in `openapi.yaml`,
 * operation by operation?
 *
 * The comparison itself lives in `published-drift-compare.mjs` (pure) and what the gateway does to
 * the spec at serve time lives in `published-drift-normalize.mjs`. This file is the shell: read the
 * documents, hand them over, turn the verdict into an exit code.
 *
 * THREE QUESTIONS, THREE TOOLS — named here so nobody ships a fourth:
 *   1. "Is the service's PIN of this spec stale?" — a byte-level watcher that already lives in the
 *      serving repo, which vendors a pinned copy of openapi.yaml. It resolves this repo's HEAD,
 *      hashes openapi.yaml there, and compares it to the pin. It stays where it is: only that repo
 *      can act on its answer, which is to bump its own pin.
 *   2. "Is a live PRICED CAPABILITY undocumented?" — skills-index-coverage.mjs, next to this file.
 *      Reads the published capability index at PRODUCT granularity.
 *   3. "Does the PUBLISHED CONTRACT match the declared one?" — this script. Neither of the others
 *      answers it. (1) compares repo bytes to a pin and says nothing about what is SERVED — a pin
 *      can be current while the served document still differs, because the service enriches and
 *      overlays the spec at serve time. (2) is product-granular and one-directional, so it cannot
 *      see a method-level difference, nor an operation served live that this repo never documented.
 *
 * WHICH REPO OWNS THIS GATE: this one. The published contract is this repo's OUTPUT — every SDK
 * and the CLI are generated from openapi.yaml — so "the published contract disagrees with the
 * spec" is a defect in this repo's product, and the remedy (document the operation, promote it out
 * of draft, or drop the claim) edits a file that lives here. The serving repo keeps the pin
 * watcher because the remedy THERE is a pin bump. Each gate lives where its fix lives.
 *
 * EXIT CODES — the fleet's standing contract for scheduled upstream watchers, the same one the pin
 * watcher uses. A FAILED READ IS NEVER REPORTED AS "NO DRIFT".
 *   0  no drift — every difference is normalized enrichment, a draft operation, or a live
 *      allowlist entry whose predicate still holds.
 *   1  UNKNOWN — could not read the published spec or the local spec, or the allowlist is
 *      malformed. A TOOLING failure: it says nothing about drift and must go red WITHOUT filing
 *      the routine drift issue.
 *   2  DRIFT — at least one unexplained operation-level difference.
 * There is deliberately no exit 3: the pin watcher reserves 3 for PROVENANCE, a question about a
 * pin this repo does not have.
 *
 * USAGE
 *   node .github/scripts/published-drift.mjs [openapi.yaml]
 *   node .github/scripts/published-drift.mjs openapi.yaml --live fixtures/live.json   # offline
 *   node .github/scripts/published-drift.mjs openapi.yaml --out contract-drift.json
 *   node .github/scripts/published-drift.mjs openapi.yaml --no-normalize              # see the 71
 *
 * NETWORK: one GET to the hardcoded public URL below, unauthenticated, bounded by an
 * AbortController timeout. Nothing else. `--live <file>` makes the run fully offline.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { compare, indexOperations, validateAllowlist } from './published-drift-compare.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PUBLISHED_SPEC_URL = 'https://api.wave.online/openapi.json';
export const ALLOWLIST_PATH = join(__dirname, 'published-drift-allowlist.json');
export const FETCH_TIMEOUT_MS = 20_000;

export const EXIT_OK = 0;
export const EXIT_UNKNOWN = 1;
export const EXIT_DRIFT = 2;

/** Fetch the published contract. Returns a result, never throws, never defaults to "no drift". */
export async function fetchPublished(url = PUBLISHED_SPEC_URL, doFetch = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${url}` };
    return { ok: true, doc: await res.json() };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS}ms` : (err?.message ?? String(err));
    return { ok: false, error: `${url}: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

export function parseArgs(argv) {
  const args = { spec: null, live: null, out: null, normalize: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--no-normalize') args.normalize = false;
    else if (a === '--json') args.json = true;
    else if (!a.startsWith('--') && args.spec === null) args.spec = a;
  }
  args.spec ??= 'openapi.yaml';
  return args;
}

function report(r) {
  const h = r.headline;
  console.log(
    `published-drift: repo ${h.repoVersion} ${h.repoPaths} paths / ${h.repoOperations} ops vs published ` +
      `${h.publishedVersion} ${h.publishedPaths} paths / ${h.publishedOperations} ops — shared ${h.sharedOperations}`,
  );
  console.log(
    `published-drift: findings — undocumented-live ${h.undocumentedLive}, unpublished-repo ${h.unpublishedRepo}, ` +
      `shared-drift ${h.sharedDrift}; suppressed — draft ${h.draftNotYetPublished}, allowlisted ${h.allowlisted}`,
  );
  console.log(
    `published-drift: gateway enrichment normalized — ${r.enrichmentObservations.errorResponsesInjected} injected error ` +
      `responses, ${r.enrichmentObservations.operationIdsSynthesized} synthesized operationIds`,
  );
  if (r.enrichmentObservations.descriptionsOverwritten.length) {
    console.log(
      `::warning::${r.enrichmentObservations.descriptionsOverwritten.length} operations have a real description in ` +
        "openapi.yaml that the published contract replaced with its versioning boilerplate. " +
        'Not drift in this spec — a defect in the publishing service, tracked separately.',
    );
  }
  for (const e of r.lapsedAllowlist) {
    console.error(
      `::error::allowlist entry ${e.method} ${e.path} no longer matches its predicate — treating it as a finding instead ` +
        `of honoring a stale exemption. Original justification: ${e.justification}`,
    );
  }
  for (const f of r.findings) {
    const extra = f.differences ? ` fields: ${f.differences.map((d) => d.field).join(', ')}` : '';
    console.error(`::error::[${f.direction}] ${f.method} ${f.path} — ${f.note ?? 'differs from the published contract'}${extra}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  let repoDoc;
  try {
    const yaml = await import('js-yaml');
    repoDoc = (yaml.default ?? yaml).load(readFileSync(args.spec, 'utf8'));
  } catch (err) {
    console.error(`published-drift: could not read/parse ${args.spec}: ${err.message}`);
    return EXIT_UNKNOWN;
  }
  if (!repoDoc?.paths || typeof repoDoc.paths !== 'object') {
    console.error(`published-drift: ${args.spec} has no usable "paths" object`);
    return EXIT_UNKNOWN;
  }

  let allowlist;
  try {
    allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch (err) {
    console.error(`published-drift: could not read/parse ${ALLOWLIST_PATH}: ${err.message}`);
    return EXIT_UNKNOWN;
  }
  const allowlistError = validateAllowlist(allowlist);
  if (allowlistError) {
    console.error(`published-drift: ${allowlistError}`);
    return EXIT_UNKNOWN;
  }

  let liveDoc;
  let source;
  if (args.live) {
    try {
      liveDoc = JSON.parse(readFileSync(args.live, 'utf8'));
      source = `snapshot ${args.live}`;
    } catch (err) {
      console.error(`published-drift: could not read/parse snapshot ${args.live}: ${err.message}`);
      return EXIT_UNKNOWN;
    }
  } else {
    const fetched = await fetchPublished();
    if (!fetched.ok) {
      // FAIL LOUD. An unreachable gateway is not "the contract matches".
      console.error(`published-drift: could not read the published contract: ${fetched.error}`);
      return EXIT_UNKNOWN;
    }
    liveDoc = fetched.doc;
    source = PUBLISHED_SPEC_URL;
  }
  if (!liveDoc?.paths || typeof liveDoc.paths !== 'object') {
    console.error(`published-drift: the published contract at ${source} has no usable "paths" object`);
    return EXIT_UNKNOWN;
  }
  if (indexOperations(liveDoc).size === 0) {
    console.error(`published-drift: the published contract at ${source} declares zero operations — refusing to call that "no drift"`);
    return EXIT_UNKNOWN;
  }

  const result = compare({ repoDoc, liveDoc, allowlist, normalize: args.normalize });
  const artifact = {
    about:
      'Point-in-time operation-level diff between this repo\'s openapi.yaml and the contract the gateway publishes. ' +
      'It is a dated receipt, not a live view: regenerate with ' +
      '`node .github/scripts/published-drift.mjs openapi.yaml --out contract-drift.json`. ' +
      'The published-contract-drift workflow uploads a fresh copy on every scheduled run.',
    generatedAt: new Date().toISOString(),
    criterion: ['CONTRACT-001', 'COMPAT-001', 'API-001'],
    sources: { repoSpec: args.spec, repoCommit: process.env.GITHUB_SHA ?? null, publishedSpec: source },
    ...result,
  };
  if (args.out) writeFileSync(args.out, `${JSON.stringify(artifact, null, 2)}\n`);
  if (args.json) process.stdout.write(`${JSON.stringify(artifact)}\n`);
  report(result);

  if (result.findings.length) {
    console.error(`published-drift: DRIFT — ${result.findings.length} unexplained operation-level difference(s).`);
    return EXIT_DRIFT;
  }
  console.log('published-drift: OK — the published contract matches openapi.yaml at operation granularity.');
  return EXIT_OK;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
