// SPDX-License-Identifier: Apache-2.0
/**
 * hiero-x402 — x402 on Hiero with verifiable settlement and receipts.
 *
 * Reading order mirrors the payment's lifecycle:
 *   requirements  what a resource costs, in both request languages
 *   verify        did the chain actually pay it — the differentiator
 *   stream        the same verdict from a cryptographically PROVEN block
 *   receipt       the keepsake
 *   attestation   the verdict's wire format for HCS audit logs
 *   errors        discriminable failure kinds (instanceof, not string-matching)
 *   mirror        the thin REST access verify rides on
 */
export {
  DEFAULT_MAX_TIMEOUT_SECONDS,
  HBAR_ASSET,
  SCHEME,
  fromPaymentRequirements,
  toPaymentRequirements,
} from "./requirements.js";
export type { RequirementsOptions } from "./requirements.js";
export { verifySettlement } from "./verify.js";
export type { SettlementVerdict, VerifyOptions } from "./verify.js";
export { verifySettlementFromBlock } from "./stream.js";
export type { BlockSource, StreamVerifyOptions } from "./stream.js";
export { settlementReceiptHTML, verdictLine } from "./receipt.js";
export { ATTESTATION_VERSION, attestationMessage, parseAttestation } from "./attestation.js";
export {
  BlockProofError,
  InvalidRequirementsError,
  MirrorError,
  UnsupportedNetworkError,
  X402Error,
} from "./errors.js";
export type { Attestation } from "./attestation.js";
export { restTransactionId, toTransactionInfo, transactionsById } from "./mirror.js";
export type { MirrorTx } from "./mirror.js";
export {
  HASHSCAN_HOSTS,
  MIRROR_HOSTS,
  SUPPORTED_NETWORKS,
  assertSupportedNetwork,
  isSupportedNetwork,
} from "./config.js";
export type { SupportedNetwork } from "./config.js";
