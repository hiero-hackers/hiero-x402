// SPDX-License-Identifier: Apache-2.0
/**
 * The demo's shared vocabulary: env access that fails loudly, the catalog of
 * priced resources (defined in OUR request language, then bridged to x402),
 * and the one place ports/URLs default.
 *
 * Keys are read ONLY in facilitator.ts and agent.ts — never here, never in
 * the server, never in src/.
 */
import type { PaymentRequest } from "@hiero-hackers/hiero-payment-requests";
import { HEDERA_TESTNET_USDC, PrivateKey } from "@x402/hedera";
import { MIRROR_HOSTS, SUPPORTED_NETWORKS, assertSupportedNetwork } from "../src/index.js";

export function requireEnv(name: string): string {
  // `name` is always a literal at the call sites in this repo, never input.
  // eslint-disable-next-line security/detect-object-injection
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`[demo] missing required env var: ${name} (see .env.example)`);
    process.exit(1);
  }
  return value;
}

/**
 * A private key however the Portal handed it to you — resolved against the
 * CHAIN, not guessed. A key string can parse as more than one curve (raw hex
 * is ambiguous; even DER inputs have bitten us), and a wrong guess surfaces
 * later as a baffling INVALID_SIGNATURE at precheck. So: parse every way
 * that succeeds, derive each candidate's public key, and pick the one that
 * matches the account's on-chain key from the public mirror. Deterministic,
 * and fails loudly with the real reason ("that key does not belong to that
 * account") instead of a curve lottery.
 */
export async function resolvePrivateKey(
  accountId: string,
  text: string,
): Promise<InstanceType<typeof PrivateKey>> {
  const candidates: InstanceType<typeof PrivateKey>[] = [];
  for (const parse of [
    PrivateKey.fromStringDer,
    PrivateKey.fromStringECDSA,
    PrivateKey.fromStringED25519,
  ]) {
    try {
      const key = parse.call(PrivateKey, text.trim());
      if (!candidates.some((c) => c.publicKey.toStringRaw() === key.publicKey.toStringRaw())) {
        candidates.push(key);
      }
    } catch {
      /* not this encoding */
    }
  }
  if (candidates.length === 0) {
    console.error("[demo] could not parse the private key — copy the DER form from the Portal");
    process.exit(1);
  }

  const host = MIRROR_HOSTS[demoNetwork()];
  try {
    const response = await fetch(`${host}/api/v1/accounts/${encodeURIComponent(accountId)}`);
    if (!response.ok) throw new Error(`mirror answered ${response.status}`);
    const body = (await response.json()) as { key?: { key?: string } };
    const onChain = body.key?.key?.toLowerCase();
    if (onChain === undefined) throw new Error("account has no single key on the mirror");
    const match = candidates.find((c) => c.publicKey.toStringRaw().toLowerCase() === onChain);
    if (match === undefined) {
      console.error(
        `[demo] the private key does not belong to ${accountId} — its on-chain key is ` +
          `different. Check the account id / key pairing in .env.`,
      );
      process.exit(1);
    }
    return match;
  } catch (error) {
    // Mirror unreachable: proceed with the first parse, but say so.
    console.warn(
      `[demo] could not confirm the key against ${accountId} on the mirror ` +
        `(${error instanceof Error ? error.message : String(error)}) — proceeding unverified`,
    );
    return candidates[0]!;
  }
}

/** The demo network — env-overridable in name only: the gate still applies,
 *  so anything outside ${SUPPORTED_NETWORKS} refuses to start. */
export function demoNetwork(): "hedera:testnet" {
  return assertSupportedNetwork(process.env.X402_NETWORK ?? SUPPORTED_NETWORKS[0]);
}

export const FACILITATOR_PORT = Number(process.env.FACILITATOR_PORT ?? 4020);
export const SERVER_PORT = Number(process.env.SERVER_PORT ?? 4021);

/** One priced resource: the route, what it costs, in which asset. */
export interface Product {
  readonly path: string;
  readonly label: string;
  /** Atomic units — tinybar for HBAR, the token's smallest unit otherwise. */
  readonly amount: bigint;
  readonly asset: { kind: "hbar" } | { kind: "token"; id: string; symbol: string };
}

/** The catalog. HBAR routes are the demo's main path (faucet money, no
 *  association needed). The USDC route uses the OFFICIAL testnet USDC id
 *  from @x402/hedera — paying it needs an agent that HOLDS testnet USDC and
 *  a payTo associated with it (see .env.example); the facilitator's
 *  preflight refuses cleanly otherwise. */
export const CATALOG: readonly Product[] = [
  {
    path: "/data/spot-price",
    label: "Spot price (mock)",
    amount: 5_000_000n, // 0.05 ℏ
    asset: { kind: "hbar" },
  },
  {
    path: "/data/ohlc",
    label: "OHLC candle (mock)",
    amount: 10_000_000n, // 0.10 ℏ
    asset: { kind: "hbar" },
  },
  {
    path: "/data/fx",
    label: "FX rate (mock) — priced in USDC",
    amount: 10_000n, // 0.01 USDC at 6 decimals
    asset: { kind: "token", id: HEDERA_TESTNET_USDC, symbol: "USDC" },
  },
];

/** A product as a `PaymentRequest` — the SAME object can become an x402
 *  payment option (bridge) or a human-scannable checkout link (`toLink`).
 *  `network` is explicit so the env-free app factory can pass its own. */
export function productRequest(
  product: Product,
  payTo: string,
  network: string = demoNetwork(),
): PaymentRequest {
  return {
    recipient: `${network}:${payTo}`,
    asset:
      product.asset.kind === "hbar"
        ? `${network}/slip44:3030`
        : `${network}/token:${product.asset.id}`,
    amount: product.amount,
    reference: product.path,
  };
}
