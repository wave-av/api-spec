#!/usr/bin/env node
/**
 * live-route-probe.mjs — how this repo asks the gateway whether a route EXISTS, and nothing else.
 * Pure I/O plus one classification rule. The comparison lives in `live-route-compare.mjs` and the
 * CLI in `live-route-drift.mjs`; see that file's header for why a third source is needed at all.
 *
 * ── THE PROBE SEMANTICS ARE LOAD-BEARING ────────────────────────────────────────────────────────
 * On this gateway an unmapped path answers HTTP 404 with `error.code === "ROUTE_NOT_MAPPED"`
 * ("no scope rule for this route (fail-closed)"). Earlier gateway builds answered the same code
 * with HTTP 403, and a few gateway-native paths still do, so BOTH statuses are accepted — but only
 * with that exact code. Anything else — INCLUDING 402 — means the route exists.
 *
 *   MEASURED 2026-09-11: the gateway moved ROUTE_NOT_MAPPED from 403 to 404 without this
 *   classifier following. Every absent route then read as MAPPED, and the declared-not-live
 *   direction went silently empty — a gate that could no longer fail. Keying absence on the code
 *   with a small allowlist of statuses is what keeps that from recurring; keying it on a status
 *   alone would reintroduce the false-green the moment the number changes again.
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
 * ── THE OTHER TWO MEMBERS OF THE CLOSED "NOT SERVED" SET (wave-gateway#1910) ────────────────────
 * MEASURED 2026-09-28 against `wave-gateway` `src/not-served-404-codes.ts`: the gateway's own
 * `NOT_SERVED_404_CODES` enum is `["ROUTE_NOT_MAPPED", "ROUTE_NOT_FOUND", "SPOKE_OPERATION_NOT_FOUND"]`
 * — a documented, tested, CLOSED set of exactly three codes for "nothing is served here", not one.
 * `ROUTE_NOT_FOUND` (`forward-target.ts`) fires when a path IS scope-mapped but has no live spoke or
 * override behind it — the prefix is real, nothing answers it. `SPOKE_OPERATION_NOT_FOUND` (#1832,
 * `upstream-4xx-sanitize.ts`) fires when the gateway DID forward and the live destination itself
 * answered its own 404 for this exact path+method. Both are ALWAYS status 404 — unlike
 * `ROUTE_NOT_MAPPED`, neither has 403 legacy-build history, so neither is added to
 * `ROUTE_NOT_MAPPED_STATUSES`.
 *
 *   Before this fix, a probe landing on either code fell into the bare-404 branch below and read as
 *   INDETERMINATE — not a false green, but a genuine "not served" signal went unclaimed and
 *   `npm run probe:live` could not fail on it. Every probed path here is parameterless (see
 *   `isProbeable`), so a `SPOKE_OPERATION_NOT_FOUND` response to one of these paths cannot be a
 *   handler reporting a missing id; it means the declared operation truly is not implemented at the
 *   destination the gateway forwarded to.
 *
 * A BARE 404 — any 404 without one of these three codes, including one whose body is not JSON — is
 * INDETERMINATE, neither absent nor present. It is not absence, because only this closed set is a
 * route-level "not served" refusal. It is not presence either: every probed path is parameterless
 * (see `isProbeable`), so the one 404 a mapped handler legitimately returns — "no such resource" for
 * a missing or unsubstituted id — cannot arise here, and what CAN arise is a mapped prefix
 * forwarding to an origin that does not serve this particular sub-path and says so with a 404 of its
 * own, carrying neither of the two documented codes above. Reading that as MAPPED would let a
 * declared-but-unserved route go green on an unreadable body, which is exactly the false-green this
 * gate exists to catch. The sibling classifier in `published-drift-live.mjs` makes the same call (a
 * bare 404 is `unknown`).
 *
 * A 5xx, a timeout or a transport error is INDETERMINATE, never absent. An origin having a bad
 * minute must not be recorded as "this route does not exist", because that would silently clear a
 * real finding and leave the gate greener than the evidence supports. INDETERMINATE is never a
 * pass: `live-route-compare.mjs` surfaces every such probe by path and reason.
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

/** Statuses the gateway has been observed to pair with ROUTE_NOT_MAPPED. 404 is current; 403 is retained for older builds and the gateway-native paths that still use it. */
export const ROUTE_NOT_MAPPED_STATUSES = new Set([403, 404]);

/**
 * The other two members of wave-gateway's closed "not served" set (`src/not-served-404-codes.ts`,
 * wave-gateway#1910): `ROUTE_NOT_FOUND` (scope-mapped, no live spoke) and `SPOKE_OPERATION_NOT_FOUND`
 * (#1832 — forwarded to a live destination that itself 404'd). Both are always HTTP 404; neither has
 * ROUTE_NOT_MAPPED's legacy-403 history, so they are not added to `ROUTE_NOT_MAPPED_STATUSES`.
 */
export const OTHER_NOT_SERVED_404_CODES = new Set(['ROUTE_NOT_FOUND', 'SPOKE_OPERATION_NOT_FOUND']);

/** Classify one probe response. See the header — 402 is MAPPED, and only the closed not-served set is ABSENT. */
export function classifyProbe({ status, body }) {
  if (status >= 500) return INDETERMINATE;
  // A redirect conveys nothing about whether a route exists: `probePath` uses `redirect: 'manual'`,
  // so a 3xx arrives with a non-JSON body and would otherwise fall through to MAPPED, which is wrong
  // in both directions — it can hide a genuinely withdrawn/redirected route (false green) and it can
  // fabricate a live-undeclared finding for a redirecting undeclared path (false red).
  if (status >= 300 && status < 400) return INDETERMINATE;
  const code = body?.error?.code;
  // Require one of the statuses the documented contract pairs with the code (404 today, 403 on
  // earlier builds). Checking the body code alone would let a gateway error at some other status
  // that happens to carry the same code hide a real live-route finding — the 5xx guard above is the
  // concrete case: a 500 carrying ROUTE_NOT_MAPPED must stay INDETERMINATE.
  if (ROUTE_NOT_MAPPED_STATUSES.has(status) && code === 'ROUTE_NOT_MAPPED') return ABSENT;
  // ROUTE_NOT_FOUND and SPOKE_OPERATION_NOT_FOUND are always 404 (no legacy-403 form to accept).
  if (status === 404 && OTHER_NOT_SERVED_404_CODES.has(code)) return ABSENT;
  // A 404 without one of the three codes is evidence of nothing (see the header): the path is
  // parameterless, so this is not a handler reporting a missing id — it may be an origin behind a
  // mapped prefix that does not serve this sub-path, or a body the probe could not read. Neither
  // fabricates presence.
  if (status === 404) return INDETERMINATE;
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
