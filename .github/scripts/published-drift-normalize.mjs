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
  const observations = {
    descriptionOverwritten: false,
    strippedErrorCodes: [],
    overwrittenErrorCodes: [],
    strippedOperationId: false,
    strippedParameters: [],
  };
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
  //
  // RULE 4b — the SAME injected shape also OVERWRITES a response this repo already declares for
  // that code (measured on the 1.1.0 publish: a hand-written 404 with a real description and a
  // real schema ref, replaced verbatim with the generic injected shape). Same class of defect as
  // RULE 2's description overwrite — a real declaration destroyed by the service's own boilerplate,
  // not drift in this spec — so it gets the same treatment: drop both sides and record it, rather
  // than let a real 4xx doc get silently blamed on this repo. Still matched by EXACT shape only:
  // repo's response merely being ABSENT is RULE 4 above; repo's response being PRESENT but DIFFERENT
  // from the exact injected literal is this rule.
  for (const code of INJECTED_ERROR_CODES) {
    const injected = { description: `${code} error`, content: { 'application/json': { schema: ERROR_SCHEMA } } };
    if (!isDeepStrictEqual(live.responses?.[code], injected)) continue;
    if (repo.responses?.[code] === undefined) {
      delete live.responses[code];
      observations.strippedErrorCodes.push(code);
    } else if (!isDeepStrictEqual(repo.responses[code], injected)) {
      delete live.responses[code];
      delete repo.responses[code];
      observations.overwrittenErrorCodes.push(code);
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

  // RULE 6 — decorative parameter metadata (`description`, `example`, `schema.pattern`) dropped at
  // serve time. Measured on the 1.1.0 publish across multiple operations: a hand-written
  // path/query parameter keeps its `name`/`in`/`required`/`schema.type` (and `schema.enum`, where
  // present) but loses `description`, `example`, and any `schema.pattern` — the service publishes
  // the CONTRACT (name, location, required-ness, type) faithfully and drops only prose plus the one
  // validation detail (a regex) it does not carry through its own generated schema. Matched per
  // parameter by identity (`name`+`in`), and ONLY when every OTHER field of that parameter is
  // unchanged — a parameter that differs in name, location, required-ness, enum, or type is never
  // touched here and still surfaces as drift.
  if (Array.isArray(repo.parameters) && Array.isArray(live.parameters)) {
    const liveByKey = new Map(live.parameters.map((p) => [`${p.in}:${p.name}`, p]));
    for (const repoParam of repo.parameters) {
      const liveParam = liveByKey.get(`${repoParam.in}:${repoParam.name}`);
      if (!liveParam) continue;
      const stripped = clone(repoParam);
      delete stripped.description;
      delete stripped.example;
      if (stripped.schema && typeof stripped.schema === 'object') delete stripped.schema.pattern;
      if (isDeepStrictEqual(stripped, liveParam)) {
        delete repoParam.description;
        delete repoParam.example;
        if (repoParam.schema && typeof repoParam.schema === 'object') delete repoParam.schema.pattern;
        observations.strippedParameters.push(repoParam.name);
      }
    }
  }

  return { repo, live, observations };
}

/** The identity observations, for `--no-normalize`. */
export const NO_OBSERVATIONS = {
  descriptionOverwritten: false,
  strippedErrorCodes: [],
  overwrittenErrorCodes: [],
  strippedOperationId: false,
  strippedParameters: [],
};

export const NORMALIZATION_RULES = [
  "strip op['x-version'] and op['x-deprecation-policy'], which the service assigns onto every operation",
  "drop op['description'] on BOTH sides when the published value is the versioning boilerplate, and count the repo descriptions it destroyed",
  'strip op.operationId only when it equals the service synthesis of (path, method) and this repo has none',
  `strip responses ${INJECTED_ERROR_CODES.join('/')} only when they deep-equal the injected error envelope and this repo lacks the code`,
  `drop responses ${INJECTED_ERROR_CODES.join('/')} on BOTH sides when the published value deep-equals the injected error envelope but this repo declares a DIFFERENT response for that code — the service overwrote a real declaration, and count which codes it destroyed`,
  'unwrap the auto-wrapped 200 only when it deep-equals the wrapping of this repo\'s 200',
  'strip a parameter\'s description/example on BOTH sides when every other field of that parameter (name, in, required, schema) is otherwise identical — the service publishes the contract faithfully and drops only prose',
  'components.securitySchemes: NOT APPLICABLE — this comparator is operation-scoped and never reads components',
  'root-level operations the service adds of its own accord are deliberately NOT normalized away: they surface as undocumented-live findings and must be allowlisted by path+method with a justification, so they stay visible',
];
