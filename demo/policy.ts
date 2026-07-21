// SPDX-License-Identifier: Apache-2.0
/**
 * Facilitator policy — which requirements this fee payer sponsors at all —
 * as pure, TYPED functions. The refusal builders return the real
 * `VerifyResponse` / `SettleResponse` contract types, so a wrong field name
 * (the `invalidMessage` vs `errorMessage` trap that bit us once) is a
 * compile error, and the conformance suite pins the shapes besides.
 *
 * The spec invites exactly this layer: "implementations MAY introduce
 * stricter limits but MUST NOT relax" — policy refuses BEFORE the engine,
 * never instead of it.
 */
import type {
  Network,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

export interface Policy {
  /** Allow-listed payTo account ids; empty = any. */
  readonly allowedPayTo: readonly string[];
  /** Max amount sponsored, in the offered asset's ATOMIC units; "" = no cap. */
  readonly maxAmount: string;
}

/** Parse the two policy env vars into a `Policy`. */
export function policyFromEnv(env: { ALLOWED_PAY_TO?: string; MAX_AMOUNT?: string }): Policy {
  return {
    allowedPayTo: (env.ALLOWED_PAY_TO ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
    maxAmount: env.MAX_AMOUNT ?? "",
  };
}

/** The violated rule in plain words, or undefined when policy is satisfied. */
export function policyViolation(
  requirements: PaymentRequirements,
  policy: Policy,
): string | undefined {
  if (policy.allowedPayTo.length > 0 && !policy.allowedPayTo.includes(requirements.payTo)) {
    return `payTo ${requirements.payTo} is not in this facilitator's ALLOWED_PAY_TO list`;
  }
  if (policy.maxAmount !== "" && BigInt(requirements.amount) > BigInt(policy.maxAmount)) {
    return `amount ${requirements.amount} exceeds this facilitator's MAX_AMOUNT (${policy.maxAmount} atomic units)`;
  }
  return undefined;
}

/** A policy refusal as the `/verify` contract shape. */
export function verifyRefusal(violation: string): VerifyResponse {
  return { isValid: false, invalidReason: "policy_violation", invalidMessage: violation };
}

/** A policy refusal as the `/settle` contract shape. */
export function settleRefusal(
  violation: string,
  network: Network,
  feePayer: string,
): SettleResponse {
  return {
    success: false,
    errorReason: "policy_violation",
    errorMessage: violation,
    transaction: "",
    network,
    payer: feePayer,
  };
}
