# Releasing & operating this repo

The runbook for maintainers — everything that is not derivable from the code.

## One-time machine setup

GitHub Packages needs a `read:packages` token even for public packages:

```sh
gh auth refresh -s read:packages
npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"
```

(Re-run the second line if you ever re-login with `gh`.)

## One-time repo settings

1. **Package access** for the packages CI installs
   (`hiero-payment-requests`, `hiero-receipts`, `streams-node`): each
   package's settings → _Manage Actions access_ → add this repo, Read.
   CI 401s on `npm ci` until then.
2. **Branch protection** on `main` requiring the CI checks and DCO.
3. Trigger the Scorecard workflow once so the badge populates.

## Cutting a release

Only `src/` ships — the library (`verifySettlement`,
`verifySettlementFromBlock`, the bridge, receipts, attestations). The demo,
tests, and research are repo-only (the `files` whitelist in package.json).

```sh
# 1. bump "version" in package.json, land on main through a PR
# 2. tag the merge commit:
git switch main && git pull
git tag -s v0.1.0 -m "hiero-x402 0.1.0"
git push origin v0.1.0
```

The tag push runs the gates (typecheck, lint, format, tests), checks the tag
equals `package.json`'s version, publishes to GitHub Packages, and cuts a
GitHub Release with auto-generated notes. Re-runs are idempotent — each half
skips or fails cleanly if already done.

Pre-1.0 semver: minor versions may break. Downstream consumers
(`hiero-agent-treasury` once it imports from the registry) should pin
`^0.x` accordingly. Cross-repo order when everything moves:
`hiero-streams-rs` → `hiero-receipts` / `hiero-payment-requests` → this repo.

## Dependency policy

- **`@x402/*` is pinned EXACTLY at 2.19.0 on purpose** — the five packages
  move in lockstep and `@x402/paywall` is a silent peer dependency of
  `@x402/hono` (npm skips peers without erroring). Bump all five together,
  then rerun the conformance suite AND a live e2e before landing.
- The org intends an eventual **npmjs migration** (no token wall, OIDC
  provenance). When it happens: drop `publishConfig.registry`, claim the
  scope, keep GitHub Packages during a transition.

## Maintenance notes

- **Coverage floors ratchet** (`vitest.config.ts`): raise them when coverage
  rises; never lower silently.
- **README claims are machine-enforced** (`test/readme-claims.test.ts`):
  scripts, badges, proof transaction ids, and env knobs mentioned in the
  README must exist in the code — edit either side and the suite tells you
  about the other.
- **Receipt wording/layout changes** → regenerate the README screenshots
  from real runs: `npm run demo`, `npm run e2e`, `npm run provenance`, then
  `npm run screenshots` (headless Chrome; writes `docs/*.png`).
- **Live runs are never in CI** — `npm run e2e` needs funded testnet keys in
  `.env`. CI proves everything else offline (fixtures, wire-shape pins,
  block-proof verification on committed blocks).
- **Bumping `engines`**: also grep `.github/workflows` for hardcoded
  `node-version:` — Dependabot bumps actions, not these numbers.
