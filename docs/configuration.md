# Configuration — every knob, and what it changes

All variables live in [.env.example](../.env.example) with inline
documentation; this page is the longer story of what each one buys you.
The hub at `http://localhost:4021/ui` sets the per-run knobs (resource,
spend cap, approval mode) without touching the env.

## `CONTENT_SIGNER_ACCOUNT_ID` / `CONTENT_SIGNER_KEY` — content commitments

The server signs sha-256(served bytes) against each settlement
transaction, so it can never later deny WHAT it served for a payment. The
agent verifies the signature against the signer's on-chain key from the
mirror — never the header's own claims — and the receipt's **Delivered
content** panel says which register the run earned:

- `SERVER COMMITTED` — the signature holds over the exact received bytes;
- `COMMITMENT BROKEN` — loud: a false commitment is evidence;
- `AGENT RECORD` — no commitment offered; not a failure.

This is a signing-only identity, not a treasury: use a dedicated account
that holds nothing. A commitment binds bytes to a payment — it does not
make the data true, and the receipt says so in as many words.

## `ATTEST_TOPIC_ID` — the public audit log

After verifying, the agent writes the verdict to a **Hedera Consensus
Service topic**: an append-only public audit log of every payment it made
and checked. `create` makes a fresh topic once (the run prints the id —
pin it to keep one continuous log). The attestation carries the content
hash and the server's commitment signature, and `npm run audit`
re-verifies every commitment straight from the mirror — rebuild the
signed message from the attestation's own fields, check it against the
signer's on-chain key, trust nobody's flag. The hub's Audit trail card
runs the same re-verification live, scoped to the current session.

## `MAX_AGENT_PAYMENT` / `MAX_AGENT_PAYMENT_ASSET` — the spend policy

A hard cap in atomic units of ONE asset (5 ℏ = 500000000 tinybar; 1 USDC
= 1000000 base units). A 402 in the cap's asset quoting more is REFUSED
before the approval gate — nothing signed, nothing spent (exit 4). Quotes
in a different asset are never compared against it: units first. The
hub's "max spend" input takes plain ℏ/USDC (the label follows the chosen
resource) and converts exactly, no floats.

## `RESOURCE` — what the agent buys

`/data/spot-price` (0.05 ℏ — the live network exchange rate),
`/data/ohlc` (0.10 ℏ), or `/data/fx` (0.01 **testnet USDC**, the official
token id from `@x402/hedera`). The USDC route needs an agent holding
testnet USDC ([Circle's faucet](https://faucet.circle.com)) and a `payTo`
that can receive the token; the facilitator's preflight refuses cleanly
otherwise — and the agent explains the fix in plain words.

## `VERIFY_BEFORE_SERVE` — the merchant's own check

`1` = the server itself withholds data until the settlement verifies on
the public mirror, closing the verify-pass/settle-fail window the
reference implementations accept. Off by default, deliberately: it costs
honest seconds of mirror lag per paid request, the merchant's exposure is
bounded at one response, and the agent verifies regardless — flip it on
when one response is worth more than seconds (reasoning in
[SECURITY.md](../SECURITY.md)).

## `HUMAN_APPROVAL`, `APPROVER_ACCOUNT_ID`, `WALLETCONNECT_PROJECT_ID`

The human-in-the-loop gates: stdin y/N in a terminal, the hub's Approve
button, or wallet-signed consent over a one-time nonce-bound challenge —
verified against the approver's on-chain key, single-use, and carried
onto the receipt and the attestation. See the run-modes section of the
[README](../README.md).

## Ports and hosts

`FACILITATOR_PORT` (4020), `SERVER_PORT` (4021), `FACILITATOR_URL`,
`SERVER_URL`, `CHECKOUT_BASE`, and `X402_NETWORK` — env-overridable in
name only: the testnet gate still applies, in code, everywhere.
