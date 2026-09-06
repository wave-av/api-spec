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
 *   node .github/scripts/published-drift.mjs openapi.yaml --no-live-probe            # unit tier only
 *
 * NETWORK: one GET to the hardcoded public URL below for the published spec, unauthenticated,
 * bounded by an AbortController timeout, PLUS — only on a real (non-`--live`, non-`--no-live-probe`)
 * run — one unauthenticated request per `x-schema-status: draft` operation this repo declares that
 * the published spec does not carry. See published-drift-live.mjs for why: `draft` must not be able
 * to suppress an operation the real gateway actually serves. `--live <file>` keeps this whole run
 * offline end to end, INCLUDING the draft probe (which is skipped, preserving "draft always
 * suppresses" for that run) — exactly what the offline test suite needs. `--no-live-probe` skips
 * only the probe tier (see the flag's own comment in parseArgs for why it cannot become a quiet way
 * to turn the behavioural tier back off in the workflow).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { compare, indexOperations, validateAllowlist } from './published-drift-compare.mjs';
import { probeOperations } from './published-drift-live.mjs';
import { DIGEST_FIELD, repoFacts } from './published-drift-freshness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PUBLISHED_SPEC_URL = 'https://api.wave.online/openapi.json';
export const ALLOWLIST_PATH = join(__dirname, 'published-drift-allowlist.json');
export const FETCH_TIMEOUT_MS = 20_000;

export const EXIT_OK = 0;
export const EXIT_UNKNOWN = 1;
export const EXIT_DRIFT = 2;

/** The fixed placeholder segment substituted for every `{param}` template before a live probe. */
export const PROBE_PLACEHOLDER = 'wave-drift-probe-placeholder';

/**
 * A declared-but-unpublished path can carry an OpenAPI `{param}` template (e.g. `/clips/{clipId}`).
 * Probed literally, the gateway's router will not match it — it matches on a real path segment, not
 * the literal string `{clipId}` — so it 404s and gets misclassified as unpublished, reintroducing
 * the exact false-green this tier removes for any draft route that is actually live behind a path
 * parameter. Substitute a fixed placeholder segment so the probe hits the route the same way a real
 * request would.
 */
export function templateToProbePath(path) {
  return path.replace(/\{[^}]+\}/g, PROBE_PLACEHOLDER);
}

/**
 * An operation's own `servers[0].url` overrides the document-level one — a handful of operations in
 * this spec do exactly that (e.g. a root-level surface served with no `/v1` prefix). Probing such an
 * operation against the document-level base would hit the wrong path and could misclassify it. But
 * the override comes from `repoDoc` — the very document that is attacker-controlled on a fork PR —
 * so it is honored ONLY when it resolves to the SAME ORIGIN as the trusted, liveDoc-derived base
 * (differences in PATH are fine; a different host is never trusted, the override is silently
 * ignored instead, falling back to the default prefix). This is the same SSRF discipline as the
 * base-URL fix above, applied per operation instead of once.
 */
function resolveProbePrefix(op, trustedOrigin, defaultPrefix) {
  const override = op?.servers?.[0]?.url;
  if (!override) return defaultPrefix;
  try {
    const parsed = new URL(override);
    if (parsed.origin !== trustedOrigin) return defaultPrefix;
    return parsed.pathname.replace(/\/$/, '');
  } catch {
    return defaultPrefix;
  }
}

/**
 * Build the map from a probe path (placeholder-substituted, and prefixed per-operation per
 * `resolveProbePrefix`) back to every declared-but-unpublished-and-DRAFT spec path it stands in for
 * (two templated paths can collapse to the same probe path, e.g. `/x/{a}` and `/x/{b}`). `compare()`
 * looks observations up by the ORIGINAL spec path — never the probe path — so this index is what
 * lets a probe result find its way back to the key `compare()` actually reads.
 *
 * Scoped to `x-schema-status: draft` only: that is the ONLY set `compare()` ever consults
 * `liveObservations` for (see the `unpublished-repo` loop) — a non-draft unpublished operation is
 * always a finding regardless of what the gateway answers, so probing it spends a request whose
 * result nothing ever reads.
 */
export function indexSpecPathsByProbePath(repoDoc, livePublished, trustedOrigin, defaultPrefix) {
  const specPathsByProbePath = new Map();
  for (const { path, method, op } of indexOperations(repoDoc).values()) {
    if (op?.['x-schema-status'] !== 'draft') continue;
    if (livePublished.has(`${method.toUpperCase()} ${path}`)) continue;
    const prefix = resolveProbePrefix(op, trustedOrigin, defaultPrefix);
    const probePath = prefix + templateToProbePath(path);
    const specPaths = specPathsByProbePath.get(probePath) ?? [];
    if (!specPaths.includes(path)) specPaths.push(path);
    specPathsByProbePath.set(probePath, specPaths);
  }
  return specPathsByProbePath;
}

/** Re-key a probe's `{ probePath -> observation }` map onto every spec path it stands in for. */
export function reindexObservationsBySpecPath(observations, specPathsByProbePath) {
  const out = new Map();
  for (const [probePath, observation] of observations) {
    for (const specPath of specPathsByProbePath.get(probePath) ?? [probePath]) {
      out.set(specPath, observation);
    }
  }
  return out;
}

/**
 * Fetch the published contract. Returns a result, never throws, never defaults to "no drift".
 *
 * REDIRECTS ARE NOT FOLLOWED. `redirect: 'follow'` would let whatever answers the published URL
 * choose this job's next destination, and this job runs on a CI runner with a token in its
 * environment. The URL is a single hardcoded HTTPS constant; there is no legitimate reason for it
 * to bounce us somewhere else, and if it ever starts to, the honest answer is "I could not read the
 * published contract" — EXIT_UNKNOWN, red, no issue filed — rather than grading whatever the
 * redirect target happened to serve. Measured 2026-09-04: the endpoint answers HTTP/2 200 directly,
 * so this refuses nothing that works today.
 */
export async function fetchPublished(url = PUBLISHED_SPEC_URL, doFetch = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: controller.signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const target = res.headers?.get?.('location') ?? 'an undisclosed location';
      return { ok: false, error: `${url} redirected (HTTP ${res.status}) to ${target} — refusing to follow` };
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

/**
 * Value-taking options must actually be given a value. `--live` with nothing after it used to set
 * `args.live = undefined`, which reads as "no snapshot" and silently takes the NETWORK branch — the
 * opposite of what `--live` was typed to ask for, and the one branch the caller was trying to
 * avoid. `--out` with no value silently wrote no artifact. In both cases a following option token
 * was also accepted as a filename. An option that quietly means its opposite is worse than one that
 * errors, so this returns a usage error the caller turns into EXIT_UNKNOWN.
 */
export function parseArgs(argv) {
  const args = { spec: null, live: null, out: null, normalize: true, json: false, liveProbe: true, error: null };
  const value = (name, next) => {
    if (next === undefined || next.startsWith('--')) {
      args.error ??= `${name} needs a value (got ${next === undefined ? 'nothing' : JSON.stringify(next)})`;
      return null;
    }
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = value('--live', argv[++i]);
    else if (a === '--out') args.out = value('--out', argv[++i]);
    else if (a === '--no-normalize') args.normalize = false;
    // Offline escape hatch for the unit tier ONLY. The workflow never passes it, and
    // published-drift-live.test.mjs asserts the workflow never passes it, so this cannot become
    // the quiet way to turn the behavioural tier back off.
    else if (a === '--no-live-probe') args.liveProbe = false;
    else if (a === '--json') args.json = true;
    else if (!a.startsWith('--') && args.spec === null) args.spec = a;
  }
  args.spec ??= 'openapi.yaml';
  return args;
}

/**
 * `say` is stdout normally and stderr under `--json`. Under `--json` stdout carries the artifact and
 * nothing else — a consumer piping this into `jq` cannot parse a stream with prose in it — but the
 * prose still has to go SOMEWHERE, because it carries the ::error:: and ::warning:: annotations CI
 * renders. Dropping it would trade one defect for a quieter one.
 */
function report(r, say = console.log) {
  const h = r.headline;
  say(
    `published-drift: repo ${h.repoVersion} ${h.repoPaths} paths / ${h.repoOperations} ops vs published ` +
      `${h.publishedVersion} ${h.publishedPaths} paths / ${h.publishedOperations} ops — shared ${h.sharedOperations}`,
  );
  say(
    `published-drift: findings — undocumented-live ${h.undocumentedLive}, unpublished-repo ${h.unpublishedRepo}, ` +
      `draft-but-live ${h.draftButLive}, shared-drift ${h.sharedDrift}; suppressed — draft ${h.draftNotYetPublished} ` +
      `(of ${h.liveProbed ?? 'unprobed'} probed live), allowlisted ${h.allowlisted}`,
  );
  say(
    `published-drift: gateway enrichment normalized — ${r.enrichmentObservations.errorResponsesInjected} injected error ` +
      `responses, ${r.enrichmentObservations.operationIdsSynthesized} synthesized operationIds, ` +
      `${r.enrichmentObservations.parametersStripped} parameter description/example fields dropped`,
  );
  if (r.enrichmentObservations.descriptionsOverwritten.length) {
    say(
      `::warning::${r.enrichmentObservations.descriptionsOverwritten.length} operations have a real description in ` +
        "openapi.yaml that the published contract replaced with its versioning boilerplate. " +
        'Not drift in this spec — a defect in the publishing service, tracked separately.',
    );
  }
  if (r.enrichmentObservations.errorResponsesOverwritten.length) {
    say(
      `::warning::${r.enrichmentObservations.errorResponsesOverwritten.length} operations have a real error response ` +
        'in openapi.yaml that the published contract replaced with its generic injected envelope ' +
        `(${r.enrichmentObservations.errorResponsesOverwritten.join('; ')}). ` +
        'Not drift in this spec — a defect in the publishing service, tracked separately.',
    );
  }
  for (const e of r.unmatchedAllowlist ?? []) {
    say(
      `::warning::allowlist entry ${e.key} matched no operation in this comparison — the operation is no longer ` +
        'served, or openapi.yaml now documents it. Either way the exemption is dead and should be deleted rather ' +
        `than left standing. Original justification: ${e.justification}`,
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
  if (args.error) {
    console.error(`published-drift: ${args.error}`);
    console.error('published-drift: usage — node published-drift.mjs [openapi.yaml] [--live <file>] [--out <file>] [--json] [--no-normalize]');
    return EXIT_UNKNOWN;
  }

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

  // ── LIVE-BEHAVIOUR TIER ────────────────────────────────────────────────────────────────────
  // Probe only the operations this repo declares that the published contract does NOT carry, which
  // is exactly the set the `draft` annotation was suppressing. See published-drift-live.mjs for
  // the measurement that motivated it and for the safety argument (unauthenticated GET, no body,
  // no credential, nothing paid).
  // `--live <snapshot>` already documents itself as making the run FULLY OFFLINE, so it implies no
  // behaviour probe either. That is honoring the flag's stated contract, not an escape hatch: the
  // workflow passes neither `--live` nor `--no-live-probe`, and published-drift-live.test.mjs
  // asserts that against the workflow file itself.
  let liveObservations = null;
  if (args.liveProbe && !args.live) {
    // `repoDoc` is THIS PR's openapi.yaml, and the drift job now runs on pull requests — so on a
    // fork PR `repoDoc` is attacker-controlled. Deriving the probe target from its `servers[0].url`
    // would let a malicious PR point unauthenticated CI network calls at an arbitrary HTTPS host
    // (an SSRF read primitive). `liveDoc` came from the trusted, hardcoded `PUBLISHED_SPEC_URL` a
    // few lines up (never from `--live`, since that branch already returned before reaching here) —
    // only ITS servers entry, resolved here ONCE into an origin and a default path prefix, is a
    // legitimate probe base. A per-operation `servers` override (see indexSpecPathsByProbePath) is
    // honored only when it resolves to this SAME origin — never a foreign host.
    const rawBaseUrl = String(liveDoc?.servers?.[0]?.url ?? '').replace(/\/$/, '');
    if (!/^https:\/\//.test(rawBaseUrl)) {
      console.error(`published-drift: cannot probe live behaviour — the published contract at ${source} declares no https servers[0].url`);
      return EXIT_UNKNOWN;
    }
    const parsedBase = new URL(rawBaseUrl);
    const trustedOrigin = parsedBase.origin;
    const defaultPrefix = parsedBase.pathname.replace(/\/$/, '');

    const livePublished = indexOperations(liveDoc);
    // Probe a path that already carries its resolved prefix and placeholder substitution, but
    // `compare()` looks observations up by the ORIGINAL spec path (see published-drift-compare.mjs,
    // the `unpublished-repo` loop) — so the probe path must never become the key an observation is
    // stored or looked up under. Re-key the returned observations back onto the spec path before
    // they reach compare(); see indexSpecPathsByProbePath / reindexObservationsBySpecPath.
    const specPathsByProbePath = indexSpecPathsByProbePath(repoDoc, livePublished, trustedOrigin, defaultPrefix);
    const repoOnly = [...specPathsByProbePath.keys()];
    // `repoDoc` is THIS PR's openapi.yaml, so a fork PR controls how many draft-and-unpublished
    // operations it declares. Probing an unbounded set would send one unauthenticated request per
    // operation to the production gateway and could run for a very long time; refuse rather than
    // silently degrade into a slow, traffic-generating job.
    const MAX_PROBED_OPERATIONS = 400;
    if (repoOnly.length > MAX_PROBED_OPERATIONS) {
      console.error(`published-drift: refusing to probe ${repoOnly.length} operations (limit ${MAX_PROBED_OPERATIONS})`);
      return EXIT_UNKNOWN;
    }
    // probeOperations() defaults its two control paths to no prefix at all, which matched the old
    // call (baseUrl carried the full default prefix already). Now that baseUrl is the bare origin
    // and each real path carries its OWN resolved prefix, the controls need the same default prefix
    // explicitly — otherwise they test a different, unrepresentative endpoint space (the bare origin
    // root) instead of the prefix the vast majority of probed operations actually live under.
    const probe = await probeOperations(trustedOrigin, repoOnly, {
      controls: [`${defaultPrefix}/wave-drift-control-no-such-route`, `${defaultPrefix}/wave-drift-control-also-absent`],
    });
    if (!probe.usable) {
      // A probe whose control failed is not a probe. Reporting "no drift" on the strength of it
      // would be the same defect in a new place.
      console.error(`published-drift: ${probe.reason}`);
      return EXIT_UNKNOWN;
    }
    liveObservations = reindexObservationsBySpecPath(probe.observations, specPathsByProbePath);
  }

  const result = compare({ repoDoc, liveDoc, allowlist, normalize: args.normalize, liveObservations });
  const artifact = {
    about:
      'Point-in-time operation-level diff between this repo\'s openapi.yaml and the contract the gateway publishes. ' +
      'It is a dated receipt, not a live view: regenerate with ' +
      '`node .github/scripts/published-drift.mjs openapi.yaml --out contract-drift.json`. ' +
      'The published-contract-drift workflow uploads a fresh copy on every scheduled run. ' +
      'The PUBLISHED half of this receipt ages on the gateway\'s schedule and only the scheduled ' +
      'drift job can refresh it; the REPO half is pinned by ' +
      `sources.${DIGEST_FIELD}, which the freshness job checks offline on every run so this file ` +
      'cannot quietly disagree with the openapi.yaml sitting next to it.',
    generatedAt: new Date().toISOString(),
    criterion: ['CONTRACT-001', 'COMPAT-001', 'API-001'],
    // repoOperationsDigest pins the repo-side input this report consumed, so published-drift-freshness.mjs
    // can tell offline whether the spec has moved since. See that file for what the digest covers.
    sources: {
      repoSpec: args.spec,
      repoCommit: process.env.GITHUB_SHA ?? null,
      publishedSpec: source,
      [DIGEST_FIELD]: repoFacts(repoDoc).digest,
    },
    ...result,
  };
  if (args.out) writeFileSync(args.out, `${JSON.stringify(artifact, null, 2)}\n`);
  // Under --json, stdout is the artifact and only the artifact; every human line goes to stderr so
  // the stream stays parseable.
  const say = args.json ? console.error : console.log;
  if (args.json) process.stdout.write(`${JSON.stringify(artifact)}\n`);
  report(result, say);

  if (result.findings.length) {
    console.error(`published-drift: DRIFT — ${result.findings.length} unexplained operation-level difference(s).`);
    return EXIT_DRIFT;
  }
  say('published-drift: OK — the published contract matches openapi.yaml at operation granularity.');
  return EXIT_OK;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
