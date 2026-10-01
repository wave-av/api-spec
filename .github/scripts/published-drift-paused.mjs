/**
 * published-drift-paused.mjs — operations the gateway leaves out ON PURPOSE because their product is paused.
 *
 * wave-gateway drops every operation of an operator-paused product from GET /openapi.json
 * (wave-gateway src/openapi-paused.ts) and says so at the document root:
 *
 *   "x-wave-paused-products": { "products": [{ "path": "/v1/render", "product": "render", "paused_since": "2026-09-24" }, …] }
 *
 * Measured 2026-10-01 against build 06e4efce1050: /v1/render, /v1/renders, /v1/enhance and /v1/video-gen.
 * The compare never read that declaration, so CONTRACT-001 reported POST /enhance, POST /render,
 * GET /render/{jobId} and GET /render/{jobId}/events as unexplained `unpublished-repo` findings on main
 * and on every branch: red for a reason no change to this repo can fix.
 *
 * The exemption is deliberately narrow. It applies only to a repo operation that is ABSENT from the
 * published document, only under a path prefix that the published document itself names as paused, and
 * every operation it covers is counted and listed (`pausedNotPublished`), never dropped silently. When a
 * product is unpaused its operations reappear in the published document and are compared as usual; an
 * operation that stays absent without a paused declaration is an ordinary finding again.
 *
 * Pure: no network, no filesystem.
 */

/** The server base path of the published document (`/v1` for https://api.wave.online/v1), or "". */
function serverBasePath(liveDoc) {
  try {
    return new URL(String(liveDoc?.servers?.[0]?.url ?? '')).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** The paused products the published document declares: `[{ prefix, product, pausedSince, base }]`. */
export function pausedProducts(liveDoc) {
  const list = liveDoc?.['x-wave-paused-products']?.products;
  if (!Array.isArray(list)) return [];
  const base = serverBasePath(liveDoc);
  return list
    .filter((p) => p && typeof p.path === 'string' && p.path.startsWith('/') && p.path.length > 1)
    .map((p) => ({ prefix: p.path.replace(/\/+$/, ''), product: p.product ?? null, pausedSince: p.paused_since ?? null, base }));
}

/** The paused product a spec path (relative to the server, e.g. `/render/{jobId}`) belongs to, or null. */
export function pausedProductFor(path, paused) {
  for (const p of paused) {
    const full = `${p.base}${path}`;
    if (full === p.prefix || full.startsWith(`${p.prefix}/`)) return p;
  }
  return null;
}
