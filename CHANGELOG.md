# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Streams, productions, cameras, moderation, live pipeline, billing, and
  analytics operations** (`openapi.yaml`) — 26 hand-documented operations
  backing the hosted MCP tool surface, replacing the draft
  `additionalProperties: true` placeholders for `/billing`, `/cameras`,
  `/moderate`, `/productions`, `/streams`, and `/usage`: stream lifecycle
  (`listStreams`, `createStream`, `getStream`, `startStream`, `stopStream`,
  `getStreamStatus`, `getStreamAnalytics`, `listStreamHighlights`,
  `markStreamHighlight`), content moderation (`moderateContent`), the live
  transcription pipeline (`startLivePipeline`, `transcribeLiveAudio`),
  multi-camera productions (`listProductions`, `createProduction`,
  `getProduction`, `switchProductionCamera`, `setProductionOverlay`), managed
  cameras (`listCameras`, `registerCamera`, `controlCamera`), and
  billing/analytics (`getBilling`, `getBillingUsage`, `getUsage`,
  `getAnalyticsOverview`, `getAnalyticsTopContent`, `getAnalyticsEngagement`).
  Every request/response shape is read from the live or in-review route
  handler, not guessed.
- **`X402PaymentRequired.error_detail.payment_rejected`** (`openapi.yaml`) — documents the
  additive `{ reason, rail }` deny verdict the gateway publishes on a 402 when a submitted payment
  was rejected; absent on an ordinary unpaid challenge. Live
  receipt: a malformed `X-PAYMENT` header returns `payment_rejected: { reason:
  "invalid_payment_header", rail: "base-usdc" }`. Closes #46. (#76)
- **Spec coverage from the live gateway skills index** (v1.1.0). Diffed the live capability
  index (`https://gateway.wave.online/.well-known/wave-skills.json`, 178 priced capabilities)
  against this spec's 72 operations and added a draft operation for every capability that had
  none: 158 new `POST /{name}` operations (one per missing product), 157 new tags, and a
  `bearerWithScopes` OAuth2 security scheme carrying one scope per capability, all drawn
  verbatim from the live index (no invented fields). Each new operation carries:
  - `x-schema-status: draft` — the request/response shape is `additionalProperties: true`
    because the actual payload contract is not published anywhere the spec can read it.
  - `x-skill-url` — the capability's own skill document.
  - `x-price` — `model`/`currency`/`network`/`meter` from the live index, plus, where an
    unauthenticated `GET` on the route returned a real x402 402 challenge, the observed
    `atomicAmount` and `asset` (verified live 2026-09-02; most capabilities gate at a flat
    1000-atomic-unit entry price, one at 600000 — these are the gateway's real numbers, not
    estimates).
  - Coverage: **before 21/178 → after 178/178** (1 allowlisted: `internal`, which the live
    index itself marks `pricing.model=free` and `auth.scope=null`).

- **`skills-index-coverage` CI check** (`.github/scripts/skills-index-coverage.mjs`,
  `.github/scripts/skills-index-allowlist.json`) — fetches the live skills index on every PR
  and push to `main` and fails if a live, non-allowlisted priced capability has no matching
  path segment or tag in `openapi.yaml`. Wired into `foundation-gate.yml`.

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
  `grant_type` enum now also documents the registered URN
  `urn:ietf:params:oauth:grant-type:device_code` alongside the existing bare `device_code`
  shorthand; both remain valid and the bare form is canonicalized to the URN before
  forwarding upstream. Non-breaking: no enum value was removed. (#68)
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

### Deprecated

- **`GET/POST /videos/{videoId}/chapters` and `POST /videos/{videoId}/chapters/detect`** —
  marked `deprecated: true` / `x-status: unrouted`. Verified live 2026-09-02: the gateway
  returns `403 ROUTE_NOT_MAPPED` ("this path and method are not part of the WAVE API") for
  both paths. The live-priced Chapters capability is the flat `POST /chapters` operation
  (added above); the nested shape stays documented — deprecated rather than deleted — until
  it is either wired up or formally removed.

- **`/leaderboard` and `/platform`** — confirmed live 2026-09-02: both return
  `403 ROUTE_NOT_MAPPED` at the gateway. Neither appears in this spec (never did) nor in the
  live gateway skills index (not a priced capability), so nothing here needed a
  `deprecated: true` marker — they are documented on the publicly served `openapi.json` at
  the API host but are not real operations. Recommend the publicly served copy drop them;
  out of scope for this spec since they were never present here.

### Fixed

- **`X402PaymentRequired.error_detail` nesting** (`openapi.yaml`): `error_detail` referenced the
  `Error` envelope (`{ error: { code, ... } }`), but the gateway nests the bare error object
  directly under `error_detail` (`{ code, message, ... }`), with no inner `error` wrapper —
  confirmed against a live 402 receipt (`curl https://api.wave.online/v1/clips`). The inner
  object is now extracted as the `ErrorBody` component schema (referenced by `Error`, so every
  other response is unchanged) and `error_detail` composes `ErrorBody` instead, matching the wire
  shape so generated types no longer expect a nonexistent `error_detail.error` member. (#76)
- **`ClipCreate`** (`openapi.yaml`) documented `{videoId, startTime, endTime}`;
  the live `POST /clips` route's own request validator requires `source` (a
  recording id) plus an `in` time string and never accepted `videoId`.
  Corrected the schema to the real contract and added `ClipCreateResponse`/
  `ClipError` for the operation's actual 201/400 shapes (the 400 body is the
  route's own `{ok, error, detail}` envelope, not the shared `Error` schema).
- **`GET /leaderboard`, `GET /platform`** (`openapi.yaml`) — documented for real, following the
  1.1.0 gateway deploy that moved both gateway-native root surfaces behind operator/tenant auth
  (measured live 2026-09-06). Both had been exempted in the drift allowlist as
  `undocumented-live` while unauthenticated; the exemption's own justification named real
  documentation as the intended remedy once each operation gained a security requirement, which
  it now has. New `Operator` tag for `/platform`'s operator-only shape.
- `.github/scripts/published-drift-normalize.mjs`: two new normalization rules measured against
  the 1.1.0 publish — the service overwrites a hand-written 4xx response with its generic
  injected envelope even when this repo already declares a real one for that code (previously
  only the "repo lacks the code" case was normalized), and it drops a parameter's
  `description`/`example`/`schema.pattern` while publishing its `name`/`in`/`required`/type
  faithfully. Both are matched by exact residual shape, never by key name, and both are reported
  (not silently absorbed) via new `enrichmentObservations` fields.
- `.github/scripts/published-drift-allowlist.json` — new `shared-drift` exemptions for
  `GET /usage` (a key collision between this repo's real `/v1` billing endpoint and the
  gateway's own unrelated, operator-only telemetry route that publishes at the same literal
  path with no distinguishing `servers` override), `GET`/`POST /streams` (the gateway still
  serves the auto-generated skills-index placeholder; this repo has promoted the real `/v1`
  shape ahead of the gateway shipping it), and `POST /agent/auth/token` (the service's own
  generated 400 response is a coarser single-schema shape than this repo's accurate `oneOf`
  documentation of the RFC 8628 device-flow passthrough). New `unpublished-repo` exemptions for
  `DELETE /videos/{videoId}/chapters/{chapterId}` and
  `GET /videos/{videoId}/chapters/detect/{jobId}`: both are live-probed and confirmed answering
  (not `ROUTE_NOT_MAPPED`), but the published `/openapi.json` document has not yet registered
  them — a gap in the service's own spec generation, not in this repo's declaration.

## [1.0.0] - 2026-04-05

### Added

- Initial public release: the WAVE OpenAPI 3.1 specification (12 API modules).

[Unreleased]: https://github.com/wave-av/api-spec/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/wave-av/api-spec/releases/tag/v1.0.0
