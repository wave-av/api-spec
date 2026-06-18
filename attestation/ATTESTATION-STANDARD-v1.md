# WAVE Attestation Standard — Version 1

**Status:** Frozen  
**Version string:** `wave.render-attestation/v1`  
**Issued:** 2026-06-17  
**Supersedes:** `wave.render-attestation/v0` (documented, not revoked — see §8)

---

## 1. Purpose

A WAVE Attestation is a tamper-evident claim that a specific renderer produced a
specific output from a specific scene, at a specific time, with an optional
cryptographic signature. It travels inside an OTLP span attribute (`wave.attestation`)
and is stored idempotently in the observability database.

This document is the normative reference for the v1 wire format, canonicalization
algorithm, signature scheme, and verification procedure.

---

## 2. Attestation Envelope (wire format)

An attestation is a JSON object with the following top-level fields:

| Field     | Type                          | Required | Notes                                              |
|-----------|-------------------------------|----------|----------------------------------------------------|
| `id`      | string (64-char hex)          | yes      | Content-addressed. See §4.                        |
| `kind`    | `"render"` \| `"context"` \| `"settlement"` | yes | See §3.                          |
| `v`       | string (≤ 64 chars)           | yes      | Version string. For render: `wave.render-attestation/v1`. |
| `subject` | object                        | yes      | Kind-specific payload. See §3.                    |
| `alg`     | string (≤ 32 chars)           | yes      | Signature algorithm. `"ed25519"` or `"none"`.     |
| `sig`     | string (≤ 2048 chars) \| null | cond.    | Base64url-encoded signature. **Must be `null` iff `alg` is `"none"`**. |
| `created` | integer (unix seconds)        | yes      | When the attestation was minted.                  |

**Invariant:** `alg === "none"` ⟺ `sig === null`. Any attestation violating this
invariant MUST be rejected by the ingest layer.

### 2.1 Example (unsigned)

```json
{
  "id": "a3f2e1...c9d8b7",
  "kind": "render",
  "v": "wave.render-attestation/v1",
  "subject": {
    "v": "wave.render-attestation/v1",
    "kind": "render",
    "renderer": "wave-video@0.3.0/kernel",
    "scene_sha256": "4f9a2b...e7c1d0",
    "output_sha256": "8c3d1e...a2f5b9",
    "format": "mp4",
    "bytes": 308224
  },
  "alg": "none",
  "sig": null,
  "created": 1750000000
}
```

### 2.2 Example (signed with Ed25519)

```json
{
  "id": "a3f2e1...c9d8b7",
  "kind": "render",
  "v": "wave.render-attestation/v1",
  "subject": {
    "v": "wave.render-attestation/v1",
    "kind": "render",
    "renderer": "wave-video@0.3.0/kernel",
    "scene_sha256": "4f9a2b...e7c1d0",
    "output_sha256": "8c3d1e...a2f5b9",
    "format": "mp4",
    "bytes": 308224
  },
  "alg": "ed25519",
  "sig": "base64url-encoded-64-byte-ed25519-signature",
  "created": 1750000000
}
```

---

## 3. Subject Payloads by Kind

### 3.1 `render` — Render Attestation

Attests that a renderer produced `output_sha256` from `scene_sha256`.

| Field           | Type                  | Notes                                       |
|-----------------|-----------------------|---------------------------------------------|
| `v`             | string                | Must equal the envelope `v`.               |
| `kind`          | `"render"`            | Mirror of the envelope kind.               |
| `renderer`      | string                | Renderer identifier (name@version/runtime). |
| `scene_sha256`  | string (64-char hex)  | SHA-256 of the canonical scene input.      |
| `output_sha256` | string (64-char hex)  | SHA-256 of the rendered output bytes.      |
| `format`        | `"mp4"` \| `"alpha"`  | Output container/codec family.             |
| `bytes`         | integer               | Byte length of the rendered output.        |

### 3.2 `context` — Context Attestation

Attests the provenance of a context object passed to a renderer or pipeline step.
Subject fields are defined by the consuming service and MUST include at minimum:
`v`, `kind`, and a content-addressed hash of the context object.

### 3.3 `settlement` — Settlement Attestation

Attests that a payment settlement event occurred for a rendered asset.
Subject fields include billing identifiers and are defined by the settlement service.

---

## 4. Canonicalization Algorithm

The `id` field is a SHA-256 hash of the **canonical form** of the **subject** object.
The canonical form is deterministic regardless of insertion order in the original JSON.

### 4.1 Algorithm: `canonicalJson`

```
canonicalJson(value):
  if value is null or not an object → JSON.stringify(value)
  if value is an array             → '[' + elements.map(canonicalJson).join(',') + ']'
  if value is an object:
    keys = Object.keys(value).sort()   // lexicographic ascending, Unicode code point order
    pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k]))
    return '{' + pairs.join(',') + '}'
```

This is a compact (no whitespace), recursive, deterministic serialization. It produces
the same output for `{b:2,a:1}` and `{a:1,b:2}`.

### 4.2 `attestationSubject(attestation)`

The **signable subject** of a render attestation is:

```
attestationSubject(a) = {
  v:             a.v,
  kind:          a.kind,
  renderer:      a.renderer,
  scene_sha256:  a.scene_sha256,
  output_sha256: a.output_sha256,
  format:        a.format,
  bytes:         a.bytes,
}
```

The fields `created`, `cached`, `alg`, and `sig` are **explicitly excluded** from the
subject. This means an attestation ID is stable across cache replays — two renderers
producing the same output from the same scene will share an attestation ID, and
upserts are idempotent.

### 4.3 `attestationId(attestation)`

```
attestationId(a) = sha256hex(canonicalJson(attestationSubject(a)))
```

Where `sha256hex` produces a 64-character lowercase hexadecimal string.

**Reference implementation** (TypeScript, `wave-video/src/service/attestation.ts`):

```typescript
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function attestationId(a: RenderAttestation): string {
  return createHash('sha256').update(canonicalJson(attestationSubject(a))).digest('hex');
}
```

---

## 5. Signature Algorithm

When `alg === "ed25519"`:

1. Compute `canonicalJson(attestationSubject(a))` → UTF-8 bytes (no BOM).
2. Sign those bytes with the private Ed25519 key using the signing key identified by
   the `kid` in the public key endpoint (see §7).
3. Encode the 64-byte signature as base64url (no padding).
4. Set `sig` to the resulting string.

The current WAVE signing infrastructure uses Google Tink's Ed25519 signer. Any
conformant Ed25519 implementation (RFC 8032) is interoperable.

**Signing scope:** The signature covers only the subject bytes — it does NOT cover
`created`, `id`, or `alg`. This is intentional: `created` timestamps are minting
metadata, not content, and the `id` is derivable from the subject.

---

## 6. Verification Procedure

See `verifier-reference.md` for the standalone reference function signature and
step-by-step algorithm. Summary:

1. Validate the envelope against `attestation-v1.schema.json`.
2. Assert the `alg`/`sig` invariant.
3. Recompute `attestationId(a)` and assert it equals `a.id`.
4. If `alg === "ed25519"`: fetch the public key from `/.well-known/wave-attestation-keys.json`,
   verify the signature over `canonicalJson(attestationSubject(a))`.
5. If `alg === "none"`: attestation is unsigned; provenance is claimed but not verified.

---

## 7. Public Key Surface

The public key endpoint is described in `well-known-keys.md`. Summary:

- URL: `/.well-known/wave-attestation-keys.json` on any WAVE product host
- Format: JWKS-style array of OKP (Ed25519) keys with `crv: "Ed25519"`, `kty: "OKP"`,
  `use: "sig"`, `alg: "EdDSA"`, and `x` (base64url public key bytes)
- Key rotation: via `exp` field and `kid` matching; old keys remain for 30 days
  post-rotation to allow in-flight attestation verification

---

## 8. Version History

### `wave.render-attestation/v0` (live, not revoked)

The v0 attestation uses the same envelope shape and canonicalization algorithm but
pre-dates the frozen public standard. The `v` field will read `wave.render-attestation/v0`.
The ingest layer accepts both v0 and v1 attestations without distinction; the `v` field
is stored as-is and queryable.

Key differences from v1:
- No `id` field in the original emitter code (added in the wire format validation layer)
- No frozen public specification
- Same `attestationSubject` and `canonicalJson` algorithms (implementations are compatible)

### `wave.render-attestation/v1` (this document)

- Frozen public specification
- `id` field is normatively defined and required in the envelope
- JSON Schema published at `attestation-v1.schema.json`
- Verifier reference published at `verifier-reference.md`
- Public key surface published at `well-known-keys.md`

---

## 9. Security Considerations

- **Unsigned attestations** (`alg: "none"`) are provenance claims only — they establish
  what was claimed to be produced, not that the claim is authentic. Use signed attestations
  for billing, settlement, and chain-of-custody assertions.
- **The `id` field is a commitment.** Altering any subject field changes the id; a
  verifier that recomputes the id and compares it can detect tampering.
- **Private keys must remain secret.** If a signing key is compromised, revoke it via
  the key rotation procedure in `well-known-keys.md` and re-sign affected attestations.
- **The ingest layer drops malformed attestations silently** to avoid failing span
  ingestion over a bad attestation. This is fail-soft by design; operators SHOULD monitor
  for attestation parse error rates.
- **Replay protection:** The content-addressed `id` + idempotent upsert means replays
  are safe but not authenticated. Settlement attestations SHOULD include a nonce or
  reference to a specific payment event to prevent replay in billing contexts.
