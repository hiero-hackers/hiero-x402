// SPDX-License-Identifier: Apache-2.0
/**
 * The content-commitment schema — the `x402-content-commitment` message a
 * resource server signs over the EXACT bytes it served for a settled x402
 * payment. The settlement verdict proves the money moved; this message is
 * the missing binding: "account X served exactly these bytes for exactly
 * that transaction." Signed, it is non-repudiable — the server cannot later
 * deny what it delivered.
 *
 * Scope honesty (the receipt repeats this): a commitment binds bytes to a
 * payment. It does NOT make the data true — data truth needs an oracle
 * signature from the upstream source, which is out of this rail's scope.
 *
 * Like attestation.ts, the SCHEMA lives here — pure, versioned, testable —
 * and the SDK I/O (key loading, signing, mirror key resolution) stays in
 * the demo. The message is line-oriented rather than JSON so there is
 * exactly ONE byte sequence to sign and verify — no canonicalization
 * ambiguity, and any human can read what was signed.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

/** The current message version — bump when the shape changes. */
export const CONTENT_COMMITMENT_VERSION = 1;

/** The response headers the commitment rides on (server → client). */
export const CONTENT_SHA256_HEADER = "x-content-sha256";
export const CONTENT_SIGNER_HEADER = "x-content-signer";
export const CONTENT_SIGNATURE_HEADER = "x-content-signature";

/** The facts a commitment binds together. */
export interface ContentCommitment {
  readonly v: typeof CONTENT_COMMITMENT_VERSION;
  /** The settlement transaction id, REST-normalized (`0.0.x-seconds-nanos`)
   *  — the ONE canonical form, shared with verdicts, mirror links, and
   *  topic attestations, so any of them can rebuild this exact message. */
  readonly transactionId: string;
  /** The paid resource — the same `reference` the payment terms carried. */
  readonly reference: string;
  /** sha-256 (lowercase hex) of the exact response bytes. */
  readonly sha256: string;
}

/** sha-256 of `bytes`, lowercase hex — the digest the commitment names. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes)
    .digest("hex");
}

/** Is `text` a well-formed sha-256 digest in this repo's ONE canonical
 *  spelling (64 lowercase hex chars)? Every parser that judges a digest
 *  judges it here — two parsers with their own regex is how they drift. */
export const isSha256Hex = (text: string): boolean => /^[0-9a-f]{64}$/.test(text);

/**
 * THE convention for what reference a content commitment signs: the route
 * PATH, never a full URL and never the query string. Settlement references
 * are often full URLs — the two must not be confused (the auditor's first
 * field trip caught exactly that mismatch). Server middleware and client
 * verification both derive the reference HERE, so a deliberate change to
 * the convention is a one-site edit that moves both parties together.
 */
export function commitmentReference(url: string | URL): string {
  return typeof url === "string" && url.startsWith("/")
    ? url.split("?")[0]!
    : new URL(url).pathname;
}

/**
 * The ONE byte sequence a commitment signs — utf8 of this string. Line
 * format, one fact per line, so the signed bytes are unambiguous and
 * human-auditable (paste the message next to the signature and look).
 */
export function contentCommitmentMessage(commitment: Omit<ContentCommitment, "v">): string {
  return [
    `x402-content-commitment v${String(CONTENT_COMMITMENT_VERSION)}`,
    `tx:${commitment.transactionId}`,
    `ref:${commitment.reference}`,
    `sha256:${commitment.sha256}`,
  ].join("\n");
}

/**
 * Parse a commitment message back into its facts, or undefined for anything
 * that isn't one (foreign strings are data, not errors — same posture as
 * parseAttestation). Rejects future versions: a reader that doesn't know a
 * shape must not claim to have understood it.
 */
export function parseContentCommitment(message: string): ContentCommitment | undefined {
  const lines = message.split("\n");
  if (lines.length !== 4) return undefined;
  if (lines[0] !== `x402-content-commitment v${String(CONTENT_COMMITMENT_VERSION)}`) {
    return undefined;
  }
  const [, tx, ref, sha] = lines;
  if (!tx!.startsWith("tx:") || !ref!.startsWith("ref:") || !sha!.startsWith("sha256:")) {
    return undefined;
  }
  const transactionId = tx!.slice("tx:".length);
  const reference = ref!.slice("ref:".length);
  const sha256 = sha!.slice("sha256:".length);
  if (transactionId === "" || reference === "" || !isSha256Hex(sha256)) {
    return undefined;
  }
  return { v: CONTENT_COMMITMENT_VERSION, transactionId, reference, sha256 };
}

/**
 * The commitment as response headers, built — the PRODUCER half of the
 * protocol. `sign` is injected (this library ships no key handling): it
 * receives the exact message bytes and returns the raw signature.
 */
export function contentCommitmentHeaders(commitment: {
  readonly transactionId: string;
  readonly reference: string;
  readonly sha256: string;
  readonly signer: string;
  readonly sign: (message: Uint8Array) => Uint8Array;
}): Record<string, string> {
  const message = contentCommitmentMessage(commitment);
  return {
    [CONTENT_SHA256_HEADER]: commitment.sha256,
    [CONTENT_SIGNER_HEADER]: commitment.signer,
    [CONTENT_SIGNATURE_HEADER]: Buffer.from(commitment.sign(Buffer.from(message, "utf8"))).toString(
      "base64",
    ),
  };
}

/**
 * The commitment read OFF a response — the CONSUMER half. The accessor
 * keeps this platform-neutral (fetch Headers, node, test stubs all fit).
 * All three headers or nothing: a partial commitment is no commitment.
 */
export function parseContentCommitmentHeaders(
  header: (name: string) => string | null,
): { sha256: string; signer: string; signatureB64: string } | undefined {
  const sha256 = header(CONTENT_SHA256_HEADER);
  const signer = header(CONTENT_SIGNER_HEADER);
  const signatureB64 = header(CONTENT_SIGNATURE_HEADER);
  if (sha256 === null || signer === null || signatureB64 === null) return undefined;
  return { sha256, signer, signatureB64 };
}

/**
 * What the receipt renders about the delivered content — the agent's own
 * observation (its hash of the bytes it received) plus, when the server
 * committed, the verified-or-not commitment. Kept as plain data so the
 * receipt stays a renderer of facts, never a judge.
 */
export interface DeliveredContent {
  /** sha-256 (hex) of the exact bytes the agent received. */
  readonly sha256: string;
  /** The reference EXACTLY as the commitment message named it (the route
   *  path) — which can differ from a settlement reference (often a full
   *  URL). Carried so downstream artifacts (receipts, attestations) can
   *  rebuild the signed bytes without guessing which form was signed. */
  readonly reference?: string;
  /** Present when the server presented a commitment. */
  readonly commitment?: {
    /** The signing account, as the `x-content-signer` header named it. */
    readonly signer: string;
    /** The signature, base64, as presented. */
    readonly signatureB64: string;
    /** Did the signature verify against the signer's on-chain key over the
     *  bytes the agent actually received? False is a loud fact: a
     *  commitment was CLAIMED and does not hold. */
    readonly verified: boolean;
  };
}
