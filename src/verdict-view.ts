// SPDX-License-Identifier: Apache-2.0
/**
 * The ONE owner of the receipt's trust registers — the decisions AND the
 * wording, as data. Renderers (the HTML receipt today, a JSON export
 * tomorrow) consume these instead of re-deriving them, so two formats of
 * the same verdict can never disagree about a stamp: per register there is
 * exactly one place that decides what may honestly be claimed.
 *
 * Wording registers are part of the API (CONTRIBUTING.md): "verified" is
 * reserved for cryptography; mirror data is an attested record; an absent
 * commitment is the agent's own record, never a failure. Strings here are
 * PLAIN TEXT — each renderer escapes for its own medium.
 */
import type { DeliveredContent } from "./content.js";
import type { SettlementVerdict } from "./verify.js";

/** The settlement's trust stamp — VERIFIED belongs to the block-proof rung alone. */
export type SettlementStamp = "VERIFIED" | "UNVERIFIED";

/** How the settlement was read, with the honest words for it. */
export interface SettlementRegister {
  /** True only when a contributing receipt carries block-proof provenance. */
  readonly proven: boolean;
  readonly stamp: SettlementStamp;
  /** HOW the chain was consulted — a banner must never claim the mirror
   *  for a block-proof verdict, or vice versa. */
  readonly readVia: "block-proof" | "mirror";
  /** The method line, plain text. */
  readonly method: string;
}

export function settlementRegister(verdict: SettlementVerdict): SettlementRegister {
  const proven = verdict.receipts.some((receipt) => receipt.provenance.kind === "verified");
  return proven
    ? {
        proven,
        stamp: "VERIFIED",
        readVia: "block-proof",
        method:
          "Verified against the ledger's own block proof — cryptography, not the facilitator's word.",
      }
    : {
        proven,
        stamp: "UNVERIFIED",
        readVia: "mirror",
        method:
          "Read from the public mirror node — the operator's attested record, not the facilitator's word.",
      };
}

/** Three registers, named for what the panel IS, never what is missing. */
export type ContentBadge = "AGENT RECORD" | "SERVER COMMITTED" | "COMMITMENT BROKEN";

export interface ContentRegister {
  readonly badge: ContentBadge;
  /** The panel's explanatory line, plain text. */
  readonly line: string;
}

export function contentRegister(content: DeliveredContent): ContentRegister {
  const { commitment } = content;
  if (commitment === undefined) {
    return {
      badge: "AGENT RECORD",
      line: "The agent's own record of the bytes it received. This server does not offer content commitments — the payment above is proven either way; the content simply carries no server signature.",
    };
  }
  return commitment.verified
    ? {
        badge: "SERVER COMMITTED",
        line: "The server signed these exact bytes against this settlement — it cannot later deny serving them. Anyone holding the content can re-hash it and check.",
      }
    : {
        badge: "COMMITMENT BROKEN",
        line: "A commitment was presented but its signature does NOT verify over the received bytes. Treat the content as unattested — and keep this artifact: a false commitment is itself evidence.",
      };
}

/** Two registers only — an unverifiable consent is loud, never quiet fact. */
export type ConsentBadge = "HUMAN APPROVED" | "CONSENT UNVERIFIED";

export interface ConsentRegister {
  readonly badge: ConsentBadge;
  /** The panel's explanatory line, plain text. */
  readonly line: string;
}

export function consentRegister(consent: { readonly verified: boolean }): ConsentRegister {
  return consent.verified
    ? {
        badge: "HUMAN APPROVED",
        line: "A human's wallet signed this exact challenge — nonce and issue time bind the approval to THIS run, so a captured signature approves nothing later.",
      }
    : {
        badge: "CONSENT UNVERIFIED",
        line: "A consent was presented but its signature does not verify against the approver's on-chain key — treat the approval as unattested.",
      };
}

/** The settled numbers as facts (atomic units) — what a renderer formats. */
export interface SettledFacts {
  /** Absent when nothing was credited under these terms. */
  readonly received?: bigint;
  /** Present only on the overpaid outcome. */
  readonly excess?: bigint;
  /** Present only on the underpaid outcome. */
  readonly shortfall?: bigint;
}

export function settledFacts(fulfilment: SettlementVerdict["fulfilment"]): SettledFacts {
  if (!("received" in fulfilment)) return {};
  return {
    received: fulfilment.received,
    ...(fulfilment.status === "overpaid" ? { excess: fulfilment.excess } : {}),
    ...(fulfilment.status === "underpaid" ? { shortfall: fulfilment.shortfall } : {}),
  };
}
