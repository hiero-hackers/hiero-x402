// SPDX-License-Identifier: Apache-2.0
/**
 * The bridge between the two request languages this stack speaks — now a
 * thin veneer over the library it came from.
 *
 * The mapping (`PaymentRequest` ⇄ x402 `PaymentRequirements`) started life
 * here, grew a twin in hiero-checkout, and was upstreamed to
 * `hiero-payment-requests` v0.1.3 as the `fromX402`/`toX402` adapter — the
 * third feature this integration fed back. What remains HERE is only the
 * x402-package typing (the library is structurally typed on purpose) and
 * this repo's exported names, kept stable for the demo and tests.
 *
 * Field conventions are the official Hedera scheme's (research/02): asset
 * `"0.0.0"` means HBAR in tinybars, otherwise an HTS token id in its
 * smallest unit; `extra.feePayer` names the fee-sponsoring account.
 */
import { fromX402, toX402 } from "@hiero-hackers/hiero-payment-requests";
import type { PaymentRequest } from "@hiero-hackers/hiero-payment-requests";
import type { PaymentRequirements } from "@x402/core/types";
import { InvalidRequirementsError, rethrowAs } from "./errors.js";

/** The official Hedera scheme's sentinel for native HBAR. */
export const HBAR_ASSET = "0.0.0";

/** The scheme this bridge speaks — the only one specified for Hedera today. */
export const SCHEME = "exact";

/** Window a client has to present payment; both reference implementations use 180. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 180;

export interface RequirementsOptions {
  /** Account that sponsors network fees — typically the facilitator's.
   *  Bare Hedera id (`0.0.x`); the scheme requires it in `extra.feePayer`. */
  readonly feePayer: string;
  /** Seconds the payer has to present payment. Default {@link DEFAULT_MAX_TIMEOUT_SECONDS}. */
  readonly maxTimeoutSeconds?: number;
}

/**
 * A validated `PaymentRequest` as x402 `PaymentRequirements` — the library's
 * `toX402`, typed for the `@x402/core` consumer this repo wires together.
 */
export function toPaymentRequirements(
  request: PaymentRequest,
  options: RequirementsOptions,
): PaymentRequirements {
  try {
    return toX402(request, {
      feePayer: options.feePayer,
      ...(options.maxTimeoutSeconds !== undefined
        ? { maxTimeoutSeconds: options.maxTimeoutSeconds }
        : {}),
    }) as PaymentRequirements;
  } catch (error) {
    rethrowAs(error, InvalidRequirementsError);
  }
}

/**
 * x402 `PaymentRequirements` as a `PaymentRequest` — the direction the
 * verifier walks. `reference` is required because x402 has no correlation
 * field (settlements correlate by transaction id); the resource URL is a
 * fine choice.
 */
export function fromPaymentRequirements(
  requirements: PaymentRequirements,
  reference: string,
): PaymentRequest {
  let request: PaymentRequest | undefined;
  try {
    request = fromX402(requirements, { reference });
  } catch (error) {
    rethrowAs(error, InvalidRequirementsError);
  }
  if (request === undefined) {
    // A typed PaymentRequirements is always x402-shaped; reaching here means
    // the object lost its shape at runtime — refuse loudly, never guess.
    throw new InvalidRequirementsError("not an x402 requirements object");
  }
  return request;
}
