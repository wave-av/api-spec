#!/usr/bin/env node
/**
 * published-drift-live.mjs — the LIVE-BEHAVIOUR tier. Pure classifier + a bounded prober.
 *
 * WHY THIS EXISTS
 *
 * `unpublished-repo` is suppressed when an operation carries `x-schema-status: draft`. The idea is
 * sound — draft says "this shape is a placeholder, not yet a promise to consumers" — but the gate
 * read the ANNOTATION and never checked the WORLD. So the headline `unpublishedRepo: 0` was zero by
 * redefinition: 157 operations sat in the suppressed bucket, and measured on 2026-09-05 against the
 * live gateway, 155 of those 157 ANSWER. Not 404. They serve.
 *
 *   402 + x402 payment challenge   152    priced, callable, billable today
 *   200 with a real response body    1    serving live data, no payment required
 *   401 AUTH_REQUIRED                1    the route exists and wants a credential
 *   5xx from the route's own handler 1    routed to its handler, which reported a config problem
 *   403 ROUTE_NOT_MAPPED             2    genuinely not published  <- the only honest "draft"
 *
 * Controls: two synthetic paths that do not exist both returned 403 ROUTE_NOT_MAPPED, so the probe
 * discriminates rather than calling everything live.
 *
 * THE RULE. On this gateway a 402 PROVES the route exists and is priced — an unmapped path returns
 * 403 ROUTE_NOT_MAPPED instead. A paywall is not an absence. Live behaviour is the ground truth;
 * `x-schema-status` is a CLAIM about that truth. When the two disagree, the claim is what is wrong.
 *
 * WHY THE CLASSIFICATION IS BEHAVIOURAL AND NOT A RELABELLING. Re-labelling the 157 would fix the
 * number once and leave the mechanism intact: the next draft stub on a live route re-suppresses
 * itself, silently, by carrying one annotation. Here, suppression requires TWO independent
 * conditions — the operation says `draft` AND the gateway does not answer for it. Editing the
 * annotation can only ever satisfy one of them. There is no edit to openapi.yaml that hides a route
 * the gateway serves.
 *
 * WHAT IS PROBED, AND THE SAFETY ARGUMENT. Only operations already in the DECLARED-BUT-NOT-PUBLISHED
 * set — never the whole spec. Requests are unauthenticated GETs with no body and no credentials,
 * regardless of the operation's declared method: the gateway makes its route/price decision before
 * method dispatch (verified on samples — GET and POST return the identical challenge), so a GET
 * yields the same classification while being side-effect-free. Nothing is paid: a 402 IS the
 * challenge, and answering one would require signing a payment, which this never does.
 */

/** A body code that proves the gateway has NO route for the path. */
export const UNMAPPED_CODES = new Set(['ROUTE_NOT_MAPPED']);

export const LIVE_PROBE_TIMEOUT_MS = 20_000;

/**
 * The classifier only ever needs a short error code near the start of a JSON body. A probed
 * endpoint is not trusted to return a small body — this bounds how much of it is ever buffered in
 * memory, so a large response cannot turn a live probe into a CI memory-exhaustion vector.
 */
export const MAX_BODY_BYTES = 4096;

/** Read at most `MAX_BODY_BYTES` bytes of a response body, decoded as UTF-8. Never throws. */
export async function readBoundedText(res, maxBytes = MAX_BODY_BYTES) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    // No streamable body (e.g. a stub in tests) — fall back to the full read, already the prior
    // behaviour for anything that does not expose a stream.
    try { return await res.text(); } catch { return ''; }
  }
  const decoder = new TextDecoder();
  let received = 0;
  let out = '';
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    // Stop pulling bytes we will never read — a probed endpoint does not get to keep this socket
    // busy past the prefix this classifier actually needs.
    try { await reader.cancel(); } catch { /* best effort */ }
  }
  return out;
}

/**
 * The whole classification, as pure data. `unknown` is a first-class outcome and is NEVER folded
 * into either of the other two: a probe that could not run says nothing about publication, and
 * treating silence as "not published" is precisely the false-green this tier removes.
 *
 * @returns {'published'|'unpublished'|'unknown'}
 */
export function classifyLiveObservation({ status, bodyCode } = {}) {
  if (!Number.isInteger(status) || status === 0) return 'unknown';
  // An explicit "there is no route here" is the ONLY thing that confirms genuine non-publication.
  if (UNMAPPED_CODES.has(bodyCode)) return 'unpublished';
  // A BARE 404 — no route-level refusal code — is ambiguous, not a refusal: it is also what a
  // MAPPED resource route returns for a missing or unsubstituted path parameter (the gateway routed
  // the request to a real handler, which then reported "no such resource"). Reading every bare 404
  // as "unpublished" would suppress exactly the operations this tier exists to stop suppressing.
  // Same discipline as the bare-5xx rule below: an ambiguous signal is UNKNOWN, never a verdict.
  if (status === 404) return 'unknown';
  // 5xx WITHOUT a route-level refusal is an infrastructure wobble, not evidence either way. Calling
  // it "unpublished" would let a gateway outage silently empty this gate's findings.
  if (status >= 500) return bodyCode ? 'published' : 'unknown';
  // Everything else — 2xx, 401, 402, 403-with-some-other-code, 405, 409, 429 — means something on
  // the other end recognised this path enough to answer about it. That is publication in behaviour.
  return 'published';
}

/** Human-readable reason, so a finding explains itself without the reader re-running the probe. */
export function describeObservation(o) {
  if (!o) return 'not probed';
  if (o.status === 0) return `probe failed (${o.bodyCode ?? 'no response'})`;
  const code = o.bodyCode ? ` ${o.bodyCode}` : '';
  if (o.status === 402) return `HTTP 402${code} — the gateway prices and serves this route`;
  if (o.status === 401) return `HTTP 401${code} — the route exists and requires a credential`;
  if (o.status >= 200 && o.status < 300) return `HTTP ${o.status} — the route serves a live response`;
  return `HTTP ${o.status}${code}`;
}

/** Read an error code out of a response body without trusting it to be JSON or to be small. */
export function extractBodyCode(text) {
  if (typeof text !== 'string' || text === '') return null;
  try {
    const j = JSON.parse(text);
    if (j?.error?.code) return String(j.error.code);
    if (j?.x402Version !== undefined || Array.isArray(j?.accepts)) return 'X402_CHALLENGE';
    if (j?.code) return String(j.code);
    return null;
  } catch {
    // A truncated or non-JSON body still carries the marker often enough to be worth one regex, and
    // a wrong `null` here only ever makes the classifier MORE conservative, never less.
    const m = /"code"\s*:\s*"([A-Z_]+)"/.exec(text);
    return m ? m[1] : null;
  }
}

/**
 * Probe one path. Never throws; a failure becomes `status: 0`, which classifies as `unknown`.
 * `baseUrl` comes from the spec's own `servers[0].url`, so this cannot drift from what the spec says.
 */
export async function probePath(baseUrl, path, doFetch = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_PROBE_TIMEOUT_MS);
  try {
    const res = await doFetch(`${baseUrl}${path}`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    let text = '';
    try { text = await readBoundedText(res); } catch { /* a body we cannot read is not a classification */ }
    return { path, status: res.status, bodyCode: extractBodyCode(text) };
  } catch (err) {
    return { path, status: 0, bodyCode: err?.name === 'AbortError' ? 'TIMEOUT' : (err?.name ?? 'FETCH_ERROR') };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a set of paths with bounded concurrency, plus CONTROL paths that must classify as
 * `unpublished`. If a control comes back `published`, the gateway is answering for a path that
 * cannot exist and every other observation in the batch is worthless — the whole probe is reported
 * as unusable rather than acted on. A probe with no control is not a measurement.
 */
export async function probeOperations(baseUrl, paths, { doFetch = fetch, concurrency = 4, controls = ['/wave-drift-control-no-such-route', '/wave-drift-control-also-absent'] } = {}) {
  const observations = new Map();
  const run = async (queue, sink) => {
    const workers = Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, async () => {
      while (queue.length) {
        const p = queue.shift();
        sink.set(p, await probePath(baseUrl, p, doFetch));
      }
    });
    await Promise.all(workers);
  };

  const controlResults = new Map();
  await run([...controls], controlResults);
  const badControls = [...controlResults.values()].filter((o) => classifyLiveObservation(o) !== 'unpublished');
  if (badControls.length) {
    return {
      usable: false,
      reason:
        `live-probe control failed: ${badControls.map((o) => `${o.path} -> ${o.status} ${o.bodyCode ?? ''}`).join('; ')}. ` +
        'A path that cannot exist answered as live, so no observation in this batch can be trusted.',
      observations,
      controls: [...controlResults.values()],
    };
  }

  await run([...new Set(paths)], observations);
  return { usable: true, reason: null, observations, controls: [...controlResults.values()] };
}
