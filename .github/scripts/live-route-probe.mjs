#!/usr/bin/env node
/**
 * live-route-probe.mjs — how this repo asks the gateway whether a route EXISTS, and nothing else.
 * Pure I/O plus one classification rule. The comparison lives in `live-route-compare.mjs` and the
 * CLI in `live-route-drift.mjs`; see that file's header for why a third source is needed at all.
 *
 * ── THE PROBE SEMANTICS ARE LOAD-BEARING ────────────────────────────────────────────────────────
 * On this gateway an unmapped path answers HTTP 403 with `error.code === "ROUTE_NOT_MAPPED"`
 * ("no scope rule for this route (fail-closed)"). Anything else — INCLUDING 402 — means the route
 * exists.
 *
 *   402 IS NOT AN ABSENCE. It is the strongest available evidence of PRESENCE: the route is mapped
 *   and it is PRICED. Reading a paywall as "route not found" would make this gate blind to exactly
 *   the routes that charge customers money, which inverts its purpose. Do not ever quiet a noisy
 *   run by treating 402 as absent.
 *
 * ONLY an explicit `ROUTE_NOT_MAPPED` counts as absence. A bare 403 does not: 403 is also what an
 * authorization failure looks like, and an authorization failure PROVES the route exists — there
 * was something there to be unauthorized for. Requiring the code keeps "absent" a positive claim
 * read off the body rather than an inference from a status number.
 *
 * A 5xx, a timeout or a transport error is INDETERMINATE, never absent. An origin having a bad
 * minute must not be recorded as "this route does not exist", because that would silently clear a
 * real finding and leave the gate greener than the evidence supports.
 *
 * ── COST ────────────────────────────────────────────────────────────────────────────────────────
 * Every probe is an unauthenticated GET. No credential is sent, so no tenant, meter or balance is
 * touched, and a 402 is returned BEFORE any work is performed — the challenge IS the response.
 * These probes are free. Never add a paid call, a POST, an authenticated request, or a retry storm
 * to this file; concurrency is deliberately tiny because this is a correctness gate, not a load
 * test.
 */
export const ORIGIN = 'https://api.wave.online';
export const FETCH_TIMEOUT_MS = 20_000;
/** Deliberately tiny. This is a correctness gate, not a load test — never raise it. */
export const PROBE_CONCURRENCY = 4;

export const MAPPED = 'mapped';
export const ABSENT = 'absent';
export const INDETERMINATE = 'indeterminate';

/** Classify one probe response. See the header — 402 is MAPPED, and only ROUTE_NOT_MAPPED is ABSENT. */
export function classifyProbe({ status, body }) {
  if (status >= 500) return INDETERMINATE;
  if (body?.error?.code === 'ROUTE_NOT_MAPPED') return ABSENT;
  return MAPPED;
}

/** GET one path, unauthenticated, bounded. Returns a result; never throws. */
export async function probePath(path, doFetch = fetch, origin = ORIGIN) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(`${origin}${path}`, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
      headers: { accept: 'application/json' },
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null; // a non-JSON body is fine; classification falls back to the status
    }
    return { path, ok: true, status: res.status, body, state: classifyProbe({ status: res.status, body }) };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS}ms` : (err?.message ?? String(err));
    return { path, ok: false, error: reason, state: INDETERMINATE };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe many paths with a small fixed concurrency. Returns `Map<path, result>`. */
export async function probeAll(paths, doFetch = fetch, origin = ORIGIN, concurrency = PROBE_CONCURRENCY) {
  const queue = [...paths];
  const out = new Map();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
      out.set(p, await probePath(p, doFetch, origin));
    }
  });
  await Promise.all(workers);
  return out;
}
