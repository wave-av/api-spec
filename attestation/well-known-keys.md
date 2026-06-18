# WAVE Attestation — Public Key Surface

**Endpoint:** `GET /.well-known/wave-attestation-keys.json`  
**Served by:** Any WAVE product host (`*.wave.online`)

---

## 1. Purpose

This endpoint exposes the Ed25519 public keys used to sign WAVE Attestation v1
envelopes. Verifiers fetch this endpoint to obtain the public key needed to check
the `sig` field of an attestation whose `alg` is `"ed25519"`.

---

## 2. Response Shape

```json
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "use": "sig",
      "alg": "EdDSA",
      "kid": "<key-id>",
      "x": "<base64url-encoded-32-byte-public-key>",
      "iat": 1750000000,
      "exp": 1781536000
    }
  ]
}
```

### 2.1 Key Object Fields

| Field | Type    | Required | Notes                                                       |
|-------|---------|----------|-------------------------------------------------------------|
| `kty` | string  | yes      | Always `"OKP"` (Octet Key Pair, RFC 8037).                 |
| `crv` | string  | yes      | Always `"Ed25519"`.                                        |
| `use` | string  | yes      | Always `"sig"` (signature use).                            |
| `alg` | string  | yes      | Always `"EdDSA"` (IANA algorithm registry, RFC 8037).      |
| `kid` | string  | yes      | Key ID. Must be unique across all keys in the endpoint.    |
| `x`   | string  | yes      | Base64url (no padding) of the 32-byte Ed25519 public key.  |
| `iat` | integer | yes      | Unix seconds when this key was activated.                  |
| `exp` | integer | no       | Unix seconds when this key expires. Absent = no expiry.    |

### 2.2 Envelope Fields

| Field   | Type  | Notes                                                                  |
|---------|-------|------------------------------------------------------------------------|
| `keys`  | array | Array of active (and recently retired) key objects. May be empty.      |

---

## 3. Key ID (`kid`) Convention

Key IDs are lowercase hex strings (8–64 chars), derived from the first 8 bytes of the
SHA-256 hash of the public key bytes. Example: `"a3f2e1c9"`.

The `kid` in the response must match the `kid` embedded in (or derivable from) the
attestation's signature header when using JWS-structured signatures, or matched by
convention when using raw Ed25519 signatures. For WAVE v1, the `kid` is embedded in
a compact header prepended to the signature value (see §5).

---

## 4. Key Rotation Policy

### Lifecycle

1. **Active:** Key is in the `keys` array with no `exp` or `exp` in the future.
2. **Retiring:** Key has an `exp` set (≥30 days in the future). New attestations
   are signed with the replacement key; old key remains for verification.
3. **Expired:** Key's `exp` has passed. It is removed from the endpoint.
4. **Revoked (emergency):** Key is removed immediately. All attestations signed with
   it are invalidated. An out-of-band notification MUST be issued.

### Rotation Schedule

- Planned rotations happen no more than once per quarter.
- The outgoing key MUST remain in the endpoint for at least **30 days** after the
  replacement key is added. This ensures in-flight attestations (signed under the old
  key) can still be verified.
- At any time, the endpoint may contain at most **5 keys** (1 active + up to 4 retiring).

### Rotation Procedure

1. Generate a new Ed25519 key pair using a CSPRNG.
2. Derive the `kid` from the first 8 bytes of `sha256(publicKey)`.
3. Add the new key to the endpoint with `iat = now`.
4. Set `exp = now + 30days` on the outgoing key.
5. Update the signing infrastructure to use the new private key.
6. After 30 days, remove the expired key from the endpoint.
7. Destroy the old private key.

---

## 5. Signature Wire Encoding

For `alg: "ed25519"` attestations, the `sig` field encodes:

```
sig = base64url(kid_bytes || ed25519_sig_bytes)
```

Where:
- `kid_bytes` = the UTF-8 bytes of the `kid` string, length-prefixed with a 1-byte
  count (so: `[len, ...kid_utf8]`)
- `ed25519_sig_bytes` = the 64-byte raw Ed25519 signature

Verifiers extract the `kid` from the first `1 + len` bytes of the decoded `sig`,
look up the key in the endpoint, then verify the remaining 64 bytes as the signature
over `UTF8(canonicalJson(attestationSubject(a)))`.

**Note:** This is a simple deterministic encoding, not JWS/JWT. WAVE attestations do
not use JWTs.

---

## 6. Security Requirements

- **HTTPS only.** The endpoint MUST be served over TLS. Verifiers MUST NOT fetch
  the endpoint over plain HTTP.
- **Cache-Control.** The endpoint SHOULD set `Cache-Control: max-age=3600, stale-while-revalidate=3600`
  to allow verifiers to cache keys for performance while staying fresh.
- **No private keys.** The response MUST NOT contain any private key material (`d` field
  or equivalent). Only the `x` (public key) field is present.
- **Revocation monitoring.** Operators MUST monitor for unauthorized key additions.
  The endpoint SHOULD be diff-compared against a known-good baseline on each rotation.

---

## 7. Example Response

```json
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "use": "sig",
      "alg": "EdDSA",
      "kid": "a3f2e1c9",
      "x": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
      "iat": 1750000000
    }
  ]
}
```

---

## 8. Discovery

The standard well-known URI path for WAVE attestation keys follows
[RFC 8615](https://datatracker.ietf.org/doc/html/rfc8615):

```
https://<host>/.well-known/wave-attestation-keys.json
```

Any WAVE product host (`*.wave.online`) SHOULD serve this endpoint. A central
platform-level endpoint is also available at:

```
https://wave.online/.well-known/wave-attestation-keys.json
```

The platform-level endpoint is the authoritative source for keys used by the
`wave-video` renderer. Per-product endpoints may be used for keys scoped to a
specific product host's attestations.
