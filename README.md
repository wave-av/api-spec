<div align="center">

# api-spec

**WAVE is media infrastructure for the agentic internet: one call shape moves live and on-demand
media across every transport, and both kinds of user, people and agents, discover it, call it, and
pay for it per call.** This repository is the OpenAPI 3.1 specification for that call shape — 43
documented endpoints across 17 tag groups (streaming, production, analytics, voice, captions, clips,
and more), plus generators for client SDKs.

![kind](https://img.shields.io/badge/kind-openapi--spec-555?style=flat-square) ![domain](https://img.shields.io/badge/domain-api-0a7?style=flat-square) ![format](https://img.shields.io/badge/format-OpenAPI%203.1-85ea2d?style=flat-square) ![visibility](https://img.shields.io/badge/visibility-public-brightgreen?style=flat-square) ![license](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)

[wave.online](https://wave.online) · [Docs](https://docs.wave.online) · [github](https://github.com/wave-av/api-spec) · [Status](https://wave.online/status)

</div>

---

## What this is

A single-file OpenAPI 3.1 document (`openapi.yaml`) describing the WAVE Enterprise Streaming Platform
API: 43 endpoint paths grouped under 17 tags. It is the source of truth other WAVE packages generate
from — the [`@wave-av/sdk`](https://www.npmjs.com/package/@wave-av/sdk) TypeScript client is built from
this spec.

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

The spec documents a normalized error envelope used across all endpoints:

```json
{ "error": { "code": "...", "message": "...", "details": { "field": "..." }, "suggestions": ["..."], "did_you_mean": ["..."], "doc_url": "..." } }
```

List endpoints support `page` / `perPage` pagination, and requests are subject to rate limiting
(responses include a `Retry-After` header when throttled) — both per the spec's top-level description.

## Repo layout

| Path | What it is |
| --- | --- |
| `openapi.yaml` | The spec itself — 3,589 lines, 43 paths, 17 tags |
| `capabilities.json` | Machine-readable lifecycle metadata (this spec is tagged `ga`, version 3.0.0) |
| `scripts/public-repo-guard` | CI check that keeps this public mirror free of internal-only content |

## Related packages

| Package | Description |
| --- | --- |
| [@wave-av/sdk](https://www.npmjs.com/package/@wave-av/sdk) | TypeScript SDK generated against this spec |
| [@wave-av/adk](https://www.npmjs.com/package/@wave-av/adk) | Agent Developer Kit |
| [@wave-av/mcp-server](https://www.npmjs.com/package/@wave-av/mcp-server) | MCP server exposing WAVE APIs as tools |
| [@wave-av/cli](https://www.npmjs.com/package/@wave-av/cli) | Command-line interface |

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

---

<div align="center">

**Built by [WAVE Online, LLC](https://wave.online)** · [wave.online](https://wave.online) · [Docs](https://docs.wave.online)

</div>
