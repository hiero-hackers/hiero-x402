// SPDX-License-Identifier: Apache-2.0
/**
 * The trust ladder's top rung as an API: judge a settlement against a
 * **cryptographically proven block** instead of the mirror's attested record.
 *
 * Same verdict pipeline as `verify.ts` — `source → receiptFor → match` — with
 * the source swapped: the block's in-band proof (recomputed merkle root +
 * threshold signature, `@hiero-hackers/streams-node`) is checked FIRST, and
 * if it does not verify, this module refuses to read the data at all. The
 * receipts that come out are stamped `verified`, not `unverified`.
 *
 * Two honest limits, stated plainly:
 * - **Acquisition is the caller's.** Block streams (HIP-1056) are not on
 *   testnet yet, so there is no public endpoint to fetch "the block holding
 *   transaction X" — you bring the bytes (today: preview-network blocks).
 *   No network I/O happens here at all, which is also why the testnet gate
 *   does not apply: pure computation on supplied bytes moves no money.
 * - **Correlation is by the true transaction id** — `payer@validStart`,
 *   exactly as wallets and explorers spell it. It wasn't always: the parsed
 *   stream shape used to carry no id at all, and this repo correlated on a
 *   synthesized `payer@consensusTimestamp`. That gap was fixed upstream
 *   because of this integration (streams-node 0.2.0 exposes the id;
 *   receipts 0.2.1 threads it through `fromStream`).
 */
import { Buffer } from "node:buffer";
import { fromReceipt, paymentInstructions } from "@hiero-hackers/hiero-payment-requests";
import { receiptFor } from "@hiero-hackers/hiero-receipts";
import { fromStream } from "@hiero-hackers/hiero-receipts/stream";
import type { BlockProofLike, ParsedTransactionLike } from "@hiero-hackers/hiero-receipts/stream";
import { parseBlockJson, verifyBlockProofJson } from "@hiero-hackers/streams-node";
import type { PaymentRequirements } from "@x402/core/types";
import { HASHSCAN_HOSTS, isSupportedNetwork } from "./config.js";
import { BlockProofError } from "./errors.js";
import { fromPaymentRequirements } from "./requirements.js";
import { toVerdict } from "./verify.js";
import type { SettlementVerdict } from "./verify.js";

/** The block holding the settlement, plus the genesis block seeding trust. */
export interface BlockSource {
  readonly blockBytes: Uint8Array;
  readonly genesisBytes: Uint8Array;
}

export interface StreamVerifyOptions {
  /** Injectable for offline tests; default `verifyBlockProofJson`. */
  readonly verifyImpl?: (block: Uint8Array, genesis: Uint8Array) => string;
  /** Injectable for offline tests; default `parseBlockJson`. */
  readonly parseImpl?: (block: Uint8Array) => string;
}

/**
 * Judge a settlement claim against a proven block. Proof first, always: an
 * invalid proof throws — untrusted data earns no verdict, not even "unpaid".
 */
export function verifySettlementFromBlock(
  requirements: PaymentRequirements,
  transactionId: string,
  reference: string,
  block: BlockSource,
  options: StreamVerifyOptions = {},
): SettlementVerdict {
  const request = fromPaymentRequirements(requirements, reference);
  const { network: bareNetwork, recipient } = paymentInstructions(request);

  const verify =
    options.verifyImpl ??
    ((block: Uint8Array, genesis: Uint8Array): string =>
      verifyBlockProofJson(Buffer.from(block), Buffer.from(genesis)));
  const proof = JSON.parse(verify(block.blockBytes, block.genesisBytes)) as BlockProofLike;
  if (!proof.valid) {
    throw new BlockProofError(
      `block ${proof.blockNumber} proof did NOT verify (${proof.proofPath}) — ` +
        "refusing to read the data at all",
      proof.blockNumber,
      proof.proofPath,
    );
  }

  const parse =
    options.parseImpl ?? ((block: Uint8Array): string => parseBlockJson(Buffer.from(block)));
  const { transactions } = JSON.parse(parse(block.blockBytes)) as {
    transactions: ParsedTransactionLike[];
  };
  const entries = transactions.map((tx) => {
    const receipt = receiptFor(recipient, fromStream(tx, proof, { network: bareNetwork }));
    return { receipt, payment: fromReceipt(receipt, bareNetwork) };
  });

  const hashscanBase = isSupportedNetwork(requirements.network)
    ? HASHSCAN_HOSTS[requirements.network]
    : undefined;
  return toVerdict(request, entries, transactionId, hashscanBase);
}
