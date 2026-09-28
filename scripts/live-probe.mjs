#!/usr/bin/env node
/**
 * live-probe.mjs — unauthenticated GET/POST live-probe gate for openapi.yaml.
 *
 * WHAT THIS CHECKS: for every operation in openapi.yaml that is NOT marked preview
 * (`x-wave-availability: preview` or `x-schema-status: preview`, at either the operation or the
 * shared-across-methods path level), fire one unauthenticated request at the live gateway and
 * confirm it is actually served. A route the spec calls GA (or draft-but-live) has no honest
 * reason to answer `ROUTE_NOT_FOUND` or `ROUTE_NOT_MAPPED` — those two codes mean the gateway's
 * forward table does not know this path, which is exactly the "stale/aspirational doc" failure
 * this script exists to catch (see the ME-SPEC-transport-truth lane header in openapi.yaml's
 * git history and docs/ for the incident this closes).
 *
 * WHY THIS IS NARROW ON PURPOSE: it does not assert 2xx. A GA route answering 401 AUTH_REQUIRED,
 * 402 (x402 challenge or PaymentRequired), 400 (bad params for an unauthenticated smoke call), 426
 * (WebSocket upgrade required), or a route-specific 503 (e.g. `EGRESS_HOST_NOT_CONFIGURED`) is
 * PROVEN LIVE — the gateway's forward table resolved the path to a real handler, which is the
 * only thing this gate is responsible for. Payment/auth/param correctness is every other gate's
 * job (CONTRACT-001, the SDK/CLI/MCP surfaces, and the per-route test suites).
 *
 * A preview-marked route is only checked when --strict-preview is passed: honest 404
 * ROUTE_NOT_FOUND / 503 is exactly what a preview route is SUPPOSED to answer (see the go-live
 * definition's "every protocol ruled preview returns an honest, actionable 404 or 503"), so this
 * gate does not fail a preview route for that response by default. --strict-preview flips this to
 * REQUIRE a preview route answer 404/503 (catches the inverse staleness: a route we still call
 * preview that is secretly serving GA traffic undocumented).
 *
 * USAGE:
 *   node scripts/live-probe.mjs                       probe every non-preview operation
 *   node scripts/live-probe.mjs --only srt,moq,whip    probe only paths starting with /srt, /moq, /whip (still non-preview only, unless --strict-preview)
 *   node scripts/live-probe.mjs --strict-preview       also assert every preview op answers 404/503
 *   node scripts/live-probe.mjs --json                 machine-readable result on stdout
 *
 * OVERRIDES (mirrors scripts/ga/contract-001-check.mjs's override pattern):
 *   GA_LIVE_PROBE_BASE_URL   probe against this base instead of https://api.wave.online/v1
 *
 * EXIT CODES:
 *   0  every probed operation passed
 *   1  at least one probed operation failed (ROUTE_NOT_FOUND / ROUTE_NOT_MAPPED on a non-preview
 *      route, or — under --strict-preview — a 2xx/402/401 on a preview route)
 *   2  could not run (spec failed to load/parse)
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { connect as tlsConnect } from 'node:tls';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SPEC_PATH = join(REPO_ROOT, 'openapi.yaml');

const DEFAULT_BASE_URL = 'https://api.wave.online/v1';
const FETCH_TIMEOUT_MS = 15_000;
const ROUTE_MISSING_CODES = new Set(['ROUTE_NOT_FOUND', 'ROUTE_NOT_MAPPED']);
const PROBED_METHODS = ['get', 'post'];

/**
 * Node's global `fetch` (undici) does not read `HTTPS_PROXY`/`https_proxy` the way `curl` and
 * most HTTP clients do — a real gap outside this repo too (many CI runners sit behind an egress
 * proxy). When one of those env vars is set, tunnel every probe through it via a plain CONNECT
 * handshake using only Node built-ins (no new dependency): open CONNECT to the proxy, upgrade the
 * raw socket to TLS for the real target, then hand that socket to `https.request`/`http.request`
 * as a custom Agent's connection. The proxy URL (which may carry Basic-auth userinfo) is read
 * from the environment and used only to build the CONNECT request — it is never logged.
 */
function buildProxyAgent(proxyUrlString) {
  const proxyUrl = new URL(proxyUrlString);
  class TunnelAgent extends HttpsAgent {
    createConnection(options, callback) {
      const headers = {};
      if (proxyUrl.username) {
        const cred = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
        headers['Proxy-Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
      }
      const connectReq = httpRequest({
        host: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        method: 'CONNECT',
        path: `${options.host}:${options.port}`,
        headers,
      });
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          callback(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
          return;
        }
        const tlsSocket = tlsConnect({ socket, servername: options.servername ?? options.host });
        tlsSocket.on('secureConnect', () => callback(null, tlsSocket));
        tlsSocket.on('error', (err) => callback(err));
      });
      connectReq.on('error', (err) => callback(err));
      connectReq.end();
    }
  }
  return new TunnelAgent();
}

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || null;
const proxyAgent = PROXY_URL ? buildProxyAgent(PROXY_URL) : null;

/** fetch()-shaped wrapper: uses the tunneling agent when a proxy is configured, plain global
 * fetch otherwise. Keeps probeOne() below agnostic to which transport is in play. */
function proxyAwareFetch(url, opts) {
  if (!proxyAgent) return fetch(url, opts);
  return new Promise((resolvePromise, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        agent: proxyAgent,
        protocol: u.protocol,
        host: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: opts.method,
        signal: opts.signal,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          resolvePromise({
            status: res.statusCode,
            json: async () => JSON.parse(bodyText),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export function parseArgs(argv) {
  const out = { only: null, strictPreview: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only') out.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--strict-preview') out.strictPreview = true;
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

async function loadSpec(path) {
  const yaml = await import('js-yaml');
  return (yaml.default ?? yaml).load(readFileSync(path, 'utf8'));
}

/** Placeholder-fill every `{param}` path template segment with a syntactically-plausible token —
 * never a real resource id — so the request reaches route resolution instead of failing on the
 * literal `{...}` text. */
export function fillPathTemplate(pathTemplate) {
  return pathTemplate.replace(/\{[^}]+\}/g, 'live-probe-smoke');
}

export function isPreview(op, pathItem) {
  const avail = op['x-wave-availability'] ?? pathItem['x-wave-availability'];
  const status = op['x-schema-status'] ?? pathItem['x-schema-status'];
  return avail === 'preview' || status === 'preview';
}

/** True selection logic for whether an operation should be probed at all, given --only/--strict-preview. */
export function shouldProbe(pathTemplate, op, pathItem, args) {
  if (args.only && !args.only.some((prefix) => pathTemplate === `/${prefix}` || pathTemplate.startsWith(`/${prefix}/`))) {
    return false;
  }
  const preview = isPreview(op, pathItem);
  if (preview && !args.strictPreview) return false;
  return true;
}

/** The pass/fail verdict for one probed row — pulled out of main() so it is unit-testable without
 * any network I/O. A row missing `ok` (network/timeout failure) is never a pass. A non-preview
 * route is a FAIL only for the two "the gateway doesn't know this path" codes. A preview route,
 * under --strict-preview, is a FAIL unless it honestly answers 404/503. */
export function isFailure(row) {
  if (!row.ok) return true;
  if (row.preview) return !(row.status === 404 || row.status === 503);
  return ROUTE_MISSING_CODES.has(row.code);
}

async function probeOne(baseUrl, method, urlPath) {
  const url = `${baseUrl}${urlPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await proxyAwareFetch(url, {
      method: method.toUpperCase(),
      redirect: 'manual',
      signal: controller.signal,
    });
    let code = null;
    try {
      const body = await res.json();
      code = body?.error?.code ?? null;
    } catch {
      // Non-JSON (e.g. a 101 Switching Protocols has no body) — fine, code stays null.
    }
    return { status: res.status, code, ok: true };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS}ms` : (err?.message ?? String(err));
    return { status: null, code: null, ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.GA_LIVE_PROBE_BASE_URL ?? DEFAULT_BASE_URL;

  let spec;
  try {
    spec = await loadSpec(SPEC_PATH);
  } catch (err) {
    console.error(`could not load/parse ${SPEC_PATH}: ${err?.message ?? err}`);
    process.exit(2);
  }

  const paths = spec?.paths ?? {};
  const rows = [];

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    for (const method of PROBED_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      if (!shouldProbe(pathTemplate, op, pathItem, args)) continue;

      const preview = isPreview(op, pathItem);
      const urlPath = fillPathTemplate(pathTemplate);
      const result = await probeOne(baseUrl, method, urlPath);
      rows.push({ path: pathTemplate, method, urlPath, preview, ...result });
    }
  }

  const failures = rows.filter(isFailure);

  if (args.json) {
    console.log(JSON.stringify({ baseUrl, total: rows.length, failed: failures.length, rows }, null, 2));
  } else {
    for (const r of rows) {
      const verdict = failures.includes(r) ? 'FAIL' : 'pass';
      const detail = r.ok ? `${r.status}${r.code ? ` ${r.code}` : ''}` : `ERROR ${r.error}`;
      console.log(`[${verdict}] ${r.method.toUpperCase().padEnd(4)} ${r.urlPath.padEnd(40)} ${detail}${r.preview ? ' (preview)' : ''}`);
    }
    console.log(`\n${rows.length} probed, ${failures.length} failed (base: ${baseUrl})`);
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main();
}
