#!/usr/bin/env node
/**
 * probe-live.mjs — a direct, single-document liveness check: does every non-deprecated operation
 * THIS repo currently promises still answer as SERVED against the real gateway, right now?
 *
 * Deliberately narrower than live-route-drift.mjs (which unions five enumerators and reasons about
 * three documents at once): this script reads ONLY openapi.yaml and asks one question per declared,
 * non-deprecated path — "is this route mapped?" — using the exact same probe semantics
 * (live-route-probe.mjs) and the exact same per-operation `servers`-override exclusion
 * (live-route-compare.mjs's hasOwnServerOverride) that live-route-drift.mjs already relies on: a
 * path where every operation carries its own `servers` override (the Realtime API at
 * realtime.wave.online; `/leaderboard` and `/platform` at the bare `https://api.wave.online` host
 * root, no `/v1`) is served at a DIFFERENT origin than the one this script's prober queries
 * (`live-route-probe.mjs`'s `ORIGIN`, `https://api.wave.online`) and is skipped rather than probed
 * at the wrong host. MEASURED live 2026-09-28: probing `/leaderboard`/`/platform` at their OWN
 * declared override answers 401 (LEADERBOARD_AUTH_REQUIRED / TELEMETRY_AUTH_REQUIRED) — genuinely
 * served — while probing the wrong, un-overridden `.../v1/leaderboard` path a naive uniform prober
 * would guess answers 404 ROUTE_NOT_MAPPED. Skipping is correct here, not a gap: verifying an
 * override host is out of scope for a script hardwired to one origin, exactly as it already is for
 * live-route-drift.mjs's candidatePaths/compareAgainstLive.
 *
 * A path whose only non-deprecated methods are non-GET is not judged here either, for the same
 * reason live-route-compare.mjs excludes it: the gateway's scope map is keyed by route AND method,
 * so an unauthenticated GET on a POST-only route proves nothing about whether its POST is served.
 * It is logged as skipped, never failed.
 *
 * EXIT CODES
 *   0  every GET-checkable, non-deprecated path answered something other than the closed
 *      not-served set (ROUTE_NOT_MAPPED / ROUTE_NOT_FOUND / SPOKE_OPERATION_NOT_FOUND).
 *   1  at least one such path is ABSENT, or the spec could not be read, or there is nothing to check.
 *
 * COST: every probe is an unauthenticated, bodiless GET — free, per live-route-probe.mjs's own cost
 * policy. Never add a paid call, a POST, or an authenticated request to this file.
 *
 * USAGE
 *   node .github/scripts/probe-live.mjs [openapi.yaml]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { probeAll, ABSENT, INDETERMINATE } from './live-route-probe.mjs';
import { basePath, hasOwnServerOverride, isProbeable } from './live-route-compare.mjs';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * Every path worth probing against THIS document's own base, in origin-relative form. Skips:
 * templated paths (isProbeable), a path with an operation-level `servers` override (see header —
 * served at a different origin than this script queries), paths whose every operation is already
 * `deprecated: true`, and paths with no non-deprecated GET (an unauthenticated GET cannot confirm
 * whether a write-only route is served).
 */
export function livePathsToCheck(doc) {
  const docBase = basePath(doc);
  const out = [];
  for (const [p, item] of Object.entries(doc?.paths ?? {})) {
    if (!isProbeable(p)) continue;
    if (hasOwnServerOverride(item)) continue; // different origin -- out of scope, see header
    const ops = Object.entries(item ?? {}).filter(([m]) => HTTP_METHODS.includes(m.toLowerCase()));
    const live = ops.filter(([, op]) => !op?.deprecated);
    if (!live.length) continue;
    if (!live.some(([m]) => m.toLowerCase() === 'get')) continue;
    out.push({ path: `${docBase}${p}`, methods: live.map(([m]) => m.toUpperCase()).sort() });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function main(argv = process.argv.slice(2)) {
  const specPath = argv.find((a) => !a.startsWith('--')) ?? 'openapi.yaml';
  let doc;
  try {
    const yaml = await import('js-yaml');
    doc = (yaml.default ?? yaml).load(readFileSync(specPath, 'utf8'));
  } catch (err) {
    console.error(`probe-live: could not read/parse ${specPath}: ${err.message}`);
    return 1;
  }
  if (!doc?.paths || typeof doc.paths !== 'object') {
    console.error(`probe-live: ${specPath} has no usable "paths" object`);
    return 1;
  }

  const targets = livePathsToCheck(doc);
  if (!targets.length) {
    console.error('probe-live: zero probeable non-deprecated GET paths — refusing to call that a clean run');
    return 1;
  }

  const probes = await probeAll(targets.map((t) => t.path));
  let absent = 0;
  let unread = 0;
  for (const { path } of targets) {
    const probe = probes.get(path);
    if (probe.state === ABSENT) {
      absent += 1;
      console.error(`::error::ABSENT ${path} — HTTP ${probe.status} ${probe.body?.error?.code ?? ''}`.trim());
    } else if (probe.state === INDETERMINATE) {
      unread += 1;
      console.log(`::warning::could not classify ${path}: ${probe.error ?? `HTTP ${probe.status}`}`);
    }
  }
  console.log(
    `probe-live: checked ${targets.length} non-deprecated GET-declaring path(s) — ` +
      `${targets.length - absent - unread} mapped, ${absent} ABSENT, ${unread} indeterminate`,
  );
  if (absent > 0) {
    console.error(`probe-live: FAIL — ${absent} declared, non-deprecated route(s) are not served live.`);
    return 1;
  }
  console.log('probe-live: OK — every declared, non-deprecated, GET-checkable route answers as served.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
