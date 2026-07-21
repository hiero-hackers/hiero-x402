// SPDX-License-Identifier: Apache-2.0
/**
 * The attestation wire format — round-trip fidelity, and a parser that
 * treats a public topic's foreign messages as data, never as errors.
 */
import { describe, expect, it } from "vitest";
import { attestationMessage, parseAttestation, verifySettlement } from "../src/index.js";
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
