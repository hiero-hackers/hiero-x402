// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { settlementReceiptJSON, RECEIPT_SCHEMA_VERSION } from "../src/index.js";
import { verifySettlement } from "../src/index.js";
import {
  HBAR_REQUEST,
  REQUIREMENTS,
  SETTLEMENT_ID,
  fetchStub,
  hbarRow,
} from "./helpers.js";

async function verdictFor(credited: number) {
  const { fetchImpl } = fetchStub([hbarRow(credited)]);
  return verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, { fetchImpl });
}

describe("settlementReceiptJSON", () => {
  it("produces a schema-version-1 object", async () => {
    const verdict = await verdictFor(5_000_000);
    const receipt = settlementReceiptJSON(verdict);
    expect(receipt.schemaVersion).toBe(1);
    expect(RECEIPT_SCHEMA_VERSION).toBe(1);
  });

  it("carries the verdict status, transaction id, and trust stamp", async () => {
    const verdict = await verdictFor(5_000_000);
    const receipt = settlementReceiptJSON(verdict);
    expect(receipt.settlement.status).toBe("paid");
    expect(receipt.settlement.transactionId).toContain("0.0.7000001");
    expect(receipt.settlement.trust).toBe("UNVERIFIED");
    expect(receipt.settlement.method).toContain("Mirror");
  });

  it("marks trust as VERIFIED for block-proof verdicts", async () => {
    const verdict = await verdictFor(5_000_000);
    const blockReceipt = {
      ...verdict,
      receipts: [
        ...(verdict.receipts as readonly unknown[]),
        { provenance: { kind: "verified" } },
      ] as never,
    };
    const receipt = settlementReceiptJSON(blockReceipt as never);
    expect(receipt.settlement.trust).toBe("VERIFIED");
    expect(receipt.settlement.method).toContain("Block proof");
  });

  it("includes proof kind and reference", async () => {
    const verdict = await verdictFor(5_000_000);
    const receipt = settlementReceiptJSON(verdict);
    expect(receipt.proof.kind).toBe("mirror");
    expect(receipt.proof.reference).toBe(verdict.transactionId);
  });

  it("agrees with HTML on status for underpaid", async () => {
    const verdict = await verdictFor(4_000_000);
    const receipt = settlementReceiptJSON(verdict);
    expect(receipt.settlement.status).toBe("underpaid");
  });

  it("agrees with HTML on status for overpaid", async () => {
    const verdict = await verdictFor(6_000_000);
    const receipt = settlementReceiptJSON(verdict);
    expect(receipt.settlement.status).toBe("overpaid");
  });

  it("omits content panel when no options are passed", async () => {
    const verdict = await verdictFor(5_000_000);
    const receipt = settlementReceiptJSON(verdict);
    expect(receipt.content).toBeUndefined();
  });

  it("includes consent when provided", async () => {
    const verdict = await verdictFor(5_000_000);
    const receipt = settlementReceiptJSON(verdict, { consent: "Test caveat" });
    expect(receipt.consent).toBe("Test caveat");
  });
});
