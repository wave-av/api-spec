# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **SDK types generated from the spec** (`generated/api-types.d.ts`) — `openapi-typescript@7.13.0`
  now emits typed paths/operations/schemas from `openapi.yaml`, and the `sdk-types` CI gate
  regenerates them on every PR and fails if the committed artifact has drifted from the spec.
  Consumers get typed clients without keeping their own copy in sync.
- **Breaking-change gate** (`breaking-change` CI job) — PRs are diffed against the base branch
  with `oasdiff`; an unacknowledged breaking change fails the build unless the PR body carries
  the explicit `Breaking: yes` marker.
- **Body content-policy gate** (`body-guard` CI job, `scripts/public-repo-guard/body-policy.sh`) —
  PR titles/bodies, issue bodies, and comment bodies are now scanned server-side, the half of a
  public repo's surface the tree gate never covered. Blocks credential formats, infrastructure
  identifiers (internal IPs, operator home paths, hardcoded account IDs), self-identified
  internal-only markers, and a private repo named near operational detail. A line carrying
  `guard:allow <reason>` exempts the infra-identifier tier; credential formats block
  unconditionally (defang the string to discuss one).

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
