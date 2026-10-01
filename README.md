# api-spec

<div align="center">

**WAVE is media infrastructure for the agentic internet: one call shape moves live and on-demand
media across every transport, and both kinds of user, people and agents, discover it, call it, and
pay for it per call.** This repository is the OpenAPI 3.1 specification for that call shape — 231
documented endpoint paths across 182 tag groups (streaming, production, analytics, voice, captions,
clips, and more), plus generators for client SDKs.

![kind](https://img.shields.io/badge/kind-openapi--spec-555?style=flat-square) ![domain](https://img.shields.io/badge/domain-api-0a7?style=flat-square) ![format](https://img.shields.io/badge/format-OpenAPI%203.1-85ea2d?style=flat-square) ![visibility](https://img.shields.io/badge/visibility-public-brightgreen?style=flat-square) ![license](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)

[wave.online](https://wave.online) · [Docs](https://docs.wave.online) · [GitHub](https://github.com/wave-av/api-spec) · [Status](https://wave.online/status)

</div>

---

## What this is

A single-file OpenAPI 3.1 document (`openapi.yaml`) describing the WAVE Enterprise Streaming Platform
API: 231 endpoint paths (256 operations) grouped under 182 tags. It is the source of truth for the
contract the gateway publishes at [`api.wave.online/openapi.json`](https://api.wave.online/openapi.json).

**What is callable today.** Not every operation here is served yet:

- 151 operations carry `x-schema-status: draft`. Draft describes the **shape**, not whether the
  route is served: the request/response schema is a placeholder, so do not generate typed client
  methods from it. Probed keyless on 2026-10-01, 126 of the 149 drafts in the published contract
  answered the gateway's own `404 ROUTE_NOT_FOUND`, 17 answered a `402` (the path is priced, which
  does not prove a service answers behind it), and 6 reached a handler or the auth chain (for
  example `POST /embeddings` answers `401 AUTH_REQUIRED`). A served draft needs its real shape
  documented here before it can drop the flag. Probe the live route before you rely on one.
- Operations marked `deprecated: true` with `x-status: unrouted` have no destination on the live
  gateway. Do not build against them. The refusal differs by path and is recorded on each
  operation: `POST /moderate` answers `404 ROUTE_NOT_FOUND`, and the three
  `/videos/{videoId}/chapters` operations were measured at `403 ROUTE_NOT_MAPPED` (keyless, a
  priced prefix can answer `402` first).
- Everything else is the callable contract.

**About `@wave-av/sdk`.** The [`@wave-av/sdk`](https://www.npmjs.com/package/@wave-av/sdk) TypeScript
client is **hand-written, not generated from this spec**, and its coverage does not match it: measured
on 2026-09-30 against `@wave-av/sdk@2.1.3`, 44 of the 255 published operations are reachable from an SDK
method, and most SDK calls target paths this contract does not declare. Treat this spec, not the SDK
surface, as the authority on what the API accepts.

## Quick start

```bash
# Preview the spec in a browser (Redoc)
npx @redocly/cli preview openapi.yaml

# Lint / validate
npx @redocly/cli lint openapi.yaml

# Generate a client SDK (example: TypeScript fetch client)
npx @openapitools/openapi-generator-cli generate -i openapi.yaml -g typescript-fetch -o ./sdk/typescript
```

## Authentication

Most documented endpoints require a Bearer token (the x402-payable `/render` operations —
`renderVideo`, `renderPoll`, `renderEvents` — are the exception; they set `security: []` and
authenticate via an x402 payment challenge instead):

```
Authorization: Bearer YOUR_API_KEY
```

## Errors

The spec documents a normalized error envelope used across most endpoints (the x402 payment-challenge
and device-authorization-flow responses use their own distinct shapes, noted above and in the spec
itself):

```json
{ "error": { "code": "...", "message": "...", "details": { "field": "..." }, "suggestions": ["..."], "did_you_mean": ["..."], "doc_url": "..." } }
```

List endpoints support `page` / `perPage` pagination, and requests are subject to rate limiting
(responses include a `Retry-After` header when throttled) — both per the spec's top-level description.

## Repo layout

| Path | What it is |
| --- | --- |
| `openapi.yaml` | The spec itself — about 14,500 lines, 231 paths, 256 operations, 182 tags; `info.version` 1.1.0 |
| `capabilities.json` | Machine-readable lifecycle metadata (lifecycle tag `ga`; its own `version` field, 3.0.0, versions that metadata file, not the API) |
| `scripts/public-repo-guard` | CI check that keeps this public mirror free of internal-only content |

## Related packages

| Package | Description |
| --- | --- |
| [@wave-av/sdk](https://www.npmjs.com/package/@wave-av/sdk) | Hand-written TypeScript SDK (not generated from this spec; see "About `@wave-av/sdk`" above) |
| [@wave-av/adk](https://www.npmjs.com/package/@wave-av/adk) | Agent Developer Kit |
| [@wave-av/mcp-server](https://www.npmjs.com/package/@wave-av/mcp-server) | MCP server exposing WAVE APIs as tools |
| [@wave-av/cli](https://www.npmjs.com/package/@wave-av/cli) | Command-line interface |

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

---

<div align="center">

**Built by [WAVE Online, LLC](https://wave.online)** · [wave.online](https://wave.online) · [Docs](https://docs.wave.online)

</div>
