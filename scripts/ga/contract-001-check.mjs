#!/usr/bin/env node
/**
 * contract-001-check.mjs — GA evidence check for CONTRACT-001 ("one promoted contract is the
 * source of truth across spec, gateway, registry, MCP, SDK and CLI").
 *
 * REUSE, NOT REIMPLEMENTATION. This repo already owns the comparison between the declared spec
 * and the gateway's live published contract — see .github/workflows/published-contract-drift.yml
 * and .github/scripts/published-drift*.mjs. That normalizer exists for a measured reason (its own
 * header: "all 72 shared operations report a difference for enrichment reasons alone" without it),
 * so this check imports those modules directly rather than re-deriving normalization rules that
 * would silently drift out of sync with the ones the `drift` job actually uses.
 *
 * WHAT THIS CHECKS, PRECISELY (narrower than the informational `published-contract-drift` job,
 * which is scheduled/advisory by design — see that workflow's header):
 *
 *   1. operation-parity — every operation this repo declares in openapi.yaml at HEAD that is not
 *      `x-schema-status: draft` is served live, and every operation the gateway serves is either
 *      declared here or explicitly allowlisted (published-drift-allowlist.json, with an owner and
 *      a lapsing predicate). This is CONTRACT-001's own text: "repo-only and live-only operations
 *      are zero unless explicitly allowlisted."
 *   2. content-digest — for every operation declared on BOTH sides AND not covered by a still-live
 *      `shared-drift` allowlist exemption, this builds two independent sha256 digests: one walking
 *      the repo's copy of each such operation (after stripping the gateway's serve-time enrichment
 *      via the shared normalizePair()), one walking the live document's copy the same way. These
 *      two digests must be byte-identical. Two independent walks are used deliberately, rather than
 *      one shared list, so a bug that fabricated one side from the other could not produce a false
 *      match.
 *
 * Both conditions must hold; neither substitutes for the other. (1) alone would miss in-place
 * content drift on an operation whose path+method did not move. (2) alone would miss an entire
 * operation appearing or disappearing.
 *
 * WHY content-digest SUBTRACTS THE `shared-drift` ALLOWLIST. The two sub-checks are siblings over
 * the same operation set and must honour the same exemptions, or the repo has two different answers
 * to "is this divergence accepted?". They did not. `operation-parity` reads compare()'s findings,
 * which are post-allowlist; content-digest re-derived its own list from the raw shared keys and so
 * ignored every exemption. That was not a stricter check — it was an incoherent one, and measurably
 * so: `operation-parity` deliberately filters `shared-drift` out of its own verdict ("already
 * reported, more precisely, by content-digest below"), so the allowlist's entire `shared-drift`
 * direction suppressed a finding that NOTHING then consumed. Nine documented, predicate-guarded
 * exemptions were dead letters, and the criterion they were written for failed on them anyway.
 *
 * The exemption is applied at OPERATION granularity — an exempted operation contributes neither its
 * own object nor its reachable `$ref` content to the digest. That is deliberate and it is the honest
 * reading of what a `shared-drift` entry says: this operation's published shape is accepted as
 * diverging. It is also load-bearing rather than cosmetic — six of the nine current exemptions
 * diverge in referenced component content precisely BECAUSE of the divergence the entry documents
 * (a gateway-native or draft-placeholder operation reaches different components than the
 * hand-written one), so a refs-only carve-out would exempt the stated cause and still fail on its
 * direct consequence.
 *
 * THE RESIDUAL RISK, STATED: while an exemption stands, a genuine change to a component schema that
 * only that operation reaches is not seen by this digest. That risk is intrinsic to granting the
 * exemption at all, not introduced here, and it is bounded by the machinery that already exists —
 * every entry carries a lapsing `expect`/`expectAbsent` predicate, a lapsed entry drops straight
 * back into `findings` (and therefore back into this digest), and compare() separately surfaces
 * entries that match nothing. The remedy for an exemption that has outlived its justification is to
 * delete it, which re-arms this check in the same commit.
 *
 * An exemption can only ever REMOVE an operation from the digest; it can never make a
 * non-exempted difference pass. Both directions are pinned by tests in contract-001-check.test.mjs.
 *
 * NOT CHECKED HERE: the registry/MCP/SDK/CLI surfaces CONTRACT-001 also names. Those are owned by
 * wave-av/sdks (see its registry-cleanroom producer) and are out of this repo's scope.
 *
 * EXIT CODES (this repo's GA-evidence contract, shared with check-COMPAT-001.sh):
 *   0  ran, and the criterion holds (both checks pass)
 *   1  ran, and the criterion does not hold (a genuine finding)
 *   2  could not run (fetch/parse failure, missing input) — never to be read as a pass
 *
 * OVERRIDES (for local reproduction and the deliberately-broken-input drill; never used in the
 * scheduled/PR workflow, which always reads the real live URL with no auth):
 *   GA_CONTRACT_LIVE_URL   fetch this URL instead of the default published contract
 *   GA_CONTRACT_LIVE_FILE  read this local JSON file instead of fetching anything (fully offline)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

export const DEFAULT_LIVE_URL = 'https://api.wave.online/openapi.json';
const FETCH_TIMEOUT_MS = 20_000;

async function loadYaml(path) {
  const yaml = await import('js-yaml');
  return (yaml.default ?? yaml).load(readFileSync(path, 'utf8'));
}

export async function fetchLive(url, doFetch = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // redirect: 'manual' — a single hardcoded HTTPS URL has no legitimate reason to redirect a CI
    // job with no credentials to leak; refusing to follow is the honest "could not run", never a
    // grade of whatever the redirect target happened to serve. Same posture as published-drift.mjs.
    const res = await doFetch(url, { signal: controller.signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, error: `${url} redirected (HTTP ${res.status}) — refusing to follow` };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${url}` };
    return { ok: true, doc: await res.json() };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS}ms` : (err?.message ?? String(err));
    return { ok: false, error: `${url}: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

function sha256(s) {
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
  return JSON.stringify(sortKeysDeep(value ?? null));
}

/** RFC 6901 JSON Pointer resolution against a document already fully loaded in memory. */
export function resolveJsonPointer(doc, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  const parts = ref
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = doc;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Walk `node` and resolve every internal `$ref` reachable from it against `doc`, recursively (a
 * referenced schema may itself `$ref` another). Returns a Map of ref-string -> resolved value.
 *
 * WHY THIS EXISTS (cubic P1): the content digest below hashes only the operation object itself. An
 * operation that still points at the same `$ref` while the REFERENCED component schema changed
 * would report matching digests and miss real contract drift. Folding the reachable referenced
 * content into the digest input closes that gap. Pure/offline: only reads objects already in
 * memory, no I/O.
 */
export function collectReachableRefs(node, doc, out = new Map(), seen = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectReachableRefs(item, doc, out, seen);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    if (!seen.has(node.$ref)) {
      seen.add(node.$ref);
      const resolved = resolveJsonPointer(doc, node.$ref);
      if (resolved !== undefined) {
        out.set(node.$ref, resolved);
        collectReachableRefs(resolved, doc, out, seen);
      }
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref') continue;
    collectReachableRefs(value, doc, out, seen);
  }
  return out;
}

/** Canonical JSON of every ref this operation reaches, sorted by ref string for determinism. */
function canonicalReachableRefs(op, doc) {
  const refs = collectReachableRefs(op, doc);
  return canonicalJson(Object.fromEntries([...refs.entries()].sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * Run the CONTRACT-001 check. Returns `{ couldNotRun, checks, ... }`. Never throws for an
 * ordinary tooling failure — those come back as `couldNotRun: true` with a check named for what
 * failed, so the caller can render `UNKNOWN <name>: <detail>` and exit 2.
 */
export async function run(opts = {}) {
  const repoSpecPath = opts.repoSpecPath ?? join(REPO_ROOT, 'openapi.yaml');
  const liveFile = opts.liveFile ?? process.env.GA_CONTRACT_LIVE_FILE ?? null;
  const liveUrl = opts.liveUrl ?? process.env.GA_CONTRACT_LIVE_URL ?? DEFAULT_LIVE_URL;

  const compareMod = await import(pathToFileURL(join(REPO_ROOT, '.github/scripts/published-drift-compare.mjs')));
  const normalizeMod = await import(pathToFileURL(join(REPO_ROOT, '.github/scripts/published-drift-normalize.mjs')));
  const { indexOperations, compare, validateAllowlist } = compareMod;
  const { normalizePair } = normalizeMod;
  // opts-only, deliberately NOT env-readable: this is the in-process seam the hermetic tests use to
  // supply a fixture allowlist, exactly like opts.repoSpecPath/opts.liveFile. The CLI never passes
  // opts, so the real run can only ever read the committed allowlist at its fixed repo path.
  const allowlistPath = opts.allowlistPath ?? join(REPO_ROOT, '.github/scripts/published-drift-allowlist.json');

  let repoDoc;
  try {
    repoDoc = await loadYaml(repoSpecPath);
  } catch (err) {
    return fail('repo-spec-read', `could not read/parse ${repoSpecPath}: ${err.message}`);
  }
  if (!repoDoc?.paths || typeof repoDoc.paths !== 'object') {
    return fail('repo-spec-read', `${repoSpecPath} has no usable "paths" object`);
  }

  let allowlist;
  try {
    allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  } catch (err) {
    return fail('allowlist-read', `could not read/parse ${allowlistPath}: ${err.message}`);
  }
  const allowlistErr = validateAllowlist(allowlist);
  if (allowlistErr) return fail('allowlist-read', allowlistErr);

  let liveDoc;
  let source;
  if (liveFile) {
    try {
      liveDoc = JSON.parse(readFileSync(liveFile, 'utf8'));
      source = `file:${liveFile}`;
    } catch (err) {
      return fail('live-fetch', `could not read/parse snapshot ${liveFile}: ${err.message}`);
    }
  } else {
    const fetched = await fetchLive(liveUrl);
    if (!fetched.ok) return fail('live-fetch', `could not fetch ${liveUrl}: ${fetched.error}`);
    liveDoc = fetched.doc;
    source = liveUrl;
  }
  if (!liveDoc?.paths || typeof liveDoc.paths !== 'object' || Object.keys(liveDoc.paths).length === 0) {
    return fail('live-fetch', `${source} has no usable "paths" object`);
  }

  const result = compare({ repoDoc, liveDoc, allowlist, normalize: true });
  const repoOps = indexOperations(repoDoc);
  const liveOps = indexOperations(liveDoc);
  const sharedKeys = [...repoOps.keys()].filter((k) => liveOps.has(k)).sort();

  // The exemptions compare() ACTUALLY honoured this run. `result.allowlisted` holds only entries
  // whose lapsing predicate still matches the live document — a lapsed entry is absent from it (it
  // goes to lapsedAllowlistEntries and its finding stays in `findings`), so a lapsed exemption
  // leaves its operation in the digest, where it belongs. Key format matches indexOperations().
  const exemptKeys = new Set(
    (result.allowlisted ?? [])
      .filter((a) => a.direction === 'shared-drift')
      .map((a) => `${String(a.method).toUpperCase()} ${a.path}`),
  );
  const digestKeys = sharedKeys.filter((k) => !exemptKeys.has(k));
  const exemptedCount = sharedKeys.length - digestKeys.length;

  const rowsRepo = [];
  const rowsLive = [];
  for (const key of digestKeys) {
    const { path, method, op: repoOp } = repoOps.get(key);
    const { op: liveOp } = liveOps.get(key);
    const { repo, live } = normalizePair(repoOp, liveOp, path, method);
    // Reachable $ref content is resolved from the RAW (pre-normalize) operation against its own
    // document — normalizePair only touches operation-level enrichment fields, never $ref targets,
    // so this sees exactly what each side's components actually publish today.
    const repoRefs = canonicalReachableRefs(repoOp, repoDoc);
    const liveRefs = canonicalReachableRefs(liveOp, liveDoc);
    rowsRepo.push(`${key}\t${sha256(`${canonicalJson(repo)}\n${repoRefs}`)}`);
    rowsLive.push(`${key}\t${sha256(`${canonicalJson(live)}\n${liveRefs}`)}`);
  }
  const localDigest = sha256([...rowsRepo].sort().join('\n'));
  const liveDigest = sha256([...rowsLive].sort().join('\n'));

  const findings = result.findings ?? [];
  // operation-parity is CONTRACT-001's "repo-only and live-only operations are zero" text — it must
  // NOT also fail on `shared-drift` findings (an operation present on both sides with different
  // content), because that condition is already reported, more precisely, by content-digest below.
  // Counting shared-drift here too would make both sub-checks fail for the same underlying cause
  // and mislabel which condition actually broke (cubic P2).
  const parityFindings = findings.filter((f) => f.direction === 'undocumented-live' || f.direction === 'unpublished-repo');
  const parityLabels = parityFindings.slice(0, 10).map((f) => `${f.direction} ${f.method} ${f.path}`);

  const checks = [
    {
      name: 'operation-parity',
      ok: parityFindings.length === 0,
      detail: parityFindings.length === 0
        ? `zero unexplained repo-only/live-only operations (${repoOps.size} declared, ${liveOps.size} live, ${sharedKeys.length} shared, ${result.allowlisted?.length ?? 0} allowlisted, ${result.draftNotYetPublished?.length ?? 0} draft)`
        : `${parityFindings.length} unexplained repo-only/live-only operation finding(s): ${parityLabels.join('; ')}${parityFindings.length > parityLabels.length ? '; …' : ''}`,
    },
    {
      name: 'content-digest',
      // The exempted count is always reported, on pass AND on fail. A gate that quietly subtracts
      // work from itself is unreadable; the number that was skipped has to be as visible as the
      // number that was checked, so a growing exemption set is obvious in the evidence line itself.
      ok: localDigest === liveDigest,
      detail: `${localDigest === liveDigest
        ? `repo and live digests match over ${digestKeys.length} compared operation(s) (${localDigest.slice(0, 12)})`
        : `repo digest ${localDigest.slice(0, 12)} != live digest ${liveDigest.slice(0, 12)} over ${digestKeys.length} compared operation(s)`}` +
        ` [${sharedKeys.length} shared, ${exemptedCount} allowlisted shared-drift exemption(s) excluded]`,
    },
  ];

  return {
    couldNotRun: false,
    checks,
    localDigest,
    liveDigest,
    source,
    repoOpCount: repoOps.size,
    liveOpCount: liveOps.size,
    sharedCount: sharedKeys.length,
    digestedCount: digestKeys.length,
    exemptedCount,
  };
}

function fail(name, detail) {
  return { couldNotRun: true, checks: [{ name, ok: null, detail }] };
}

async function cli() {
  const result = await run();
  for (const c of result.checks) {
    const label = c.ok === null ? 'UNKNOWN' : c.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`${label} CONTRACT-001/${c.name}: ${c.detail}\n`);
  }
  if (result.couldNotRun) {
    process.exitCode = 2;
    return;
  }
  const allOk = result.checks.every((c) => c.ok === true);
  process.exitCode = allOk ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  cli().catch((err) => {
    process.stderr.write(`contract-001-check could not run: ${err?.stack || err}\n`);
    process.exit(2);
  });
}
