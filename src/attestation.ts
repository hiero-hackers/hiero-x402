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
import type { DeliveredContent } from "./content.js";
import { contentCommitmentMessage, isSha256Hex } from "./content.js";
import type { SettlementVerdict } from "./verify.js";

/** The current message version — bump when the shape changes. */
export const ATTESTATION_VERSION = 1;

/**
 * The content block an attestation may carry: the agent's hash of the
 * bytes it received, and — when
 * the server committed — the commitment's signer and signature. On a topic
 * this makes the (transaction → content hash) binding PUBLIC and consensus-
 * timestamped, and an auditor can re-verify the server's signature from the
 * log alone: rebuild `contentCommitmentMessage` from the attestation's own
 * transactionId/reference/sha256 and check it against the signer's on-chain
 * key. Optional and additive — v1 readers that predate it ignore it.
 */
export interface AttestedContent {
  /** sha-256 (lowercase hex) of the exact bytes the agent received. */
  readonly sha256: string;
  /** The reference EXACTLY as the commitment message named it (the route
   *  path). The attestation's own top-level `reference` is the settlement
   *  reference — often a full URL — which is NOT what the server signed;
   *  the auditor's first field trip caught precisely that mismatch. */
  readonly reference?: string;
  /** Present when the server presented a commitment. */
  readonly commitment?: {
    readonly signer: string;
    /** Base64, exactly as presented — re-verifiable, not just claimed. */
    readonly signature: string;
    /** The agent's verification outcome at receipt time. An auditor need
     *  not take this word for it — the signature above re-verifies. */
    readonly verified: boolean;
  };
}

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
  /** What was served for the payment — see AttestedContent. */
  readonly content?: AttestedContent;
}

/** A verdict as the attestation message string a topic submit takes. */
export function attestationMessage(
  verdict: SettlementVerdict,
  options: { readonly content?: DeliveredContent } = {},
): string {
  const { content } = options;
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
    ...(content !== undefined
      ? {
          content: {
            sha256: content.sha256,
            ...(content.reference !== undefined ? { reference: content.reference } : {}),
            ...(content.commitment !== undefined
              ? {
                  commitment: {
                    signer: content.commitment.signer,
                    signature: content.commitment.signatureB64,
                    verified: content.commitment.verified,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
  return JSON.stringify(attestation);
}

/** Is `content` a well-formed AttestedContent? Malformed → the whole
 *  message is rejected: a reader must never half-understand a shape. */
function isAttestedContent(content: unknown): content is AttestedContent {
  if (typeof content !== "object" || content === null) return false;
  const { sha256, reference, commitment } = content as Partial<AttestedContent>;
  if (typeof sha256 !== "string" || !isSha256Hex(sha256)) return false;
  if (reference !== undefined && (typeof reference !== "string" || reference === "")) return false;
  if (commitment === undefined) return true;
  if (typeof commitment !== "object" || commitment === null) return false;
  return (
    typeof commitment.signer === "string" &&
    commitment.signer !== "" &&
    typeof commitment.signature === "string" &&
    commitment.signature !== "" &&
    typeof commitment.verified === "boolean"
  );
}

/**
 * The exact byte sequence the server signed for an attestation's content
 * commitment, rebuilt from the attestation's OWN fields — this is what
 * makes the topic self-auditing: message + on-chain signer key + the
 * attested signature is a complete verification, no cooperation needed
 * from agent or server. Undefined when the attestation carries no content.
 */
export function attestationCommitmentMessage(attestation: Attestation): string | undefined {
  if (attestation.content === undefined) return undefined;
  return contentCommitmentMessage({
    transactionId: attestation.transactionId,
    // The content block's reference is the one the server SIGNED (the route
    // path); the top-level reference is the settlement's (often a full
    // URL). Prefer the signed form — older messages without it fall back,
    // and an auditor then reports honestly on whatever was recorded.
    reference: attestation.content.reference ?? attestation.reference,
    sha256: attestation.content.sha256,
  });
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
      /^\d+$/.test(parsed.amount) &&
      (parsed.content === undefined || isAttestedContent(parsed.content))
    ) {
      return parsed as Attestation;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
