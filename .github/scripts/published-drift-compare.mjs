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
 *   unpublished-repo   Declared here, not served. Suppressed — and ONLY suppressed — when the
 *                      operation carries `x-schema-status: draft`, the spec's own statement that
 *                      the shape is a placeholder and not yet a promise to consumers. Promote an
 *                      operation out of draft and this gate immediately requires the published
 *                      contract to carry it. Draft is a lane to publication, not a parking space.
 *   shared-drift       In both, different once the gateway's serve-time enrichment is normalized
 *                      away (see published-drift-normalize.mjs).
 *
 * WHY `draft` SUPPRESSES RATHER THAN AN ALLOWLIST ENTRY PER OPERATION. There are 158 such
 * operations today. Enumerating them in a JSON file would mean every new draft stub carries an
 * allowlist edit, the file rots, and the exemptions decay into noise nobody reads. `draft` is a
 * property the spec already states about itself, in the operation, next to the schema it
 * qualifies — so the gate reads it there. The allowlist is reserved for what no rule covers.
 */
import { isDeepStrictEqual } from 'node:util';
import { NORMALIZATION_RULES, NO_OBSERVATIONS, normalizePair } from './published-drift-normalize.mjs';

export const DIRECTIONS = ['undocumented-live', 'unpublished-repo', 'shared-drift'];

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
 * An allowlist entry is honored ONLY while the live operation still matches every `expect` field
 * and carries none of the `expectAbsent` keys — the same idea as skills-index-coverage.mjs's
 * allowlistStillApplies(): an exemption that survives on a path match alone outlives its own
 * justification.
 *
 * Two deliberate refinements over that function, both required for OpenAPI operation objects:
 *   - a `null` expectation matches an ABSENT key as well as a literal null, because for an
 *     operation "no `security` key" and "`security: null`" make the same claim;
 *   - `expectAbsent` names keys that must NOT appear. This is what makes an exemption granted for
 *     an UNAUTHENTICATED public route lapse the moment that route gains a `security` requirement:
 *     the exemption was reasoned about the unauthenticated shape and must not silently carry over
 *     to the authenticated one.
 */
export function allowlistStillApplies(entry, liveOp) {
  if (!liveOp) return false;
  for (const [path, expected] of Object.entries(entry.expect ?? {})) {
    const actual = getPath(liveOp, path);
    if (expected === null ? actual !== null && actual !== undefined : !isDeepStrictEqual(actual, expected)) return false;
  }
  for (const key of entry.expectAbsent ?? []) {
    if (getPath(liveOp, key) !== undefined) return false;
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
    const key = `${e.direction} ${e.method.toUpperCase()} ${e.path}`;
    if (seen.has(key)) return `duplicate allowlist entry for ${key}`;
    seen.add(key);
  }
  return null;
}

export function compare({ repoDoc, liveDoc, allowlist = [], normalize = true }) {
  const repoOps = indexOperations(repoDoc);
  const liveOps = indexOperations(liveDoc);
  const allowByKey = new Map(allowlist.map((e) => [`${e.direction} ${e.method.toUpperCase()} ${e.path}`, e]));

  const findings = [];
  const allowlisted = [];
  const lapsedAllowlist = [];
  const draftNotYetPublished = [];
  const enrichmentObservations = { descriptionsOverwritten: [], operationIdsSynthesized: 0, errorResponsesInjected: 0 };

  const record = (direction, path, method, entry, detail, liveOp) => {
    const allow = allowByKey.get(`${direction} ${method.toUpperCase()} ${path}`);
    if (allow) {
      if (allowlistStillApplies(allow, liveOp)) {
        allowlisted.push({ ...entry, direction, justification: allow.justification });
        return;
      }
      lapsedAllowlist.push({
        ...entry,
        direction,
        justification: allow.justification,
        reason: "the live operation no longer matches the entry's expect/expectAbsent predicate",
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
      draftNotYetPublished.push(entry);
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

    const differences = diffOperation(repo, live);
    if (differences.length === 0) continue;
    record('shared-drift', path, method, { path, method: method.toUpperCase() }, { severity: 'contract-mismatch', differences }, liveEntry.op);
  }

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
      sharedDrift: count('shared-drift'),
      draftNotYetPublished: draftNotYetPublished.length,
      allowlisted: allowlisted.length,
      lapsedAllowlistEntries: lapsedAllowlist.length,
    },
    findings,
    allowlisted,
    lapsedAllowlist,
    draftNotYetPublished,
    enrichmentObservations,
    normalizationRules: normalize ? NORMALIZATION_RULES : ['NORMALIZATION DISABLED (--no-normalize)'],
  };
}
