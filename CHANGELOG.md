# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Enhance AI video super-resolution surface** (`openapi.yaml`) — the live-routed
  `POST /v1/enhance` route had no spec entry, so no SDK or CLI method could be
  generated for it. Adds the `Enhance` tag and the `enhanceVideo` operation:
  - `POST /enhance` (scope `enhance:write`), x402-payable via the reusable `PaymentRequired`
    402 response. v1 ships exactly one model, `espcn` (ESPCN super-resolution, fixed 3x factor
    baked into the trained weights); any other `model` value 400s.
  - Input as raw request body (`video/*` / `application/octet-stream`) or a server-side `?url=`
    fetch (`https` only, non-public hosts rejected), capped at 200 MiB either way.
  - Binary streaming output with per-job receipt headers: `x-enhance-model`,
    `x-enhance-scale-factor`, `x-enhance-input-dimensions`, `x-enhance-output-dimensions`,
    `x-wave-meter`, `x-wave-usage-minutes`. Billed against `wave_enhance_minutes` (output
    duration in minutes, rounded up).
  - Failure modes specified alongside the happy path: 400, 401, the 402 x402 challenge, 403,
    413, `422 INPUT_TOO_LARGE`, 429, 501 (spoke not provisioned), 502, and 503 with
    `Retry-After`. Cross-referenced with the async Studio AI enhancement surface
    (`POST /studio-ai/enhancements`).
- **MoQ join-token mint surface** (`openapi.yaml`) — the Media over QUIC product had no spec at
  all, so no SDK or CLI could be generated for it. Adds the `MoQ` tag and both mint operations:
  - `POST /moq/publish/{ns}/{track}` (`mintMoqPublishToken`, scope `moq:write`) and
    `GET /moq/subscribe/{ns}/{track}` (`mintMoqSubscribeToken`, scope `moq:read`), with the
    optional `x-wave-declare-protocol` publish header.
  - `MoqJoinToken` response schema (`relayWsUrl`, `joinToken`, `expiresIn`, `ns`, `track`, `role`,
    `scope`, optional `protocol`) and the `MoqNamespaceParam` / `MoqTrackParam` path parameters
    constrained to `^[a-z0-9-]{1,64}$`.
  - Failure modes are specified alongside the happy path: `400 MOQ_JOIN_BAD_RESOURCE`, 401, the
    402 x402 challenge, 403, 429, and the fail-closed `503 MOQ_JOIN_UNCONFIGURED`.
  - `X402PaymentRequired` / `X402Accepts` schemas and a reusable `PaymentRequired` response — the
    402 body is **not** the `Error` envelope (its `error` member is a string and the normalized
    error object is nested under `error_detail`), which the spec previously did not capture.
  - The MoQ media session itself is intentionally **not** modelled: it is not an HTTP surface. The
    tag description explains the direct-to-relay flow, the `join` query parameter /
    `x-wave-moq-join` header token carriers, and pins the surface to
    `draft-ietf-moq-transport-18` (draft-19, published 2026-07-06, is not yet deployed).
- **WAVE Attestation Standard v1** (`attestation/` directory):
  - `attestation/ATTESTATION-STANDARD-v1.md` — Frozen v1 specification: wire envelope
    shape, field types, canonicalization algorithm (`canonicalJson` + `attestationId`),
    Ed25519 signature scheme, verification procedure, and v0→v1 version history.
  - `attestation/attestation-v1.schema.json` — JSON Schema Draft 2020-12 for the v1
    envelope. Includes `$defs` for `RenderAttestationSubject`, `ContextAttestationSubject`,
    and `SettlementAttestationSubject`. Enforces the `alg:"none"` ⟺ `sig:null` invariant
    via `allOf/if/then/else`.
  - `attestation/verifier-reference.md` — Standalone verifier procedure: step-by-step
    algorithm, `VerifyResult`/`VerifyError` type definitions, helper function signatures
    (`attestationSubject`, `canonicalJson`, `attestationId`, `fetchKeys`), and outcome
    reference table.
  - `attestation/well-known-keys.md` — `/.well-known/wave-attestation-keys.json` endpoint
    specification: JWKS-style OKP/Ed25519 response shape, `kid`/`x`/`iat`/`exp` field
    definitions, key rotation policy (30-day overlap window, ≤5 keys at once), signature
    wire encoding, and security requirements.
- **OpenAPI component schemas** (`openapi.yaml` `components/schemas`):
  - `RenderAttestation` — render attestation v1 subject payload (the `subject` field for
    `kind: render` envelopes).
  - `WaveAttestation` — full v1 wire envelope schema with `id`/`kind`/`v`/`subject`/
    `alg`/`sig`/`created` fields and the `alg`/`sig` invariant.
