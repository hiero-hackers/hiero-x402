// SPDX-License-Identifier: Apache-2.0
/**
 * The verdicts, one fixture each — every way a settlement claim can be true
 * or false, judged offline against canned mirror bodies.
 */
import { describe, expect, it } from "vitest";
import { verifySettlement } from "../src/index.js";
import {
  CONSENSUS_AT,
  HBAR_REQUEST,
  REQUIREMENTS,
  SETTLEMENT_ID,
  SETTLEMENT_ID_REST,
  fetchStub,
  hbarRow,
  tokenRow,
} from "./helpers.js";

const REFERENCE = HBAR_REQUEST.reference;

describe("verifySettlement", () => {
  it("confirms an exact payment, with proof link and receipt", async () => {
    const { fetchImpl } = fetchStub([hbarRow(5_000_000)]);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, REFERENCE, { fetchImpl });
    expect(verdict.fulfilment.status).toBe("paid");
    expect(verdict.transactionId).toBe(SETTLEMENT_ID_REST);
    expect(verdict.hashscanUrl).toBe(`https://hashscan.io/testnet/transaction/${CONSENSUS_AT}`);
    expect(verdict.receipts).toHaveLength(1);
  });

  it("reports an underpayment with the shortfall", async () => {
    const { fetchImpl } = fetchStub([hbarRow(4_000_000)]);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, REFERENCE, { fetchImpl });
    expect(verdict.fulfilment.status).toBe("underpaid");
    if (verdict.fulfilment.status === "underpaid") {
      expect(verdict.fulfilment.shortfall).toBe(1_000_000n);
    }
  });

  it("reports an overpayment as a fact, not a failure", async () => {
    const { fetchImpl } = fetchStub([hbarRow(6_000_000)]);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, REFERENCE, { fetchImpl });
    expect(verdict.fulfilment.status).toBe("overpaid");
  });

  it("calls out the wrong asset — a token landed where HBAR was asked", async () => {
    const { fetchImpl } = fetchStub([tokenRow(5_000_000)]);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, REFERENCE, { fetchImpl });
    expect(verdict.fulfilment.status).toBe("wrong-asset");
  });

  it("calls out a settlement whose transaction credits someone else", async () => {
    const row = hbarRow(0, {
      transfers: [
        { account: "0.0.999999", amount: 5_000_000 },
        { account: "0.0.4507291", amount: -5_000_000 },
      ],
    });
    const { fetchImpl } = fetchStub([row]);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, REFERENCE, { fetchImpl });
    // The library's deliberate semantics: something DID move, just not what
    // (or to whom) these terms ask — classify.ts files that under wrong-asset,
    // "emphatically not unpaid". The claimed payment stays as evidence.
    expect(verdict.fulfilment.status).toBe("wrong-asset");
    expect(verdict.receipts).toHaveLength(1);
  });

  it("treats a failed transaction as no payment at all", async () => {
    const { fetchImpl } = fetchStub([hbarRow(5_000_000, { result: "INSUFFICIENT_PAYER_BALANCE" })]);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, REFERENCE, { fetchImpl });
    expect(verdict.fulfilment.status).toBe("unpaid");
  });

  it("treats a different transaction id as no payment — the settlement claim is the claim", async () => {
    const { fetchImpl } = fetchStub([
      hbarRow(5_000_000, { transaction_id: "0.0.7000001-1753099999-999999999" }),
    ]);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, REFERENCE, { fetchImpl });
    expect(verdict.fulfilment.status).toBe("unpaid");
  });

  it("handles a mirror that has not ingested the transaction yet", async () => {
    const { fetchImpl } = fetchStub(undefined, 404);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, REFERENCE, { fetchImpl });
    expect(verdict.fulfilment.status).toBe("unpaid");
    expect(verdict.hashscanUrl).toBeUndefined();
  });

  it("retries while the mirror lags, then verifies — ingestion is seconds behind consensus", async () => {
    let call = 0;
    const fetchImpl = (() => {
      call += 1;
      return Promise.resolve(
        call < 3
          ? { ok: false, status: 404, json: () => Promise.resolve({}) }
          : {
              ok: true,
              status: 200,
              json: () => Promise.resolve({ transactions: [hbarRow(5_000_000)] }),
            },
      );
    }) as unknown as typeof fetch;
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, REFERENCE, {
      fetchImpl,
      attempts: 5,
      delayMs: 0,
    });
    expect(call).toBe(3); // stopped retrying the moment rows appeared
    expect(verdict.fulfilment.status).toBe("paid");
  });

  it("refuses to verify against a non-gated network", async () => {
    const mainnet = { ...REQUIREMENTS, network: "hedera:mainnet" as const };
    const { fetchImpl, calls } = fetchStub([hbarRow(5_000_000)]);
    await expect(
      verifySettlement(mainnet, SETTLEMENT_ID, REFERENCE, { fetchImpl }),
    ).rejects.toThrow(/enforced in code/);
    expect(calls).toHaveLength(0);
  });
});
