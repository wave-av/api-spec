#!/usr/bin/env node
/**
 * published-drift-compare.mjs — the pure comparison. No network, no filesystem, no process.exit.
 * Everything the CLI and the tests both need is decided here; `published-drift.mjs` is the shell
 * that feeds it documents and turns its verdict into an exit code.
 *
 * THE THREE DIRECTIONS
 *   undocumented-live  Served by the gateway, absent from openapi.yaml. THE SECURITY-RELEVANT
 *                      DIRECTION: an operation the gateway serves that the published contract does
 *                      not describe is public API nobody reviewed as public API. Always a finding
 *                      unless explicitly allowlisted with a justification AND a live predicate.
 *   unpublished-repo   Declared here, not served BY THE PUBLISHED SPEC. Suppressed — and ONLY
 *                      suppressed — when the operation carries `x-schema-status: draft` AND the
 *                      gateway itself has never been observed to serve the route live. Promote an
 *                      operation out of draft, or have it start answering anything other than 403
 *                      ROUTE_NOT_MAPPED on the real gateway, and this gate immediately requires the
 *                      published contract to carry it. Draft is a lane to publication, not a
 *                      parking space — and it is not a bucket a live route can hide in either.
 *   shared-drift       In both, different once the gateway's serve-time enrichment is normalized
 *                      away (see published-drift-normalize.mjs).
 *
 * WHY `draft` SUPPRESSES RATHER THAN AN ALLOWLIST ENTRY PER OPERATION. There were 158 such
 * operations on 2026-09-04. Enumerating them in a JSON file would mean every new draft stub carries
 * an allowlist edit, the file rots, and the exemptions decay into noise nobody reads. `draft` is a
 * property the spec already states about itself, in the operation, next to the schema it
 * qualifies — so the gate reads it there. The allowlist is reserved for what no rule covers.
 *
 * THE DRAFT-LIVE CARVE-OUT (added after the 2026-09-04 GA verdict: `unpublishedRepo: 0` was zero
 * by redefinition — 158 operations were shunted into `draft` and excluded from the count while 10
 * of 10 sampled answered a live 402 in production, meaning the route exists and is priced. A 402
 * is not a draft.). `draft` suppresses an operation ONLY while `liveObservations` (a Map the caller
 * builds — see published-drift-live.mjs — by asking the real gateway) has NO observation for that
 * path, or classifies it as `unpublished`. The moment the observation classifies as `live` or
 * `unknown`, the finding is NOT suppressed: it is reported under its own `draft-but-live` direction
 * (severity `claim-contradicted-by-behaviour` for a confirmed-live route, `unverifiable` for a probe
 * that could not resolve — UNKNOWN IS NOT A PASS), and it counts in `headline.draftButLive` and
 * `headline.liveProbed`. An operation with no `liveObservations` at all (the offline `--live
 * <snapshot>` or `--no-live-probe` paths, which are documented to stay fully offline) keeps the
 * prior behavior — suppressed — because compare() itself makes no network calls; the probe and its
 * classification both live in published-drift.mjs / published-drift-live.mjs.
 */
import { isDeepStrictEqual } from 'node:util';
import { NORMALIZATION_RULES, NO_OBSERVATIONS, normalizePair } from './published-drift-normalize.mjs';
import { classifyLiveObservation, describeObservation } from './published-drift-live.mjs';

export const DIRECTIONS = ['undocumented-live', 'unpublished-repo', 'draft-but-live', 'shared-drift'];

/** The HTTP verbs an OpenAPI path item may carry; anything else there is metadata, not an operation. */
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** `{ "GET /render": { path, method, op } }` — one flat index per document, method upper-cased. */
export function indexOperations(doc) {
  const out = new Map();
  for (const [path, item] of Object.entries(doc?.paths ?? {})) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method.toLowerCase())) continue;
      if (!op || typeof op !== 'object' || Array.isArray(op)) continue;
      out.set(`${method.toUpperCase()} ${path}`, { path, method: method.toLowerCase(), op });
    }
  }
  return out;
}

/** Top-level field-by-field difference between two normalized operations. */
export function diffOperation(repoOp, liveOp) {
  const fields = new Set([...Object.keys(repoOp ?? {}), ...Object.keys(liveOp ?? {})]);
  const diffs = [];
  for (const field of [...fields].sort()) {
    if (!isDeepStrictEqual(repoOp?.[field], liveOp?.[field])) {
      diffs.push({ field, repo: repoOp?.[field] ?? null, published: liveOp?.[field] ?? null });
    }
  }
  return diffs;
}

/** Dotted-path lookup, the same shape skills-index-coverage.mjs uses for its `expect` predicates. */
export function getPath(obj, path) {
  return String(path)
    .split('.')
    .reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/**
 * The security requirement that ACTUALLY applies to an operation.
 *
 * OpenAPI 3.x makes a document-level `security` the DEFAULT for every operation that does not state
 * its own. So an operation with no `security` key, in a document that has one, is authenticated —
 * and reading only the operation object would call it unauthenticated. That distinction is the
 * whole point of the `expectAbsent: ["security"]` guard on this repo's live-surface exemptions,
 * whose justifications say in as many words that the exemption lapses "the moment the operation
 * gains a security requirement". Auth arriving at the document root is that moment just as much as
 * auth arriving on the operation, so it has to be resolved before the predicate is evaluated.
 *
 * Only `security` is inherited here. It is the one operation field OpenAPI defines as a whole-value
 * document default; `parameters` and `servers` merge under different rules and no predicate in this
 * repo depends on them.
 */
export function effectiveOperation(liveOp, liveDoc) {
  if (!liveOp || liveOp.security !== undefined || liveDoc?.security === undefined) return liveOp;
  return { ...liveOp, security: liveDoc.security };
}

/**
 * An allowlist entry is honored ONLY while the live operation still matches every `expect` field
 * and carries none of the `expectAbsent` keys — the same idea as skills-index-coverage.mjs's
 * allowlistStillApplies(): an exemption that survives on a path match alone outlives its own
 * justification.
 *
 * Three deliberate refinements over that function, all required for OpenAPI operation objects:
 *   - a `null` expectation matches an ABSENT key as well as a literal null, because for an
 *     operation "no `security` key" and "`security: null`" make the same claim;
 *   - `expectAbsent` names keys that must NOT appear. This is what makes an exemption granted for
 *     an UNAUTHENTICATED public route lapse the moment that route gains a `security` requirement:
 *     the exemption was reasoned about the unauthenticated shape and must not silently carry over
 *     to the authenticated one. `liveDoc` is read so that document-level auth counts as gaining it
 *     (see effectiveOperation);
 *   - the `unpublished-repo` direction has NO live operation by construction — the operation is
 *     declared here and not served — so there is nothing for a predicate to match. A predicate-free
 *     entry there is still a valid exemption and is honored; one that states a predicate cannot be
 *     graded at all and lapses rather than being honored blind. validateAllowlist rejects that
 *     combination up front, so this branch is the belt to its braces.
 */
export function allowlistStillApplies(entry, liveOp, liveDoc) {
  const expect = entry.expect ?? {};
  const expectAbsent = entry.expectAbsent ?? [];
  if (!liveOp) return Object.keys(expect).length === 0 && expectAbsent.length === 0;
  const op = effectiveOperation(liveOp, liveDoc);
  for (const [path, expected] of Object.entries(expect)) {
    const actual = getPath(op, path);
    if (expected === null ? actual !== null && actual !== undefined : !isDeepStrictEqual(actual, expected)) return false;
  }
  for (const key of expectAbsent) {
    if (getPath(op, key) !== undefined) return false;
  }
  return true;
}

/** Returns an error string, or null when the allowlist is well-formed. */
export function validateAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) return `allowlist is not an array (got ${typeof allowlist})`;
  const seen = new Set();
  for (const e of allowlist) {
    if (!e || typeof e.path !== 'string' || typeof e.method !== 'string')
      return `allowlist entry needs string path and method: ${JSON.stringify(e)}`;
    if (typeof e.justification !== 'string' || e.justification.trim().length < 20)
      return `allowlist entry ${e.method} ${e.path} needs a real justification (>=20 chars)`;
    if (!DIRECTIONS.includes(e.direction))
      return `allowlist entry ${e.method} ${e.path} has an unknown direction ${JSON.stringify(e.direction)}`;
    const hasPredicate = Object.keys(e.expect ?? {}).length > 0 || (e.expectAbsent ?? []).length > 0;
    // Directions `record()` never hands a live OpenAPI operation object to. `unpublished-repo` has
    // none by construction (declared here, not served). `draft-but-live` has a live PROBE
    // OBSERVATION ({status, bodyCode}), not an operation object — there is nothing shaped like an
    // operation for `expect`/`expectAbsent` to walk. A predicate on either direction validates and
    // then never gets to run: allowlistStillApplies always receives `liveOp: null` for both, so it
    // always takes the "no live operation" branch, which is unconditionally false the moment a
    // predicate is present.
    const noLiveOperation = ['unpublished-repo', 'draft-but-live'].includes(e.direction);
    // The header of this file promises that a live-direction exemption carries "a justification AND
    // a live predicate". Enforce the second half: without a predicate the entry is honored on
    // path+method alone, can never lapse, and outlives the reasoning that granted it — the exact
    // failure `expectAbsent` exists to prevent.
    if (!noLiveOperation && !hasPredicate)
      return `allowlist entry ${e.method} ${e.path} (${e.direction}) needs an expect or expectAbsent predicate — an exemption that cannot lapse outlives its justification`;
    // The mirror image. `unpublished-repo` and `draft-but-live` never receive a live operation to
    // evaluate against, so a predicate on either can never be true; the entry would validate, then
    // silently never apply.
    if (noLiveOperation && hasPredicate)
      return `allowlist entry ${e.method} ${e.path} (${e.direction}) cannot carry a predicate — there is no live operation to evaluate one against`;
    const key = `${e.direction} ${e.method.toUpperCase()} ${e.path}`;
    if (seen.has(key)) return `duplicate allowlist entry for ${key}`;
    seen.add(key);
  }
  return null;
}

export function compare({ repoDoc, liveDoc, allowlist = [], normalize = true, liveObservations = null }) {
  const repoOps = indexOperations(repoDoc);
  const liveOps = indexOperations(liveDoc);
  const allowByKey = new Map(allowlist.map((e) => [`${e.direction} ${e.method.toUpperCase()} ${e.path}`, e]));

  const findings = [];
  const allowlisted = [];
  const lapsedAllowlist = [];
  const draftNotYetPublished = [];
  const enrichmentObservations = {
    descriptionsOverwritten: [],
    operationIdsSynthesized: 0,
    errorResponsesInjected: 0,
    errorResponsesOverwritten: [],
    parametersStripped: 0,
  };

  // Every allowlist key `record` actually consults. What is left over at the end is an exemption
  // that matched nothing — see unmatchedAllowlist below.
  const usedAllowKeys = new Set();

  const record = (direction, path, method, entry, detail, liveOp) => {
    const allowKey = `${direction} ${method.toUpperCase()} ${path}`;
    const allow = allowByKey.get(allowKey);
    if (allow) {
      usedAllowKeys.add(allowKey);
      if (allowlistStillApplies(allow, liveOp, liveDoc)) {
        allowlisted.push({ ...entry, direction, justification: allow.justification });
        return;
      }
      lapsedAllowlist.push({
        ...entry,
        direction,
        justification: allow.justification,
        // Name the actual cause. "No longer matches the predicate" is false when there was never a
        // live operation to match one against, and a wrong reason sends the reader hunting for a
        // change in the published contract that never happened.
        reason: liveOp
          ? "the live operation no longer matches the entry's expect/expectAbsent predicate"
          : 'this direction has no live operation, and the entry states a predicate that therefore cannot be evaluated',
      });
    }
    findings.push({ ...entry, direction, ...detail });
  };

  // ── undocumented-live: served, but this repo never described it. ───────────────────────────
  for (const [key, { path, method, op }] of liveOps) {
    if (repoOps.has(key)) continue;
    record(
      'undocumented-live',
      path,
      method,
      { path, method: method.toUpperCase() },
      {
        severity: 'security-relevant',
        note: 'served by the gateway but absent from openapi.yaml — public API the published contract does not describe',
        publishedSummary: op.summary ?? null,
        publishedTags: op.tags ?? null,
        publishedSecurity: op.security ?? null,
      },
      op,
    );
  }

  // ── unpublished-repo: declared here, not served. ───────────────────────────────────────────
  for (const [key, { path, method, op }] of repoOps) {
    if (liveOps.has(key)) continue;
    const entry = {
      path,
      method: method.toUpperCase(),
      operationId: op.operationId ?? null,
      xSchemaStatus: op['x-schema-status'] ?? null,
      xPriceModel: op['x-price']?.model ?? null,
      xSkillUrl: op['x-skill-url'] ?? null,
    };
    if (op['x-schema-status'] === 'draft') {
      // SUPPRESSION NOW REQUIRES TWO INDEPENDENT CONDITIONS, and an annotation can only ever
      // satisfy one of them. `draft` is a CLAIM that the operation is not yet a promise to
      // consumers; the live gateway is the GROUND TRUTH about whether it is one already. When
      // `liveObservations` is present, a route that answers is published in behaviour no matter
      // what the annotation says, and no edit to openapi.yaml can hide it again.
      const observed = liveObservations ? classifyLiveObservation(liveObservations.get(path)) : null;
      if (observed === null || observed === 'unpublished') {
        draftNotYetPublished.push({ ...entry, liveEvidence: observed === null ? null : describeObservation(liveObservations.get(path)) });
        continue;
      }
      record(
        'draft-but-live',
        path,
        method,
        { ...entry, liveEvidence: describeObservation(liveObservations.get(path)) },
        observed === 'unknown'
          ? {
              severity: 'unverifiable',
              // UNKNOWN IS NOT A PASS. A probe that could not run is not evidence that the route is
              // absent, and letting it fall back into the suppressed bucket would restore exactly
              // the false-green this tier removes — quietly, and only during an outage.
              note: 'declared draft, and the live gateway could not be asked whether it already serves this route — an unverifiable suppression is not a suppression',
            }
          : {
              severity: 'claim-contradicted-by-behaviour',
              note: 'declared x-schema-status: draft — the claim that it is not yet a promise to consumers — while the live gateway already answers for it. On this gateway an unmapped path returns ROUTE_NOT_MAPPED, so an answer proves the route exists. Publication is a fact about behaviour, not about an annotation.',
            },
        null,
      );
      continue;
    }
    record(
      'unpublished-repo',
      path,
      method,
      entry,
      {
        severity: 'contract-ahead',
        note: 'declared in openapi.yaml without x-schema-status: draft, but the published contract does not serve it — either the gateway pin is behind or the operation was promoted before it shipped',
      },
      null,
    );
  }

  // ── shared-drift: in both, different after normalization. ──────────────────────────────────
  for (const [key, { path, method, op: repoOp }] of repoOps) {
    const liveEntry = liveOps.get(key);
    if (!liveEntry) continue;
    const { repo, live, observations } = normalize
      ? normalizePair(repoOp, liveEntry.op, path, method)
      : { repo: repoOp, live: liveEntry.op, observations: NO_OBSERVATIONS };
    if (observations.descriptionOverwritten) enrichmentObservations.descriptionsOverwritten.push(`${method.toUpperCase()} ${path}`);
    if (observations.strippedOperationId) enrichmentObservations.operationIdsSynthesized++;
    enrichmentObservations.errorResponsesInjected += observations.strippedErrorCodes.length;
    if (observations.overwrittenErrorCodes.length) {
      enrichmentObservations.errorResponsesOverwritten.push(
        `${method.toUpperCase()} ${path} (${observations.overwrittenErrorCodes.join(', ')})`,
      );
    }
    enrichmentObservations.parametersStripped += observations.strippedParameters.length;

    const differences = diffOperation(repo, live);
    if (differences.length === 0) continue;
    record('shared-drift', path, method, { path, method: method.toUpperCase() }, { severity: 'contract-mismatch', differences }, liveEntry.op);
  }

  // An exemption `record` never consulted: its operation is no longer served, or openapi.yaml now
  // documents it, so no pass ever reaches for the key. Without this it is invisible — the headline
  // counts `allowlisted` and `lapsedAllowlistEntries`, and a dead entry appears in neither, so it
  // reads as "no allowlist problem" indefinitely. A standing grant nobody reviews is the thing an
  // allowlist is supposed to make impossible. Surfaced, not failed: a dead entry is stale
  // bookkeeping, not drift, and reddening the daily job for it would train people to ignore it.
  const unmatchedAllowlist = [...allowByKey.keys()]
    .filter((k) => !usedAllowKeys.has(k))
    .sort()
    .map((key) => ({ key, justification: allowByKey.get(key).justification }));

  findings.sort((a, b) => `${a.direction} ${a.path} ${a.method}`.localeCompare(`${b.direction} ${b.path} ${b.method}`));
  draftNotYetPublished.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));

  const count = (d) => findings.filter((f) => f.direction === d).length;
  return {
    headline: {
      repoVersion: repoDoc?.info?.version ?? null,
      repoPaths: Object.keys(repoDoc?.paths ?? {}).length,
      repoOperations: repoOps.size,
      publishedVersion: liveDoc?.info?.version ?? null,
      publishedPaths: Object.keys(liveDoc?.paths ?? {}).length,
      publishedOperations: liveOps.size,
      sharedOperations: [...repoOps.keys()].filter((k) => liveOps.has(k)).length,
      undocumentedLive: count('undocumented-live'),
      unpublishedRepo: count('unpublished-repo'),
      draftButLive: count('draft-but-live'),
      liveProbed: liveObservations ? liveObservations.size : null,
      sharedDrift: count('shared-drift'),
      draftNotYetPublished: draftNotYetPublished.length,
      allowlisted: allowlisted.length,
      lapsedAllowlistEntries: lapsedAllowlist.length,
      unmatchedAllowlistEntries: unmatchedAllowlist.length,
    },
    findings,
    allowlisted,
    lapsedAllowlist,
    unmatchedAllowlist,
    draftNotYetPublished,
    enrichmentObservations,
    normalizationRules: normalize ? NORMALIZATION_RULES : ['NORMALIZATION DISABLED (--no-normalize)'],
  };
}
