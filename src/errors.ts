// SPDX-License-Identifier: Apache-2.0
/**
 * The error vocabulary — discriminable kinds instead of anonymous `Error`s,
 * so a consumer can decide by `instanceof` what a failure MEANS: refuse a
 * network (policy), distrust a block (security), reject bad terms (input),
 * or retry a flaky mirror (transport). Same idiom as payment-requests'
 * `RequestError`/`CaipError`: small classes, no error-code registry.
 *
 * Wrapped causes are preserved (`cause`), and messages are unchanged from
 * before the classes existed — typing adds discrimination, not churn.
 */

/** Base class — `instanceof X402Error` catches everything thrown here. */
export class X402Error extends Error {}

/** The testnet gate refused a network — policy, enforced in code. */
export class UnsupportedNetworkError extends X402Error {
  constructor(
    message: string,
    /** The refused CAIP-2 network id. */
    readonly network: string,
  ) {
    super(message);
  }
}

/** x402 terms that cannot become (or come from) a valid `PaymentRequest`. */
export class InvalidRequirementsError extends X402Error {}

/** A block whose in-band proof did not verify — the data is untrusted and
 *  was not read. Security-critical: never downgrade this to a verdict. */
export class BlockProofError extends X402Error {
  constructor(
    message: string,
    readonly blockNumber: number,
    readonly proofPath: string,
  ) {
    super(message);
  }
}

/** The mirror node could not be read (transport/status) — retryable, and
 *  distinct from a verdict: an unreachable mirror proves nothing either way. */
export class MirrorError extends X402Error {}

/** Rethrow `error` as `kind`, preserving message and cause. */
export function rethrowAs(
  error: unknown,
  kind: new (message: string, options?: ErrorOptions) => X402Error,
): never {
  if (error instanceof X402Error) throw error; // already discriminable
  const message = error instanceof Error ? error.message : String(error);
  throw new kind(message, { cause: error });
}
