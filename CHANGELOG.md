# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `pr-agent` lane: fork-triggered `/` commands are now refused, and the AI
  call's budget fits inside its step. Three defects, one of them only visible
  once the first was fixed.

  The job-level `if:` refused forks on the `pull_request` arm and could not on
  `issue_comment` — fork status is absent from that payload, so there was never
  an expression to write. A `fork gate` step now asks the pulls endpoint and
  fails closed: only a literal `false` proceeds, so a 404, a rate limit or a
  deleted fork all skip. The lane runs no `actions/checkout`, so fork code was
  never executed and no exfiltration path existed; what this closes is the
  comment claiming forks were already skipped, which was true of one arm only.

  `CONFIG__AI_TIMEOUT` was 600s inside a 360s step, so the runner killed the
  step before pr-agent could reach its own timeout or fall back to a secondary
  model. Now 300s.

  Fixing the first exposed a third: `stamp attempt 2 end` runs under
  `if: always()`, so when attempt 2 never ran the verdict subtracted from zero
  and reported a 1787580408-second attempt as a confident TIMED OUT.

  Contributors on forks are affected: a maintainer's `/review` on a fork PR is
  now declined with a warning rather than silently running.
  (wave-av/wave-foundation-public#73)

- **`X402PaymentRequired.error_detail` nesting** (`openapi.yaml`): `error_detail` referenced the
  `Error` envelope (`{ error: { code, ... } }`), but the gateway nests the bare error object
  directly under `error_detail` (`{ code, message, ... }`), with no inner `error` wrapper —
  confirmed against a live 402 receipt (`curl https://api.wave.online/v1/clips`). The inner
  object is now extracted as the `ErrorBody` component schema (referenced by `Error`, so every
  other response is unchanged) and `error_detail` composes `ErrorBody` instead, matching the wire
  shape so generated types no longer expect a nonexistent `error_detail.error` member.

### Added

- **Fleet agent directory resolve** (`GET /identity/resolve`) — identity-fabric E1. Adds the
  `Identity` tag, the `identityResolve` operation (`agent` query param, optional `org`
  self-assertion), and the `IdentityResolveResponse` oneOf (`AgentIdentity` |
  `TelephonyIdentity`) so generated clients see the documented telephony variation. Directory
  data is public only: `key`/`keys` are Doppler key NAMES, never values. Gateway gate:
  `directory:read` scope (distinct from compliance `identity:read`).
- **SDK types generated from the spec** (`generated/api-types.d.ts`) — `openapi-typescript@7.13.0`
  now emits typed paths/operations/schemas from `openapi.yaml`, and the `sdk-types` CI gate
  regenerates them on every PR and fails if the committed artifact has drifted from the spec.
  Consumers get typed clients without keeping their own copy in sync.
- **Breaking-change gate** (`breaking-change` CI job) — PRs are diffed against the base branch
  with `oasdiff`; an unacknowledged breaking change fails the build unless the PR body carries
  the explicit `Breaking: yes` marker.

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
- **`X402PaymentRequired.error_detail.payment_rejected`** (`openapi.yaml`) — documents the
  additive `{ reason, rail }` deny verdict the gateway now publishes on a 402 when a submitted
  payment was REJECTED, so generated types and docs can discover the diagnostic field. Optional
  and conditional: absent on an ordinary unpaid challenge, present with a rejection reason token
  and rail name when a submitted credential was denied — confirmed against a live rejected-payment
  receipt (`curl -H "X-PAYMENT: <malformed>" https://api.wave.online/v1/clips`), which returned
  `error_detail.payment_rejected: { reason: "invalid_payment_header", rail: "base-usdc" }`.
  Closes #46.
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
