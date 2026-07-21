# 02 · x402 on Hedera — the official mapping

Primary source: **`specs/schemes/exact/scheme_exact_hedera.md` in coinbase/x402
itself** (raw copy: [`_raw-scheme-exact-hedera.md`](_raw-scheme-exact-hedera.md)) —
Hedera is an officially specified x402 scheme, not a community bolt-on.
Cross-checked against two working reference codebases (raw copies under
[`_raw-hedera-example/`](_raw-hedera-example/) and [`_raw-scaffold/`](_raw-scaffold/)).
Verified 2026-07-21.

## The conventions, field by field

| x402 field       | Hedera value                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `network`        | `hedera:testnet` / `hedera:mainnet` (CAIP-2 style — same namespace our `hiero-pay:` URIs use)  |
| `asset`          | `"0.0.0"` for native HBAR; otherwise an HTS fungible token id (`0.0.x`)                        |
| `amount`         | String, atomic units: **tinybars** for HBAR (1 ℏ = 10⁸), token's smallest unit for HTS         |
| `payTo`          | Recipient account id (`0.0.x`)                                                                 |
| `extra.feePayer` | **Required.** Account id of whoever sponsors network fees — typically the facilitator          |
| `payload`        | `{ "transaction": "<base64>" }` — a serialized, **partially signed** `TransferTransaction`     |
| Settlement       | `{ success, transactionId: "0.0.x@seconds.nanos", network, payer }` — `payer` is the fee payer |

## The fee-payer trick (the clever part)

The client builds a `TransferTransaction` (client → payTo, exact amount) but
sets **`transactionId.accountId = extra.feePayer`** — making the facilitator
the network-level fee payer — then signs with only its own key and ships the
partially-signed bytes as base64. The facilitator inspects the decoded
transaction, adds the missing fee-payer signature, and submits.

Consequences:

- The **client pays zero fees** (agents don't need HBAR-for-gas, only the
  asset being spent).
- The **resource server holds no keys at all** — it just relays payloads to
  the facilitator.
- Replay safety is native: a Hedera `TransactionId` submits once, expires in
  ~2 minutes. No nonce machinery.
- The facilitator carries the risk, hence the strict MUST-rules below.

## Facilitator verification rules (spec MUSTs — our checklist)

Before co-signing, a facilitator MUST verify the decoded transaction:

1. **Layout** — is a bare `TransferTransaction` (no `ScheduleCreate`
   wrapping); `transactionId.accountId == extra.feePayer`; contains _only_
   transfer operations; HBAR transfers net to zero; each token's transfers
   net to zero.
2. **Fee-payer safety** — the feePayer never appears as a **negative** entry
   in any transfer list (it may receive, never send). It only sponsors fees.
3. **Network/asset correctness** — valid Hedera CAIP-2 network; asset is
   `"0.0.0"` or a real FT id; **no other token ids appear anywhere**.
4. **Destination** — net credit to `payTo` for the asset.
5. **Exactness** — net credit to `payTo` **equals `amount` exactly**; no
   positive net transfer to anyone else; client sends no more than `amount`.
6. **Validity** — replay/idempotency check; SHOULD preflight (balance, token
   association) so settlement won't fail on-chain.

Alias edge case: `payTo` as an EVM/key alias triggers fee-payer-funded
auto-account-creation. The spec leaves policy open; the scaffold facilitator
uses `aliasPolicy: "reject"` (payTo must be a concrete `0.0.x`). We do the same.

This is _structural transaction inspection before submission_ — the same
discipline as hiero-payment-requests' `match`, applied pre-chain instead of
post-chain. The two are complementary: verify-before-settle (facilitator) and
verify-on-chain-outcome (mirror + `match`). See [[03-implementation-notes]].

## Who has already built what (critical context)

1. **`@x402/hedera` — official npm package, latest 2.19.0** (with `@x402/core`,
   `@x402/hono`, `@x402/fetch`). Built on `@hiero-ledger/sdk` (the renamed
   Hiero SDK — helpful for our Hiero-first story). Ships all three roles:
   - `@x402/hedera/exact/client` — `ExactHederaScheme(signer)`; signers via
     `createClientHederaSigner(accountId, PrivateKey, {network})` or any
     object with `createPartiallySignedTransferTransaction(requirements)`.
   - `@x402/hedera/exact/server` — resource-server side, paired with
     `x402ResourceServer(facilitatorClient)` and `paymentMiddleware` from
     `@x402/hono`.
   - `@x402/hedera/exact/facilitator` — `ExactHederaScheme(signer, {aliasPolicy})`
     plus helpers `createHederaClient`, `createHederaPreflightTransfer`,
     `createHederaSignAndSubmitTransaction`, `toFacilitatorHederaSigner`.
2. **Hosted testnet facilitator**: `https://api.testnet.blocky402.com`
   (used by the example server; zero-setup demo path — but a third-party
   dependency mid-demo). Verified live 2026-07-21: `/supported` advertises
   `x402Version: 2`, `hedera:testnet` with `feePayer: 0.0.7162784`.
3. **`matevszm/x402-hedera-example`** — Hono resource server selling mock
   financial data at 0.01–0.05 HBAR/call against blocky402; includes
   `scripts/x402-sign.ts`, a stdin/stdout delegated signer so an _agent_ runs
   the HTTP flow while the key stays in a separate process. Server holds no key.
4. **`hedera-dev/scaffold-hbar` branch `templates/x402-pay-per-use`** — the
   judges' own template: pay-per-download file marketplace, HashPack in the
   browser as the x402 signer (WalletConnect `hedera_signTransaction`,
   partially-signed tx — the exact machinery hiero-checkout already ships),
   and a **self-hosted facilitator** (~115-line Node HTTP wrapper around the
   official engine) run via docker-compose.

## Which asset for the demo?

**Native HBAR (`asset: "0.0.0"`, tinybars).** Both reference implementations
price in HBAR; the scaffold hardcodes `HBAR_ASSET = "0.0.0"`. Faucet-fundable,
no token association step, no USDC dependency. HTS-token support comes free
from the official scheme if we want to show one paid route in a token, but
HBAR is the demonstrated, judge-familiar path.
