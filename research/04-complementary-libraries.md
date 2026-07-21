# 04 · Complementary libraries — what we already ship that this build reuses

The differentiator in [[03-implementation-notes]] ("x402 with independently
verifiable settlement + receipts") is only credible because the pieces already
exist, published and tested. This file is the inventory: which package, which
exact exports, and what role each plays here.

## `@hiero-hackers/hiero-payment-requests` (v0.1.2, published)

The protocol brain. What we use, per module:

| Export                                   | Role in hiero-x402                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRequest`                          | Validated `PaymentRequest` construction (checksums, CAIP networks, atomic amounts) — the input side of the `requirements.ts` bridge                                         |
| `match`                                  | **The core differentiator.** Verdict of receipts vs a request: paid / underpaid / wrong-asset. Runs post-settlement against mirror data — the facilitator-independent check |
| `paymentInstructions`                    | Splits a request into `{network, asset, to, amount, memo}` — nearly 1:1 with x402 `PaymentRequirements` fields; the bridge is mostly this plus `extra.feePayer`             |
| `toLink` / `toQRSVG`                     | Human fallback: the same requirements rendered as a hiero-checkout link/QR next to the 402 challenge — one price, two audiences (agents and people)                         |
| `byUniqueAmount`, `remainderRequest`     | Roadmap: correlation when one `payTo` serves many concurrent agents; underpay follow-ups                                                                                    |
| `expectedChecksum`, `formatBaseUnits`    | Display and validation hygiene throughout                                                                                                                                   |
| `vectors/wire.v1.json` (exports subpath) | Conformance fixtures for property-testing the bridge round-trip                                                                                                             |

Shared conventions that make the bridge cheap: both formats use CAIP-style
network ids (`hedera:testnet`) and **string amounts in atomic units**. No unit
conversion layer needed.

## `@hiero-hackers/hiero-receipts` (v0.2.0, published)

The audit artifact. What we use:

- `fromMirror` — normalizes a mirror-node transaction (structural
  `TransactionInfoLike`, camelCase) into net credits, custom fees resolved.
  This is what turns "the facilitator said success" into "the chain says
  0.05 ℏ landed at 0.0.x".
- `receiptFor` — the receipt object for a given account's perspective.
- `toHTML` — the downloadable/printable receipt the agent keeps. The demo's
  closing beat ("receipt written to receipt.html") is this one call.

## `hiero-checkout` (live, not a dependency — a source-pattern quarry)

Patterns to lift, not code to import:

- **Thin mirror fetch**: originally duplicated here and in checkout; since
  upstreamed as `hiero-receipts/mirror-fetch` (item 2 below) — both now
  delegate to it.
- **Testnet-only gate** (`src/config.ts`): the enforcement pattern for the
  demo's refuse-mainnet rule.
- **WalletConnect partially-signed signer** (`src/wallets/walletconnect.ts`):
  the scaffold's browser x402 signer uses the _same_ `hedera_signTransaction`
  machinery — if we ever add a browser client, checkout already solved it.

## `@hiero-hackers/hiero-enterprise-js` (enterprise-mirror et al.)

The Node-shaped mirror client family. **Decision: not used in v1.** The demo
server needs three mirror endpoints; the thin-fetch pattern is lighter and
keeps the dependency graph small (same call made for checkout). Revisit if
`verify.ts` grows real polling/backoff needs — that's what enterprise-mirror
is for. (enterprise-express / enterprise-fastify are also the natural future
home for a first-party x402 middleware, once they're public.)

## `hiero-notifications`

Roadmap only: fire a merchant-side notification on verified settlement
(the `fulfils` adapter already consumes payment-requests). Not in the bounty
scope.

## Official `@x402/*` packages (cross-ref [[02-hedera-mapping]])

`@x402/core`, `@x402/hedera`, `@x402/hono`, `@x402/fetch` @ 2.19.0 — the
plumbing we deliberately do **not** rebuild: schemes, middleware, facilitator
engine, header codecs.

## The stack, as one picture

```
                 402 challenge                  payment                     settlement
agent  ── GET ──▶ resource server ── verify ──▶ facilitator ── submit ──▶ Hedera testnet
  │               (@x402/hono +                 (@x402/hedera/                  │
  │                requirements.ts bridge        exact/facilitator)             │
  │                from payment-requests)                                       │
  │                                                                    mirror node (REST)
  │                                                                             │
  └── verify.ts: transactionId → thin fetch → receipts.fromMirror ──────────────┘
                     → payment-requests.match → verdict + receipts.toHTML
```

Top row: official packages, table stakes. Bottom row: ours, the submission.

## What this build wants upstream — AFTER July 31, not before

Nothing below blocks the bounty (the whole build runs on the published
packages as-is — which is itself the strongest ecosystem claim we can make).
These are earned findings to upstream once the submission is in, each as an
issue the maintainer files, then a PR:

1. ~~payment-requests: a by-transaction-id correlation strategy.~~ **SHIPPED
   as `byTransactionId` in v0.1.2** (2026-07-21) — this repo's local strategy
   was upstreamed and now imports from the published library. The integration
   fed a feature back: the story the README should tell.
2. ~~receipts: extract the thin mirror fetch.~~ **SHIPPED as the
   `hiero-receipts/mirror-fetch` subpath in v0.2.0** (2026-07-21); both
   consumers now delegate to it — checkout keeps host policy + the fiat
   estimate, this repo keeps the testnet gate.
3. **streams-node: block acquisition + true transaction ids.** Two gaps the
   rung-three verifier (`verifySettlementFromBlock`) surfaced:
   (a) no client exists to fetch "the block holding transaction X" —
   **still blocked** on HIP-1056 reaching testnet and public block nodes
   (the cutover tripwire in hiero-streams-rs watches the signals);
   (b) ~~parsed transactions carry no validStart-based id~~ **SHIPPED**
   (2026-07-21): streams-node 0.2.0 exposes `transactionId`
   (payer@validStart, both stream eras) and receipts 0.2.1 prefers it in
   `fromStream` — rung-three correlation is now exact, not synthesized.
4. ~~checkout: render an x402 challenge.~~ **SHIPPED** (2026-07-21,
   checkout `src/x402.ts`): the landing paste box now accepts a 402 body, a
   bare requirements object, or the raw base64 `payment-required` header —
   validated, then rendered as a normal payer card. The once-duplicated
   mapping was then unified upstream: **payment-requests v0.1.3 ships
   `fromX402`/`toX402`** (2026-07-21), and both this repo's
   `requirements.ts` and checkout's `x402.ts` are now thin veneers over it —
   the fourth feature this build fed back.
