#!/usr/bin/env node
/**
 * published-drift-normalize.mjs — everything this repo knows about what the GATEWAY SERVICE does
 * to this spec on the way out.
 *
 * WHY THIS IS ITS OWN FILE. The service does not serve the spec verbatim: it rewrites every
 * operation as it publishes it. That behaviour belongs to a different deployable and changes on
 * its schedule, not this repo's, so it gets one small module — instead of being scattered through
 * the comparator — and there is exactly one place to look when the published shape changes.
 *
 * EVERY LITERAL BELOW WAS TRANSCRIBED FROM THE PUBLISHED DOCUMENT ITSELF
 * (https://api.wave.online/openapi.json), not from any service source. That is the honest source
 * for a public spec repo: the published contract is the only thing this repo can actually observe,
 * and it is the thing consumers get.
 *
 * WHY A NAIVE DIFFER IS USELESS WITHOUT THIS. Measured against the published document on
 * 2026-09-03: all 72 shared operations report a difference for enrichment reasons alone, 71 of
 * them in the response-code set. A comparator that skipped normalization would open with 72
 * findings, every one false, and be switched off within a day. `published-drift.test.mjs` pins
 * that property so the normalizer keeps earning its place.
 *
 * THE ONE INVARIANT: every rule strips by EXACT SHAPE, never by key name. The injected 404 is
 * removed only when it deep-equals the exact object the service publishes; a hand-written 404 that
 * merely happens to be missing upstream still surfaces as drift. Normalizing by key name would
 * blind the gate in precisely the fields the service touches.
 *
 * FAILURE MODE BY DESIGN: if the service changes its enrichment literals, these shapes stop
 * matching and the differences resurface as findings. The gate goes LOUD, not quiet.
 */
import { isDeepStrictEqual } from 'node:util';

/** The versioning block the service assigns onto every operation it publishes. */
export const VERSIONING = {
  description:
    'WAVE API v1. Versioned by URL path (/v1/). Deprecations announced via Sunset headers and the changelog.',
  'x-version': '1',
  'x-deprecation-policy': 'https://wave.online/changelog',
};

/** The shared error envelope the service injects on 4xx/429. */
export const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Machine-readable error code' },
        message: { type: 'string', description: 'Human-readable error message' },
        param: { type: 'string', description: 'The parameter that caused the error', nullable: true },
      },
      required: ['code', 'message'],
    },
  },
  required: ['error'],
};

/** Exactly these codes are injected when the published operation would otherwise lack them. */
export const INJECTED_ERROR_CODES = ['400', '401', '403', '404', '429'];

/** Only these verbs are enriched; anything else is published untouched. */
export const ENRICHED_METHODS = ['get', 'post', 'put', 'delete', 'patch'];

/**
 * The service's operationId synthesis, reproduced so a SYNTHESIZED id can be told apart from a
 * hand-set one. Stripping `operationId` whenever this repo lacked one would also hide a real,
 * hand-written id the service had begun publishing.
 */
export function synthesizeOperationId(path, method) {
  const segs = String(path)
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/[^a-zA-Z0-9]/g, ''));
  const name = segs.map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1))).join('');
  return `${method}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * Strip the serve-time enrichment from a matched (repo, published) operation pair so the two are
 * comparable. Returns normalized copies plus the observations worth reporting upward.
 */
export function normalizePair(repoOp, liveOp, path, method) {
  const repo = clone(repoOp) ?? {};
  const live = clone(liveOp) ?? {};
  const observations = { descriptionOverwritten: false, strippedErrorCodes: [], strippedOperationId: false };
  if (!ENRICHED_METHODS.includes(method)) return { repo, live, observations };

  // RULE 1 — the two versioning extensions.
  for (const key of ['x-version', 'x-deprecation-policy']) {
    if (live[key] === VERSIONING[key]) delete live[key];
  }

  // RULE 2 — the same assignment OVERWRITES `description` unconditionally, so when the published
  // description is the boilerplate it carries no information about this repo's and comparing them
  // is meaningless: drop both sides. But a repo description that was real and different has been
  // DESTROYED in the published contract. That is a defect in the publishing service, not drift in
  // this spec, and its remedy lives there (assign only the two x- keys; set description only when
  // absent). Record it so it is reported rather than silently absorbed; it does not fail this gate.
  if (live.description === VERSIONING.description) {
    if (typeof repo.description === 'string' && repo.description !== VERSIONING.description) {
      observations.descriptionOverwritten = true;
    }
    delete live.description;
    delete repo.description;
  }

  // RULE 3 — a synthesized operationId, and only a synthesized one.
  if (repo.operationId === undefined && live.operationId === synthesizeOperationId(path, method)) {
    delete live.operationId;
    observations.strippedOperationId = true;
  }

  // RULE 4 — injected error responses, matched against the exact injected object.
  for (const code of INJECTED_ERROR_CODES) {
    const injected = { description: `${code} error`, content: { 'application/json': { schema: ERROR_SCHEMA } } };
    if (repo.responses?.[code] === undefined && isDeepStrictEqual(live.responses?.[code], injected)) {
      delete live.responses[code];
      observations.strippedErrorCodes.push(code);
    }
  }

  // RULE 5 — the auto-wrapped 200: a contentless 200 here is published as
  // `{ description: <original || "Success">, content: { application/json: { schema: {type:object} } } }`.
  const repo200 = repo.responses?.['200'];
  if (repo200 && typeof repo200 === 'object' && repo200.content === undefined) {
    const wrapped = {
      description: repo200.description || 'Success',
      content: { 'application/json': { schema: { type: 'object' } } },
    };
    if (isDeepStrictEqual(live.responses?.['200'], wrapped)) live.responses['200'] = clone(repo200);
  }

  // An operation whose only responses were injected leaves `{}` on one side and an absent key on
  // the other. Not a difference worth reporting.
  if (live.responses && Object.keys(live.responses).length === 0 && repo.responses === undefined) delete live.responses;

  return { repo, live, observations };
}

/** The identity observations, for `--no-normalize`. */
export const NO_OBSERVATIONS = { descriptionOverwritten: false, strippedErrorCodes: [], strippedOperationId: false };

export const NORMALIZATION_RULES = [
  "strip op['x-version'] and op['x-deprecation-policy'], which the service assigns onto every operation",
  "drop op['description'] on BOTH sides when the published value is the versioning boilerplate, and count the repo descriptions it destroyed",
  'strip op.operationId only when it equals the service synthesis of (path, method) and this repo has none',
  `strip responses ${INJECTED_ERROR_CODES.join('/')} only when they deep-equal the injected error envelope and this repo lacks the code`,
  'unwrap the auto-wrapped 200 only when it deep-equals the wrapping of this repo\'s 200',
  'components.securitySchemes: NOT APPLICABLE — this comparator is operation-scoped and never reads components',
  'root-level operations the service adds of its own accord are deliberately NOT normalized away: they surface as undocumented-live findings and must be allowlisted by path+method with a justification, so they stay visible',
];
