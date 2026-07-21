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
accounts — see [.env.example](.env.example) and the README.

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
- **Amounts are strings/bigints in atomic units.** No floats, ever.
- **Keys stay in the two demo files that must hold them.** `src/` is
  key-free and env-free by construction.

## Sign your commits (DCO)

```sh
git commit -s
```

## Tests

`npm run verify` runs everything offline — canned mirror fixtures, injected
fetch, committed proven blocks. Coverage floors are at 100 on all axes:
lower one only deliberately, with the reason in the diff.
