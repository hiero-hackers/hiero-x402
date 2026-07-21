# Security

Prototype software, testnet only. This document states the model honestly
rather than aspirationally.

## Key posture

- Exactly **two files touch private keys**, both in `demo/`, both reading
  `.env` only: [`demo/facilitator.ts`](demo/facilitator.ts) (the fee payer —
  co-signs and submits) and [`demo/agent.ts`](demo/agent.ts) (the payer —
  signs one transfer per run, for the exact advertised amount). Use two
  separate faucet accounts; fund them with amounts you are comfortable losing.
- The resource server holds **no keys**. The `src/` library is key-free and
  env-free by construction.
- Nothing in this repo stores, logs, or transmits key material; keys never
  appear in argv or output.

## Testnet gate

`src/config.ts` pins the supported networks to `hedera:testnet` **in code**
— not in an env var someone can fat-finger. The facilitator refuses to
start, the bridge refuses to build requirements, and the verifier refuses to
even contact a mirror for any other network, mainnet included. Prototype
money is never real money.

## Trust model

- The **facilitator** is the security-critical component: it co-signs as fee
  payer, so it must prove a payment does exactly what the requirements say
  before sponsoring it. That inspection (transaction layout, fee-payer
  safety, asset and amount exactness, payer-signature verification,
  `aliasPolicy: "reject"`) is deliberately the **official
  `@x402/hedera` engine's**, not a reimplementation — the code that
  specified the MUST-rules enforces them.
- The **agent trusts no one's word**: after settlement it verifies the
  on-chain outcome against the public mirror node and treats anything but an
  exact match as not paid. The mirror is the network's own record; anyone
  can re-run the check from the transaction id.
- Everything rendered in the receipt derives from the **verified** verdict,
  never echoed from a facilitator response; user-influenced strings are
  HTML-escaped.

## Verify-then-serve posture

The demo server can withhold data until the settlement **verifies on the
public mirror** (`VERIFY_BEFORE_SERVE=1`), closing the verify-pass /
settle-fail window the reference implementations accept. It is **off by
default, deliberately**: a failed settle is already a 402 from the official
middleware, so the wrapper only upgrades the success path from "facilitator
said so" to "chain confirmed" — at the cost of seconds of mirror lag on
every honest request. The merchant's residual exposure is bounded at one
response per request, and the payer-side agent verifies every settlement
regardless. Flip it on when a single response is worth more than seconds of
latency; the startup log states the active posture either way.

## Supply chain

- `npm audit` currently reports **38 advisories (28 moderate, 10 high)** —
  all inherited through the official `@x402/*` → Hedera SDK dependency
  chain, the same tree every reference implementation ships. There are no
  non-breaking fixes; forcing them would downgrade the SDK bridge. Accepted
  for a testnet prototype and re-checked before any mainnet consideration —
  same posture as the sibling repos.
- `@x402/*` versions are **pinned exactly** (2.19.0); `@x402/paywall` is
  installed explicitly because it is a silent peer dependency of
  `@x402/hono`.
- The verify gate (typecheck, lint incl. `eslint-plugin-security`, format,
  tests with 100% coverage floors) runs on bare exit codes.

## Reporting

Please use GitHub's private vulnerability reporting on this repository
rather than a public issue.
