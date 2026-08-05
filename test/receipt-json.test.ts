// SPDX-License-Identifier: Apache-2.0
// The JSON receipt shares every register with the HTML by construction
// (both consume verdict-view); these tests pin the contract from the
// JSON side: stamps agree with the HTML, amounts are decimal strings,
// and the whole object survives JSON round-tripping — no bigint leaks.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RECEIPT_SCHEMA_VERSION,
  contentRegister,
  escapeHTML,
  settlementReceiptHTML,
  settlementReceiptJSON,
  verifySettlement,
  verifySettlementFromBlock,
} from "../src/index.js";
import type { DeliveredContent } from "../src/index.js";
import { HBAR_REQUEST, REQUIREMENTS, SETTLEMENT_ID, fetchStub, hbarRow } from "./helpers.js";

async function verdictFor(credited: number) {
  const { fetchImpl } = fetchStub([hbarRow(credited)]);
  return verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, { fetchImpl });
}

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe("settlementReceiptJSON", () => {
  it("is schema version 1 and survives a JSON round-trip — no bigint leaks", async () => {
    const receipt = settlementReceiptJSON(await verdictFor(5_000_000));
    expect(receipt.schemaVersion).toBe(RECEIPT_SCHEMA_VERSION);
    expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
  });

  it("answers 'did I pay what was asked?' in atomic-unit strings", async () => {
    const paid = settlementReceiptJSON(await verdictFor(5_000_000));
    expect(paid.verdict).toMatchObject({
      status: "paid",
      quoted: "5000000",
      received: "5000000",
    });
    expect(paid.verdict.line).toMatch(/Paid in full/);

    const over = settlementReceiptJSON(await verdictFor(6_000_000));
    expect(over.verdict).toMatchObject({ received: "6000000", excess: "1000000" });

    const under = settlementReceiptJSON(await verdictFor(4_000_000));
    expect(under.verdict).toMatchObject({ received: "4000000", shortfall: "1000000" });
  });

  it("reports nothing credited without inventing a number", async () => {
    const { fetchImpl } = fetchStub(undefined, 404);
    const verdict = await verifySettlement(REQUIREMENTS, SETTLEMENT_ID, HBAR_REQUEST.reference, {
      fetchImpl,
    });
    const receipt = settlementReceiptJSON(verdict);
    expect(receipt.verdict.received).toBeUndefined();
    expect(receipt.payments).toEqual([]);
  });

  it("stamps the mirror rung UNVERIFIED — and the HTML says the same words", async () => {
    const verdict = await verdictFor(5_000_000);
    const receipt = settlementReceiptJSON(verdict);
    expect(receipt.settlement).toMatchObject({ stamp: "UNVERIFIED", readVia: "mirror" });
    expect(receipt.settlement.hashscanUrl).toContain("hashscan.io");
    expect(receipt.settlement.mirrorUrl).toContain("/api/v1/transactions/");
    // The agreement contract: the HTML renders exactly this register's line.
    expect(settlementReceiptHTML(verdict)).toContain(escapeHTML(receipt.settlement.method));
  });

  it("reserves VERIFIED for the block-proof rung, with no mirror links", () => {
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
    const receipt = settlementReceiptJSON(verdict);
    expect(receipt.settlement).toMatchObject({ stamp: "VERIFIED", readVia: "block-proof" });
    expect(receipt.settlement.mirrorUrl).toBeUndefined();
    expect(receipt.payments.length).toBeGreaterThan(0);
  });

  it("embeds hiero-receipts' canonical payment JSON — amounts as strings", async () => {
    const receipt = settlementReceiptJSON(await verdictFor(5_000_000));
    expect(receipt.payments).toHaveLength(1);
    // The library's own policy, inherited: bigints are decimal strings.
    expect(JSON.stringify(receipt.payments[0])).toContain('"5000000"');
  });

  const sha256 = "a".repeat(64);
  const contents: readonly [string, DeliveredContent][] = [
    ["AGENT RECORD", { sha256 }],
    [
      "SERVER COMMITTED",
      {
        sha256,
        reference: "/data/spot-price",
        commitment: { signer: "0.0.7000009", signatureB64: "c2ln", verified: true },
      },
    ],
    [
      "COMMITMENT BROKEN",
      { sha256, commitment: { signer: "0.0.7000009", signatureB64: "c2ln", verified: false } },
    ],
  ];

  it.each(contents)(
    "content register %s — same badge as the HTML panel",
    async (badge, content) => {
      const verdict = await verdictFor(5_000_000);
      const receipt = settlementReceiptJSON(verdict, { content });
      expect(receipt.content?.badge).toBe(badge);
      expect(receipt.content?.badge).toBe(contentRegister(content).badge);
      expect(receipt.content?.sha256).toBe(sha256);
      expect(settlementReceiptHTML(verdict, { content })).toContain(badge);
    },
  );

  it("carries the consent register and the re-verifiable facts", async () => {
    const consent = { approver: "0.0.42", terms: "t", signatureB64: "c2ln", verified: true };
    const approved = settlementReceiptJSON(await verdictFor(5_000_000), { consent });
    expect(approved.consent).toMatchObject({ badge: "HUMAN APPROVED", ...consent });
    const broken = settlementReceiptJSON(await verdictFor(5_000_000), {
      consent: { ...consent, verified: false },
    });
    expect(broken.consent?.badge).toBe("CONSENT UNVERIFIED");
  });

  it("passes the proof's working and the caveat through verbatim", async () => {
    const proof = { source: "block 467", anchor: "genesis block 0", checks: ["root", "sig"] };
    const receipt = settlementReceiptJSON(await verdictFor(5_000_000), {
      proof,
      caveat: "previewnet fixture",
    });
    expect(receipt.proof).toEqual(proof);
    expect(receipt.caveat).toBe("previewnet fixture");
    const bare = settlementReceiptJSON(await verdictFor(5_000_000), {
      proof: { source: "block 467", checks: [] },
    });
    expect(bare.proof?.anchor).toBeUndefined();
  });

  it("omits every optional panel when nothing was passed", async () => {
    const receipt = settlementReceiptJSON(await verdictFor(5_000_000));
    expect(receipt.content).toBeUndefined();
    expect(receipt.consent).toBeUndefined();
    expect(receipt.proof).toBeUndefined();
    expect(receipt.caveat).toBeUndefined();
  });
});
