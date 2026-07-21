// SPDX-License-Identifier: Apache-2.0
/**
 * The error vocabulary — consumers decide by instanceof, so every public
 * failure path must throw a discriminable kind (and rethrowAs must never
 * double-wrap what is already typed).
 */
import { describe, expect, it } from "vitest";
import {
  BlockProofError,
  InvalidRequirementsError,
  MirrorError,
  UnsupportedNetworkError,
  X402Error,
  assertSupportedNetwork,
  fromPaymentRequirements,
  toPaymentRequirements,
  transactionsById,
  verifySettlementFromBlock,
} from "../src/index.js";
import { HBAR_REQUEST, REQUIREMENTS, SETTLEMENT_ID, fetchStub } from "./helpers.js";

const catchFrom = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
};

describe("discriminable failure kinds", () => {
  it("the gate refuses with UnsupportedNetworkError, carrying the network", () => {
    const error = catchFrom(() => assertSupportedNetwork("hedera:mainnet"));
    expect(error).toBeInstanceOf(UnsupportedNetworkError);
    expect(error).toBeInstanceOf(X402Error);
    expect((error as UnsupportedNetworkError).network).toBe("hedera:mainnet");
  });

  it("bad terms throw InvalidRequirementsError in both bridge directions", () => {
    expect(catchFrom(() => toPaymentRequirements(HBAR_REQUEST, { feePayer: "0x" }))).toBeInstanceOf(
      InvalidRequirementsError,
    );
    expect(
      catchFrom(() => fromPaymentRequirements({ ...REQUIREMENTS, amount: "1.5" }, "r")),
    ).toBeInstanceOf(InvalidRequirementsError);
  });

  it("an unverifiable block throws BlockProofError, carrying block and path", () => {
    const invalid = JSON.stringify({ blockNumber: 467, proofPath: "tampered", valid: false });
    const error = catchFrom(() =>
      verifySettlementFromBlock(
        { ...REQUIREMENTS, network: "hedera:previewnet", payTo: "11.12.98" },
        "11.12.2@1.2",
        "r",
        { blockBytes: new Uint8Array(), genesisBytes: new Uint8Array() },
        { verifyImpl: () => invalid },
      ),
    );
    expect(error).toBeInstanceOf(BlockProofError);
    expect((error as BlockProofError).blockNumber).toBe(467);
    expect((error as BlockProofError).proofPath).toBe("tampered");
  });

  it("mirror transport failures throw MirrorError — but a malformed id does not", async () => {
    const { fetchImpl } = fetchStub(undefined, 500);
    await expect(
      transactionsById("hedera:testnet", SETTLEMENT_ID, fetchImpl),
    ).rejects.toBeInstanceOf(MirrorError);
    // Malformed id: the caller's input problem, not dressed as transport.
    await expect(
      transactionsById("hedera:testnet", "not-an-id", fetchImpl),
    ).rejects.not.toBeInstanceOf(MirrorError);
  });

  it("rethrowAs never double-wraps an already-typed error, and stringifies non-Errors", async () => {
    const { rethrowAs } = await import("../src/errors.js");
    const typed = new MirrorError("already typed");
    expect(catchFrom(() => rethrowAs(typed, InvalidRequirementsError))).toBe(typed);
    const error = catchFrom(() => rethrowAs("boom", MirrorError));
    expect(error).toBeInstanceOf(MirrorError);
    expect((error as Error).message).toBe("boom");
  });
});
