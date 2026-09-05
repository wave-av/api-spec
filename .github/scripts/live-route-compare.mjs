#!/usr/bin/env node
/**
 * live-route-compare.mjs — the pure three-way comparison. No network, no filesystem, no
 * process.exit. Probe results are an INPUT here, not a side effect, so the entire verdict is
 * testable offline against hand-built fixtures.
 *
 * ── THE TWO FINDINGS ────────────────────────────────────────────────────────────────────────────
 *   live-undeclared    The probe says the route is MAPPED, and it appears in NEITHER openapi.yaml
 *                      nor the published contract. This is the direction `published-drift.mjs`
 *                      structurally cannot see, because that gate compares those two documents to
 *                      each other: public surface that no artifact describes and nobody reviewed as
 *                      public surface.
 *   declared-not-live  Declared in openapi.yaml WITHOUT `x-schema-status: draft` — stated as a
 *                      promise to consumers — but the gateway answers ROUTE_NOT_MAPPED. The two
 *                      documents can agree with each other and both be wrong; only the live probe
 *                      can say so.
 *
 * `draft` suppresses the second direction for the same reason it does in `published-drift-compare.mjs`:
 * it is the spec's own statement that a shape is a placeholder rather than a promise. It does NOT
 * suppress the first — an undeclared live route is a finding no matter what the spec says about
 * anything else, because the spec is not what is serving traffic.
 */
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export const DIRECTIONS = ['live-undeclared', 'declared-not-live'];

/** `/clips` + server base `/v1` -> `/v1/clips`. Both specs declare paths relative to servers[0]. */
export function basePath(doc) {
  const url = doc?.servers?.[0]?.url;
  if (!url) return '';
  try {
    return new URL(url).pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
}

/** Templated paths cannot be probed: a made-up id would test the id, not the route. */
export function isProbeable(path) {
  return !path.includes('{');
}

/** `/v1/render/{jobId}` -> `v1/render`, the product-level key the live enumerators are keyed at. */
export function segmentKey(path) {
  return path.split('/').filter(Boolean).slice(0, 2).join('/');
}

/**
 * Is this path inside the CONTRACT'S DOMAIN OF DISCOURSE?
 *
 * openapi.yaml declares a contract for `https://api.wave.online/v1`. The gateway also serves
 * `/robots.txt`, `/favicon.svg`, `/llms.txt`, `/health` and friends, which are live, public, and
 * correctly absent from an API contract — no OpenAPI document would ever declare them. Reporting
 * them as "undeclared live routes" would be 7 false findings sitting on top of the real ones, and a
 * gate people learn to skim is a gate that stops working.
 *
 * This is a SCOPE rule, not a suppression: it is keyed on the spec's own `servers[0]` base, so any
 * route under `/v1/` — the entire API surface, including anything new — is always in scope and can
 * never be excluded by it. If the base is empty (a spec with no servers block) everything is in
 * scope, which is the fail-closed direction.
 */
export function withinSpecBase(path, base) {
  if (!base) return true;
  return path === base || path.startsWith(`${base}/`);
}

/** Union of every candidate path worth probing, from all five enumerators. */
export function candidatePaths({ repoDoc, publishedDoc, scopeCatalog, capabilityIndex, seeds }) {
  const out = new Set();
  const add = (p) => {
    if (typeof p === 'string' && p.startsWith('/') && isProbeable(p)) out.add(p);
  };
  const repoBase = basePath(repoDoc);
  for (const p of Object.keys(repoDoc?.paths ?? {})) add(`${repoBase}${p}`);
  const pubBase = basePath(publishedDoc);
  for (const p of Object.keys(publishedDoc?.paths ?? {})) add(`${pubBase}${p}`);
  for (const r of scopeCatalog?.routes ?? []) add(r?.path);
  for (const p of scopeCatalog?.no_scope_required?.paths ?? []) add(p);
  for (const s of Object.values(capabilityIndex ?? {})) add(s?.path);
  for (const s of seeds ?? []) add(s?.path);
  return [...out].sort();
}

/**
 * What `published-drift.mjs` can see, reproduced in four lines for ONE purpose: the test suite
 * asserts that this returns ZERO findings on an input where `compareAgainstLive` returns one. That
 * is the mutation proof for this whole feature — remove the live probe and the answer silently
 * becomes "no drift". Exported so the claim is executable rather than a comment someone can drift
 * away from.
 */
export function twoArtifactDriftOnly({ repoDoc, publishedDoc }) {
  const repoBase = basePath(repoDoc);
  const pubBase = basePath(publishedDoc);
  const repo = new Set(Object.keys(repoDoc?.paths ?? {}).map((p) => `${repoBase}${p}`));
  const pub = new Set(Object.keys(publishedDoc?.paths ?? {}).map((p) => `${pubBase}${p}`));
  return [...pub].filter((p) => !repo.has(p)).concat([...repo].filter((p) => !pub.has(p)));
}

export function compareAgainstLive({ repoDoc, publishedDoc, probes, allowlist = [] }) {
  const repoBase = basePath(repoDoc);
  const pubBase = basePath(publishedDoc);
  const repoPaths = new Map(Object.entries(repoDoc?.paths ?? {}).map(([p, item]) => [`${repoBase}${p}`, item]));
  const pubPaths = new Set(Object.keys(publishedDoc?.paths ?? {}).map((p) => `${pubBase}${p}`));

  // Segment-level coverage, because the live enumerators are product-granular: the capability index
  // lists `/v1/voice` while the spec documents `/voice/voices` and `/voice/generate`. Calling the
  // product root undeclared would bury the one real finding under a dozen false ones, and a gate
  // nobody can read is a gate nobody acts on.
  const repoSegs = new Set([...repoPaths.keys()].map(segmentKey));
  const pubSegs = new Set([...pubPaths].map(segmentKey));

  const allowByKey = new Map(allowlist.map((e) => [`${e.direction} ${e.path}`, e]));
  const usedAllowKeys = new Set();
  const findings = [];
  const allowlisted = [];
  const indeterminate = [];
  const outOfScope = [];

  const record = (direction, path, detail) => {
    const key = `${direction} ${path}`;
    const allow = allowByKey.get(key);
    if (allow) {
      usedAllowKeys.add(key);
      allowlisted.push({ direction, path, ...detail, justification: allow.justification });
      return;
    }
    findings.push({ direction, path, ...detail });
  };

  for (const [path, probe] of probes) {
    if (probe.state === 'indeterminate') {
      // Neither a pass nor a finding. Surfaced so a run that could not read half the surface can
      // never masquerade as a clean one.
      indeterminate.push({ path, reason: probe.error ?? `HTTP ${probe.status}` });
      continue;
    }
    if (!withinSpecBase(path, repoBase)) {
      outOfScope.push({ path, reason: `outside the spec's server base ${repoBase}` });
      continue;
    }
    const declaredRepo = repoPaths.has(path) || repoSegs.has(segmentKey(path));
    const declaredPub = pubPaths.has(path) || pubSegs.has(segmentKey(path));

    if (probe.state === 'mapped' && !declaredRepo && !declaredPub) {
      record('live-undeclared', path, {
        severity: 'security-relevant',
        status: probe.status,
        note:
          'live on the gateway and absent from BOTH openapi.yaml and the published contract — public surface no artifact ' +
          'describes. published-drift.mjs cannot see this: it compares those two documents to each other.',
      });
      continue;
    }

    if (probe.state === 'absent') {
      const item = repoPaths.get(path);
      if (!item) continue; // not declared here and not live: nothing to say
      const ops = Object.entries(item).filter(([m]) => HTTP_METHODS.includes(m.toLowerCase()));
      const promised = ops.filter(([, op]) => op?.['x-schema-status'] !== 'draft');
      if (!promised.length) continue;

      // THE PROBE IS A GET, SO IT CAN ONLY JUDGE A GET. The gateway's scope map is keyed by route
      // AND method, so a POST-only route answers ROUTE_NOT_MAPPED to a GET while its POST is
      // perfectly live. Reporting that as "declared but not served" would be this gate committing
      // the very error it exists to prevent — asserting a fact about production that its evidence
      // does not support. MEASURED: /v1/agent/auth/device and /v1/agent/auth/token are POST-only
      // OAuth device-grant routes; a GET to each returns 403 ROUTE_NOT_MAPPED, and an earlier draft
      // of this file reported both as findings. They are not findings.
      //
      // This does NOT quietly pass them. An unverifiable claim is INDETERMINATE and is surfaced as
      // such — unknown is not a pass. Closing the gap properly means probing the declared method,
      // which for a POST means a write, which this gate will not do.
      if (!promised.some(([m]) => m.toLowerCase() === 'get')) {
        indeterminate.push({
          path,
          reason: `declares only ${promised.map(([m]) => m.toUpperCase()).sort().join('/')} — a GET probe cannot establish whether that method is served`,
        });
        continue;
      }
      record('declared-not-live', path, {
        severity: 'contract-ahead',
        status: probe.status,
        methods: promised.map(([m]) => m.toUpperCase()).sort(),
        note:
          'declared in openapi.yaml without x-schema-status: draft, but the gateway answers ROUTE_NOT_MAPPED — the two ' +
          'documents may agree with each other and both still be wrong; only the live probe can tell.',
      });
    }
  }

  const unmatchedAllowlist = [...allowByKey.keys()].filter((k) => !usedAllowKeys.has(k)).sort();
  findings.sort((a, b) => `${a.direction} ${a.path}`.localeCompare(`${b.direction} ${b.path}`));

  const count = (d) => findings.filter((f) => f.direction === d).length;
  return {
    headline: {
      probed: probes.size,
      mapped: [...probes.values()].filter((p) => p.state === 'mapped').length,
      absent: [...probes.values()].filter((p) => p.state === 'absent').length,
      indeterminate: indeterminate.length,
      outOfScope: outOfScope.length,
      repoDeclaredPaths: repoPaths.size,
      publishedPaths: pubPaths.size,
      liveUndeclared: count('live-undeclared'),
      declaredNotLive: count('declared-not-live'),
      allowlisted: allowlisted.length,
      unmatchedAllowlistEntries: unmatchedAllowlist.length,
    },
    findings,
    allowlisted,
    indeterminate,
    outOfScope,
    unmatchedAllowlist,
  };
}

/** Returns an error string, or null when the allowlist is well-formed. */
export function validateAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) return `allowlist is not an array (got ${typeof allowlist})`;
  const seen = new Set();
  for (const e of allowlist) {
    if (!e || typeof e.path !== 'string') return `allowlist entry needs a string path: ${JSON.stringify(e)}`;
    if (!DIRECTIONS.includes(e.direction)) return `allowlist entry ${e.path} has an unknown direction ${JSON.stringify(e.direction)}`;
    if (typeof e.justification !== 'string' || e.justification.trim().length < 20)
      return `allowlist entry ${e.path} needs a real justification (>=20 chars)`;
    const key = `${e.direction} ${e.path}`;
    if (seen.has(key)) return `duplicate allowlist entry for ${key}`;
    seen.add(key);
  }
  return null;
}
