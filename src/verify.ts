// SPDX-License-Identifier: Apache-2.0
/**
 * The differentiator: **don't take the facilitator's word for it.**
 *
 * Every x402 flow ends with a `SettleResponse` — a claim, made by the party
 * that moved the money, that the money moved. Both reference implementations
 * stop there. This module walks the remaining distance: look the settlement
 * up on the network's public mirror, normalize what actually landed
 * (hiero-receipts — net credits, custom fees deducted), and judge it against
 * the original terms with the SAME `match` rule hiero-checkout's merchant and
 * payer already share. Three parties, one definition of "paid", none of them
 * trusting another's word.
 *
 * Correlation is the one place x402 differs from a memo-carrying checkout
 * payment: x402 transactions have no memo, but the protocol hands us
 * something stronger — the exact settlement transaction id. That insight
 * started life here as a local strategy through `match`'s documented seam
 * (`MatchOptions.correlate`) and was upstreamed as `byTransactionId` in
 * payment-requests v0.1.2 — this integration fed the library a feature.
 */
import {
  byTransactionId,
  fromReceipt,
  match,
  paymentInstructions,
} from "@hiero-hackers/hiero-payment-requests";
import type { Fulfilment, Payment, PaymentRequest } from "@hiero-hackers/hiero-payment-requests";
import { receiptFor } from "@hiero-hackers/hiero-receipts";
import type { Receipt } from "@hiero-hackers/hiero-receipts";
import { fromMirror } from "@hiero-hackers/hiero-receipts/mirror";
import type { PaymentRequirements } from "@x402/core/types";
import { HASHSCAN_HOSTS, MIRROR_HOSTS, assertSupportedNetwork } from "./config.js";
import { restTransactionId, transactionsById } from "./mirror.js";
import { fromPaymentRequirements } from "./requirements.js";

/** What the verifier hands back: the verdict, and the evidence behind it. */
export interface SettlementVerdict {
  /** The library's honest classification: paid / underpaid / overpaid / unpaid… */
  readonly fulfilment: Fulfilment;
  /** The request the requirements were judged as — what `match` saw. */
  readonly request: PaymentRequest;
  /** Receipts for the payments that contributed — the audit artifacts. */
  readonly receipts: readonly Receipt[];
  /** The settlement id, REST-normalized. */
  readonly transactionId: string;
  /** Human-checkable proof link. Present once the mirror knows the transaction. */
  readonly hashscanUrl?: string;
  /** The raw mirror-node REST record this verdict was read from — the
   *  operator's own output, linkable so a reader can re-derive the verdict
   *  themselves. Present on the mirror path once the mirror knows the
   *  transaction; absent on the block-proof path (no mirror is consulted). */
  readonly mirrorUrl?: string;
}

export interface VerifyOptions {
  /** Injectable for offline tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** How many mirror lookups to attempt while the transaction is not yet
   *  ingested (mirrors lag consensus by a few seconds). Default 1 — the
   *  caller decides how long "not found yet" is worth waiting on. */
  readonly attempts?: number;
  /** Milliseconds between attempts. Default 3000. */
  readonly delayMs?: number;
}

/**
 * Judge a settlement claim against the requirements it supposedly paid.
 *
 * `reference` is the caller's correlator for receipts and follow-ups (the
 * resource URL is a fine default) — see `fromPaymentRequirements`.
 *
 * Network note: the testnet gate applies — this refuses to verify (or even
 * contact a mirror for) anything but the pinned networks.
 */
export async function verifySettlement(
  requirements: PaymentRequirements,
  transactionId: string,
  reference: string,
  options: VerifyOptions = {},
): Promise<SettlementVerdict> {
  const network = assertSupportedNetwork(requirements.network);
  const request = fromPaymentRequirements(requirements, reference);
  const { network: bareNetwork, recipient } = paymentInstructions(request);

  const attempts = Math.max(1, options.attempts ?? 1);
  const delayMs = options.delayMs ?? 3000;
  let rows = await transactionsById(network, transactionId, options.fetchImpl);
  for (let attempt = 1; rows.length === 0 && attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    rows = await transactionsById(network, transactionId, options.fetchImpl);
  }
  const entries = rows.map((row) => {
    const receipt = receiptFor(recipient, fromMirror(row, { network: bareNetwork }));
    return { receipt, payment: fromReceipt(receipt, bareNetwork) };
  });

  // `network` is the gate's narrowed literal union, not attacker-chosen.
  // eslint-disable-next-line security/detect-object-injection
  return toVerdict(request, entries, transactionId, HASHSCAN_HOSTS[network], MIRROR_HOSTS[network]);
}

/** One receipt + its payment view — what both sources produce per row. */
export interface VerdictEntry {
  readonly receipt: Receipt;
  readonly payment: Payment;
}

/**
 * The verdict assembly both sources share: judge the entries against the
 * request (correlating by the given transaction id), keep the contributing
 * receipts as evidence, link the proof when the network has an explorer.
 * Exported for `stream.ts`; not part of the public barrel.
 */
export function toVerdict(
  request: PaymentRequest,
  entries: readonly VerdictEntry[],
  transactionId: string,
  hashscanBase: string | undefined,
  mirrorHost?: string,
): SettlementVerdict {
  const fulfilment = match(
    request,
    entries.map((entry) => entry.payment),
    { correlate: byTransactionId(transactionId) },
  );

  const contributing = new Set(
    "payments" in fulfilment
      ? fulfilment.payments.map((payment: Payment) => payment.transactionId)
      : [],
  );
  const receipts = entries
    .filter((entry) => contributing.has(entry.payment.transactionId))
    .map((entry) => entry.receipt);

  const consensusTimestamp = entries[0]?.payment.consensusTimestamp;
  const rest = restTransactionId(transactionId);
  return {
    fulfilment,
    request,
    receipts,
    transactionId: rest,
    ...(consensusTimestamp !== undefined && hashscanBase !== undefined
      ? { hashscanUrl: `${hashscanBase}/transaction/${consensusTimestamp}` }
      : {}),
    ...(consensusTimestamp !== undefined && mirrorHost !== undefined
      ? { mirrorUrl: `${mirrorHost}/api/v1/transactions/${rest}` }
      : {}),
  };
}
