#!/usr/bin/env node
/**
 * published-drift-live-probe.mjs — is a `x-schema-status: draft` operation ACTUALLY LIVE on the
 * gateway, regardless of whether the published /openapi.json documents it?
 *
 * WHY THIS FILE EXISTS. published-drift-compare.mjs's `unpublished-repo` direction suppresses an
 * operation the moment it carries `x-schema-status: draft` — see that file's header for why draft
 * is a lane to publication rather than a parking space. But "the published SPEC does not list this
 * operation" and "the gateway does not SERVE this operation" are different claims, and the drift
 * gate used to conflate them: 158 operations were `draft` on 2026-09-04, and 10 of 10 sampled
 * answered a live 402 — the gateway fail-closed price challenge, which only fires for a route that
 * exists and is priced. A path the gateway genuinely does not map answers 403 `ROUTE_NOT_MAPPED`
 * instead (verified as the control on the same date). So `draft` was hiding shipped, priced,
 * unreviewed public API behind a metric (`unpublishedRepo`) that reached zero by moving those 158
 * operations into a bucket the headline never counts — the exact "zero by redefinition" shape this
 * program exists to kill.
 *
 * THE PROBE. One unauthenticated HTTP request per draft-and-unpublished operation, to the same
 * gateway host the rest of this repo's tooling reads (`api.wave.online`), using the operation's own
 * method and path. No bearer token is sent and no request body is sent, so this can only ever
 * reach the gateway's routing/paywall layer — it PROVES a route exists (or does not); it never
 * completes an x402 payment or executes a priced action. See CONTRACT-001 / the GA verdict for the
 * "probe the paywall, never execute a paid call" rule this follows.
 *
 * CLASSIFICATION. A route is `live` unless the gateway answers EXACTLY 403 with
 * `error.code === "ROUTE_NOT_MAPPED"` — the fail-closed shape the gateway itself uses for "this
 * path and method are not part of the WAVE API" (verified live 2026-09-04, matches the control).
 * Anything else — 402 (priced, unauthenticated), 401 (authenticated route, no key), 5xx (a live
 * handler that errored) — means the gateway routed the request somewhere, so the route exists and
 * `draft` is not a true description of it. A route is `unknown` when the probe itself failed
 * (network error, timeout, a redirect) — NEVER read as "not live": see probeDraftOperations for how
 * callers must refuse rather than default an unknown probe to safe.
 *
 * REDIRECTS ARE NOT FOLLOWED, for the same reason published-drift.mjs's fetchPublished doesn't:
 * this runs in CI with tokens in its environment, and the URL host is meant to be fixed.
 */
export const GATEWAY_BASE_URL = 'https://api.wave.online/v1';
export const PROBE_TIMEOUT_MS = 10_000;
export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 500;
export const ROUTE_NOT_MAPPED_CODE = 'ROUTE_NOT_MAPPED';

export const PROBE_LIVE = 'live';
export const PROBE_NOT_LIVE = 'not-live';
export const PROBE_UNKNOWN = 'unknown';

/** `{ path, method }` -> the map key `compare()` looks operations up by, everywhere in this repo. */
export function probeKey({ path, method }) {
  return `${method.toUpperCase()} ${path}`;
}

const VALID_PROBE_STATUSES = new Set([PROBE_LIVE, PROBE_NOT_LIVE, PROBE_UNKNOWN]);

/**
 * Validate a `--draft-live-snapshot` file's parsed JSON before it becomes `draftLiveProbe`. This is
 * the same shape `probeDraftOperations` returns, but a hand-written fixture is untrusted input:
 *   - a `null` entry crashes the caller's unresolved-probe check (`r.status` on `null` throws),
 *     the same tier of failure as an unreadable file, so it must return here instead;
 *   - `{}` or a `status` outside {live, not-live, unknown} does not throw, but compare() reads
 *     `probe.status === 'live'` and treats anything else — including a typo — as `not-live`,
 *     silently suppressing a draft operation the snapshot may have meant to mark live.
 * Returns an error string, or null when every entry is well-formed.
 */
export function validateDraftLiveSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `draft-live snapshot must be a JSON object (got ${Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw})`;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return `draft-live snapshot entry "${key}" must be an object (got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value})`;
    }
    if (!VALID_PROBE_STATUSES.has(value.status)) {
      return `draft-live snapshot entry "${key}" has status ${JSON.stringify(value.status)}, must be one of ` +
        `${[...VALID_PROBE_STATUSES].join(', ')}`;
    }
  }
  return null;
}

/**
 * One probe, one operation, never throws. Returns `{ status, httpStatus, code, error }` where
 * `status` is one of PROBE_LIVE / PROBE_NOT_LIVE / PROBE_UNKNOWN. `doFetch` is injectable so the
 * unit tests never touch the network.
 */
export async function probeOperation({ path, method }, { baseUrl = GATEWAY_BASE_URL, doFetch = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${baseUrl}${path}`, { method: method.toUpperCase(), signal: controller.signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      return { status: PROBE_UNKNOWN, httpStatus: res.status, code: null, error: `redirected (HTTP ${res.status}) — refusing to follow` };
    }
    let code = null;
    try {
      const body = await res.json();
      code = body?.error?.code ?? null;
    } catch {
      // A non-JSON or empty body still answers the liveness question from the status code alone —
      // only a 403 ROUTE_NOT_MAPPED reads as "not live", and that shape is always JSON in practice,
      // so a body that fails to parse can never spuriously produce a false "not live" here.
    }
    const notLive = res.status === 403 && code === ROUTE_NOT_MAPPED_CODE;
    return { status: notLive ? PROBE_NOT_LIVE : PROBE_LIVE, httpStatus: res.status, code, error: null };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err?.message ?? String(err));
    return { status: PROBE_UNKNOWN, httpStatus: null, code: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe every given operation, bounded concurrency, with retries ONLY for PROBE_UNKNOWN (a real
 * verdict — live or not-live — is never retried away). Retrying only smooths over a transient
 * network blip; it never turns a genuine "the route says ROUTE_NOT_MAPPED" into anything else, and
 * it never turns a persistent failure into a false verdict — after the retries are spent the result
 * for that operation stays PROBE_UNKNOWN, which the caller must treat as a refusal, not a pass.
 *
 * Returns a Map keyed by probeKey().
 */
export async function probeDraftOperations(ops, opts = {}) {
  const { concurrency = DEFAULT_CONCURRENCY, retries = DEFAULT_RETRIES, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = opts;
  const results = new Map();
  if (ops.length === 0) return results;
  let idx = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function worker() {
    while (idx < ops.length) {
      const op = ops[idx++];
      let result = { status: PROBE_UNKNOWN, httpStatus: null, code: null, error: 'not probed' };
      for (let attempt = 0; attempt <= retries; attempt++) {
        result = await probeOperation(op, opts);
        if (result.status !== PROBE_UNKNOWN) break;
        if (attempt < retries) await sleep(retryDelayMs);
      }
      results.set(probeKey(op), result);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ops.length) }, worker));
  return results;
}
