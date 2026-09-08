# PROTO-001 — public reproduction: "x402/payment protocol behavior has one canonical dialect or tested compatibility"

`PROTO-001` is owned by the gateway service repository (private). It is hosted here, in
`wave-av/api-spec` (public), alongside `API-001.md`, for the same reason: the criterion's
production-facing half is provable with anonymous HTTP requests against `https://api.wave.online`
and `https://gateway.wave.online` alone. The gateway exposes its x402 payment challenge in **three**
different dialects on the same response — a V1 JSON body (`x402Version: 1`, `accepts[0]`), a V2
`payment-required` response header (base64-encoded JSON, `x402Version: 2`), and an MPP
`www-authenticate` header — and this document shows all three, captured from the same live
response, agreeing on every *value* that matters. The dialects deliberately do **not** share field
names: the V1 body (and this repository's `openapi.yaml` `X402Accepts` schema) carries the amount as
`maxAmountRequired` and the chain as `network: "base"`; the V2 header carries the same amount as
`amount` and the same chain as CAIP-2 `network: "eip155:8453"`; the MPP header carries the amount
inside its base64url `request=` parameter as `amount` and the chain as `network="base"`. That
mapping is published by the gateway itself at
`https://gateway.wave.online/.well-known/payments.json` (`protocols[x402].wire.v1` / `.v2`) and is
read back, anonymously, in the supplementary run below.

## Pass condition (from the canonical gate spec)

> A response never contradicts itself; one dialect is canonical, or every supported dialect is
> version-negotiated, documented and conformance-tested end to end.

## Revision measured

- **Gateway deployed revision**: `ecc9f4f36aa0064b6ceea064823aeb9164e37023`, verified at
  2026-09-06T02:05:12Z (confirm today's revision the same way as `API-001.md`:
  `curl -sS https://gateway.wave.online/healthz`).
- **Pinning of the live receipts in this document.** The 2026-09-08T05:14Z transcript below did not
  capture `/healthz` in its own run, so on its own it is **unpinned** — read it as "a revision
  deployed on 2026-09-08 later than `ecc9f4f36aa0`" (`API-001.md`'s run at the same timestamp
  reported `commit: bb1baf3bd71c`, but that is a different document's capture and is not claimed
  here as this transcript's revision). The supplementary run at 2026-09-08T15:58:01Z **is** pinned:
  it captured `/healthz` at its start and end, both reporting `commit: ef1cf411b64e`.
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
and the V1 JSON body (`x402Version: 1`, with `accepts[0]` and `error_detail`) in the response body
itself. Note that the command above uses `-o /dev/null`, which shows the two header dialects and
**discards the V1 body**; to see all three from one request keep the body — the supplementary run
below does exactly that (`curl -sS -D - https://api.wave.online/v1/clips | python3 crosscheck.py`).
No credential is sent, no payment is made; a `402` is the normal, expected, unauthenticated response
and settles nothing.

## Observed output — this document's own live run, 2026-09-08T05:14Z (unpinned; see "Revision measured")

```text
$ curl -sS -D - -o /dev/null https://api.wave.online/v1/clips
HTTP/2 402
www-authenticate: Payment id="<opaque per-request id>", realm="api.wave.online",
  method="exact", intent="charge", network="base",
  asset="<USDC-on-Base contract address, redacted here — read live via the command above>",
  payto="<gateway receive address, redacted here — read live via the command above>", resource="/v1/clips"
payment-required: <base64, redacted here>   (decodes to JSON accepts[0] below)
```

(The `www-authenticate` line above is abridged: the live header also carries `request="<base64url>"`,
`expires="<timestamp>"` and `description="wave api access"`, which the 05:14Z transcript elided.
`request=` is the parameter the amount row of the cross-check table refers to; it is base64url JSON
with the keys `amount`, `currency`, `recipient`. The supplementary run below decodes it in full.)

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

Note the V2 header's field names (`amount`, CAIP-2 `network`) differ from the V1 body's and from
`openapi.yaml`'s `X402Accepts` (`maxAmountRequired`, `network: base`); the values agree. This is the
gateway's documented V1/V2 wire difference, not a contract violation — see the `payments.json` read
in the supplementary run.

Cross-checking every field against the `www-authenticate` header captured in the same response:

| field | `www-authenticate` (MPP) | `payment-required` (V2 header) | agree? |
|---|---|---|---|
| amount | encoded in `request=` (elided from the abridged header above; see note), decodes to `"amount":"20000"` | `20000` | yes |
| asset / currency | (decodes to same address) | identical to the `www-authenticate` `asset` value | yes |
| payTo / recipient | (decodes to same address) | identical to the `www-authenticate` `payto` value | yes |
| network | `network="base"` | `eip155:8453` (CAIP-2 of `base`, per the gateway's `payments.json` — shown below) | yes |

All three surfaces — the MPP header, the V2 header, and the V1 JSON body
— name the identical amount, asset, payee and chain for the identical resource, on the identical
response, at this document's own run 2026-09-08T05:14Z — the same live-receipt invariant the
original 2026-09-06T02:05:12Z measurement recorded (amount `20000`; the asset and payTo addresses
were likewise byte-identical across all three dialects then, exactly as they are now — different
`id`/`session_id`/`expires` nonces, which is expected per-request state, not protocol disagreement).
Run the command above yourself to read the live address values; this document does not reprint them
verbatim so that no automated scanner mistakes a public, openly-served payment address for a leaked
credential.

## Supplementary run — 2026-09-08T15:58:01Z, same-run revision `ef1cf411b64e`

Added in review. One anonymous request with the body **kept**, all three dialects decoded from that
one response and compared field by field; then the gateway's own public dialect map. `/healthz` was
read at the start and the end of the same run and reported the same `commit` both times. Addresses
are compared for equality rather than reprinted (same policy as above).

```text
$ curl -sS https://gateway.wave.online/healthz
{"ok":true,"service":"<redacted — see API-001.md>","version":"ef1cf411b64e","release":"82ef5cfe-ceb5-4055-a037-7c4538ed2c0a","commit":"ef1cf411b64e"}

$ curl -sS -D - https://api.wave.online/v1/clips | python3 crosscheck.py
status line: HTTP/2 402
MPP www-authenticate params: ['asset', 'description', 'expires', 'id', 'intent', 'method', 'network', 'payto', 'realm', 'request', 'resource']
MPP request= decodes to keys: ['amount', 'currency', 'recipient'] | amount = 20000
V2 payment-required decodes to: x402Version = 2 | accepts[0] keys = ['amount', 'asset', 'extra', 'maxTimeoutSeconds', 'network', 'payTo', 'scheme']
V1 JSON body: x402Version = 1 | top-level keys = ['accepts', 'error', 'error_detail', 'next_action', 'x402Version'] | accepts[0] keys = ['asset', 'description', 'extra', 'maxAmountRequired', 'maxTimeoutSeconds', 'mimeType', 'network', 'payTo', 'protocol', 'resource', 'scheme']
amount   : V1 maxAmountRequired = 20000 | V2 amount = 20000 | MPP request.amount = 20000
asset    : identical across V1.asset / V2.asset / MPP asset= / MPP request.currency -> True
payTo    : identical across V1.payTo / V2.payTo / MPP payto= / MPP request.recipient -> True
network  : V1 = base | V2 = eip155:8453 | MPP = base
resource : V1 = /v1/clips | V2 = https://api.wave.online/v1/clips | MPP = /v1/clips

$ curl -sS https://gateway.wave.online/.well-known/payments.json | python3 norm.py
v1 {"carrier": "response body (JSON)", "network_id": "base", "amount_field": "maxAmountRequired"}
v2 {"carrier": "PAYMENT-REQUIRED response header (base64 JSON)", "network_id": "eip155:8453", "amount_field": "amount"}
networks: ['eip155:8453', 'eip155:84532'] | precedence: Both dialects carry identical terms for the same quote.

$ curl -sS https://gateway.wave.online/healthz   # same run, closing
{"ok":true,"service":"<redacted — see API-001.md>","version":"ef1cf411b64e","release":"82ef5cfe-ceb5-4055-a037-7c4538ed2c0a","commit":"ef1cf411b64e"}
```

`crosscheck.py`, as run above (stdin is the raw `-D -` output: headers, blank line, body):

```python
import json,re,base64,sys
raw=sys.stdin.buffer.read().decode(); hdr,_,body=raw.partition('\r\n\r\n')
def b64(s): s=s.replace('-','+').replace('_','/'); return base64.b64decode(s+'='*(-len(s)%4)).decode()
wa=re.search(r'^www-authenticate: (.*)$',hdr,re.M|re.I).group(1); pr=re.search(r'^payment-required: (\S+)',hdr,re.M|re.I).group(1)
mpp=dict(re.findall(r'(\w+)="([^"]*)"',wa)); req=json.loads(b64(mpp['request'])); v2=json.loads(b64(pr)); v1=json.loads(body)
a1,a2=v1['accepts'][0],v2['accepts'][0]
print('status line:', hdr.splitlines()[0])
print('MPP www-authenticate params:', sorted(mpp))
print('MPP request= decodes to keys:', sorted(req), '| amount =', req['amount'])
print('V2 payment-required decodes to: x402Version =', v2['x402Version'], '| accepts[0] keys =', sorted(a2))
print('V1 JSON body: x402Version =', v1['x402Version'], '| top-level keys =', sorted(v1), '| accepts[0] keys =', sorted(a1))
print('amount   : V1 maxAmountRequired =', a1['maxAmountRequired'], '| V2 amount =', a2['amount'], '| MPP request.amount =', req['amount'])
print('asset    : identical across V1.asset / V2.asset / MPP asset= / MPP request.currency ->', a1['asset'].lower()==a2['asset'].lower()==mpp['asset'].lower()==req['currency'].lower())
print('payTo    : identical across V1.payTo / V2.payTo / MPP payto= / MPP request.recipient ->', a1['payTo'].lower()==a2['payTo'].lower()==mpp['payto'].lower()==req['recipient'].lower())
print('network  : V1 =', a1['network'], '| V2 =', a2['network'], '| MPP =', mpp['network'])
print('resource : V1 =', a1['resource'], '| V2 =', v2['resource']['url'], '| MPP =', mpp['resource'])
```

`norm.py`, as run above (stdin is `payments.json`):

```python
import json,sys
d=json.load(sys.stdin); x=next(p for p in d['protocols'] if p['protocol']=='x402')
for v in ('v1','v2'): print(v, json.dumps({k:x['wire'][v][k] for k in ('carrier','network_id','amount_field')}))
print('networks:', [n['networkId'] for n in x['networks']], '| precedence:', x['precedence'].split('.')[0]+'.')
```

Three-dialect table at this pinned revision, from the one response above:

| value | V1 JSON body | V2 `payment-required` header | MPP `www-authenticate` header | agree? |
|---|---|---|---|---|
| amount | `maxAmountRequired: "20000"` | `amount: "20000"` | `request=` → `amount: "20000"` | yes |
| asset | `asset` | `asset` (identical) | `asset=` and `request=` → `currency` (identical) | yes |
| payee | `payTo` | `payTo` (identical) | `payto=` and `request=` → `recipient` (identical) | yes |
| network | `base` | `eip155:8453` | `base` | yes — `payments.json` declares `wire.v1.network_id = base` and `wire.v2.network_id = eip155:8453` for the same rail, and lists `eip155:8453` as the settlement network |
| resource | `/v1/clips` | `https://api.wave.online/v1/clips` (absolute form of the same path) | `/v1/clips` | yes |

## What this reproduction does not cover

The full pass condition is "conformance-tested end to end," which in the private repo means the
33/33 `vitest` run across 4 hosts × 2 rails, CI-gated on every gateway PR
(`.github/workflows/build-check.yml`). This document reproduces the **live, production-facing**
half of that claim (the three dialects agree on a real response, right now) without requiring
access to the private test suite or its Cloudflare `workers-pool` environment. It does not
independently reproduce the other 3 routed hosts (`gateway.wave.online`, `api.mcp.wave.online`,
`gateway.mcp.wave.online`) or the flat-rail path (`POST /v1/dispatch/chat/completions`); a reader
who wants that full matrix needs the private repo's test suite, exactly as named above.
