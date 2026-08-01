// SPDX-License-Identifier: Apache-2.0
/**
 * The machine-readable companion to {@link settlementReceiptHTML} — same
 * verdict, same options, same trust registers, as a plain serializable
 * object an agent can store, index, or forward.
 *
 * Every stamp and every wording line comes from verdict-view (the ONE
 * owner), so this format cannot disagree with the HTML. The per-payment
 * bodies come from hiero-receipts' own canonical `toJSON` — decimals,
 * memo sanitization, and the bigint-as-decimal-string policy are the
 * library's, not a re-implementation. Money is NEVER a JSON number:
 * every amount here is a decimal string of atomic units.
 */
import { toJSON } from "@hiero-hackers/hiero-receipts";
import type { DeliveredContent } from "./content.js";
import { verdictLine } from "./receipt.js";
import type { ReceiptOptions } from "./receipt.js";
import {
  contentRegister,
  consentRegister,
  settledFacts,
  settlementRegister,
} from "./verdict-view.js";
import type { ConsentBadge, ContentBadge, SettlementStamp } from "./verdict-view.js";
import type { SettlementVerdict } from "./verify.js";

/** Schema version — additive evolution only; consumers pin on it. */
export const RECEIPT_SCHEMA_VERSION = 1 as const;

/** The machine-readable settlement receipt. All amounts are decimal
 *  strings in ATOMIC units — never floats, never JSON numbers. */
export interface SettlementReceiptJSON {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  /** The judgment: what was asked, what landed, in the library's words. */
  readonly verdict: {
    readonly status: string;
    /** The same plain-language line the HTML banner prints. */
    readonly line: string;
    /** The quoted amount, atomic units. */
    readonly quoted: string;
    /** Absent when nothing was credited under these terms. */
    readonly received?: string;
    /** Present only on the overpaid outcome. */
    readonly excess?: string;
    /** Present only on the underpaid outcome. */
    readonly shortfall?: string;
  };
  /** How the chain was consulted — stamped for HOW it was read. */
  readonly settlement: {
    readonly transactionId: string;
    readonly reference: string;
    readonly stamp: SettlementStamp;
    readonly readVia: "block-proof" | "mirror";
    readonly method: string;
    readonly hashscanUrl?: string;
    readonly mirrorUrl?: string;
  };
  /** The contributing payments — hiero-receipts' canonical JSON, verbatim. */
  readonly payments: readonly Record<string, unknown>[];
  /** Delivered content, in its own register — never under the seal above. */
  readonly content?: {
    readonly badge: ContentBadge;
    readonly line: string;
    readonly sha256: string;
    readonly reference?: string;
    readonly commitment?: {
      readonly signer: string;
      readonly signatureB64: string;
      readonly verified: boolean;
    };
  };
  /** The human approval for THIS payment, when one happened. */
  readonly consent?: {
    readonly badge: ConsentBadge;
    readonly line: string;
    readonly approver: string;
    readonly terms: string;
    readonly signatureB64: string;
    readonly verified: boolean;
  };
  /** The block proof's working — what was checked, not just that it was. */
  readonly proof?: {
    readonly source: string;
    readonly anchor?: string;
    readonly checks: readonly string[];
  };
  /** The caller's honesty caveat, verbatim — it survives every format. */
  readonly caveat?: string;
}

function contentJSON(content: DeliveredContent): NonNullable<SettlementReceiptJSON["content"]> {
  const register = contentRegister(content);
  return {
    badge: register.badge,
    line: register.line,
    sha256: content.sha256,
    ...(content.reference !== undefined ? { reference: content.reference } : {}),
    ...(content.commitment !== undefined ? { commitment: content.commitment } : {}),
  };
}

/**
 * Build the JSON receipt from the same verdict + options the HTML takes.
 * The two formats share every register by construction — a stamp that
 * differs between them is a build failure, not a bug to catch in review.
 */
export function settlementReceiptJSON(
  verdict: SettlementVerdict,
  options: ReceiptOptions = {},
): SettlementReceiptJSON {
  const register = settlementRegister(verdict);
  const facts = settledFacts(verdict.fulfilment);
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    verdict: {
      status: verdict.fulfilment.status,
      line: verdictLine(verdict),
      quoted: verdict.request.amount.toString(),
      ...(facts.received !== undefined ? { received: facts.received.toString() } : {}),
      ...(facts.excess !== undefined ? { excess: facts.excess.toString() } : {}),
      ...(facts.shortfall !== undefined ? { shortfall: facts.shortfall.toString() } : {}),
    },
    settlement: {
      transactionId: verdict.transactionId,
      reference: verdict.request.reference,
      stamp: register.stamp,
      readVia: register.readVia,
      method: register.method,
      ...(verdict.hashscanUrl !== undefined ? { hashscanUrl: verdict.hashscanUrl } : {}),
      ...(verdict.mirrorUrl !== undefined ? { mirrorUrl: verdict.mirrorUrl } : {}),
    },
    payments: verdict.receipts.map(
      (receipt) => JSON.parse(toJSON(receipt)) as Record<string, unknown>,
    ),
    ...(options.content !== undefined ? { content: contentJSON(options.content) } : {}),
    ...(options.consent !== undefined
      ? { consent: { ...consentRegister(options.consent), ...options.consent } }
      : {}),
    ...(options.proof !== undefined ? { proof: options.proof } : {}),
    ...(options.caveat !== undefined ? { caveat: options.caveat } : {}),
  };
}
