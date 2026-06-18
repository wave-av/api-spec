# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
