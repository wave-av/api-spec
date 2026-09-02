# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Console-management operations** (`openapi.yaml`) — six new operations across four paths
  give the derived MCP tool plane coverage of the console-management surfaces: `GET`/`POST`
  `/pricing/manifests` (org-scoped list and validated upsert), `POST /custody/{op}` with a
  four-value enum (`grant`/`revoke`/`inspect`/`exercise`), `GET /engine/capabilities`, and
  `GET`/`POST` `/gpu/infer`. Adds the `PricingManifest` component schema and the `Pricing`,
  `Custody`, `Engine`, and `Gpu` tags. (#72)
- **Agent-auth device authorization ceremony** (`openapi.yaml`) — two new paths under the
  `Agent Auth` tag: `POST /agent/auth/device` (the RFC 8628 bootstrap, deliberately
  unauthenticated) and its poll counterpart, modelling the device-code grant shape and the
  honest `403` while the user has not yet approved. (#66)
- **Registered RFC 8628 grant type URN** (`openapi.yaml`) — the device-authorization poll's
  `grant_type` enum now requires the registered URN
  `urn:ietf:params:oauth:grant-type:device_code` instead of the bare `device_code` shorthand.
  **Breaking:** removes the bare-shorthand enum value from the spec (the live gateway still
  accepts both forms on the wire, so no client is broken by this alone). (#68)
- **`POST /batch` endpoint** (`openapi.yaml`) — documents the batch operation contract: an
  `operations` array of method, enforced `/v1` path, and optional body, capped at 25 items
  per call. (#64)
- **`/search` reconciled to the shipped contract** (`openapi.yaml`) — replaces four stale
  search paths that described an archived contract with the four the gateway actually
  serves: `POST /search` (hybrid dense+sparse query), `POST /search/index` (upsert one
  document or a batch), `DELETE /search/index/{id}`, and the shipped suggest/semantic
  variants. (#56)
- **Async render job lifecycle** (`openapi.yaml`) — documents `GET /render/{jobId}` and
  `GET /render/{jobId}/events` (server-sent events) so a render started through `POST
  /render` can be polled and streamed to completion. Also fixes a YAML structural bug that
  had corrupted an adjacent schema. (#34)
- **`AV Mux/Demux` surface** (`openapi.yaml`) — documents `POST /v1/av/remux` (combine
  separate RTP H.264 video and Dante/AES67 audio into one MPEG-TS/fMP4 stream) and `POST
  /v1/av/demux` (the inverse), with the `AvRemuxRequest`, `AvDemuxRequest`, and
  `AvTransformResult` schemas. (#23)
- **Braided Audio publish/stop** (`openapi.yaml`) — documents `POST /v1/braid/publish` and
  `DELETE /v1/braid/publish/{ns}` under a new `Braided Audio` tag, with the
  `BraidPublishRequest`, `BraidPublishResult`, and `BraidStopResult` schemas. (#19)
- **WAVE Render in the OpenAPI source of truth** (`openapi.yaml`) — adds the `Render` tag and
  `POST /render`, payable via the x402 challenge flow, so render gets a generated client
  instead of a hand-written one. (#12)
- **Error responses carry suggestions** (`openapi.yaml`) — the shared `Error` envelope gains
  optional `suggestions[]`, `did_you_mean[]`, and `doc_url` fields, matching the gateway's
  error layer. Additive only. (#10)
- **Word-level timestamps on the Voice API** (`openapi.yaml`) — `VoiceGenerateRequest` gains
  a `timestamps` boolean (default `false`); when set, `VoiceGeneration.alignment` returns the
  new `VoiceAlignment` schema with parallel `characters[]` and start/end time arrays. (#9)
- **Realtime control/event plane** (`openapi.yaml`) — adds the `Realtime` tag and
  `/realtime/connect`, `/realtime/channels/{channel}/publish`, `/presence`, and `/history`
  paths, each with a per-operation `servers` override pointing at
  `https://realtime.wave.online`. (#4)
- **Fleet agent directory resolve** (`GET /identity/resolve`) — adds the `Identity` tag, the
  `identityResolve` operation (`agent` query parameter, optional `org` self-assertion), and
  the `IdentityResolveResponse` oneOf (`AgentIdentity` | `TelephonyIdentity`). Directory data
  is public only: `key`/`keys` fields are key names, never values. Gated by the
  `directory:read` scope. (#57)
- **SDK types generated from the spec** (`generated/api-types.d.ts`) — `openapi-typescript`
  now emits typed paths, operations, and schemas from `openapi.yaml`, and a CI gate
  regenerates them on every pull request and fails if the committed artifact has drifted.
  (#49)
- **Breaking-change gate** — pull requests are diffed against the base branch with `oasdiff`;
  an unacknowledged breaking change fails the build unless the PR body carries an explicit
  `Breaking: yes` marker. (#49)
- **MoQ join-token mint surface** (`openapi.yaml`) — adds the `MoQ` tag and both mint
  operations: `POST /moq/publish/{ns}/{track}` and `GET /moq/subscribe/{ns}/{track}`, the
  `MoqJoinToken` response schema, path parameters constrained to `^[a-z0-9-]{1,64}$`, the
  `X402PaymentRequired`/`X402Accepts` schemas and the reusable `PaymentRequired` response
  (the 402 body is not the standard `Error` envelope). The media session itself is not
  modelled, since it is not an HTTP surface; the spec pins the direct-to-relay flow to
  `draft-ietf-moq-transport-18`. (#30)
- **WAVE Attestation Standard v1** (`attestation/` directory) — a frozen v1 specification
  covering the wire envelope shape, canonicalization algorithm, Ed25519 signature scheme,
  and verification procedure, plus a standalone verifier reference and the
  `/.well-known/wave-attestation-keys.json` key-rotation contract (30-day overlap window, up
  to 5 keys at once). (#14)
- **Attestation component schemas** (`openapi.yaml`) — `RenderAttestation` (the render
  attestation v1 subject payload) and `WaveAttestation` (the full v1 wire envelope, with the
  `alg`/`sig` invariant enforced). (#11)
- **`capabilities.json`** — registers this repository with the organization's platform
  registry for discovery and lifecycle tracking. (#3)

### Changed

- **License: Apache-2.0** — the specification and repository now carry the Apache-2.0
  license, with a NOTICE file reserving the WAVE marks; `openapi.yaml`'s `info.license` and
  the README were updated to match, and the staging server entry was removed from the spec.
  (#6)

## [1.0.0] - 2026-04-05

### Added

- Initial public release: the WAVE OpenAPI 3.1 specification (12 API modules).

[Unreleased]: https://github.com/wave-av/api-spec/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/wave-av/api-spec/releases/tag/v1.0.0
