# 03 · Implementation notes — what hiero-x402 should actually be

Builds on [[01-x402-spec]] and [[02-hedera-mapping]]. Written 2026-07-21;
bounty deadline July 31.

## The honest landscape assessment

"Make x402 work on Hedera" is **already done, officially**: the scheme is in
the coinbase/x402 spec, `@x402/hedera` 2.19.0 is on npm with client + server +
facilitator, there's a hosted testnet facilitator (blocky402), a community
example server, and the judges' own scaffold template. A submission that
re-implements the plumbing is a worse copy of code the judges wrote.

So we **build on the official packages instead of competing with them**, and
put our effort where the ecosystem has a real, documented gap.

## The gap we fill: settlement you can verify yourself

The example server's own README concedes the v1 weakness:

- `settle` runs after the handler → a verify-pass / settle-fail delivers data
  without the payment landing, and conversely a client has only the
  facilitator's word (`payment-response` header) that it paid what it paid.
- Every existing flow **trusts the facilitator's report**. Nothing checks the
  chain.

That check is literally our shipped stack:

```
payment-response header → transactionId (0.0.x@s.n)
  → mirror-node lookup (public REST, no keys)
  → hiero-receipts fromMirror  (normalize: net credits, custom fees)
  → hiero-payment-requests match (same rule merchant + payer already share)
  → verdict: paid / underpaid / wrong-asset — with on-chain proof links
```

**Positioning: "x402 for Hiero, with receipts."** The agent (or the resource
server, or an auditor) gets an independent, facilitator-free proof that the
exact amount landed at `payTo` — plus a downloadable hiero-receipts receipt as
the audit artifact. Nobody in the x402-hedera ecosystem does post-settlement
verification; we own that.

Second string: a **bridge from `hiero-pay:` to x402** — the same
`PaymentRequest` object emits a 402 challenge for agents _and_ a QR/link for
humans (hiero-checkout). Both formats already share CAIP network ids and
atomic string amounts, so this is a small mapping, and it ties the whole
hiero-hackers stack into the submission.

## Repo shape

```
hiero-x402/
  src/
    requirements.ts   PaymentRequest ⇄ x402 PaymentRequirements bridge
    verify.ts         the differentiator: settlement → mirror → receipts → match
    receipt.ts        settlement + verdict → hiero-receipts artifact
    index.ts          barrel
  demo/
    server.ts         Hono resource server (official middleware) selling 1-2 routes
    facilitator.ts    self-hosted facilitator (official engine) — no blocky402
                      dependency live in the demo; keys stay in this process
    agent.ts          the paying client: 402 → sign → 200 → INDEPENDENT verify
                      → receipt. The only file that touches a client key.
  research/           these documents
```

- Deps: `@x402/core`, `@x402/hedera`, `@x402/hono`, `@x402/fetch`, `hono`,
  `@hiero-hackers/hiero-payment-requests`, `@hiero-hackers/hiero-receipts`.
- The reusable part (`src/`) is publishable later as
  `@hiero-hackers/hiero-x402`; the demo consumes it like any user would.
- Mirror access: reuse hiero-checkout's thin-fetch pattern (`mirror.ts` there
  is ~140 lines; we need transaction-by-id + one list endpoint). No heavy
  client dependency.

## Hard constraints (house rules)

- **Testnet only**, enforced in code the way hiero-checkout's
  `src/config.ts` gates WalletConnect — the demo refuses `hedera:mainnet`.
- Asset: **HBAR, `"0.0.0"`, tinybars** (per [[02-hedera-mapping]] — the
  judge-familiar path). Amounts as strings/bigints, never floats.
- Keys live only in `.env`, read only by `demo/facilitator.ts` (fee payer) and
  `demo/agent.ts` (client). Two separate faucet accounts. The resource server
  holds nothing.
- Facilitator: self-hosted via the official `@x402/hedera/exact/facilitator`
  with `aliasPolicy: "reject"` — a live demo must not depend on a third
  party's uptime.
- Gating commands run bare (no pipe-masking); vitest for tests; the usual
  verify kit (typecheck, lint, format, coverage) ported from the sibling repos.

## What to test without a network

- `requirements.ts` bridge: property-test round-trips against the
  payment-requests vectors we already publish.
- `verify.ts`: feed canned mirror JSON (fixtures lifted from real testnet
  responses) — exact-pay, underpay, wrong-token, wrong-recipient,
  fee-payer-received-change cases.
- The MUST-rules of [[02-hedera-mapping]] as a table-driven suite over
  synthetic `TransferTransaction` bytes — proves we understand the security
  model even where we delegate enforcement to the official package.
- Live e2e (`npm run e2e`) is the demo itself, kept out of CI.

## Demo script (< 5 min, user records — updated for the final build)

1. **(~30s) The pitch over the README**: every x402 flow ends with the
   facilitator's word; this repo is the agent that checks the chain itself.
2. **(~30s) Start the rails**: `npm run demo` (one terminal; `.env` never
   on screen) — it boots the facilitator, waits, then the server. Point at
   the log lines: the facilitator holds the fee-payer key, the server says
   "no keys in this process" — separate processes, one command. Then open
   **http://localhost:4021/ui** — the demo hub, the browser tab the whole
   video lives in: catalog with human checkout links, receipts, audit
   topic, one column.
3. **(~60s) The star beat**: click **▶ Run the agent** on the hub — the
   rail chips light up as the agent's numbered steps stream in live. Pause
   on _"Paid in full — the chain confirms the exact amount landed"_ and
   click the HashScan proof link right there in the log. (Start the demo
   with `ATTEST_TOPIC_ID` set so the HCS chip lights too; `npm run e2e`
   is the identical run for judges who prefer a terminal.)
4. **(~30s) Back to the hub**, refresh, click _"latest settlement —
   verified against the mirror"_ — verdict banner, proof link, and the
   honest UNVERIFIED provenance stamp; one sentence: "the receipt says what
   its data is". Then click the hub's **Audit trail** topic link — the
   verdict, attested on an append-only public HCS topic.
5. **(~40s) The catch story**: scroll the README's Proof section — the
   underpaid-by-the-fee run the verifier caught on day one, with its own
   HashScan link. "Everyone trusting the facilitator would have called this
   paid."
6. **(~30s) Bonus beat**: paste the base64 `payment-required` header into
   the LIVE site — https://hiero-hackers.github.io/hiero-checkout/ — and the
   agent's own challenge becomes a human-payable card, watching the chain
   live. (Say the URL out loud: it's a deployed consumer of the same stack.)
7. **(~40s) Closer — the trust ladder**: `npm run provenance`, then click
   the hub's _"block-proof settlement — cryptographically verified"_ link —
   _"Paid in full … receipt provenance: verified"_ against a
   cryptographically proven block, exact transaction-id correlation.
   (Honest phrasing: the block fixtures are preview-network blocks — the
   proof math is real; testnet block streams are what's pending.)
   "When block streams reach testnet, the e2e gains this stamp by swapping
   the source. Three features were upstreamed to published libraries during
   this build."

Total ≈ 4½ minutes. Every beat is a command a judge can re-run.

## Risks / open items

- **npm supply-chain déjà vu**: `@x402/hedera` pulls the Hedera SDK stack —
  expect the same `npm audit` noise as hiero-checkout; document posture in
  SECURITY.md, don't chase it.
- **v2 header names** (`payment-signature` vs `X-PAYMENT`): accept both
  inbound like the scaffold does; emit v2.
- **Package API drift**: 2.16.0 → 2.19.0 already happened between the two
  reference repos. **Verified 2026-07-21**: the `./exact/client|server|facilitator`
  subpath exports the scaffold uses still exist at 2.19.0. New at 2.19.0:
  `@x402/hono` peer-depends on `@x402/paywall` — install it explicitly (npm
  has silently skipped x402-adjacent peer deps on us twice this project).
- **Bounty framing**: the submission story is "the missing verification +
  receipts layer for x402 on Hiero", not "x402 port" — make the README say so
  in the first paragraph.
