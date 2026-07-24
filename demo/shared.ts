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

  const network = demoNetwork();
  const host = MIRROR_HOSTS[network];
  try {
    const response = await fetch(`${host}/api/v1/accounts/${encodeURIComponent(accountId)}`);
    if (!response.ok) throw new Error(`mirror answered ${response.status}`);
    const body = (await response.json()) as { key?: { key?: string } };
    const onChain = body.key?.key?.toLowerCase();
    if (onChain === undefined)
      throw new Error(`${accountId} has no single ECDSA/ED25519 key on the mirror`);
    const match = candidates.find((c) => c.publicKey.toStringRaw().toLowerCase() === onChain);
    if (match === undefined) {
      console.error(
        `[demo] the private key does not belong to ${accountId} — its on-chain key is ` +
          `different. Check the account id / key pairing in .env.`,
      );
      process.exit(1);
    }
    console.log(`[demo] key ✓ confirmed against ${accountId} on the ${network} mirror`);
    return match;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Couldn't confirm the curve against the chain. If the key parsed only ONE
    // way, that lone reading is safe. If it parsed as MORE THAN ONE curve,
    // guessing is exactly what surfaces later as a baffling INVALID_SIGNATURE
    // at precheck — so refuse, and say how to fix it (the maintainer hit this
    // adding fresh keys; a first-time user must see the cause, not the symptom).
    if (candidates.length > 1) {
      console.error(
        `[demo] could not confirm which key ${accountId} uses (${reason}), and the key is ` +
          `curve-ambiguous — it parses as more than one curve. Guessing risks a silent ` +
          `INVALID_SIGNATURE at settle. Paste the DER-encoded key from the Portal (unambiguous), ` +
          `or retry when the mirror is reachable.`,
      );
      process.exit(1);
    }
    console.warn(
      `[demo] could not confirm the key against ${accountId} (${reason}) — it parsed one way ` +
        `only, so proceeding with it.`,
    );
    return candidates[0]!;
  }
}

/** The account's single on-chain public key (raw hex) from the mirror, or undefined. */
export async function fetchAccountPublicKey(accountId: string): Promise<string | undefined> {
  const host = MIRROR_HOSTS[demoNetwork()];
  try {
    const response = await fetch(`${host}/api/v1/accounts/${encodeURIComponent(accountId)}`);
    if (!response.ok) return undefined;
    const body = (await response.json()) as { key?: { key?: string } };
    return body.key?.key;
  } catch {
    return undefined;
  }
}

/**
 * Refuse a payTo the x402 flow can never settle to. The classic trap is
 * `receiver_sig_required`: crediting such an account needs the RECEIVER's
 * signature, which neither the agent (debit) nor the facilitator (fees)
 * can supply — it surfaces on-chain as a baffling INVALID_SIGNATURE at
 * settle. Catch it at boot, with the cause and the fix, not the symptom.
 * Mirror unreachable → warn and proceed (same posture as the key check).
 */
export async function confirmPayToAccount(accountId: string): Promise<void> {
  const host = MIRROR_HOSTS[demoNetwork()];
  let body: { deleted?: boolean; receiver_sig_required?: boolean };
  try {
    const response = await fetch(`${host}/api/v1/accounts/${encodeURIComponent(accountId)}`);
    if (!response.ok) throw new Error(`mirror answered ${response.status}`);
    body = (await response.json()) as typeof body;
  } catch (error) {
    // Messages name the env var, never its value (CodeQL: clear-text logging).
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[demo] could not confirm PAY_TO_ACCOUNT against the mirror (${reason}) — proceeding.`,
    );
    return;
  }
  if (body.deleted === true) {
    console.error("[demo] PAY_TO_ACCOUNT points at a deleted account — set it to a live one.");
    process.exit(1);
  }
  if (body.receiver_sig_required === true) {
    console.error(
      "[demo] PAY_TO_ACCOUNT has receiver_sig_required — every credit to it needs ITS " +
        "signature, which the x402 flow cannot supply, so settlement would die on-chain with " +
        "INVALID_SIGNATURE. Either clear the flag (Portal → account → receiver signature " +
        "required off, signed by that account's key) or point PAY_TO_ACCOUNT at an account " +
        "without it.",
    );
    process.exit(1);
  }
  console.log("[demo] payTo ✓ PAY_TO_ACCOUNT can receive x402 settlements (no receiver-sig flag)");
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
