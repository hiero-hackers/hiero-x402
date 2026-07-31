# Contributing to hiero-x402

Thanks for considering it! This project follows the practices of the wider
Hiero / LF Decentralized Trust ecosystem, including our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Development setup

```sh
npm install           # needs a read:packages token for the @hiero-hackers scope
npm run verify        # THE gate suite: typecheck, lint, format, tests + coverage
npm run provenance    # the block-proof demo — offline, runs anywhere
```

The live demo (`npm run facilitator` / `server` / `e2e`) needs testnet
accounts — see [.env.example](.env.example) and the README. The rails are
deliberately separate processes — the facilitator holds the fee-payer key,
the resource server holds no payment keys, the agent holds its own;
`npm run demo` boots the first two in one terminal.

## Ground rules

- **Testnet only, in code.** The gate in `src/config.ts` is the safety
  property. Widening it is an architecture change to argue in SECURITY.md,
  not a config tweak.
- **Never trust a reported outcome you can check.** The whole repo exists
  because settlement claims are checkable — a change that believes a
  facilitator (or any intermediary) where the chain could be asked instead
  is moving in the wrong direction.
- **Proof before data.** The stream path refuses to read a block whose proof
  fails. Keep failure closed.
- **Amounts are strings/bigints in atomic units.** No floats, ever. The
  wire stays atomic; only surfaces (narration, hub inputs) convert.
- **Keys stay in the two demo files that must hold them.** `src/` is
  key-free and env-free by construction (the server's optional content
  signer can attest to bytes, never spend).
- **One canonical transaction-id spelling** — the REST form
  (`0.0.x-seconds-nanos`), normalized at the wire boundary
  (`readPaymentResponseHeader`). The SDK form appears only at SDK call
  sites.
- **One owner per convention** — the signed reference
  (`commitmentReference`), the digest spelling (`isSha256Hex`), the
  settlement header, the signature core (`verifySignatureWithKey`).
  Extend the owner; never fork a copy — every one of these once existed
  as two drifting copies.
- **Machine facts ride typed channels.** The hub's behavior comes from
  SSE events parsed once server-side; narration lines are display only.
  Never regex prose for an outcome.
- **Wording registers are part of the API.** "Verified" is reserved for
  cryptography; mirror data is an attested record; a missing commitment
  is `AGENT RECORD`, not a failure. Receipts, hub copy, and narration
  must not contradict each other.
- **Mind the hub template.** `demo/hub.ts` is one TS template literal — a
  backtick inside any comment terminates it. (Yes, this bit us. Twice.)

## Sign your commits (DCO)

```sh
git commit -s
```

## Tests

`npm run verify` runs everything offline — canned mirror fixtures, injected
fetch, committed proven blocks. Coverage floors are at 100 on all axes:
lower one only deliberately, with the reason in the diff.
