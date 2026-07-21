// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror access = the shared thin-fetch module + this repo's network gate.
 *
 * The fetch half (snake→camel mapping, memo decode, REST id spelling,
 * transaction-by-id) started life here and in hiero-checkout as duplicate
 * ~140-line modules; it was upstreamed to
 * `@hiero-hackers/hiero-receipts/mirror-fetch` in receipts v0.2.0 — the
 * second feature this integration fed back (the first: payment-requests'
 * `byTransactionId`). What remains HERE is policy, not plumbing: the pinned
 * network → host table, and the gate that refuses everything else.
 */
import type { TransactionInfoLike } from "@hiero-hackers/hiero-receipts/mirror";
import {
  transactionsById as fetchTransactionsById,
  restTransactionId,
  toTransactionInfo,
} from "@hiero-hackers/hiero-receipts/mirror-fetch";
import { MIRROR_HOSTS, assertSupportedNetwork } from "./config.js";
import { MirrorError, rethrowAs } from "./errors.js";

export { restTransactionId, toTransactionInfo };

/** The camelCase shape hiero-receipts' `fromMirror` accepts (structural). */
export type MirrorTx = TransactionInfoLike;

/**
 * Every mirror row for one transaction id, on a GATED network — the testnet
 * pin applies before any request is made. `[]` on 404: not-yet-ingested is a
 * verdict input, not an error.
 */
export async function transactionsById(
  network: string,
  transactionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MirrorTx[]> {
  const host = MIRROR_HOSTS[assertSupportedNetwork(network)];
  // Normalize OUTSIDE the wrap: a malformed id is the caller's input problem,
  // not a mirror transport failure, and must not be dressed as one.
  const rest = restTransactionId(transactionId);
  try {
    return await fetchTransactionsById(host, rest, { fetchImpl });
  } catch (error) {
    rethrowAs(error, MirrorError);
  }
}
