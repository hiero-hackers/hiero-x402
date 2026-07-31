# hiero-x402

[![CI](https://github.com/hiero-hackers/hiero-x402/actions/workflows/ci.yml/badge.svg)](https://github.com/hiero-hackers/hiero-x402/actions/workflows/ci.yml)
[![CodeQL](https://github.com/hiero-hackers/hiero-x402/actions/workflows/codeql.yml/badge.svg)](https://github.com/hiero-hackers/hiero-x402/actions/workflows/codeql.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/hiero-hackers/hiero-x402/badge)](https://scorecard.dev/viewer/?uri=github.com/hiero-hackers/hiero-x402)

**x402 on Hiero with verifiable settlement and receipts.** The official
`@x402/*` packages move the money; this repo proves it moved — an
independent, facilitator-free settlement check and a receipt artifact for
every payment an agent makes. Prototype, **testnet only** (enforced in code).

Every x402 flow ends with a `SettleResponse`: a claim, made by the party that
moved the money, that the money moved. Every reference implementation stops
there. Here, the agent — spending with no human in the loop — walks the
remaining distance itself: it looks the settlement up on the network's public
mirror node, normalizes what actually landed, judges it against the original
terms, and writes itself a receipt with the HashScan proof link.

And the payment is only half the trade. The server can **commit to the
content** it served: it signs sha-256(served bytes) against the settlement
transaction, the agent re-verifies that signature against the signer's
on-chain key, the receipt shows both halves in separate trust registers,
and the HCS attestation carries the commitment onto an append-only public
log that `npm run audit` re-verifies with no cooperation from anyone.

```mermaid
sequenceDiagram
    autonumber
    participant A as agent (client key)
    participant S as resource server (NO keys)
    participant F as facilitator (fee-payer key)
    participant H as Hedera testnet
    participant M as public mirror node

    A->>S: GET /data/spot-price
    S-->>A: 402 + terms (0.05 ℏ, extra.feePayer)
    A->>S: retry + payment-signature (partially signed TransferTransaction)
    S->>F: /verify, then /settle
    F->>H: co-sign as fee payer + submit
    S-->>A: 200 + data + payment-response + x-content-* (signed content hash)
    Note over A,M: this repo's contribution
    A->>M: look the settlement up yourself
    A->>M: resolve the content signer's on-chain key
    A->>A: fromMirror → match → verdict + receipt.html
    A->>H: attest verdict + content hash to an HCS topic
    Note over M: `npm run audit` re-verifies the topic — no one's cooperation needed
```

## Run it

Two funded **ECDSA testnet** accounts ([faucet](https://portal.hedera.com/faucet)):
one for the facilitator (sponsors network fees), one for the agent (pays).
The resource server holds no payment keys — optionally one signing-only
identity (`CONTENT_SIGNER_*`) that attests to served bytes and can move
nothing.

```sh
npm install            # @hiero-hackers packages come from GitHub Packages —
                       # you need the usual read:packages token in ~/.npmrc
cp .env.example .env   # fill in the two accounts
npm run demo           # both rails, in order: facilitator (:4020) then
                       # server (:4021) — hub at http://localhost:4021/ui
npm run e2e            # the agent: 402 → sign → 200 → VERIFY → receipt.html
```

(The rails stay separate processes — the facilitator holds the fee-payer
key, the server holds no payment keys, the agent holds its own — `npm run
demo` just boots the first two in one terminal. `npm run facilitator` and
`npm run server` still exist for running them apart.)

**Three ways to demo it.** The hub's Run button has a run-mode selector:

- **Autonomous** (default) — no human in the loop; the bounty's thesis.
- **Hub button** — the agent pauses at step 2½ — terms known, **nothing
  signed** — and the hub shows the exact spend to Approve or Decline; the
  "human" chip on the rails appears only in approval modes. Same gate from a
  terminal: `HUMAN_APPROVAL=1 npm run e2e` (answer y/N on stdin).
- **Wallet-signed** — the approval itself becomes verifiable: the human's
  wallet signs the exact terms under a one-time nonce the hub mints for that
  pause, the hub verifies the signature against the approver's on-chain key
  (`APPROVER_ACCOUNT_ID`, key resolved from the mirror at boot) before
  releasing the gate, and the signed consent rides into the HCS attestation —
  the audit trail then records WHO approved WHICH terms, on WHICH run, and a
  captured signature approves nothing later. Needs `APPROVER_ACCOUNT_ID` +
  `WALLETCONNECT_PROJECT_ID` (free, from cloud.reown.com) in `.env`.

The agent still leads every step in all three: it discovered the price, and
after approval it signs, retries, verifies against the mirror, and writes its
own receipt. Decline and the run ends with nothing signed, nothing spent.
And the epistemics stay honest: signed consent doesn't force the agent's
hand — the binding is post-hoc, exactly this repo's posture: the verifier
checks the on-chain settlement against the terms, and the attestation now
carries the human's signature over those same terms.

The agent narrates each protocol step; the run ends with the verdict, the
HashScan link, and `receipt.html` on disk. It exits non-zero unless the
mirror confirms the exact amount landed — data paid for on the facilitator's
word alone is treated as not paid for.

Five knobs worth knowing (all in [.env.example](.env.example)):

- **`CONTENT_SIGNER_ACCOUNT_ID` / `CONTENT_SIGNER_KEY`** — content
  commitments: the server signs sha-256(served bytes) against each
  settlement transaction, so it can never later deny WHAT it served for a
  payment. The agent verifies the signature against the signer's on-chain
  key from the mirror — never the header's own claims — and the receipt's
  **Delivered content** panel says which register the run earned: `SERVER
COMMITTED`, `COMMITMENT BROKEN` (loud — a false commitment is evidence),
  or `AGENT RECORD` (no commitment offered; not a failure). A commitment
  binds bytes to a payment — it does not make the data true, and the
  receipt says so in as many words.
- **`ATTEST_TOPIC_ID=create`** — after verifying, the agent writes the
  verdict to a **Hedera Consensus Service topic**: an append-only public
  audit log of every payment it made and checked. An auditor needs the topic
  id, not the agent's cooperation. (The reference implementation defers "HCS
  attestation" — this is that feature, live:
  [topic 0.0.9672190](https://hashscan.io/testnet/topic/0.0.9672190) holds a
  real attested verdict from a real paid run.) The attestation carries the
  content hash and the server's commitment signature, and **`npm run
audit`** re-verifies every commitment straight from the mirror — rebuild
  the signed message from the attestation's own fields, check it against
  the signer's on-chain key, trust nobody's flag.

- **`RESOURCE=/data/fx`** — a route priced in **testnet USDC** (the official
  token id from `@x402/hedera`). Needs an agent holding testnet USDC and an
  associated `payTo`; the facilitator's preflight refuses cleanly otherwise.
- **`VERIFY_BEFORE_SERVE=1`** — the server itself withholds data until the
  settlement verifies on the public mirror, closing the
  verify-pass/settle-fail window the reference implementations accept.
  Off by default, deliberately: it costs honest seconds of mirror lag per
  paid request, the merchant's exposure is bounded at one response, and the
  agent verifies regardless — flip it on when one response is worth more
  than seconds (reasoning in [SECURITY.md](SECURITY.md)).
- **`ALLOWED_PAY_TO` / `MAX_AMOUNT`** — facilitator policy: which
  requirements this fee payer will sponsor at all (the spec's
  "implementations MAY introduce stricter limits", made concrete).

## Proof (real testnet run, 2026-07-21)

```
[agent] 1 · GET http://localhost:4021/data/spot-price?symbol=HBAR
[agent] 2 · 402: 5000000 tinybar of 0.0.0 → 0.0.9651206 (feePayer 0.0.6502504 sponsors the network fee)
[agent] 3 · signing the transfer (partially — the fee payer signs last)
[agent] 4 · retrying with payment attached
[agent] 5 · 200 — data: {"product":"spot-price","symbol":"HBAR","price":11.48,"currency":"USD"}
[agent]     settlement claims transaction 0.0.6502504@1784634414.257402675
[agent] 6 · VERIFYING — the mirror node, not the facilitator's word
[agent]     Paid in full — the chain confirms the exact amount landed.
[agent]     proof: https://hashscan.io/testnet/transaction/1784634418.453138104
[agent] 7 · receipt written to receipt.html
```

**[View the settlement on HashScan](https://hashscan.io/testnet/transaction/1784634418.453138104)** —
agent `0.0.6280387` −5,000,000 tinybar → `0.0.9651206` +5,000,000, network fee
sponsored by `0.0.6502504`. Anyone can re-run the check from the transaction id.

The receipt the agent filed for that run — the verdict, the terms, and the
proof link in one printable document:

<img src="docs/receipt.png" width="480" alt="receipt.html: 'x402 settlement — mirror-node record. Paid in full — the chain confirms the exact amount landed', with reference, transaction id, quoted and settled amounts, HashScan link, the Delivered content panel (SERVER COMMITTED, content sha-256, signer, signature), and the hiero-receipts body" />

**The verifier is not decoration — it disagrees with the facilitator when
the chain does.** A facilitator can report success while the recipient nets
less than the price (fee interactions, wrong asset, wrong destination); the
agent's mirror check classifies exactly what landed — `paid`, `underpaid`
with the shortfall, `wrong-asset` — and refuses to call anything paid on
another party's word ([a real underpaid verdict, on
chain](https://hashscan.io/testnet/transaction/1784633796.552851104)). And
the trail survives scrutiny end to end: every content commitment on the
[public audit topic](https://hashscan.io/testnet/topic/0.0.9855803)
re-verifies from public data alone — `npm run audit`, no cooperation from
agent, server, or facilitator.

## Why independent verification

The x402 flow is sound, but every party downstream of the facilitator takes
its word: the reference server's own README concedes that a verify-pass /
settle-fail delivers data without payment landing, and no client checks the
chain. For autonomous agents that's exactly backwards — the party with no
human in the loop is the one that most needs receipts it can prove. The check
here is not bespoke: it is the **same `match` rule** hiero-checkout's
merchant and payer already share, so three parties agree on what "paid"
means, none by trusting another's word.

| Concern                                     | Where it lives                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| x402 wire, schemes, middleware, facilitator | official `@x402/core` / `@x402/hedera` / `@x402/hono` — deliberately not rebuilt    |
| Requirements ⇄ `PaymentRequest` bridge      | [`src/requirements.ts`](src/requirements.ts)                                        |
| Settlement → mirror → verdict               | [`src/verify.ts`](src/verify.ts) — correlation via `byTransactionId`                |
| Content commitment schema                   | [`src/content.ts`](src/content.ts) — one canonical byte sequence, signed            |
| Attestation wire (verdict + content)        | [`src/attestation.ts`](src/attestation.ts) — self-auditing topic messages           |
| The receipt artifact                        | [`src/receipt.ts`](src/receipt.ts) → hiero-receipts `toHTML`                        |
| The independent auditor                     | [`demo/audit.ts`](demo/audit.ts) — `npm run audit`, mirror-only                     |
| Mirror access                               | `hiero-receipts/mirror-fetch` + the testnet gate ([`src/config.ts`](src/config.ts)) |

## Why Hedera (and what this does for the network)

Pay-per-call only works where fees are **fixed and sub-cent** — a percentage
fee or a gas auction eats a $0.0005 API call alive. Add seconds-fast
finality and a free public mirror to verify against, and x402's design
assumptions read like Hedera's spec sheet. The network effects run the
other way too: **every paid API call is an on-chain transaction** (agents
consuming micropriced data are a TPS engine, not a burden), and fee-payer
sponsorship means a paying agent needs **no pre-funded gas at all** — the
lowest-friction account-onboarding story in the ecosystem.

## The integration fed the ecosystem back

This build runs entirely on published packages — no forks, no patches — and
upstreamed what it learned, the same week it learned it:

- **`byTransactionId`** correlation strategy → `hiero-payment-requests`
  v0.1.2. x402 payments carry no memo, but the protocol knows its settlement
  transaction — correlation by identity, through the library's documented
  strategy seam.
- **`mirror-fetch`** subpath → `hiero-receipts` v0.2.0. The thin REST access
  two repos had independently grown, extracted once.
- **x402 challenges as a checkout entry** →
  [hiero-checkout](https://hiero-hackers.github.io/hiero-checkout/): paste a
  402 body — or the raw base64 `payment-required` header — and it renders as
  a human-payable card.

That last one is the quiet bonus of the design: the demo server's catalog
(`GET /`) offers every priced resource **both ways** from one object — the
402 challenge for agents, a checkout link/QR for people — and the same rule
judges both payments. It even works as a deep link: put the base64
`payment-required` header value in checkout's URL fragment and the agent's
challenge renders as a human-payable card, watching the chain live:

<img src="docs/checkout-x402.png" width="420" alt="hiero-checkout rendering an x402 challenge as a payer card: 'x402 · http://localhost:4021/data/spot-price', 0.05 ℏ to 0.0.9651206 on testnet, Pay now, the resource URL as the required memo, live payment watching" />

(Screenshots are reproducible output, not relics: `npm run screenshots`
regenerates both receipt images from fresh `e2e` / `provenance` runs.)

## The next rung: proof, not attestation

Look closely at the receipt above: the hiero-receipts body is stamped
**UNVERIFIED**. That is honesty, not a defect — mirror data is the network
operator's _attested_ record, so the receipt says exactly that. The full
trust ladder:

1. **The facilitator's word** — where every other x402 flow stops.
2. **The public mirror node** — what `npm run e2e` checks: independent and
   re-checkable by anyone, but still operator-attested.
3. **The block stream's own proof** — recomputed merkle root + threshold
   signature, verified before a single field is believed.

Rung three already runs in this repo:

```sh
npm run provenance   # no keys, no env, no network — committed block fixtures
```

It verifies a real block's in-band proof (`@hiero-hackers/streams-node`),
refuses to read the data at all if the proof fails, and emits a receipt
stamped **"Cryptographically verified against the previewnet ledger"** —
through the _same_ `source → receiptFor → match`-shaped pipeline as the e2e.

The receipt it emits — same pipeline as the e2e's, one rung up, and the
provenance stamp says so:

<img src="docs/verified-receipt.png" width="480" alt="verified-receipt.html: 'x402 settlement — independently verified. Paid in full', the true transaction id 11.12.2@1774994518.000002058, 'Verified against the ledger's own block proof — cryptography, not the facilitator's word', a beta caveat naming the previewnet fixture as the source, and the hiero-receipts body stamped VERIFIED: 'Cryptographically verified against the previewnet ledger (block 467)'" />

The honest caveat, stated plainly: HIP-1056 block streams are not on testnet
yet, so this cannot verify our x402 settlement today — the fixtures are from
the block-stream preview network. The day block streams reach testnet, the
e2e's receipt flips from UNVERIFIED to VERIFIED by swapping the source;
hiero-receipts was built around that seam.

## What it deliberately doesn't do

Hold payment keys outside the two demo processes that must (the server's
optional content-signing identity attests to bytes and can move nothing) ·
touch mainnet (the gate in [`src/config.ts`](src/config.ts) refuses it, in
code, everywhere) · trust a facilitator's word · claim content commitments
make data true (they bind bytes to a payment; truth would need the upstream
source's own signature) · guess (unknown outcomes are reported as exactly
what the chain shows: underpaid with the shortfall, wrong asset, not found).

## Develop

```sh
npm run verify   # typecheck + lint + format + tests + coverage (floors at 100)
```

All tests run offline — canned mirror fixtures, injectable fetch; the only
networked run is the demo itself. The bridge is property-tested against the
official wire vectors shipped inside payment-requests.

Research behind every decision: [research/](research/) · system map:
[ARCHITECTURE.md](ARCHITECTURE.md).

## License

Apache-2.0
