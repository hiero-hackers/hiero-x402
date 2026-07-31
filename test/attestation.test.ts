// SPDX-License-Identifier: Apache-2.0
/**
 * The attestation wire format — round-trip fidelity, and a parser that
 * treats a public topic's foreign messages as data, never as errors.
 */
import { describe, expect, it } from "vitest";
import {
  attestationCommitmentMessage,
  attestationMessage,
  contentCommitmentMessage,
  parseAttestation,
  verifySettlement,
} from "../src/index.js";
import {
  CONSENSUS_AT,
  HBAR_REQUEST,
  REQUIREMENTS,
  SETTLEMENT_ID,
  fetchStub,
  hbarRow,
} from "./helpers.js";

async function verdict() {
  const { fetchImpl } = fetchStub([hbarRow(5_000_000)]);
  return verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, { fetchImpl });
}

describe("attestationMessage ⇄ parseAttestation", () => {
  it("round-trips a paid verdict, proof link included", async () => {
    const message = attestationMessage(await verdict());
    const parsed = parseAttestation(message);
    expect(parsed).toEqual({
      v: 1,
      kind: "x402-settlement-verdict",
      status: "paid",
      transactionId: "0.0.7000001-1753099999-123456789",
      reference: HBAR_REQUEST.reference,
      recipient: HBAR_REQUEST.recipient,
      amount: "5000000",
      asset: HBAR_REQUEST.asset,
      proof: `https://hashscan.io/testnet/transaction/${CONSENSUS_AT}`,
    });
  });

  it("omits the proof field when the verdict has no explorer link", async () => {
    const { fetchImpl } = fetchStub(undefined, 404);
    const unfound = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, {
      fetchImpl,
    });
    const parsed = parseAttestation(attestationMessage(unfound));
    expect(parsed?.status).toBe("unpaid");
    expect(parsed).not.toHaveProperty("proof");
  });

  it("carries the content block when the agent has one — hash alone, or hash plus commitment", async () => {
    const sha256 = "b".repeat(64);
    // Hash alone: the agent's own note, attested.
    const noted = parseAttestation(attestationMessage(await verdict(), { content: { sha256 } }));
    expect(noted?.content).toEqual({ sha256 });
    // With a server commitment: signer + signature land on the log so an
    // auditor can RE-VERIFY the server's signature from the topic alone.
    const committed = parseAttestation(
      attestationMessage(await verdict(), {
        content: {
          sha256,
          commitment: { signer: "0.0.7000009", signatureB64: "c2ln", verified: true },
        },
      }),
    );
    expect(committed?.content).toEqual({
      sha256,
      commitment: { signer: "0.0.7000009", signature: "c2ln", verified: true },
    });
    // No content option → no content field, byte-identical to the original wire.
    expect(parseAttestation(attestationMessage(await verdict()))).not.toHaveProperty("content");
  });

  it("rejects malformed content blocks whole — a reader must never half-understand", async () => {
    const base = JSON.parse(attestationMessage(await verdict())) as Record<string, unknown>;
    const withContent = (content: unknown): string => JSON.stringify({ ...base, content });
    const sha256 = "b".repeat(64);
    for (const malformed of [
      "not an object",
      null,
      {}, // no sha256
      { sha256: "deadbeef" }, // not a sha-256
      { sha256: sha256.toUpperCase() }, // wrong case — one canonical form only
      { sha256, reference: "" }, // an empty signed-reference is no reference
      { sha256, reference: 42 },
      { sha256, commitment: "signed, trust me" },
      { sha256, commitment: null },
      { sha256, commitment: { signer: "", signature: "c2ln", verified: true } },
      { sha256, commitment: { signer: "0.0.9", signature: "", verified: true } },
      { sha256, commitment: { signer: "0.0.9", signature: "c2ln", verified: "yes" } },
    ]) {
      expect(parseAttestation(withContent(malformed))).toBeUndefined();
    }
  });

  it("rebuilds the exact signed commitment message from the attestation alone", async () => {
    const sha256 = "b".repeat(64);
    // The server signs the ROUTE PATH; the settlement reference is a full
    // URL. The content block records the signed form, and the rebuild
    // prefers it — the auditor's first field trip caught this mismatch.
    const attested = parseAttestation(
      attestationMessage(await verdict(), {
        content: {
          sha256,
          reference: "/data/spot-price",
          commitment: { signer: "0.0.7000009", signatureB64: "c2ln", verified: true },
        },
      }),
    );
    expect(attested?.content?.reference).toBe("/data/spot-price");
    expect(attestationCommitmentMessage(attested!)).toBe(
      contentCommitmentMessage({
        transactionId: "0.0.7000001-1753099999-123456789",
        reference: "/data/spot-price",
        sha256,
      }),
    );
    // Older messages without the signed reference fall back to the
    // settlement's — the auditor reports honestly on what was recorded.
    const legacy = parseAttestation(attestationMessage(await verdict(), { content: { sha256 } }));
    expect(attestationCommitmentMessage(legacy!)).toBe(
      contentCommitmentMessage({
        transactionId: "0.0.7000001-1753099999-123456789",
        reference: HBAR_REQUEST.reference,
        sha256,
      }),
    );
    // No content block → nothing to rebuild, said plainly.
    expect(
      attestationCommitmentMessage(parseAttestation(attestationMessage(await verdict()))!),
    ).toBeUndefined();
  });

  it("answers undefined for foreign topic messages — public topics carry anything", async () => {
    const real = attestationMessage(await verdict());
    for (const foreign of [
      "gm",
      "not json {",
      "{}",
      JSON.stringify({ v: 99, kind: "x402-settlement-verdict" }),
      JSON.stringify({ v: 1, kind: "something-else" }),
      real.replace('"5000000"', '"5.5"'), // non-integer amount
    ]) {
      expect(parseAttestation(foreign)).toBeUndefined();
    }
  });
});
