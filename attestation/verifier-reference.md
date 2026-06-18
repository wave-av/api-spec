# WAVE Attestation v1 — Verifier Reference

This document specifies the standalone verification algorithm for WAVE Attestation v1
envelopes. It is a companion to `ATTESTATION-STANDARD-v1.md`.

---

## 1. Input / Output

```
verify(attestation: unknown, options?: VerifyOptions): VerifyResult
```

**Input:** An unknown value (parsed JSON from the `wave.attestation` span attribute
or any other source).

**Options:**

| Option         | Type     | Default  | Notes                                                   |
|----------------|----------|----------|---------------------------------------------------------|
| `keysUrl`      | string   | see §4   | URL of `/.well-known/wave-attestation-keys.json`        |
| `requireSig`   | boolean  | `false`  | Reject unsigned (`alg: "none"`) attestations            |
| `maxClockSkew` | number   | `300`    | Seconds of allowed clock skew for `created` validation  |

**Output:**

```typescript
type VerifyResult =
  | { ok: true;  attestation: WaveAttestationEnvelope }
  | { ok: false; reason: VerifyError; detail?: string };

type VerifyError =
  | 'INVALID_SCHEMA'       // does not match attestation-v1.schema.json
  | 'ALG_SIG_INVARIANT'    // alg:'none' ⟺ sig:null violated
  | 'ID_MISMATCH'          // id field does not match computed attestationId
  | 'SIG_INVALID'          // signature verification failed
  | 'KEY_NOT_FOUND'        // kid in sig header not in /.well-known/wave-attestation-keys.json
  | 'KEYS_FETCH_FAILED'    // could not retrieve the public key endpoint
  | 'UNSIGNED_REJECTED'    // requireSig=true but alg is 'none'
  | 'CLOCK_SKEW';          // created is too far in the future
```

---

## 2. Step-by-Step Verification Algorithm

```
verify(raw, options):

  Step 1 — Schema validation
    parsed = JSON.parse(raw) if raw is a string, else raw
    result = validate(parsed, attestation-v1.schema.json)
    if result.errors → return { ok: false, reason: 'INVALID_SCHEMA', detail: result.errors[0] }
    a = parsed as WaveAttestationEnvelope

  Step 2 — alg/sig invariant
    if (a.alg === 'none') !== (a.sig === null)
      → return { ok: false, reason: 'ALG_SIG_INVARIANT' }

  Step 3 — requireSig check
    if options.requireSig && a.alg === 'none'
      → return { ok: false, reason: 'UNSIGNED_REJECTED' }

  Step 4 — ID recomputation
    expected = attestationId(a)     // see §3
    if a.id !== expected
      → return { ok: false, reason: 'ID_MISMATCH', detail: `expected ${expected}, got ${a.id}` }

  Step 5 — Clock skew check (optional but recommended)
    now = Date.now() / 1000   // unix seconds
    created = toUnixSeconds(a.created)
    if created > now + options.maxClockSkew
      → return { ok: false, reason: 'CLOCK_SKEW' }

  Step 6 — Signature verification (only when alg !== 'none')
    if a.alg === 'ed25519':
      subjectBytes = UTF8(canonicalJson(attestationSubject(a)))
      keys = fetchKeys(options.keysUrl)   // may throw → KEYS_FETCH_FAILED
      key = keys.find(k => k.kid === extractKid(a.sig))
      if !key → return { ok: false, reason: 'KEY_NOT_FOUND' }
      pubKey = importEd25519OKP(key)
      sigBytes = base64urlDecode(a.sig)
      valid = ed25519.verify(pubKey, sigBytes, subjectBytes)
      if !valid → return { ok: false, reason: 'SIG_INVALID' }

  Step 7 — Return success
    return { ok: true, attestation: a }
```

---

## 3. Helper Functions

### `attestationSubject(a)` — extract the signable subject

For `kind === "render"`:

```typescript
function attestationSubject(a: WaveAttestationEnvelope): Record<string, unknown> {
  const s = a.subject as RenderAttestationSubject;
  return {
    v:             s.v,
    kind:          s.kind,
    renderer:      s.renderer,
    scene_sha256:  s.scene_sha256,
    output_sha256: s.output_sha256,
    format:        s.format,
    bytes:         s.bytes,
  };
}
```

Note: The fields `created`, `alg`, `sig`, and `id` are **excluded** from the subject.
This is intentional — the ID is stable across time and cache replays.

For `kind === "context"` or `"settlement"`: The full `a.subject` object is the signable
subject (no field exclusion). Implementations SHOULD verify this for forward compatibility.

### `canonicalJson(value)` — deterministic serialization

```typescript
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort(); // Unicode code point order
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}
```

### `attestationId(a)` — content-addressed ID

```typescript
function attestationId(a: WaveAttestationEnvelope): string {
  return sha256hex(canonicalJson(attestationSubject(a)));
  // sha256hex: Buffer.from(sha256(input)).toString('hex') — 64 lowercase hex chars
}
```

### `fetchKeys(url)` — JWKS key fetch

```typescript
async function fetchKeys(url: string): Promise<WavePublicKey[]> {
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error(`keys fetch failed: ${resp.status}`);
  const body = await resp.json() as WaveAttestationKeysEndpoint;
  // Filter to valid (non-expired) keys only
  const now = Math.floor(Date.now() / 1000);
  return body.keys.filter(k => !k.exp || k.exp > now);
}
```

---

## 4. Key URL Resolution

If no explicit `keysUrl` is provided, the verifier SHOULD discover it from the
attestation's originating host using the `renderer` field or out-of-band configuration.

The canonical URL for the WAVE platform is:

```
https://wave.online/.well-known/wave-attestation-keys.json
```

Individual product hosts may serve their own key endpoints:

```
https://<product>.wave.online/.well-known/wave-attestation-keys.json
```

See `well-known-keys.md` for the full endpoint specification.

---

## 5. Verification Outcomes Reference

| Outcome              | Action                                               |
|----------------------|------------------------------------------------------|
| `ok: true`           | Attestation is structurally valid; sig verified if present |
| `INVALID_SCHEMA`     | Drop the attestation; log at warn level              |
| `ALG_SIG_INVARIANT`  | Drop; this indicates a malformed emitter             |
| `ID_MISMATCH`        | Drop; possible tampering or emitter bug              |
| `SIG_INVALID`        | Drop; signature does not verify                     |
| `KEY_NOT_FOUND`      | May be a key rotation lag; retry after 60s          |
| `KEYS_FETCH_FAILED`  | Retry with backoff; do not drop the attestation yet |
| `UNSIGNED_REJECTED`  | Caller chose to require signatures; drop is valid   |
| `CLOCK_SKEW`         | Possible clock misconfiguration; log at warn         |

---

## 6. Notes for Implementors

- The ingest layer (`wave-trace-ingest`) is **fail-soft**: a malformed attestation
  causes the attestation to be dropped while the containing OTLP span is still stored.
  Verifiers that run post-ingest MUST NOT assume all stored attestations are valid.
- The `wave.attestation` OTLP attribute is a **JSON string** (not a nested object).
  Always parse it before validating against the schema.
- The `created` field can be either a Unix seconds integer OR a string (ISO 8601 or
  unix seconds). Verifiers MUST normalize it before comparison.
- For idempotent storage: the `id` is the primary key. Two attestations with the same
  `id` are the same claim; the second upsert is a no-op.
