// SPDX-License-Identifier: Apache-2.0
/**
 * The attestation message schema — the `x402-settlement-verdict` wire format
 * written to HCS topics by the demo agent (demo/attest.ts) and consumed by
 * anything auditing such a topic later (a treasury enforcing budgets from
 * the on-chain spend log, a reporting CLI, another party's verifier).
 *
 * The SCHEMA lives here in the library — pure, versioned, testable — and
 * the SDK I/O (topic create/submit) stays in the demo: publishing the shape
 * without shipping a Hedera client is what lets a reader depend on it
 * cheaply. Version bumps are additive (`v` guards readers), and amounts are
 * strings because they are bigints in atomic units.
 */
import type { SettlementVerdict } from "./verify.js";

/** The current message version — bump when the shape changes. */
export const ATTESTATION_VERSION = 1;

/** One attested verdict, as it sits (JSON-encoded) in a topic message. */
export interface Attestation {
  readonly v: typeof ATTESTATION_VERSION;
  readonly kind: "x402-settlement-verdict";
  readonly status: string;
  /** REST-normalized settlement id, `0.0.x-seconds-nanos`. */
  readonly transactionId: string;
  readonly reference: string;
  /** CAIP-10 recipient. */
  readonly recipient: string;
  /** Atomic units, stringified bigint. */
  readonly amount: string;
  /** CAIP-19 asset. */
  readonly asset: string;
  /** HashScan proof link — present when the network has an explorer. */
  readonly proof?: string;
}

/** A verdict as the attestation message string a topic submit takes. */
export function attestationMessage(verdict: SettlementVerdict): string {
  const attestation: Attestation = {
    v: ATTESTATION_VERSION,
    kind: "x402-settlement-verdict",
    status: verdict.fulfilment.status,
    transactionId: verdict.transactionId,
    reference: verdict.request.reference,
    recipient: verdict.request.recipient,
    amount: verdict.request.amount.toString(),
    asset: verdict.request.asset,
    ...(verdict.hashscanUrl !== undefined ? { proof: verdict.hashscanUrl } : {}),
  };
  return JSON.stringify(attestation);
}

/**
 * Parse a topic message back into an attestation, or undefined for anything
 * that isn't one (topics are public — foreign messages are data, not errors).
 */
export function parseAttestation(message: string): Attestation | undefined {
  try {
    const parsed = JSON.parse(message) as Partial<Attestation>;
    if (
      parsed.v === ATTESTATION_VERSION &&
      parsed.kind === "x402-settlement-verdict" &&
      typeof parsed.status === "string" &&
      typeof parsed.transactionId === "string" &&
      typeof parsed.amount === "string" &&
      /^\d+$/.test(parsed.amount)
    ) {
      return parsed as Attestation;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
