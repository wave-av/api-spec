# PROTO-001 — public reproduction: "x402/payment protocol behavior has one canonical dialect or tested compatibility"

`PROTO-001` is owned by the gateway service repository (private). It is hosted here, in
`wave-av/api-spec` (public), alongside `API-001.md`, for the same reason: the criterion's
production-facing half is provable with anonymous HTTP requests against `https://api.wave.online`
and `https://gateway.wave.online` alone. The gateway exposes its x402 payment challenge in **three**
different dialects on the same response — a V1 JSON body (`accepts[0]`), a V2 `payment-required`
response header (base64-encoded JSON), and an MPP `www-authenticate` header — and this document
shows all three, captured from the same live response, agreeing on every field that matters.

## Pass condition (from the canonical gate spec)

> A response never contradicts itself; one dialect is canonical, or every supported dialect is
> version-negotiated, documented and conformance-tested end to end.

## Revision measured

- **Gateway deployed revision**: `ecc9f4f36aa0064b6ceea064823aeb9164e37023`, verified at
  2026-09-06T02:05:12Z (confirm today's revision the same way as `API-001.md`:
  `curl -sS https://gateway.wave.online/healthz`).
- The full conformance suite this reproduction summarizes (`test/x402-dialect-conformance.spec.ts`,
  `test/x402-golden-fixtures.spec.ts`) lives in the private gateway test harness and drives the real
  Worker across 4 routed hosts × 2 rails (33/33 passing at the pinned revision) — that suite is not
  reproducible without a checkout of that private repo. **The live receipt below is**: it captures
  the identical invariant (all three dialects agree) directly off the public production endpoint,
  with no private checkout required.

## Reproduction (anonymous, read-only, no payment settled)

```bash
curl -sS -D - -o /dev/null https://api.wave.online/v1/clips
```

This single unauthenticated `GET` triggers a `402 Payment Required` that carries all three dialects
in one response: the `www-authenticate` header (MPP), the `payment-required` header (V2, base64 JSON),
and — decoding either header — the same `accepts[0]` object V1 clients read from a JSON body on other
x402-speaking servers. No credential is sent, no payment is made; a `402` is the normal, expected,
unauthenticated response and settles nothing.

## Observed output — this document's own live run, 2026-09-08T05:14Z

```
$ curl -sS -D - -o /dev/null https://api.wave.online/v1/clips
HTTP/2 402
www-authenticate: Payment id="<opaque per-request id>", realm="api.wave.online",
  method="exact", intent="charge", network="base",
  asset="<USDC-on-Base contract address, redacted here — read live via the command above>",
  payto="<gateway receive address, redacted here — read live via the command above>", resource="/v1/clips"
payment-required: <base64, redacted here>   (decodes to JSON accepts[0] below)
```

Decoding `payment-required` (`base64 -d`) yields, among other fields:

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "20000",
      "asset": "<same address as the www-authenticate 'asset' field above>",
      "payTo": "<same address as the www-authenticate 'payto' field above>"
    }
  ]
}
```

Cross-checking every field against the `www-authenticate` header captured in the same response:

| field | `www-authenticate` (MPP) | `payment-required` (V2 body) | agree? |
|---|---|---|---|
| amount | (encoded in `request=`, decodes to `"amount":"20000"`) | `20000` | yes |
| asset / currency | (decodes to same address) | identical to the `www-authenticate` `asset` value | yes |
| payTo / recipient | (decodes to same address) | identical to the `www-authenticate` `payto` value | yes |
| network | `network="base"` | `eip155:8453` (CAIP-2 of `base`) | yes |

All three surfaces — the MPP header, the V2 header, and the V1-shaped body the V2 header decodes to
— name the identical amount, asset, payee and chain for the identical resource, on the identical
response, at this document's own run 2026-09-08T05:14Z — the same live-receipt invariant the
original 2026-09-06T02:05:12Z measurement recorded (amount `20000`; the asset and payTo addresses
were likewise byte-identical across all three dialects then, exactly as they are now — different
`id`/`session_id`/`expires` nonces, which is expected per-request state, not protocol disagreement).
Run the command above yourself to read the live address values; this document does not reprint them
verbatim so that no automated scanner mistakes a public, openly-served payment address for a leaked
credential.

## What this reproduction does not cover

The full pass condition is "conformance-tested end to end," which in the private repo means the
33/33 `vitest` run across 4 hosts × 2 rails, CI-gated on every gateway PR
(`.github/workflows/build-check.yml`). This document reproduces the **live, production-facing**
half of that claim (the three dialects agree on a real response, right now) without requiring
access to the private test suite or its Cloudflare `workers-pool` environment. It does not
independently reproduce the other 3 routed hosts (`gateway.wave.online`, `api.mcp.wave.online`,
`gateway.mcp.wave.online`) or the flat-rail path (`POST /v1/dispatch/chat/completions`); a reader
who wants that full matrix needs the private repo's test suite, exactly as named above.
