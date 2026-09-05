#!/usr/bin/env node
/**
 * live-route-drift.mjs — the CLI. Reads the documents, enumerates candidates, probes the LIVE
 * surface, turns the verdict into an exit code. The probe rules live in `live-route-probe.mjs` and
 * the comparison in `live-route-compare.mjs`.
 *
 * ── WHY A THIRD SOURCE ──────────────────────────────────────────────────────────────────────────
 * `published-drift.mjs`, next to this file, compares two DOCUMENTS: the contract this repo declares
 * (`openapi.yaml`) against the contract the gateway publishes (`https://api.wave.online/openapi.json`).
 * That comparison is worth having, but it cannot close its own hole: NEITHER SIDE IS THE LIVE ROUTE
 * TABLE. Both are artifacts, both are written by us, and both can be wrong in the SAME direction at
 * the same time. A route that is live in production and absent from BOTH documents is invisible to
 * that gate by construction — it can serve traffic indefinitely while the check stays green,
 * because green there means "the two documents agree", not "the documents describe reality".
 *
 * A gate must be able to observe the thing it gates. This one observes the live surface directly.
 *
 * MEASURED 2026-09-05, which is why this is a script and not a doc comment: `GET
 * https://api.wave.online/v1/samples/clips` answers HTTP 200 with a real body. It is absent from
 * `openapi.yaml`, absent from the published `openapi.json`, and absent from the gateway's own
 * capability index — three artifacts, three misses. The cause is structural, and it is a CLASS
 * rather than an oversight: that route is dispatched PRE-AUTH, and the capability index is derived
 * from the route->scope map, so a route that never consults a scope cannot appear in a
 * scope-derived index. Every pre-auth route is invisible to every artifact-based check we have.
 * Only a probe sees it. Positive control run the same way at the same time: `/v1/clips` and
 * `/v1/render` are present in all three and answer 402, and a path that does not exist answers 403
 * ROUTE_NOT_MAPPED — so the method discriminates rather than reporting everything as missing.
 *
 * ── ENUMERATION ─────────────────────────────────────────────────────────────────────────────────
 * Candidates come from five public sources, unioned, then every one is probed:
 *   1. openapi.yaml (this repo)        — parameterless paths only; see isProbeable().
 *   2. the published openapi.json      — same treatment.
 *   3. the gateway route->scope catalog — .well-known/wave-scopes.json, derived at request time
 *                                        from the gateway's own route map.
 *   4. the gateway capability index     — .well-known/wave-skills.json.
 *   5. live-route-seeds.json (committed) — routes OBSERVED live that no machine-readable artifact
 *                                        enumerates. Without it the pre-auth class above could
 *                                        never even become a candidate, and this gate would inherit
 *                                        the blind spot it exists to remove.
 *
 * Sources 3 and 4 are ADVISORY ENUMERATORS, NOT AUTHORITIES. The scope catalog says so itself
 * ("the live response to your request is always authoritative"), and it demonstrably misses the
 * pre-auth class. The PROBE is the authority. That distinction is the same one the fleet has paid
 * for elsewhere: a Worker's runtime environment is not its committed `wrangler.toml`, so repo-only
 * verification of anything env-keyed is unsound. If we make a claim about production, we probe it.
 *
 * COST: every probe is an unauthenticated GET and is free; a 402 is the response, not a purchase.
 * See live-route-probe.mjs.
 *
 * EXIT CODES — the same contract `published-drift.mjs` uses, so one workflow can grade both the
 * same way. A FAILED READ IS NEVER REPORTED AS "NO DRIFT".
 *   0  no drift — every live route is declared; every non-draft declaration is live (or allowlisted).
 *   1  UNKNOWN — could not read the spec, an enumerator, the seeds or the allowlist. Red, files nothing.
 *   2  DRIFT — at least one unexplained difference against the LIVE surface.
 *
 * USAGE
 *   node .github/scripts/live-route-drift.mjs openapi.yaml
 *   node .github/scripts/live-route-drift.mjs openapi.yaml --out live-route-drift.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { probeAll } from './live-route-probe.mjs';
import { candidatePaths, compareAgainstLive, validateAllowlist } from './live-route-compare.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PUBLISHED_SPEC_URL = 'https://api.wave.online/openapi.json';
export const SCOPE_CATALOG_URL = 'https://gateway.wave.online/.well-known/wave-scopes.json';
export const CAPABILITY_INDEX_URL = 'https://gateway.wave.online/.well-known/wave-skills.json';
export const SEEDS_PATH = join(__dirname, 'live-route-seeds.json');
export const ALLOWLIST_PATH = join(__dirname, 'live-route-drift-allowlist.json');
export const FETCH_TIMEOUT_MS = 20_000;

export const EXIT_OK = 0;
export const EXIT_UNKNOWN = 1;
export const EXIT_DRIFT = 2;

/** Fetch one JSON enumerator. Returns a result, never throws, never defaults to "no drift". */
export async function fetchJson(url, doFetch = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Redirects are not followed, for the reason published-drift.mjs gives: this runs on a CI runner
    // and the URL must not be able to choose the job's next destination.
    const res = await doFetch(url, { signal: controller.signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) return { ok: false, error: `${url} redirected (HTTP ${res.status}) — refusing to follow` };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${url}` };
    return { ok: true, doc: await res.json() };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS}ms` : (err?.message ?? String(err));
    return { ok: false, error: `${url}: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const spec = argv.find((a) => !a.startsWith('--')) ?? 'openapi.yaml';
  const outIdx = argv.indexOf('--out');
  const out = outIdx === -1 ? null : argv[outIdx + 1];
  if (outIdx !== -1 && (!out || out.startsWith('--'))) {
    console.error('live-route-drift: --out needs a value');
    return EXIT_UNKNOWN;
  }

  let repoDoc;
  try {
    const yaml = await import('js-yaml');
    repoDoc = (yaml.default ?? yaml).load(readFileSync(spec, 'utf8'));
  } catch (err) {
    console.error(`live-route-drift: could not read/parse ${spec}: ${err.message}`);
    return EXIT_UNKNOWN;
  }
  if (!repoDoc?.paths || typeof repoDoc.paths !== 'object') {
    console.error(`live-route-drift: ${spec} has no usable "paths" object`);
    return EXIT_UNKNOWN;
  }

  let seeds;
  let allowlist;
  try {
    seeds = JSON.parse(readFileSync(SEEDS_PATH, 'utf8'));
    allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch (err) {
    console.error(`live-route-drift: could not read/parse the seeds or the allowlist: ${err.message}`);
    return EXIT_UNKNOWN;
  }
  const allowlistError = validateAllowlist(allowlist);
  if (allowlistError) {
    console.error(`live-route-drift: ${allowlistError}`);
    return EXIT_UNKNOWN;
  }

  const [published, scopes, skills] = await Promise.all([
    fetchJson(PUBLISHED_SPEC_URL),
    fetchJson(SCOPE_CATALOG_URL),
    fetchJson(CAPABILITY_INDEX_URL),
  ]);
  for (const [name, r] of [
    ['published contract', published],
    ['scope catalog', scopes],
    ['capability index', skills],
  ]) {
    if (!r.ok) {
      // FAIL LOUD. An unreachable enumerator says nothing about drift and is not "no drift".
      console.error(`live-route-drift: could not read the ${name}: ${r.error}`);
      return EXIT_UNKNOWN;
    }
  }

  const candidates = candidatePaths({
    repoDoc,
    publishedDoc: published.doc,
    scopeCatalog: scopes.doc,
    capabilityIndex: skills.doc,
    seeds,
  });
  if (!candidates.length) {
    console.error('live-route-drift: zero candidate paths — refusing to call that "no drift"');
    return EXIT_UNKNOWN;
  }

  const probes = await probeAll(candidates);
  const result = compareAgainstLive({ repoDoc, publishedDoc: published.doc, probes, allowlist });
  const h = result.headline;

  console.log(`live-route-drift: probed ${h.probed} candidate routes — mapped ${h.mapped}, absent ${h.absent}, indeterminate ${h.indeterminate}`);
  console.log(`live-route-drift: findings — live-undeclared ${h.liveUndeclared}, declared-not-live ${h.declaredNotLive}; allowlisted ${h.allowlisted}`);
  for (const i of result.indeterminate) console.log(`::warning::could not classify ${i.path}: ${i.reason}`);
  for (const k of result.unmatchedAllowlist) console.log(`::warning::allowlist entry ${k} matched nothing — the exemption is dead and should be deleted rather than left standing`);
  for (const f of result.findings) console.error(`::error::[${f.direction}] ${f.path} (HTTP ${f.status}) — ${f.note}`);

  if (out) {
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          about:
            "Point-in-time diff between this repo's openapi.yaml, the gateway's published contract, and the LIVE route " +
            'surface established by unauthenticated GET probes. The live half is the one neither document can supply.',
          generatedAt: new Date().toISOString(),
          criterion: ['CONTRACT-001', 'API-001'],
          sources: {
            repoSpec: spec,
            publishedSpec: PUBLISHED_SPEC_URL,
            scopeCatalog: SCOPE_CATALOG_URL,
            capabilityIndex: CAPABILITY_INDEX_URL,
            seeds: 'live-route-seeds.json',
          },
          ...result,
        },
        null,
        2,
      )}\n`,
    );
  }

  if (result.findings.length) {
    console.error(`live-route-drift: DRIFT — ${result.findings.length} route(s) disagree with the live surface.`);
    return EXIT_DRIFT;
  }
  console.log('live-route-drift: OK — every live route is declared, and every promised declaration is live.');
  return EXIT_OK;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
