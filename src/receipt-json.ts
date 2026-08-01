// SPDX-License-Identifier: Apache-2.0
/**
 * The machine-readable companion to {@link settlementReceiptHTML}.
 *
 * Same inputs, same verdict, same trust stamps — but a plain serialisable
 * object an agent can index, re-verify, or forward. The schema is frozen at
 * version 1; future fields are additive.
 */
import type { DeliveredContent } from "./content.js";
import type { SettlementVerdict } from "./verify.js";
import type { ReceiptOptions } from "./receipt.js";

/** Schema version for forward compatibility. */
export const RECEIPT_SCHEMA_VERSION = 1 as const;

/** A single trust stamp — identical vocabulary to the HTML receipt. */
export type TrustStamp = "UNVERIFIED" | "SERVER COMMITTED" | "VERIFIED";

/** The machine-readable settlement receipt. */
export interface SettlementReceiptJSON {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly settlement: {
    readonly status: string;
    readonly transactionId: string;
    readonly hashscanUrl?: string;
    readonly mirrorUrl?: string;
    readonly trust: TrustStamp;
    readonly method: string;
  };
  readonly content?: {
    readonly sha256?: string;
    readonly serverCommitment?: string;
    readonly signer?: string;
    readonly trust: TrustStamp;
  };
  readonly consent?: string;
  readonly proof: {
    readonly kind: "mirror" | "block";
    readonly reference: string;
  };
}

/**
 * Build a JSON receipt from the same verdict + options the HTML version uses.
 * Trust stamps are derived from the verdict's receipts, exactly as the HTML
 * banner derives its seal — the two formats must never disagree.
 */
export function settlementReceiptJSON(
  verdict: SettlementVerdict,
  options: ReceiptOptions = {},
): SettlementReceiptJSON {
  const proven = verdict.receipts.some(
    (r) => r.provenance.kind === "verified",
  );
  const trust: TrustStamp = proven ? "VERIFIED" : "UNVERIFIED";
  const method = proven
    ? "Block proof — cryptography, not the facilitator's word."
    : "Mirror node — the operator's attested record, not the facilitator's word.";

  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    settlement: {
      status: verdict.fulfilment.status,
      transactionId: verdict.transactionId,
      hashscanUrl: verdict.hashscanUrl,
      mirrorUrl: verdict.mirrorUrl,
      trust,
      method,
    },
    content: options.content
      ? {
          sha256: options.content.clientSha256,
          serverCommitment: options.content.serverCommitment,
          signer: options.content.signer,
          trust: "SERVER COMMITTED",
        }
      : undefined,
    consent: options.consent,
    proof: {
      kind: proven ? "block" : "mirror",
      reference: verdict.transactionId,
    },
  };
}
