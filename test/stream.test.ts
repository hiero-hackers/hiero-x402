// SPDX-License-Identifier: Apache-2.0
/**
 * The block-source verdict — rung three of the trust ladder. The happy paths
 * run against REAL committed preview-network blocks (proof and all, no
 * network); the refusal paths use injected verify/parse impls, same pattern
 * as the mirror tests' injected fetch.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifySettlementFromBlock } from "../src/index.js";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../demo/fixtures/${name}`, import.meta.url));
const BLOCK = { blockBytes: fixture("467.blk.gz"), genesisBytes: fixture("0.blk.gz") };

// The known payment inside fixture block 467 (preview network, 1 tinybar),
// identified by its TRUE transaction id — payer@validStart, straight from
// the parser (streams-node >= 0.2.0). ValidStart is a full minute before
// consensus here: no synthesis could have produced this id.
const TX_ID = "11.12.2@1774994518.000002058";
const REQUIREMENTS = {
  scheme: "exact",
  network: "hedera:previewnet" as const,
  amount: "1",
  asset: "0.0.0",
  payTo: "11.12.98",
  maxTimeoutSeconds: 180,
  extra: { feePayer: "11.12.2" },
};
const REFERENCE = "https://api.example.test/data/spot-price";

describe("verifySettlementFromBlock", () => {
  it("proves the block, finds the transaction, and confirms exact payment — receipts stamped verified", () => {
    const verdict = verifySettlementFromBlock(REQUIREMENTS, TX_ID, REFERENCE, BLOCK);
    expect(verdict.fulfilment.status).toBe("paid");
    expect(verdict.receipts).toHaveLength(1);
    expect(verdict.receipts[0]?.provenance.kind).toBe("verified");
    // No explorer for the preview network — no proof link is honestly no link.
    expect(verdict.hashscanUrl).toBeUndefined();
  });

  it("reports the richer verdicts from what the proven block actually credits", () => {
    const verdict = verifySettlementFromBlock(
      { ...REQUIREMENTS, amount: "2" },
      TX_ID,
      REFERENCE,
      BLOCK,
    );
    expect(verdict.fulfilment.status).toBe("underpaid");
    if (verdict.fulfilment.status === "underpaid") {
      expect(verdict.fulfilment.shortfall).toBe(1n);
    }
  });

  it("a different transaction id claims nothing, however real the block", () => {
    const verdict = verifySettlementFromBlock(
      REQUIREMENTS,
      "11.12.2@1774994578.999999999",
      REFERENCE,
      BLOCK,
    );
    expect(verdict.fulfilment.status).toBe("unpaid");
  });

  it("refuses to read data whose proof does not verify", () => {
    const invalid = JSON.stringify({ blockNumber: 467, proofPath: "tampered", valid: false });
    expect(() =>
      verifySettlementFromBlock(REQUIREMENTS, TX_ID, REFERENCE, BLOCK, {
        verifyImpl: () => invalid,
      }),
    ).toThrow(/refusing to read/);
  });

  it("a wrong genesis fails closed — the native verifier throws, nothing is read", () => {
    const wrongGenesis = { blockBytes: BLOCK.blockBytes, genesisBytes: BLOCK.blockBytes };
    expect(() => verifySettlementFromBlock(REQUIREMENTS, TX_ID, REFERENCE, wrongGenesis)).toThrow();
  });

  it("links the explorer when the network has one (gated networks only)", () => {
    const testnet = {
      ...REQUIREMENTS,
      network: "hedera:testnet" as const,
      payTo: "0.0.4507290",
      extra: { feePayer: "0.0.7000001" },
    };
    const fabricated = JSON.stringify({
      transactions: [
        {
          consensusTimestamp: "1753100000.000000001",
          payer: "0.0.4507291",
          type: "CRYPTOTRANSFER",
          result: "SUCCESS",
          chargedFeeTinybar: 76916,
          transfers: [
            { account: "0.0.4507291", amount: -1 },
            { account: "0.0.4507290", amount: 1 },
          ],
          tokenTransfers: [],
        },
      ],
    });
    const verdict = verifySettlementFromBlock(
      testnet,
      "0.0.4507291@1753100000.000000001",
      REFERENCE,
      BLOCK,
      {
        verifyImpl: () => JSON.stringify({ blockNumber: 1, proofPath: "test", valid: true }),
        parseImpl: () => fabricated,
      },
    );
    expect(verdict.fulfilment.status).toBe("paid");
    expect(verdict.hashscanUrl).toBe(
      "https://hashscan.io/testnet/transaction/1753100000.000000001",
    );
  });
});
