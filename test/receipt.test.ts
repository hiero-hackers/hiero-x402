// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { settlementReceiptHTML, verdictLine, verifySettlement } from "../src/index.js";
import {
  HBAR_REQUEST,
  REQUIREMENTS,
  SETTLEMENT_ID,
  fetchStub,
  hbarRow,
  tokenRow,
} from "./helpers.js";

async function verdictFor(credited: number) {
  const { fetchImpl } = fetchStub([hbarRow(credited)]);
  return verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, { fetchImpl });
}

describe("verdictLine", () => {
  it("speaks plainly for each outcome", async () => {
    expect(verdictLine(await verdictFor(5_000_000))).toMatch(/Paid in full/);
    expect(verdictLine(await verdictFor(4_000_000))).toMatch(/Underpaid/);
    expect(verdictLine(await verdictFor(6_000_000))).toMatch(/more than asked/);
  });

  it("covers no-payment outcomes", async () => {
    const { fetchImpl } = fetchStub(undefined, 404);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, {
      fetchImpl,
    });
    expect(verdictLine(verdict)).toMatch(/Not paid/);
  });

  it("covers wrong-asset via a token where HBAR was asked", async () => {
    const { fetchImpl } = fetchStub([tokenRow(5_000_000)]);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, {
      fetchImpl,
    });
    expect(verdictLine(verdict)).toMatch(/wrong asset or wrong destination/);
  });

  it("covers expired and unknown statuses on hand-built verdicts", async () => {
    const base = await verdictFor(5_000_000);
    expect(verdictLine({ ...base, fulfilment: { status: "expired" } })).toMatch(/deadline passed/);
    expect(verdictLine({ ...base, fulfilment: { status: "novel" } as never })).toMatch(
      /Outcome: novel/,
    );
  });
});

describe("settlementReceiptHTML", () => {
  it("carries the verdict, the reference, the proof link, and the receipt body", async () => {
    const verdict = await verdictFor(5_000_000);
    const html = settlementReceiptHTML(verdict);
    expect(html).toContain("independently verified");
    expect(html).toContain("AGENT RAIL · x402"); // the rail chip — evidence, not species
    expect(html).toContain("Paid in full");
    expect(html).toContain(HBAR_REQUEST.reference);
    expect(html).toContain("hashscan.io/testnet/transaction/");
    expect(html).toContain("public mirror node");
    expect(html).toContain("not the facilitator");
  });

  it("says block proof — not mirror — when the receipts are cryptographically verified", async () => {
    const { verifySettlementFromBlock } = await import("../src/index.js");
    const { readFileSync } = await import("node:fs");
    const fixture = (name: string): Buffer =>
      readFileSync(new URL(`../demo/fixtures/${name}`, import.meta.url));
    const verdict = verifySettlementFromBlock(
      {
        scheme: "exact",
        network: "hedera:previewnet",
        amount: "1",
        asset: "0.0.0",
        payTo: "11.12.98",
        maxTimeoutSeconds: 180,
        extra: { feePayer: "11.12.2" },
      },
      "11.12.2@1774994518.000002058",
      "r",
      { blockBytes: fixture("467.blk.gz"), genesisBytes: fixture("0.blk.gz") },
    );
    const html = settlementReceiptHTML(verdict);
    expect(html).toContain("block proof");
    expect(html).not.toContain("mirror node");
  });

  it("omits the proof link when the mirror has no transaction, and escapes what it prints", async () => {
    const { fetchImpl } = fetchStub(undefined, 404);
    const verdict = await verifySettlement(
      REQUIREMENTS,
      SETTLEMENT_ID,
      `<script>alert(1)</script>`,
      { fetchImpl },
    );
    const html = settlementReceiptHTML(verdict);
    expect(html).not.toContain("View on HashScan");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
